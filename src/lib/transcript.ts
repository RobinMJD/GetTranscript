import type { Cue, ExportOptions, SpeakerRow, Transcript } from "./types";

const MAX_CUES = 50_000;
export const normalizeText = (s: string) =>
  s.normalize("NFC").replace(/\s+/g, "");
export function plainText(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|nbsp|quot|apos|#\d+|#x[\da-f]+);/gi, (entity) => {
      const named: Record<string, string> = {
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&nbsp;": " ",
        "&quot;": '"',
        "&apos;": "'",
      };
      if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
      const n =
        entity[2].toLowerCase() === "x"
          ? parseInt(entity.slice(3, -1), 16)
          : parseInt(entity.slice(2, -1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
        ? String.fromCodePoint(n)
        : "";
    })
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}
export function parseTime(value: string): number {
  const m = /^(?:(\d{2,}):)?(\d{2}):(\d{2})[.,](\d{3})$/.exec(value);
  if (!m || +m[2] > 59 || +m[3] > 59)
    throw new Error("A caption has an invalid timestamp.");
  return (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
}
export function timestamp(seconds: number, srt = false): string {
  const ms = Math.round(seconds * 1000),
    h = Math.floor(ms / 3600000),
    m = Math.floor(ms / 60000) % 60,
    s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${srt ? "," : "."}${String(ms % 1000).padStart(3, "0")}`;
}
export function validateCues(cues: Cue[]): Cue[] {
  if (!Array.isArray(cues) || !cues.length || cues.length > MAX_CUES)
    throw new Error(
      "No usable captions were found, or the transcript is too large.",
    );
  let total = 0;
  return cues.map((c, i) => {
    if (
      !c ||
      !Number.isFinite(c.start) ||
      !Number.isFinite(c.end) ||
      c.start < 0 ||
      c.end <= c.start ||
      c.end > 360000 ||
      typeof c.text !== "string"
    )
      throw new Error("The page returned invalid caption data.");
    total += c.text.length;
    if (c.text.length > 100000 || total > 5_000_000)
      throw new Error("The transcript exceeds the safe export size.");
    const text = c.text
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .trim();
    if (!text) throw new Error("The page returned an empty caption.");
    const speaker =
      typeof c.speaker === "string"
        ? plainText(c.speaker)
            .replace(/[\r\n<>]/g, " ")
            .trim()
            .slice(0, 200)
        : undefined;
    return {
      id: String(c.id || i + 1)
        .replace(/[\r\n<>\u0000-\u001f]/g, "")
        .slice(0, 200),
      start: c.start,
      end: c.end,
      text,
      ...(speaker ? { speaker } : {}),
    };
  });
}
export function parseVtt(raw: string): Cue[] {
  if (
    typeof raw !== "string" ||
    raw.length > 5_000_000 ||
    !/^\uFEFF?WEBVTT(?:\s|$)/.test(raw)
  )
    throw new Error("The caption track is not a readable WebVTT file.");
  const blocks = raw
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n[ \t]*\n/);
  const cues: Cue[] = [];
  for (const block of blocks.slice(1)) {
    if (/^(NOTE(?:\s|$)|STYLE(?:\s|$)|REGION(?:\s|$))/.test(block)) continue;
    const lines = block.split("\n"),
      idx = lines.findIndex((l) => l.includes("-->"));
    if (idx < 0) continue;
    const m = /^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[idx]);
    if (!m) throw new Error("A caption timing line could not be read.");
    const payload = lines.slice(idx + 1).join("\n");
    const voices = [
      ...new Set(
        [...payload.matchAll(/<v(?:\.[^\s>]*)?\s+([^>]+)>/g)].map((m) =>
          plainText(m[1]),
        ),
      ),
    ];
    // A multi-voice cue stays unattributed rather than assigning the wrong speaker.
    cues.push({
      id: idx ? lines[0] : String(cues.length + 1),
      start: parseTime(m[1]),
      end: parseTime(m[2]),
      text: plainText(payload),
      ...(voices.length === 1 ? { speaker: voices[0] } : {}),
    });
  }
  return validateCues(cues);
}
export function parseSpeakerLabel(
  label: string,
): { name: string; time: number } | undefined {
  const m =
    /^(.*?)\s+((?:\d+\s+(?:hours?|heures?|minutes?|secondes?|seconds?)(?:\s|$))+)$/.exec(
      label.trim(),
    );
  if (!m) return;
  let time = 0;
  for (const part of m[2].matchAll(
    /(\d+)\s+(hours?|heures?|minutes?|secondes?|seconds?)/g,
  ))
    time +=
      +part[1] *
      (/^(hour|heure)/.test(part[2]) ? 3600 : /^minute/.test(part[2]) ? 60 : 1);
  return { name: plainText(m[1]).trim(), time };
}
export function matchSpeakers(
  cues: Cue[],
  rows: SpeakerRow[],
): { cues: Cue[]; matched: number; total: number } {
  const groups = new Map<string, Cue[]>();
  for (const c of cues) {
    const key = /\/[\d]+-\d+$/.test(c.id) ? c.id.replace(/-\d+$/, "") : c.id;
    const g = groups.get(key) || [];
    g.push(c);
    groups.set(key, g);
  }
  const candidates = rows
    .map((r) => ({ r, label: parseSpeakerLabel(r.label) }))
    .filter((x) => x.label);
  const assignments = new Map<string, string>();
  const used = new Set<number>();
  for (const group of groups.values()) {
    const text = normalizeText(group.map((c) => c.text).join(" "));
    const start = Math.min(...group.map((c) => c.start));
    const matches = candidates.filter(
      ({ r, label }) =>
        !used.has(r.index) &&
        label &&
        start - label.time >= -0.001 &&
        start - label.time < 1.001 &&
        normalizeText(r.text) === text,
    );
    if (matches.length === 1) {
      used.add(matches[0].r.index);
      for (const c of group) assignments.set(c.id, matches[0].label!.name);
    }
  }
  const result = cues.map((c) => ({
    ...c,
    ...(assignments.has(c.id) ? { speaker: assignments.get(c.id) } : {}),
  }));
  return {
    cues: result,
    matched: result.filter((c) => c.speaker).length,
    total: result.length,
  };
}
const escapeVtt = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeMarkdown = (s: string) => s.replace(/([\\`*_{}\[\]<>#|])/g, "\\$1");
export function exportTranscript(
  t: Transcript,
  options: ExportOptions,
): { text: string; mime: string } {
  const cues = validateCues(t.cues).map((c) => ({
    ...c,
    speaker: options.speakers ? c.speaker : undefined,
  }));
  const withName = (c: Cue) => `${c.speaker ? `${c.speaker}: ` : ""}${c.text}`;
  switch (options.format) {
    case "vtt":
      return {
        mime: "text/vtt",
        text:
          "WEBVTT\n\n" +
          cues
            .map(
              (c) =>
                `${c.id}\n${timestamp(c.start)} --> ${timestamp(c.end)}\n${c.speaker ? `<v ${escapeVtt(c.speaker)}>${options.visibleNames ? escapeVtt(c.speaker) + ": " : ""}` : ""}${escapeVtt(c.text)}${c.speaker ? "</v>" : ""}`,
            )
            .join("\n\n") +
          "\n",
      };
    case "srt":
      return {
        mime: "application/x-subrip",
        text:
          cues
            .map(
              (c, i) =>
                `${i + 1}\n${timestamp(c.start, true)} --> ${timestamp(c.end, true)}\n${escapeVtt(withName(c))}`,
            )
            .join("\n\n") + "\n",
      };
    case "txt":
      return {
        mime: "text/plain",
        text:
          `${t.title}\n\n` +
          cues
            .map((c) => `[${timestamp(c.start)}] ${withName(c)}`)
            .join("\n\n") +
          "\n",
      };
    case "md":
      return {
        mime: "text/markdown",
        text:
          `# ${escapeMarkdown(t.title)}\n\n` +
          cues
            .map(
              (c) =>
                `**${timestamp(c.start)}${c.speaker ? " · " + escapeMarkdown(c.speaker) : ""}**\n\n${escapeMarkdown(c.text)}`,
            )
            .join("\n\n") +
          "\n",
      };
    case "json":
      return {
        mime: "application/json",
        text:
          JSON.stringify(
            {
              schemaVersion: 1,
              title: t.title,
              language: t.language,
              provider: t.provider,
              timeUnit: "seconds",
              cues,
            },
            null,
            2,
          ) + "\n",
      };
  }
}
export function filename(
  title: string,
  language: string,
  extension: string,
): string {
  const safe = (s: string) =>
    s
      .normalize("NFC")
      .replace(
        /[\u0000-\u001f\u007f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/g,
        " ",
      )
      .replace(/\s+/g, " ")
      .replace(/^[. ]+|[. ]+$/g, "")
      .slice(0, 120)
      .trim();
  let base = safe(title) || "Transcript";
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(base))
    base = "Transcript " + base;
  return `${base}${safe(language) ? "." + safe(language).slice(0, 20) : ""}.${extension}`;
}
