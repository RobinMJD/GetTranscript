import { collectPage } from "../extractor/collect";
import { collectStreamPage } from "../extractor/stream";
import { matchSpeakers, parseVtt, plainText, validateCues } from "./transcript";
import type { PageCapture, SpeakerRow, Transcript } from "./types";

export class PageAccessError extends Error {
  constructor() {
    super(
      "Open the original video in a regular browser tab, then open GetTranscript again. Browser settings and extension Store pages cannot be read.",
    );
    this.name = "PageAccessError";
  }
}
export function isRestrictedPage(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      !["https:", "http:"].includes(url.protocol) ||
      url.hostname === "chromewebstore.google.com" ||
      (url.hostname === "chrome.google.com" &&
        /^\/webstore(?:\/|$)/.test(url.pathname)) ||
      (url.hostname === "microsoftedge.microsoft.com" &&
        /^\/addons(?:\/|$)/.test(url.pathname))
    );
  } catch {
    return true;
  }
}

function sourceIdentity(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  if (/\/stream\.aspx$/i.test(url.pathname) && url.searchParams.has("id")) {
    const id = url.searchParams.get("id")!;
    url.search = "";
    url.searchParams.set("id", id);
  }
  return url.href;
}

/** Validate MAIN-world data before it can be merged, resumed, or checkpointed. */
function validateCapture(value: unknown): asserts value is PageCapture {
  function fail(): never {
    throw new Error("The page returned invalid or oversized caption metadata.");
  }
  const record = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const text = (v: unknown, max: number): v is string =>
    typeof v === "string" && v.length <= max;
  const count = (v: unknown): v is number =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 50000;
  const time = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 360000;
  if (
    !record(value) ||
    !text(value.title, 250) ||
    !text(value.provider, 100) ||
    !Array.isArray(value.tracks) ||
    value.tracks.length > 150 ||
    !Array.isArray(value.rows) ||
    value.rows.length > 50000 ||
    !count(value.expectedRows) ||
    typeof value.completeRows !== "boolean" ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 100 ||
    !value.warnings.every((warning) => text(warning, 2000)) ||
    (value.sourceUrl !== undefined && !text(value.sourceUrl, 16384)) ||
    (value.duration !== undefined &&
      (!time(value.duration) || value.duration <= 0))
  )
    fail();
  let captionSize = 0;
  const trackKeys = new Set<string>();
  for (const track of value.tracks) {
    if (
      !record(track) ||
      !text(track.key, 200) ||
      trackKeys.has(track.key) ||
      !text(track.label, 1000) ||
      !text(track.language, 100) ||
      (track.textFormat !== undefined && track.textFormat !== "plain")
    )
      fail();
    trackKeys.add(track.key);
    if (track.vtt !== undefined) {
      if (!text(track.vtt, 5_000_000)) fail();
      captionSize += track.vtt.length;
    }
    if (track.cues !== undefined) {
      if (!Array.isArray(track.cues) || track.cues.length > 50000) fail();
      for (const cue of track.cues) {
        if (
          !record(cue) ||
          !text(cue.id, 1000) ||
          !text(cue.text, 100000) ||
          !time(cue.start) ||
          !time(cue.end) ||
          cue.end <= cue.start ||
          (cue.speaker !== undefined && !text(cue.speaker, 200))
        )
          fail();
        captionSize +=
          cue.text.length +
          cue.id.length +
          (typeof cue.speaker === "string" ? cue.speaker.length : 0);
        if (captionSize > 5_000_000) fail();
      }
    }
    if (captionSize > 5_000_000) fail();
  }
  let rowSize = 0;
  const indexes = new Set<number>();
  for (const row of value.rows) {
    if (
      !record(row) ||
      !count(row.index) ||
      row.index >= 50000 ||
      indexes.has(row.index) ||
      !text(row.text, 100000) ||
      (row.speaker !== undefined && !text(row.speaker, 200)) ||
      (row.start !== undefined && !time(row.start))
    )
      fail();
    indexes.add(row.index);
    rowSize += row.text.length;
    if (rowSize > 5_000_000) fail();
  }
  if (value.linkedRecordings !== undefined) {
    if (
      !Array.isArray(value.linkedRecordings) ||
      value.linkedRecordings.length > 100
    )
      fail();
    for (const link of value.linkedRecordings) {
      if (!record(link) || !text(link.url, 16384) || !text(link.title, 250))
        fail();
      try {
        const url = new URL(link.url);
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          fail();
      } catch {
        fail();
      }
    }
  }
  if (value.rowCursor !== undefined) {
    const cursor = value.rowCursor;
    if (
      !record(cursor) ||
      !text(cursor.sourceUrl, 16384) ||
      (value.sourceUrl !== undefined && cursor.sourceUrl !== value.sourceUrl) ||
      typeof cursor.nextScrollTop !== "number" ||
      !Number.isFinite(cursor.nextScrollTop) ||
      cursor.nextScrollTop < 0 ||
      !count(cursor.expectedRows) ||
      (cursor.startedAt !== undefined &&
        (typeof cursor.startedAt !== "number" ||
          !Number.isSafeInteger(cursor.startedAt) ||
          cursor.startedAt < 0))
    )
      fail();
    for (const name of ["speakerNames", "ambiguousUnits"] as const) {
      const values = cursor[name];
      if (
        values !== undefined &&
        (!Array.isArray(values) ||
          values.length > 1000 ||
          !values.every((item) => text(item, 500)))
      )
        fail();
    }
    if (
      cursor.timeUnits !== undefined &&
      (!Array.isArray(cursor.timeUnits) ||
        cursor.timeUnits.length > 1000 ||
        !cursor.timeUnits.every(
          (entry) =>
            Array.isArray(entry) &&
            entry.length === 2 &&
            text(entry[0], 500) &&
            [1, 60, 3600].includes(entry[1]),
        ))
    )
      fail();
  }
}

