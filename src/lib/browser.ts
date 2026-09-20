import { collectPage } from "../extractor/collect";
import { matchSpeakers, parseVtt, plainText, validateCues } from "./transcript";
import type { PageCapture, Transcript } from "./types";

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

export async function captureTab(tabId: number): Promise<PageCapture> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.id || isRestrictedPage(tab.url || "")) throw new PageAccessError();
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
