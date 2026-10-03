import type {
  PageCapture,
  RawTrack,
  RowCursor,
  SpeakerRow,
} from "../lib/types";

/** Self-contained: Chrome serializes this function into the active page's MAIN world. */
export async function collectPage(options: {
  speakers: boolean;
  prepare: boolean;
  resume?: RowCursor;
  timeoutMs?: number;
}): Promise<PageCapture> {
  const background = () => document.visibilityState === "hidden";
  const wait = (ms: number) =>
    background()
      ? Promise.resolve()
      : new Promise<void>((r) => setTimeout(r, ms));
  const startedAt = options.resume?.startedAt || Date.now();
  // Leave two seconds for restoring controls before this bounded chunk returns.
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1000, Math.min(18000, options.timeoutMs!))
    : 18000;
  const deadline = Date.now() + timeoutMs;
  const warnings: string[] = [];
  const canonicalSource = (raw: string) => {
    const url = new URL(raw, location.href);
    url.hash = "";
    if (/\/stream\.aspx$/i.test(url.pathname) && url.searchParams.has("id")) {
      const id = url.searchParams.get("id")!;
      url.search = "";
      url.searchParams.set("id", id);
    }
    return url.href;
  };
  const sourceUrl = canonicalSource(location.href);
  const sameSource = () => {
    try {
      return canonicalSource(location.href) === sourceUrl;
    } catch {
      return false;
    }
  };
  if (options.resume && options.resume.sourceUrl !== sourceUrl)
    throw new Error(
      "The recording changed while reading. Refresh to read the current video.",
    );
  const isStream =
    /(^|\.)sharepoint\.(com|us|de|cn)$/.test(location.hostname) &&
    /\/stream\.aspx$/i.test(location.pathname);
  // Match stable control identifiers and relationships, never translated labels.
  const buttons = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        'button,[role="button"],[role="menuitem"],[role="tab"]',
      ),
    );
  const transcriptRows = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '[id^="entry-"] [id^="sub-entry-"]',
      ),
    ).find((row) => row.getClientRects().length);
  const controlledPanel = (button: HTMLElement) =>
    (button.getAttribute("aria-controls") || "")
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .find(Boolean);
  const findTranscriptButton = () =>
    buttons().find((button) => {
      if (button.querySelector('[data-icon-name="SlideText"]')) return true;
      const controls = button.getAttribute("aria-controls") || "";
      if (/transcript/i.test(controls)) return true;
      return [
        button.id,
        button.getAttribute("data-automation-id"),
        button.getAttribute("data-testid"),
      ].some((id) =>
        /^(?:transcript(?:button|tab|toggle|menuitem)|(?:open|show|toggle)transcript)$/i.test(
          (id || "").replace(/[-_]/g, ""),
        ),
      );
    });
  const selected = (button: HTMLElement) =>
    ["aria-expanded", "aria-selected", "aria-pressed"].some(
      (name) => button.getAttribute(name) === "true",
    );
  const panelOpen = (button: HTMLElement) => {
    const panel = controlledPanel(button);
    return (
      selected(button) ||
      !!(
        panel &&
        !panel.hidden &&
        panel.getAttribute("aria-hidden") !== "true" &&
        panel.getClientRects().length
      )
    );
  };
  let transcriptButton = findTranscriptButton();
  const hasPlayerSignal = () =>
    document.readyState !== "complete" ||
    !!document.querySelector(
      'video,audio,[aria-busy="true"],[role="progressbar"],[data-automation-id="videoPlayer"]',
    ) ||
    !!findTranscriptButton();
  let mayMountPlayer = hasPlayerSignal();
  let openedTranscript = false;
  let previousPanel: HTMLElement | undefined;
  const waitUntil = async (ready: () => unknown, until: number) => {
    if (!sameSource() || ready() || Date.now() >= until) return;
    // Track cues can arrive without a DOM mutation. Observe structural changes
    // and sample track readiness, including when the tab becomes hidden mid-read.
    await new Promise<void>((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout>;
      let sampler: ReturnType<typeof setInterval>;
      const finish = () => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timeout);
        clearInterval(sampler);
        resolve();
      };
      const check = () => {
        if (!sameSource() || ready() || Date.now() >= until) finish();
      };
      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
      });
      timeout = setTimeout(finish, Math.max(1, until - Date.now()));
      sampler = setInterval(check, 250);
      check();
    });
  };
  const readableTracks = () =>
    Array.from(document.querySelectorAll<HTMLMediaElement>("video,audio")).some(
      (media) =>
        Array.from(media.textTracks).some(
          (track) =>
            ["captions", "subtitles"].includes(track.kind) &&
            !/Shaka Player TextTrack/i.test(track.label) &&
            (track.cues?.length ||
              Array.from(media.querySelectorAll("track")).some(
                (element) => element.track === track && element.src,
              )),
        ),
    );
  const prepareTranscriptPanel = async () => {
    if (
      !isStream ||
      !mayMountPlayer ||
      (!options.prepare && !options.speakers) ||
      transcriptRows()
    )
      return;
    // A generic player without a recording identity can already have usable
    // captions. Only identified Stream recordings need the longer cold-panel wait.
    if (
      !new URL(sourceUrl).searchParams.has("id") &&
      !findTranscriptButton() &&
      readableTracks()
    )
      return;
    const panelDeadline = Math.min(deadline, Date.now() + 12000);
    const controlDeadline = Math.min(panelDeadline, Date.now() + 6000);
    await waitUntil(() => {
      transcriptButton = findTranscriptButton();
      return (
        transcriptRows() ||
        (transcriptButton &&
          !transcriptButton.hasAttribute("disabled") &&
          transcriptButton.getAttribute("aria-disabled") !== "true")
      );
    }, controlDeadline);
    if (
      transcriptRows() ||
      !sameSource() ||
      Date.now() >= deadline ||
      !transcriptButton ||
      transcriptButton.hasAttribute("disabled") ||
      transcriptButton.getAttribute("aria-disabled") === "true"
    )
      return;
    if (!panelOpen(transcriptButton)) {
      previousPanel = Array.from(
        transcriptButton
          .closest('[role="menubar"],[role="tablist"],nav')
          ?.querySelectorAll<HTMLElement>(
            'button,[role="button"],[role="tab"]',
          ) || [],
      ).find((button) => button !== transcriptButton && panelOpen(button));
      transcriptButton.click();
      openedTranscript = true;
      // React can commit synchronous activation in a microtask, including hidden tabs.
      await Promise.resolve();
    }
    await waitUntil(() => transcriptRows() || readableTracks(), panelDeadline);
  };
  const restoreTranscriptPanel = () => {
    if (!sameSource()) return;
    const current = transcriptButton?.isConnected
      ? transcriptButton
      : findTranscriptButton();
    if (openedTranscript && current && (panelOpen(current) || transcriptRows()))
      current.click();
    if (previousPanel?.isConnected && !panelOpen(previousPanel))
      previousPanel.click();
  };
  const findCaptionButton = () =>
    buttons().find(
      (button) =>
        button.querySelector('[data-icon-name="ClosedCaptions"]') ||
        Array.from(button.querySelectorAll("svg path")).some((path) => {
          const d = path.getAttribute("d") || "";
          return d.includes("ZM5.5 12c0-3.15") && d.includes("Zm7.5 0c0-3.15");
        }),
    );
  let captionButton = findCaptionButton();
  const initialTrackModes = new Map(
    Array.from(
      document.querySelectorAll<HTMLMediaElement>("video,audio"),
    ).flatMap((media) =>
      Array.from(media.textTracks).map((track) => [track, track.mode] as const),
    ),
  );
  try {
    // Some players mount just after document completion, without a loading
    // indicator. Give that initial mount one short shared window.
    if (isStream && options.prepare && !options.resume && !mayMountPlayer) {
      await waitUntil(
        () => {
          mayMountPlayer = hasPlayerSignal();
          return mayMountPlayer;
        },
        Math.min(deadline, Date.now() + 1000),
      );
    }
    // Opening the panel can be what creates the first caption track on a cold page.
    if (isStream && mayMountPlayer && options.prepare && !options.resume) {
      await waitUntil(
        () =>
          findTranscriptButton() ||
          Array.from(
            document.querySelectorAll<HTMLMediaElement>("video,audio"),
          ).some((media) => media.textTracks.length),
        Math.min(deadline, Date.now() + 6000),
      );
    }
    await prepareTranscriptPanel();
    if (isStream && mayMountPlayer && options.prepare && !options.resume) {
      await waitUntil(readableTracks, Math.min(deadline, Date.now() + 6000));
    }
    if (!sameSource())
      throw new Error(
        "The recording changed while reading. Refresh to read the current video.",
      );
    captionButton = findCaptionButton();
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
    const units = new Map<string, number>(options.resume?.timeUnits || []);
    const ambiguousUnits = new Set<string>(
      options.resume?.ambiguousUnits || [],
    );
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
    // A duration is usable only when it belongs to one unambiguous media element.
    const playableMedia = media.filter((element) =>
      Array.from(element.textTracks).some((track) =>
        ["captions", "subtitles"].includes(track.kind),
      ),
    );
    const durationElement =
      playableMedia.length === 1 ? playableMedia[0] : undefined;
    const duration =
      durationElement &&
      Number.isFinite(durationElement.duration) &&
      durationElement.duration > 0 &&
      durationElement.duration <= 360000
        ? durationElement.duration
        : undefined;
    const linkedRecordings = isStream
      ? [
          ...new Map(
            Array.from(
              document.querySelectorAll<HTMLAnchorElement>("a[href]"),
            ).flatMap((anchor) => {
              try {
                const url = new URL(anchor.href, location.href);
                if (
                  url.protocol !== "https:" ||
                  url.origin !== location.origin ||
                  !/\/stream\.aspx$/i.test(url.pathname) ||
                  !url.searchParams.get("id")
                )
                  return [];
                const canonical = canonicalSource(url.href);
                if (canonical === sourceUrl) return [];
                return [
                  [
                    canonical,
                    {
                      url: canonical,
                      title: (anchor.textContent || "Recording")
                        .trim()
                        .slice(0, 250),
                    },
                  ] as const,
                ];
              } catch {
                return [];
              }
            }),
          ).values(),
        ].slice(0, 100)
      : [];
    const tracks: RawTrack[] = [];
    let captionSize = 0;
    let nativeCueCount = 0;
    const sizeWarning = () => {
      const message =
        "Some caption tracks exceed the scan size limit. Those tracks were omitted in full; the available tracks are unchanged.";
      if (!warnings.includes(message)) warnings.push(message);
    };
    const originalModes = new Map(
      media.flatMap((m) =>
        Array.from(m.textTracks).map(
          (t) => [t, initialTrackModes.get(t) ?? t.mode] as const,
        ),
      ),
    );
    let originalCaption: string | undefined;
    let captionMenuWasExpanded = false;
    let captionMenuTouched = false;
    let restorationDeadline = 0;
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
    const openCaptionMenu = async (restoring = false) => {
      if (!captionButton || !sameSource()) return [];
      if (captionButton.getAttribute("aria-expanded") !== "true") {
        captionButton.click();
      }
      const menuDeadline = restoring
        ? restorationDeadline
        : Math.min(deadline, Date.now() + 2000);
      await waitUntil(() => captionItems().length, menuDeadline);
      return sameSource() ? captionItems() : [];
    };
    const closeCaptionMenu = () => {
      if (
        sameSource() &&
        captionButton?.getAttribute("aria-expanded") === "true"
      )
        captionButton.click();
    };
    const prepareTrack = async (
      track: TextTrack,
      element: HTMLMediaElement,
    ) => {
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
      await waitUntil(
        () => trackElement()?.src || track.cues?.length,
        trackDeadline,
      );
      closeCaptionMenu();
    };
    try {
      for (let mi = 0; !options.resume && mi < media.length; mi++) {
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
                  const timer = setTimeout(
                    () => controller.abort(),
                    Math.max(1, Math.min(6000, deadline - Date.now())),
                  );
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
              await waitUntil(() => track.cues?.length, cueDeadline);
            }
            if (vtt) {
              if (captionSize + vtt.length > 5_000_000) {
                sizeWarning();
                continue;
              }
              captionSize += vtt.length;
              tracks.push({
                key: `${mi}:${ti}`,
                label: (track.label || track.language || "Captions").slice(
                  0,
                  1000,
                ),
                language: track.language.slice(0, 100),
                vtt,
              });
            } else if (track.cues?.length) {
              if (
                track.cues.length > 50000 ||
                nativeCueCount + track.cues.length > 100000
              ) {
                sizeWarning();
                continue;
              }
              const cues: NonNullable<RawTrack["cues"]> = [];
              let trackSize = 0;
              let oversized = false;
              for (const c of Array.from(track.cues)) {
                const text = (c as VTTCue).text || "";
                const id = (c.id || String(cues.length + 1)).slice(0, 1000);
                if (
                  text.length > 100000 ||
                  captionSize + trackSize + text.length + id.length > 5_000_000
                ) {
                  oversized = true;
                  break;
                }
                const voices = [
                  ...new Set(
                    [...text.matchAll(/<v(?:\.[^\s>]*)?\s+([^>]+)>/g)].map(
                      (m) => m[1],
                    ),
                  ),
                ];
                const speaker =
                  voices.length === 1 ? voices[0].slice(0, 200) : undefined;
                trackSize += text.length + id.length + (speaker?.length || 0);
                if (captionSize + trackSize > 5_000_000) {
                  oversized = true;
                  break;
                }
                cues.push({
                  id,
                  start: c.startTime,
                  end: c.endTime,
                  text,
                  ...(speaker ? { speaker } : {}),
                });
              }
              if (oversized) {
                sizeWarning();
                continue;
              }
              captionSize += trackSize;
              nativeCueCount += cues.length;
              tracks.push({
                key: `${mi}:${ti}`,
                label: (track.label || track.language || "Captions").slice(
                  0,
                  1000,
                ),
                language: track.language.slice(0, 100),
                cues,
              });
            }
          } finally {
            track.mode = oldMode;
          }
        }
      }
    } finally {
      restorationDeadline = Date.now() + 1500;
      if (sameSource() && captionMenuTouched && captionButton) {
        if (originalCaption !== undefined) {
          const items = await openCaptionMenu(true);
          const previous = items.find(
            (e) => e.textContent?.trim() === originalCaption,
          );
          if (previous && previous.getAttribute("aria-checked") !== "true") {
            previous.click();
            await wait(100);
          }
        }
        if (captionMenuWasExpanded) await openCaptionMenu(true);
        else closeCaptionMenu();
      }
      for (const [track, mode] of originalModes) track.mode = mode;
    }
    const rows = new Map<number, SpeakerRow>();
    let rowTextSize = 0;
    let rowLimitReached = false;
    const pendingLabels = new Map<number, string>();
    const speakerNames = new Set<string>(options.resume?.speakerNames || []);
    let sawUnresolvedSpeaker = false;
    let expectedRows = options.resume?.expectedRows || 0;
    let completeRows = false;
    let rowCursor: RowCursor | undefined;
    if (isStream && options.speakers && (tracks.length || options.resume)) {
      let scroller: HTMLElement | undefined;
      let oldScroll = 0;
      try {
        const readRows = () => {
          for (const el of document.querySelectorAll<HTMLElement>(
            '[id^="entry-"]',
          )) {
            if (!/^entry-\d+$/.test(el.id)) continue;
            const child = el.querySelector<HTMLElement>('[id^="sub-entry-"]');
            if (!child) continue;
            const total = Number(child.getAttribute("aria-setsize"));
            if (total > 50000) rowLimitReached = true;
            if (Number.isSafeInteger(total) && total > 0 && total <= 50000)
              expectedRows = Math.max(expectedRows, total);
            const index = Number(el.id.slice(6));
            if (
              !Number.isSafeInteger(index) ||
              index < 0 ||
              index >= 50000 ||
              rows.size >= 50000
            )
              continue;
            const text = child.textContent || "";
            if (text.length > 100000) continue;
            const newSize =
              rowTextSize + text.length - (rows.get(index)?.text.length || 0);
            if (newSize > 5_000_000) {
              rowLimitReached = true;
              break;
            }
            rowTextSize = newSize;
            const header = document.getElementById(`itemHeader-${index}`);
            const timeNode = document.getElementById(
              `Header-timestamp-${index}`,
            );
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
        if (scroller) oldScroll = scroller.scrollTop;
        if (scroller && !background()) {
          scroller.scrollTop = options.resume?.nextScrollTop || 0;
          await wait(120);
          readRows();
          let stableEnd = 0;
          let reachedEnd = false;
          for (
            ;
            Date.now() < deadline &&
            !background() &&
            rows.size < 50000 &&
            rowTextSize < 2_000_000 &&
            !rowLimitReached;
          ) {
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
              if (++stableEnd >= 3) {
                reachedEnd = true;
                break;
              }
            } else stableEnd = 0;
          }
          if (
            !reachedEnd &&
            !background() &&
            !(expectedRows && rows.size >= expectedRows) &&
            rows.size < 50000 &&
            !rowLimitReached
          )
            rowCursor = {
              sourceUrl,
              nextScrollTop: scroller.scrollTop,
              expectedRows,
              startedAt,
            };
        }
        completeRows =
          expectedRows > 0 &&
          rows.size === expectedRows &&
          Array.from({ length: expectedRows }, (_, i) => i).every((i) =>
            rows.has(i),
          );
        if (background() && !completeRows)
          warnings.push(
            "This player pauses speaker rows in background tabs. Available captions are kept; open the video tab and refresh to read any missing speaker names.",
          );
        if (!completeRows && rows.size && !rowCursor)
          warnings.push(
            "Some speaker labels could not be loaded. Unmatched captions remain unnamed.",
          );
        if (!rows.size && !rowCursor)
          warnings.push("Speaker labels are not exposed by this page.");
      } finally {
        if (sameSource() && scroller) scroller.scrollTop = oldScroll;
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
      if (
        row.start === undefined &&
        row.speaker &&
        label.startsWith(row.speaker)
      )
        row.start = localizedTime(label.slice(row.speaker.length));
      if (label && (row.start === undefined || !row.speaker))
        sawUnresolvedSpeaker = true;
    }
    if (sawUnresolvedSpeaker)
      warnings.push(
        "Some speaker metadata could not be verified. Those captions keep existing voice tags or remain unnamed.",
      );
    if (rowCursor) {
      rowCursor.speakerNames = [...speakerNames];
      rowCursor.timeUnits = [...units];
      rowCursor.ambiguousUnits = [...ambiguousUnits];
    }
    if (rowLimitReached)
      warnings.push(
        "Speaker collection reached its size limit. The available captions are kept; unmatched captions remain unnamed.",
      );
    if (!tracks.length && !options.resume)
      warnings.push(
        isStream && background()
          ? "This player has not exposed captions in the background. Open the video tab and refresh; GetTranscript will open its transcript panel automatically."
          : "No readable captions found. Turn captions on in the player, then refresh GetTranscript. For an embedded video, open its original page.",
      );
    if (canonicalSource(location.href) !== sourceUrl)
      throw new Error(
        "The recording changed while reading. Refresh to read the current video.",
      );
    return {
      title,
      provider: isStream ? "Microsoft Stream" : "HTML5 video",
      tracks,
      rows: [...rows.values()].sort((a, b) => a.index - b.index),
      expectedRows,
      completeRows,
      warnings,
      sourceUrl,
      ...(duration !== undefined ? { duration } : {}),
      ...(linkedRecordings.length ? { linkedRecordings } : {}),
      ...(rowCursor ? { rowCursor } : {}),
    };
  } finally {
    restoreTranscriptPanel();
  }
}
