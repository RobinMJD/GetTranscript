import {
  exportTranscript,
  filename,
  matchSpeakers,
  parseVtt,
  plainText,
  timestamp,
  validateCues,
} from "./transcript";
import type { ExportOptions, PageCapture, Transcript } from "./types";

export interface CollectionTrack {
  key: string;
  label: string;
  language: string;
  transcript: Transcript;
}
export interface RecordingPart {
  id: string;
  url: string;
  title: string;
  duration?: number;
  offset?: number;
  tracks: CollectionTrack[];
  selectedTrack: string;
  status: "pending" | "reading" | "ready" | "error";
  error: string;
}
export interface CollectionOptions extends ExportOptions {
  mode: "combined" | "individual";
  timeline: "continuous" | "custom" | "local";
  includeSources: boolean;
}
export interface RecordingCollection {
  tabId: number;
  generation: string;
  revision: number;
  sourceUrl: string;
  title: string;
  parts: RecordingPart[];
  phase: "idle" | "reading" | "paused" | "ready" | "error";
  busy?: boolean;
  activity?: "waiting" | "opening" | "reading" | "restoring";
  error: string;
  options: CollectionOptions;
  download: "idle" | "saving" | "complete" | "error";
  downloadIds: number[];
}
export const defaultCollectionOptions: CollectionOptions = {
  format: "md",
  mode: "combined",
  timeline: "continuous",
  speakers: true,
  visibleNames: false,
  includeSources: true,
};
export const MAX_COLLECTION_PARTS = 20;
export const MAX_COLLECTION_CUES = 50_000;
export const MAX_COLLECTION_TEXT = 5_000_000;
// Some players report a media boundary a few seconds before their final cues.
// Keep this compatibility tolerance bounded; never derive offsets from cues.
const MAX_CAPTION_OVERHANG_SECONDS = 5;
export const collectionKey = (tabId: number) => `collection:${tabId}`;

/** Keep playable URLs, but discard tracking parameters and reject unsafe inputs. */
export function sourceUrl(raw: string, origin?: string): string {
  if (typeof raw !== "string" || raw.length > 16_384)
    throw new Error("Enter a valid recording link.");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Enter a complete recording link beginning with https://.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      "Recording links must use HTTP or HTTPS without credentials.",
    );
  if (origin && url.origin !== new URL(origin).origin)
    throw new Error(
      "All recordings must be on the same website as the source tab.",
    );
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(referrer|referrerScenario|utm_.+)$/i.test(key))
      url.searchParams.delete(key);
  }
  return url.href;
}

/** Stream referrer changes must not cause duplicate parts or stale-tab cache hits. */
export function canonicalSource(raw: string): string {
  const url = new URL(sourceUrl(raw));
  if (
    /(?:^|\.)sharepoint\.(?:com|us|de|cn)$/i.test(url.hostname) &&
    /\/_layouts\/15\/stream\.aspx$/i.test(url.pathname)
  ) {
    const path = url.searchParams.get("id");
    if (path?.startsWith("/") && !path.startsWith("//")) {
      const file = new URL(url.origin);
      file.pathname = path
        .normalize("NFC")
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      return file.href;
    }
  }
  return url.href;
}

export function newPart(raw: string): RecordingPart {
  const url = sourceUrl(raw);
  const parsed = new URL(url);
  const filePath = parsed.searchParams.get("id");
  const path = filePath || parsed.pathname;
  let title = path.split("/").at(-1) || "Recording";
  if (!filePath) {
    try {
      title = decodeURIComponent(title);
    } catch {
      // Malformed escapes do not make the rest of a usable URL unreadable.
    }
  }
  title = title.replace(/\.(mp4|webm|mov|m4v|mkv)$/i, "") || "Recording";
  return {
    id: crypto.randomUUID(),
    url,
    title: title.slice(0, 250),
    tracks: [],
    selectedTrack: "",
    status: "pending",
    error: "",
  };
}

/** Resolve each track before merging, keeping native voices and ambiguity rules. */
export function prepareCollectionTracks(
  capture: PageCapture,
): CollectionTrack[] {
  if (capture.tracks.length > 150)
    throw new Error("The page returned too many caption tracks.");
  return capture.tracks.map((track) => {
    const cues = track.vtt
      ? parseVtt(track.vtt)
      : validateCues(
          (track.cues || []).map((cue) => ({
            ...cue,
            text: track.textFormat === "plain" ? cue.text : plainText(cue.text),
          })),
        );
    const result = matchSpeakers(cues, capture.rows);
    const warnings = [...capture.warnings];
    if (
      !result.matched &&
      !warnings.some((warning) => /speaker/i.test(warning))
    )
      warnings.push(
        "Reliable speaker names were not available. Captions remain unnamed.",
      );
    if (result.matched > 0 && result.matched < result.total)
      warnings.push(
        `${result.matched} of ${result.total} captions have verified speaker labels. Unmatched captions remain unnamed.`,
      );
    return {
      key: String(track.key),
      label: String(track.label || track.language || "Captions").slice(0, 150),
      language: String(track.language || "").slice(0, 30),
      transcript: {
        title: String(capture.title || "Transcript").slice(0, 250),
        provider: String(capture.provider || "Video").slice(0, 100),
        language: String(track.language || "").slice(0, 30),
        cues: result.cues,
        warnings,
      },
    };
  });
}