/** A mounted track can still be empty while the player loads its captions. */
function hasUsableCaptions(capture: PageCapture): boolean {
  return capture.tracks.some((track) => {
    try {
      return track.vtt
        ? parseVtt(track.vtt).length > 0
        : validateCues(
            (track.cues || []).map((cue) => ({
              ...cue,
              text:
                track.textFormat === "plain" ? cue.text : plainText(cue.text),
            })),
          ).length > 0;
    } catch {
      return false;
    }
  });
}

export async function captureTab(
  tabId: number,
  onProgress?: (capture: PageCapture) => Promise<void>,
  shouldContinue?: () => Promise<boolean>,
  initialCapture?: PageCapture,
): Promise<PageCapture> {
  const changedRecording = () =>
    new Error(
      "The recording changed while reading. Refresh to read the current video.",
    );
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.id || isRestrictedPage(tab.url || "")) throw new PageAccessError();
  const source = sourceIdentity(tab.url!);
  const checkSource = async () => {
    const current = await chrome.tabs.get(tabId);
    if (!current?.id || !current.url) throw new PageAccessError();
    if (sourceIdentity(current.url) !== source) throw changedRecording();
  };
  const checkContinue = async () => {
    if (shouldContinue && !(await shouldContinue()))
      throw new Error("Reading was canceled.");
  };
  if (initialCapture?.sourceUrl && initialCapture.sourceUrl !== source)
    throw changedRecording();
  if (initialCapture) validateCapture(initialCapture);
  const page = new URL(source);
  const isStream =
    /(^|\.)sharepoint\.(com|us|de|cn)$/.test(page.hostname) &&
    /\/stream\.aspx$/i.test(page.pathname);
  const waitForStream =
    isStream &&
    page.protocol === "https:" &&
    !!page.searchParams.get("id")?.trim();
  // ReadyState complete only describes the shell. Stream may mount the player,
  // its Transcript control and caption requests considerably later. Retry from
  // the worker so a hidden page's rendering/timers do not drive readiness.
  const startupDeadline = Date.now() + 45_000;
  const startupTimeout = () =>
    new Error(
      "Captions are not ready after waiting for this recording. Open the video tab, click Transcript, then retry this part.",
    );
  // An earlier attempt may have saved the player before its tracks loaded.
  // Never resume that empty snapshot or let it suppress a fresh direct read.
  let capture =
    initialCapture && hasUsableCaptions(initialCapture)
      ? initialCapture
      : undefined;
  // Paused time does not consume a resumed operation's active collection budget.
  // Every chunk in this invocation still shares this single bounded deadline.
  let deadline = Date.now() + 10 * 60_000;
  const rows = new Map<number, SpeakerRow>(
    capture?.rows.map((row) => [row.index, row]) || [],
  );
  let rowTextSize = [...rows.values()].reduce(
    (sum, row) => sum + row.text.length,
    0,
  );
  const incompleteWarning =
    "Some speaker labels could not be loaded. Unmatched captions remain unnamed.";
  while (!capture || capture.rowCursor) {
    await checkContinue();
    await checkSource();
    if (!capture && isStream) {
      if (waitForStream && startupDeadline - Date.now() < 1000)
        throw startupTimeout();
      // Structured entries include the player's own speaker names and do not
      // depend on rendering thousands of virtualized rows in a visible tab.
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: collectStreamPage,
        args: [
          {
            timeoutMs: waitForStream
              ? Math.min(18_000, startupDeadline - Date.now())
              : 18_000,
          },
        ],
      });
      await checkSource();
      const direct = injection?.result;
      if (direct) {
        validateCapture(direct);
        if (direct.sourceUrl !== source) throw changedRecording();
        if (hasUsableCaptions(direct)) {
          if (onProgress) await onProgress(direct);
          await checkContinue();
          return direct;
        }
      }
      await checkContinue();
      if (waitForStream && startupDeadline - Date.now() < 1000)
        throw startupTimeout();
    }
    if (Date.now() >= deadline || rows.size >= 50000) {
      if (!capture)
        throw new Error("The page did not return a usable transcript.");
      capture = {
        ...capture,
        rowCursor: undefined,
        warnings: [
          ...new Set([
            ...capture.warnings,
            "Speaker collection reached its time or size limit. The available captions are kept; unmatched captions remain unnamed.",
          ]),
        ],
      };
      if (onProgress) await onProgress(capture);
      break;
    }
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: collectPage,
      args: [
        {
          speakers: true,
          prepare: !capture,
          ...(!capture && waitForStream
            ? { timeoutMs: Math.min(18_000, startupDeadline - Date.now()) }
            : {}),
          ...(capture?.rowCursor ? { resume: capture.rowCursor } : {}),
        },
      ],
    });
    await checkSource();
    const result = injection?.result;
    if (result?.sourceUrl !== source) throw changedRecording();
    validateCapture(result);
    if (!capture && !hasUsableCaptions(result)) {
      // Empty initialization results are not durable checkpoints: the next
      // attempt must discover both native tracks and structured metadata anew.
      await checkContinue();
      if (!waitForStream) return result;
      if (Date.now() >= startupDeadline) throw startupTimeout();
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(1000, startupDeadline - Date.now())),
      );
      continue;
    }
    if (!capture) deadline = Date.now() + 10 * 60_000;
    let rowLimitReached = false;
    for (const row of result.rows) {
      if (
        !Number.isSafeInteger(row.index) ||
        row.index < 0 ||
        row.index >= 50000
      )
        throw new Error("The page returned invalid transcript rows.");
      const existing = rows.get(row.index);
      const newSize =
        rowTextSize + row.text.length - (existing?.text.length || 0);
      if (newSize > 5_000_000) {
        rowLimitReached = true;
        break;
      }
      rowTextSize = newSize;
      if (
        existing &&
        (existing.text !== row.text ||
          (existing.speaker &&
            row.speaker &&
            existing.speaker !== row.speaker) ||
          (existing.start !== undefined &&
            row.start !== undefined &&
            existing.start !== row.start))
      )
        throw new Error(
          "The transcript changed while reading. Refresh to try again.",
        );
      rows.set(row.index, { ...existing, ...row });
    }
    const expectedRows = Math.max(
      capture?.expectedRows || 0,
      result.expectedRows,
    );
    const completeRows =
      expectedRows > 0 &&
      rows.size === expectedRows &&
      Array.from({ length: expectedRows }, (_, i) => i).every((i) =>
        rows.has(i),
      );
    const warnings = [
      ...new Set([...(capture?.warnings || []), ...result.warnings]),
    ].filter((warning) => !(completeRows && warning === incompleteWarning));
    if (rowLimitReached)
      warnings.push(
        "Speaker collection reached its size limit. The available captions are kept; unmatched captions remain unnamed.",
      );
    capture = {
      ...result,
      tracks: capture?.tracks || result.tracks,
      duration: capture?.duration ?? result.duration,
      linkedRecordings: capture?.linkedRecordings || result.linkedRecordings,
      rows: [...rows.values()].sort((a, b) => a.index - b.index),
      expectedRows,
      completeRows,
      warnings,
      rowCursor: completeRows || rowLimitReached ? undefined : result.rowCursor,
    };
    // Keep the just-finished chunk when Pause arrives during an injection.
    if (onProgress) await onProgress(capture);
    if (shouldContinue && !(await shouldContinue()))
      throw new Error("Reading was canceled.");
  }
  const availabilityWarning = capture.warnings.find((warning) =>
    warning.startsWith(
      "This player has not exposed captions in the background.",
    ),
  );
  if (!capture.tracks.length && availabilityWarning)
    throw new Error(availabilityWarning);
  return capture;
}
export function prepareTranscript(
  capture: PageCapture,
  key: string,
): Transcript {
  const track = capture.tracks.find((t) => t.key === key);
  if (!track) throw new Error("Choose an available caption track.");
  const cues = track.vtt
    ? parseVtt(track.vtt)
    : validateCues(
        (track.cues || []).map((c) => ({
          ...c,
          text: track.textFormat === "plain" ? c.text : plainText(c.text),
        })),
      );
  const result = matchSpeakers(cues, capture.rows);
  const warnings = [...capture.warnings];
  if (result.matched > 0 && result.matched < result.total)
    warnings.push(
      `${result.matched} of ${result.total} captions have verified speaker labels. Unmatched captions remain unnamed.`,
    );
  return {
    title: String(capture.title || "Transcript").slice(0, 250),
    provider: String(capture.provider || "Video").slice(0, 100),
    language: String(track.language || "").slice(0, 30),
    cues: result.cues,
    warnings,
  };
}
export async function startDownload(
  text: string,
  mime: string,
  filename: string,
): Promise<number> {
  if (text.length > 8_000_000)
    throw new Error("This export is too large to save.");
  return chrome.downloads.download({
    url: `data:${mime};charset=utf-8,${encodeURIComponent(text)}`,
    filename,
    conflictAction: "uniquify",
    saveAs: false,
  });
}
