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
  if (isStream && options.prepare)
    for (
      let n = 0;
      n < 60 &&
      !Array.from(document.querySelectorAll("video,audio")).some(
        (m) => (m as HTMLMediaElement).textTracks.length,
      );
      n++
    )
      await wait(100);
  const title = (
    document.querySelector('[id="shellDocumentTitle"]')?.textContent ||
    document.title ||
    "Transcript"
  )
    .replace(/\s*[-–]\s*(View-only|Lecture seule).*$/i, "")
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
  let restoreCaption: (() => void) | undefined;
  // Stream creates its caption blob only after selecting a caption language.
  if (
    isStream &&
    options.prepare &&
    !document.querySelector('track[src^="blob:"]')
  ) {
    const captionButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'),
    ).find((b) =>
      /^(Captions|Sous-titres)$/i.test(b.getAttribute("aria-label") || ""),
    );
    if (captionButton) {
      const wasExpanded =
        captionButton.getAttribute("aria-expanded") === "true";
      if (!wasExpanded) captionButton.click();
      await wait(160);
      const items = Array.from(
        document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
      );
      const previous = items.find(
        (e) => e.getAttribute("aria-checked") === "true",
      );
      const labels = media.flatMap((m) =>
        Array.from(m.textTracks).map((t) => t.label),
      );
      const language = items.find((e) =>
        labels.includes(e.textContent?.trim() || ""),
      );
      if (language) {
        language.click();
        restoreCaption = () => {
          if (previous && previous !== language) {
            captionButton.click();
            const old = Array.from(
              document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
            ).find((e) => e.textContent === previous.textContent);
            old?.click();
          } else if (
            !wasExpanded &&
            captionButton.getAttribute("aria-expanded") === "true"
          )
            captionButton.click();
        };
        for (
          let n = 0;
          n < 40 && !document.querySelector('track[src^="blob:"]');
          n++
        )
          await wait(100);
      } else if (!wasExpanded) captionButton.click();
    }
  }
  try {
    for (let mi = 0; mi < media.length; mi++) {
      const element = media[mi];
      const native = Array.from(element.textTracks)
        .filter((t) => ["captions", "subtitles"].includes(t.kind))
        .slice(0, 12);
      for (let ti = 0; ti < native.length; ti++) {
        if (Date.now() > deadline) break;
        const track = native[ti];
        if (/Shaka Player TextTrack/i.test(track.label)) continue;
        const oldMode = track.mode;
        try {
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
          if (!vtt && !track.cues?.length)
            for (let n = 0; n < 10 && !track.cues?.length; n++) await wait(80);
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
    restoreCaption?.();
  }
  const rows = new Map<number, SpeakerRow>();
  let expectedRows = 0;
  let completeRows = false;
  if (isStream && options.speakers && tracks.length) {
    const transcriptButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'),
    ).find((b) =>
      /^(Transcript|Transcription)$/i.test(b.getAttribute("aria-label") || ""),
    );
    const opened = transcriptButton?.getAttribute("aria-expanded") === "false";
    let scroller: HTMLElement | undefined;
    let oldScroll = 0;
    try {
      if (opened) {
        transcriptButton!.click();
        for (let n = 0; n < 35 && !document.getElementById("entry-1"); n++)
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
          rows.set(index, {
            index,
            label: (el.getAttribute("aria-label") || "").slice(0, 500),
            text,
          });
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
    }
  }
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