const escapeMarkdown = (text: string) =>
  text.replace(/([\\`*_{}\[\]<>#|])/g, "\\$1");
const languageKey = (value: string) =>
  value.trim().replace(/_/g, "-").toLowerCase() || "und";
const shiftedTime = (time: number, offset: number) =>
  Math.round((time + offset) * 1000) / 1000;

function captionOverhang(part: RecordingPart): number {
  if (!Number.isFinite(part.duration) || part.duration! <= 0) return 0;
  const track = part.tracks.find((track) => track.key === part.selectedTrack);
  return (track?.transcript.cues || []).reduce(
    (overhang, cue) => Math.max(overhang, cue.end - part.duration!),
    0,
  );
}

/** Derived from the selected track so cached results also show timing drift. */
export function partTimingWarning(part: RecordingPart): string | undefined {
  const overhang = captionOverhang(part);
  if (overhang <= 0.05) return undefined;
  return `Caption timestamps extend ${overhang.toFixed(3)} seconds beyond this video's reported duration. Original caption timings and video duration are preserved.`;
}

/** Offsets come only from media duration or explicit user input, never caption ends. */
export function collectionOffsets(
  parts: RecordingPart[],
  timeline: CollectionOptions["timeline"],
): number[] {
  if (timeline === "local") return parts.map(() => 0);
  const offsets: number[] = [];
  let previousEnd = 0;
  for (let i = 0; i < parts.length; i++) {
    const offset = timeline === "custom" ? parts[i].offset : previousEnd;
    if (!Number.isFinite(offset) || offset! < 0)
      throw new Error(`Enter a valid start offset for part ${i + 1}.`);
    if (offset! < previousEnd - 0.001)
      throw new Error(
        `Part ${i + 1} overlaps the preceding recording. Adjust its start offset.`,
      );
    offsets.push(offset!);
    if (i < parts.length - 1) {
      const duration = parts[i].duration;
      if (!Number.isFinite(duration) || duration! <= 0)
        throw new Error(
          `Part ${i + 1} needs its actual video duration. Use original timestamps or individual files until it is available.`,
        );
      previousEnd = offset! + duration!;
    }
  }
  return offsets;
}

export function exportCollection(
  collection: RecordingCollection,
): { text: string; mime: string; filename: string }[] {
  const { parts, options } = collection;
  if (!parts.length || parts.length > MAX_COLLECTION_PARTS)
    throw new Error(`Add between 1 and ${MAX_COLLECTION_PARTS} recordings.`);
  if (parts.some((part) => part.status !== "ready"))
    throw new Error(
      "Every recording must finish reading before export. Retry failed parts or remove them explicitly.",
    );
  const needsTimeline =
    options.mode === "combined" && options.timeline !== "local";
  const identities = new Set<string>();
  const ids = new Set<string>();
  const origin = new URL(sourceUrl(collection.sourceUrl)).origin;
  let totalCues = 0;
  let totalText = 0;
  const tracks = parts.map((part, index) => {
    const identity = canonicalSource(sourceUrl(part.url, origin));
    if (identities.has(identity) || ids.has(part.id))
      throw new Error(
        "The collection contains the same recording more than once.",
      );
    identities.add(identity);
    ids.add(part.id);
    const track = part.tracks.find(
      (candidate) => candidate.key === part.selectedTrack,
    );
    if (!track)
      throw new Error(
        `Choose an available caption track for part ${index + 1}.`,
      );
    const cues = validateCues(track.transcript.cues);
    if (
      needsTimeline &&
      part.duration !== undefined &&
      (!Number.isFinite(part.duration) || part.duration <= 0)
    )
      throw new Error(`Part ${index + 1} has an invalid video duration.`);
    for (const cue of cues) {
      totalCues++;
      totalText += cue.text.length;
    }
    if (needsTimeline && captionOverhang(part) > MAX_CAPTION_OVERHANG_SECONDS)
      throw new Error(
        `Part ${index + 1} has captions more than ${MAX_CAPTION_OVERHANG_SECONDS} seconds outside its video duration. Refresh this recording or export separate files with original timestamps.`,
      );
    const timingWarning = partTimingWarning(part);
    const warnings = timingWarning
      ? [...new Set([...track.transcript.warnings, timingWarning])]
      : track.transcript.warnings;
    return { ...track, transcript: { ...track.transcript, cues, warnings } };
  });
  if (totalCues > MAX_COLLECTION_CUES || totalText > MAX_COLLECTION_TEXT)
    throw new Error(
      "This collection exceeds the safe export size. Export a smaller group of recordings.",
    );
  if (options.mode === "individual") {
    return tracks.map((track, i) => ({
      ...exportTranscript(track.transcript, options),
      filename: filename(
        `Part ${String(i + 1).padStart(2, "0")} - ${parts[i].title}`,
        track.language,
        options.format,
      ),
    }));
  }
  const languages = [
    ...new Set(tracks.map((track) => languageKey(track.language))),
  ];
  if (options.timeline === "local" && ["vtt", "srt"].includes(options.format))
    throw new Error(
      "Combined VTT and SRT need a continuous timeline. Use individual files to retain each recording’s original timestamps.",
    );
  const offsets = collectionOffsets(parts, options.timeline);
  const title = String(collection.title || "Combined transcript").slice(0, 250);
  const language = languages.length === 1 ? tracks[0].language : "mul";
  const exportName = filename(title, language, options.format);
  let result: { text: string; mime: string };
  if (options.format === "md" || options.format === "txt") {
    const markdown = options.format === "md";
    const escape = markdown ? escapeMarkdown : (text: string) => text;
    const sections = tracks.map((track, index) => {
      const heading = `${markdown ? "## " : ""}Part ${index + 1} · ${escape(parts[index].title)}`;
      const source = options.includeSources
        ? markdown
          ? `\n\n[Open recording](<${sourceUrl(parts[index].url).replace(/[<>]/g, (c) => (c === "<" ? "%3C" : "%3E"))}>)`
          : `\n\nSource: ${sourceUrl(parts[index].url)}`
        : "";
      const timingWarning = partTimingWarning(parts[index]);
      const note = timingWarning
        ? `\n\n${markdown ? "> " : "Note: "}${escape(timingWarning)}`
        : "";
      const cues = track.transcript.cues
        .map((cue) => {
          const clocks =
            options.timeline === "local"
              ? timestamp(cue.start)
              : `${timestamp(shiftedTime(cue.start, offsets[index]))} combined · ${timestamp(cue.start)} recording`;
          const speaker =
            options.speakers && cue.speaker ? ` · ${escape(cue.speaker)}` : "";
          return markdown
            ? `**${clocks}${speaker}**  \n${escape(cue.text)}`
            : `[${clocks}${speaker}]\n${cue.text}`;
        })
        .join("\n\n");
      return `${heading}${source}${note}\n\n${cues}`;
    });
    result = {
      mime: markdown ? "text/markdown" : "text/plain",
      text: `${markdown ? "# " : ""}${escape(title)}\n\n${sections.join("\n\n")}\n`,
    };
  } else if (options.format === "json") {
    result = {
      mime: "application/json",
      text:
        JSON.stringify(
          {
            schemaVersion: 2,
            title,
            language,
            timeline: options.timeline,
            timeUnit: "seconds",
            parts: parts.map((part, index) => ({
              id: part.id,
              order: index + 1,
              title: part.title,
              ...(options.includeSources
                ? { sourceUrl: sourceUrl(part.url) }
                : {}),
              duration: part.duration ?? null,
              offset: options.timeline === "local" ? null : offsets[index],
              language: tracks[index].language,
              provider: tracks[index].transcript.provider,
              warnings: tracks[index].transcript.warnings,
              cues: tracks[index].transcript.cues.map((cue, cueIndex) => ({
                ...cue,
                id: `${part.id}:${cueIndex + 1}:${cue.id}`,
                originalId: cue.id,
                speaker: options.speakers ? cue.speaker : undefined,
              })),
            })),
          },
          null,
          2,
        ) + "\n",
    };
  } else {
    const cues = tracks
      .flatMap((track, index) =>
        track.transcript.cues.map((cue, cueIndex) => ({
          ...cue,
          id: `${parts[index].id}:${cueIndex + 1}:${cue.id}`,
          start: shiftedTime(cue.start, offsets[index]),
          end: shiftedTime(cue.end, offsets[index]),
        })),
      )
      // Caption overhang may interleave neighboring parts. WebVTT requires
      // nondecreasing starts; stable sorting retains source order for ties.
      .sort((a, b) => a.start - b.start);
    result = exportTranscript(
      { title, language, provider: "Recording collection", cues, warnings: [] },
      options,
    );
  }
  if (new TextEncoder().encode(result.text).length > 8_000_000)
    throw new Error(
      "This export is too large to save. Choose individual files or a smaller collection.",
    );
  return [{ ...result, filename: exportName }];
}
