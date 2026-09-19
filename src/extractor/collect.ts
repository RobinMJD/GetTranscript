import type { PageCapture, RawTrack, SpeakerRow } from "../lib/types";

/** Self-contained: Chrome serializes this function into the active page's MAIN world. */
export async function collectPage(options: {
  speakers: boolean;
  prepare: boolean;
}): Promise<PageCapture> {
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const deadline = Date.now() + 30000;
  const warnings: string[] = [];
  const isStream =
    /(^|\.)sharepoint\.(com|us|de|cn)$/.test(location.hostname) &&
    /\/stream\.aspx$/i.test(location.pathname);
  // A toolbar click can arrive while Stream is still mounting its player.
  if (isStream && options.prepare) {
    const playerDeadline = Date.now() + 6000;
    for (
      ;
      Date.now() < playerDeadline &&
      !Array.from(document.querySelectorAll("video,audio")).some(
        (m) => (m as HTMLMediaElement).textTracks.length,
      );
    )
      await wait(100);
  }
  // These identifiers describe controls and icons, never translated UI strings.
  const buttons = () =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'),
    );
  const transcriptButton = buttons().find((b) =>
    b.querySelector('[data-icon-name="SlideText"]'),
  );
  const captionButton = buttons().find(
    (b) =>
      b.querySelector('[data-icon-name="ClosedCaptions"]') ||
      Array.from(b.querySelectorAll("svg path")).some((p) => {
        const d = p.getAttribute("d") || "";
        return d.includes("ZM5.5 12c0-3.15") && d.includes("Zm7.5 0c0-3.15");
      }),
  );
  const normalizeDigits = (value: string): string =>
    value
      .normalize("NFKC")
      .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/\p{Decimal_Number}/gu, (digit) => {
        const point = digit.codePointAt(0)!;
        let first = point;
        while (
          first > 0 &&
          /\p{Decimal_Number}/u.test(String.fromCodePoint(first - 1))
        )
          first--;
        return String((point - first) % 10);
      });
  const clockTime = (value: string): number | undefined => {
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(
      normalizeDigits(value).trim(),
    );
    if (!m || +m[2] > 59 || +m[3] > 59) return;
    return (
      (+m[1] || 0) * 3600 +
      +m[2] * 60 +
      +m[3] +
      +(m[4] || "0").padEnd(3, "0") / 1000
    );
  };
  const unitKey = (s: string) =>
    s
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[^\p{Letter}\p{Mark}]/gu, "");
  const units = new Map<string, number>();
  const ambiguousUnits = new Set<string>();
  const addUnit = (key: string, scale: number) => {
    if (!key || ambiguousUnits.has(key)) return;
    if (units.has(key) && units.get(key) !== scale) {
      units.delete(key);
      ambiguousUnits.add(key);
    } else units.set(key, scale);
  };
  // Intl derives plural/abbreviated forms for the document locale, not a language whitelist.
  const locales = new Set(
    [document.documentElement.lang, navigator.language].filter(Boolean),
  );
  for (const locale of locales)
    for (const [unit, scale] of [
      ["hour", 3600],
      ["minute", 60],
      ["second", 1],
    ] as const)
      for (const unitDisplay of ["long", "short", "narrow"] as const) {
        try {
          const format = new Intl.NumberFormat(locale, {
            style: "unit",
            unit,
            unitDisplay,
            useGrouping: false,
          });
          for (const value of [0, 1, 2, 3, 5, 11, 21, 100])
            addUnit(
              unitKey(
                format
                  .formatToParts(value)
                  .filter((p) => p.type === "unit")
                  .map((p) => p.value)
                  .join(""),
              ),
              scale,
            );
        } catch {
          /* Unsupported locale metadata must not prevent caption export. */
        }
      }
  const durationParts = (value: string) => {
    const normalized = normalizeDigits(value).trim();
    return [...normalized.matchAll(/(\d+)\s*([^\d]+)/g)].map((m) => ({
      value: +m[1],
      unit: unitKey(m[2]),
    }));
  };
  const localizedTime = (value: string): number | undefined => {
    const clock = clockTime(value);
    if (clock !== undefined) return clock;
    const normalized = normalizeDigits(value).trim();
    if (!/^\d/.test(normalized)) return;
    const parts = durationParts(normalized);
    if (
      !parts.length ||
      parts.length > 3 ||
      (normalized.match(/\d+/g)?.length || 0) !== parts.length
    )
      return;
    let time = 0,
      previousScale = Infinity;
    for (const p of parts) {
      const scale = units.get(p.unit);
      if (!scale || scale >= previousScale || (scale < 3600 && p.value > 59))
        return;
      time += p.value * scale;
      previousScale = scale;
    }
    return time;
  };
  const title = (
    document.querySelector('[role="heading"][aria-level="1"]')?.textContent ||
    document.querySelector("h1")?.textContent ||
    document.querySelector('[id="shellDocumentTitle"]')?.textContent ||
    document.title ||
    "Transcript"
  )
    .replace(/\.mp4$/i, "")
    .trim()
    .slice(0, 250);
  const docs: Document[] = [document];
  for (let i = 0; i < docs.length && docs.length < 12; i++)
    for (const frame of docs[i].querySelectorAll("iframe")) {
      try {
        if (frame.contentDocument && !docs.includes(frame.contentDocument))
          docs.push(frame.contentDocument);
      } catch {
        /* Cross-origin frames require their own active tab. */
      }
    }
  const media = docs
    .flatMap((d) =>
      Array.from(d.querySelectorAll<HTMLMediaElement>("video,audio")),
    )
    .slice(0, 12);
  const tracks: RawTrack[] = [];
  const originalModes = new Map(
    media.flatMap((m) =>
      Array.from(m.textTracks).map((t) => [t, t.mode] as const),
    ),
  );
  let originalCaption: string | undefined;
  let captionMenuWasExpanded = false;
  let captionMenuTouched = false;
  const captionItems = () => {
    const items = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    );
    const labels = media.flatMap((m) =>
      Array.from(m.textTracks)
        .map((t) => t.label)
        .filter(Boolean),
    );
    const match = items.find((e) =>
      labels.includes(e.textContent?.trim() || ""),
    );
    const menu = match?.closest('[role="menu"]') || match?.parentElement;
    return menu ? items.filter((e) => menu.contains(e)) : [];
  };
  const openCaptionMenu = async () => {
    if (!captionButton) return [];
    if (captionButton.getAttribute("aria-expanded") !== "true") {
      captionButton.click();
    }
    const menuDeadline = Date.now() + 2000;
    let items = captionItems();
    while (!items.length && Date.now() < menuDeadline) {
      await wait(100);
      items = captionItems();
    }
    return items;
  };
  const closeCaptionMenu = () => {
    if (captionButton?.getAttribute("aria-expanded") === "true")
      captionButton.click();
  };
  const prepareTrack = async (track: TextTrack, element: HTMLMediaElement) => {
    if (!isStream || !options.prepare || !captionButton) return;
    const trackElement = () =>
      Array.from(element.querySelectorAll("track")).find(
        (e) => e.track === track,
      );
    if (trackElement()?.src || track.cues?.length) return;
    if (!captionMenuTouched)
      captionMenuWasExpanded =
        captionButton.getAttribute("aria-expanded") === "true";
    const items = await openCaptionMenu();
    if (!captionMenuTouched) {
      originalCaption = items
        .find((e) => e.getAttribute("aria-checked") === "true")
        ?.textContent?.trim();
      captionMenuTouched = true;
    }
    const matches = items.filter(
      (e) => e.textContent?.trim() === track.label && track.label,
    );
    if (matches.length !== 1 || originalCaption === undefined) {
      closeCaptionMenu();
      return;
    }
    matches[0].click();
    const trackDeadline = Math.min(deadline, Date.now() + 4000);
    for (
      ;
      Date.now() < trackDeadline && !trackElement()?.src && !track.cues?.length;
    )
      await wait(100);
    closeCaptionMenu();
  };
  try {
    for (let mi = 0; mi < media.length; mi++) {
      const element = media[mi];
      const native = Array.from(element.textTracks)
        .filter((t) => ["captions", "subtitles"].includes(t.kind))
        .slice(0, 150);
      for (let ti = 0; ti < native.length; ti++) {
        if (Date.now() > deadline || tracks.length >= 150) {
          warnings.push(
            "Some caption languages could not be loaded within this scan. Select the language in the player and refresh.",
          );
          break;
        }
        const track = native[ti];
        if (/Shaka Player TextTrack/i.test(track.label)) continue;
        const oldMode = track.mode;
        try {
          await prepareTrack(track, element);
          if (track.mode === "disabled") track.mode = "hidden";
          const trackElement = Array.from(
            element.querySelectorAll("track"),
          ).find((e) => e.track === track);
          let vtt: string | undefined;
          if (trackElement?.src) {
            const url = new URL(
              trackElement.src,
              element.ownerDocument.baseURI,
            );
            if (["blob:", "https:", "http:"].includes(url.protocol)) {
              try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 6000);
                try {
                  const response = await fetch(url.href, {
                    credentials: "same-origin",
                    signal: controller.signal,
                  });
                  if (!response.ok) throw new Error("Track unavailable");
                  if (
                    Number(response.headers.get("content-length") || 0) >
                    5_000_000
                  )
                    throw new Error("Track too large");
                  const reader = response.body?.getReader();
                  if (!reader) throw new Error("No body");
                  const chunks: Uint8Array[] = [];
                  let size = 0;
                  while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    if (size > 5_000_000) {
                      await reader.cancel();
                      throw new Error("Track too large");
                    }
                    chunks.push(value);
                  }
                  const joined = new Uint8Array(size);
                  let offset = 0;
                  for (const chunk of chunks) {
                    joined.set(chunk, offset);
                    offset += chunk.length;
                  }
                  const raw = new TextDecoder().decode(joined);
                  if (/^\uFEFF?WEBVTT(?:\s|$)/.test(raw)) vtt = raw;
                } finally {
                  clearTimeout(timer);
                }
              } catch {
                /* Native cue access below can still succeed without an extra request. */
              }
            }
          }
          if (!vtt && !track.cues?.length) {
            const cueDeadline = Math.min(deadline, Date.now() + 800);
            while (Date.now() < cueDeadline && !track.cues?.length)
              await wait(80);
          }
          if (vtt)
            tracks.push({
              key: `${mi}:${ti}`,
              label: track.label || track.language || "Captions",
              language: track.language,
              vtt,
            });
          else if (track.cues?.length) {
            if (track.cues.length > 50000) {
              warnings.push("A caption track is too large to export.");
              continue;
            }
            const cues = Array.from(track.cues).map((c, i) => {
              const text = (c as VTTCue).text || "";
              const voices = [
                ...new Set(
                  [...text.matchAll(/<v(?:\.[^\s>]*)?\s+([^>]+)>/g)].map(
                    (m) => m[1],
                  ),
                ),
              ];
              return {
                id: c.id || String(i + 1),
                start: c.startTime,
                end: c.endTime,
                text,
                ...(voices.length === 1 ? { speaker: voices[0] } : {}),
              };
            });
            tracks.push({
              key: `${mi}:${ti}`,
              label: track.label || track.language || "Captions",
              language: track.language,
              cues,
            });
          }
        } finally {
          track.mode = oldMode;
        }
      }
    }
  } finally {
    if (captionMenuTouched && captionButton) {
      if (originalCaption !== undefined) {
        const items = await openCaptionMenu();
        const previous = items.find(
          (e) => e.textContent?.trim() === originalCaption,
        );
        if (previous && previous.getAttribute("aria-checked") !== "true") {
          previous.click();
          await wait(100);
        }
      }
      if (captionMenuWasExpanded) await openCaptionMenu();
      else closeCaptionMenu();
    }
    for (const [track, mode] of originalModes) track.mode = mode;
  }
  const rows = new Map<number, SpeakerRow>();
  const pendingLabels = new Map<number, string>();
  const speakerNames = new Set<string>();
  let sawUnresolvedSpeaker = false;
  let expectedRows = 0;
  let completeRows = false;
  if (isStream && options.speakers && tracks.length) {
    const opened = transcriptButton?.getAttribute("aria-expanded") === "false";
    const previousPanel = opened
      ? transcriptButton
          ?.closest('[role="menubar"]')
          ?.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')
      : undefined;
    let scroller: HTMLElement | undefined;
    let oldScroll = 0;
    try {
      if (opened) {
        transcriptButton!.click();
        const panelDeadline = Date.now() + 3500;
        while (
          Date.now() < panelDeadline &&
          !document.getElementById("entry-1")
        )
          await wait(100);
      }
      const readRows = () => {
        for (const el of document.querySelectorAll<HTMLElement>(
          '[id^="entry-"]',
        )) {
          if (!/^entry-\d+$/.test(el.id)) continue;
          const child = el.querySelector<HTMLElement>('[id^="sub-entry-"]');
          if (!child) continue;
          const total = Number(child.getAttribute("aria-setsize"));
          if (total > 0 && total <= 50000)
            expectedRows = Math.max(expectedRows, total);
          const index = Number(el.id.slice(6));
          const text = child.textContent || "";
          if (text.length > 100000) continue;
          const header = document.getElementById(`itemHeader-${index}`);
          const timeNode = document.getElementById(`Header-timestamp-${index}`);
          const nameNode =
            header &&
            Array.from(header.children).find(
              (e) =>
                e !== timeNode &&
                !e.contains(timeNode) &&
                e.tagName === "SPAN" &&
                !e.hasAttribute("aria-hidden"),
            );
          const speaker = nameNode?.textContent?.trim().slice(0, 200);
          const start = timeNode
            ? clockTime(timeNode.textContent || "")
            : undefined;
          const label = (el.getAttribute("aria-label") || "")
            .trim()
            .slice(0, 500);
          if (speaker) {
            speakerNames.add(speaker);
            // Learn the site's own unit wording from a row with a numeric timestamp.
            if (start !== undefined && label.startsWith(speaker)) {
              const parts = durationParts(label.slice(speaker.length));
              const h = Math.floor(start / 3600),
                m = Math.floor(start / 60) % 60,
                sec = Math.floor(start) % 60;
              const expected =
                parts.length === 3
                  ? [h, m, sec]
                  : parts.length === 2
                    ? [m, sec]
                    : [sec];
              const scales =
                parts.length === 3
                  ? [3600, 60, 1]
                  : parts.length === 2
                    ? [60, 1]
                    : [1];
              if (
                (!h || parts.length === 3) &&
                (parts.length !== 1 || (!h && !m)) &&
                parts.length &&
                parts.length <= 3 &&
                parts.every((p, i) => p.value === expected[i])
              )
                parts.forEach((p, i) => addUnit(p.unit, scales[i]));
            }
          }
          rows.set(index, {
            index,
            text,
            ...(speaker ? { speaker } : {}),
            ...(start !== undefined ? { start } : {}),
          });
          if (label) pendingLabels.set(index, label);
        }
      };
      readRows();
      let parent = (
        document.getElementById("entry-1") ||
        document.querySelector('[id^="entry-"]')
      )?.parentElement;
      while (parent && parent !== document.body) {
        if (
          parent.scrollHeight > parent.clientHeight + 5 &&
          /(auto|scroll)/.test(getComputedStyle(parent).overflowY)
        ) {
          scroller = parent;
          break;
        }
        parent = parent.parentElement;
      }
      if (scroller) {
        oldScroll = scroller.scrollTop;
        scroller.scrollTop = 0;
        await wait(120);
        readRows();
        let stableEnd = 0;
        for (let step = 0; step < 220 && Date.now() < deadline; step++) {
          readRows();
          if (expectedRows && rows.size >= expectedRows) break;
          const before = scroller.scrollTop;
          scroller.scrollTop = Math.min(
            scroller.scrollHeight,
            before + Math.max(80, scroller.clientHeight * 0.55),
          );
          await wait(110);
          readRows();
          if (Math.abs(scroller.scrollTop - before) < 2) {
            if (++stableEnd >= 3) break;
          } else stableEnd = 0;
        }
      }
      completeRows =
        expectedRows > 0 &&
        rows.size === expectedRows &&
        Array.from({ length: expectedRows }, (_, i) => i).every((i) =>
          rows.has(i),
        );
      if (!completeRows && rows.size)
        warnings.push(
          "Some speaker labels could not be loaded. Unmatched captions remain unnamed.",
        );
      if (!rows.size)
        warnings.push("Speaker labels are not exposed by this page.");
    } finally {
      if (scroller) scroller.scrollTop = oldScroll;
      if (opened && transcriptButton?.getAttribute("aria-expanded") === "true")
        transcriptButton.click();
      if (
        previousPanel &&
        previousPanel.getAttribute("aria-expanded") !== "true"
      )
        previousPanel.click();
    }
  }
  const names = [...speakerNames].sort((a, b) => b.length - a.length);
  for (const row of rows.values()) {
    const label = pendingLabels.get(row.index) || "";
    if (!row.speaker)
      row.speaker = names.find(
        (name) =>
          label.startsWith(name) && /^\s/.test(label.slice(name.length)),
      );
    if (row.start === undefined && row.speaker && label.startsWith(row.speaker))
      row.start = localizedTime(label.slice(row.speaker.length));
    if (label && (row.start === undefined || !row.speaker))
      sawUnresolvedSpeaker = true;
  }
  if (sawUnresolvedSpeaker)
    warnings.push(
      "Some speaker metadata could not be verified. Those captions keep existing voice tags or remain unnamed.",
    );
  if (!tracks.length)
    warnings.push(
      "No readable captions found. Turn captions on in the player, then refresh GetTranscript. For an embedded video, open its original page.",
    );
  return {
    title,
    provider: isStream ? "Microsoft Stream" : "HTML5 video",
    tracks,
    rows: [...rows.values()].sort((a, b) => a.index - b.index),
    expectedRows,
    completeRows,
    warnings,
  };
}
