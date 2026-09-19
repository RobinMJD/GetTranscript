import { collectPage } from "../extractor/collect";
import { matchSpeakers, parseVtt, plainText, validateCues } from "./transcript";
import type { PageCapture, Transcript } from "./types";

export async function captureActiveTab(): Promise<PageCapture> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:\/\//.test(tab.url || ""))
    throw new Error(
      "Open a video page in a regular browser tab, then try again.",
    );
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: collectPage,
    args: [{ speakers: true, prepare: true }],
  });
  const result = injection?.result;
  if (
    !result ||
    !Array.isArray(result.tracks) ||
    !Array.isArray(result.rows) ||
    result.tracks.length > 150 ||
    result.rows.length > 50000
  )
    throw new Error("The page did not return a usable transcript.");
  return result;
}
export function prepareTranscript(
  capture: PageCapture,
  key: string,
): Transcript {
  const track = capture.tracks.find((t) => t.key === key);
  if (!track) throw new Error("Choose an available caption language.");
  const cues = track.vtt
    ? parseVtt(track.vtt)
    : validateCues(
        (track.cues || []).map((c) => ({ ...c, text: plainText(c.text) })),
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
export async function saveDownload(
  text: string,
  mime: string,
  filename: string,
): Promise<void> {
  if (text.length > 8_000_000)
    throw new Error("This export is too large to save from the popup.");
  const id = await chrome.downloads.download({
    url: `data:${mime};charset=utf-8,${encodeURIComponent(text)}`,
    filename,
    conflictAction: "uniquify",
    saveAs: false,
  });
  // A data URL survives popup closure; never keep a fragile popup-owned blob alive.
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const [item] = await chrome.downloads.search({ id });
    if (item?.state === "complete") return;
    if (item?.state === "interrupted")
      throw new Error(
        "The browser interrupted the download. Check Downloads and try again.",
      );
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(
    "The download has started. Check your browser Downloads for its final status.",
  );
}
