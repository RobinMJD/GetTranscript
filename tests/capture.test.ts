import { afterEach, describe, expect, it, vi } from "vitest";
import { captureTab, prepareTranscript } from "../src/lib/browser";
import { prepareCollectionTracks } from "../src/lib/collection";
import { collectPage } from "../src/extractor/collect";
import { collectStreamPage } from "../src/extractor/stream";
import type { PageCapture } from "../src/lib/types";

const source =
  "https://fixture.sharepoint.com/personal/demo/_layouts/15/stream.aspx?id=%2Frecording.mp4";
const row = (index: number) => ({
  index,
  start: index * 60,
  speaker: "Alex",
  text: `Line ${index}`,
});
const capture: PageCapture = {
  title: "Long recording",
  provider: "Microsoft Stream",
  sourceUrl: source,
  duration: 13 * 3600,
  tracks: [
    {
      key: "0:0",
      label: "French",
      language: "fr",
      cues: [{ id: "1", start: 0, end: 1, text: "Line 0" }],
    },
  ],
  rows: [row(0)],
  expectedRows: 3,
  completeRows: false,
  warnings: [],
  rowCursor: { sourceUrl: source, nextScrollTop: 400, expectedRows: 3 },
};
function setup(results: PageCapture[], direct?: PageCapture) {
  const executeScript = vi.fn();
  results.forEach((result) =>
    executeScript.mockResolvedValueOnce([{ result }]),
  );
  vi.stubGlobal("chrome", {
    tabs: {
      get: vi.fn(async () => ({ id: 1, url: source + "&referrer=ignored" })),
    },
    scripting: {
      executeScript: (args: { func: unknown }) =>
        args.func === collectStreamPage
          ? Promise.resolve([{ result: direct }])
          : executeScript(args),
    },
  });
  return executeScript;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("chunked recording collection", () => {
  it("uses structured Stream entries without starting a DOM scan", async () => {
    const direct = { ...capture, rowCursor: undefined, completeRows: true };
    const execute = setup([], direct);
    const progress = vi.fn(async () => {});
    expect(await captureTab(1, progress)).toEqual(direct);
    expect(progress).toHaveBeenCalledWith(direct);
    expect(execute).not.toHaveBeenCalled();
  });
  it("preserves literal markup and entity text in structured transcript entries", () => {
    const text = "Use <configuration> and the literal &amp; value.";
    const value: PageCapture = {
      ...capture,
      rows: [],
      tracks: [
        {
          key: "structured",
          label: "English",
          language: "en",
          textFormat: "plain",
          cues: [{ id: "1", start: 1, end: 2, text, speaker: "Alex" }],
        },
      ],
    };
    expect(prepareTranscript(value, "structured").cues[0].text).toBe(text);
    expect(prepareCollectionTracks(value)[0].transcript.cues[0].text).toBe(
      text,
    );
  });
  it("validates structured capture and preserves actionable fallback errors", async () => {
    setup([], { ...capture, duration: Infinity });
    await expect(captureTab(1)).rejects.toThrow("caption metadata");
    setup([
      {
        ...capture,
        tracks: [],
        rowCursor: undefined,
        warnings: [
          "This player has not exposed captions in the background. Open the video tab and refresh.",
        ],
      },
    ]);
    await expect(captureTab(1)).rejects.toThrow(
      "Open the video tab and refresh.",
    );
  });
  it("merges overlap, keeps tracks once and reports resumable progress", async () => {
    const execute = setup([
      capture,
      {
        ...capture,
        tracks: [],
        rows: [row(0), row(1), row(2)],
        rowCursor: undefined,
        warnings: [
          "Some speaker labels could not be loaded. Unmatched captions remain unnamed.",
        ],
      },
    ]);
    const progress = vi.fn(async () => {});
    const result = await captureTab(1, progress);
    expect(result.rows).toEqual([row(0), row(1), row(2)]);
    expect(result.tracks).toEqual(capture.tracks);
    expect(result.duration).toBe(46800);
    expect(result.completeRows).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.rowCursor).toBeUndefined();
    expect(progress).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1][0].args[0]).toMatchObject({
      prepare: false,
      resume: capture.rowCursor,
    });
  });
  it("resumes a saved cursor without collecting tracks again", async () => {
    const execute = setup([
      { ...capture, tracks: [], rows: [row(1), row(2)], rowCursor: undefined },
    ]);
    const result = await captureTab(1, undefined, undefined, capture);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].args[0]).toMatchObject({
      prepare: false,
      resume: capture.rowCursor,
    });
    expect(result.completeRows).toBe(true);
  });
  it("checks cancellation between chunks without losing the saved checkpoint", async () => {
    const execute = setup([capture]);
    const allowed = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const progress = vi.fn(async () => {});
    await expect(captureTab(1, progress, allowed)).rejects.toThrow("canceled");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith(capture);
  });
  it("checkpoints the current chunk when Pause arrives during its injection", async () => {
    const execute = setup([capture]);
    const allowed = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const progress = vi.fn(async () => {});
    await expect(captureTab(1, progress, allowed)).rejects.toThrow("canceled");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith(capture);
  });
  it("rejects changed recordings and conflicting overlapping rows", async () => {
    setup([
      { ...capture, sourceUrl: source.replace("recording", "different") },
    ]);
    await expect(captureTab(1)).rejects.toThrow("recording changed");
    setup([
      capture,
      {
        ...capture,
        tracks: [],
        rows: [{ ...row(0), text: "Changed" }],
        rowCursor: undefined,
      },
    ]);
    await expect(captureTab(1)).rejects.toThrow("transcript changed");
  });
  it("resumes an old checkpoint after a long pause with a fresh active budget", async () => {
    const execute = setup([
      { ...capture, tracks: [], rows: [row(1), row(2)], rowCursor: undefined },
    ]);
    const initial = {
      ...capture,
      rowCursor: { ...capture.rowCursor!, startedAt: Date.now() - 600001 },
    };
    const result = await captureTab(1, undefined, undefined, initial);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].args[0]).toMatchObject({
      prepare: false,
      resume: initial.rowCursor,
    });
    expect(result.tracks).toEqual(capture.tracks);
    expect(result.rowCursor).toBeUndefined();
    expect(result.completeRows).toBe(true);
    expect(result.warnings).toEqual([]);
  });
  it("bounds all chunks in one active invocation with an explicit warning", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const execute = setup([capture]);
    const progress = vi.fn(async () => {
      now += 600001;
    });
    const result = await captureTab(1, progress);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.tracks).toEqual(capture.tracks);
    expect(result.rowCursor).toBeUndefined();
    expect(result.completeRows).toBe(false);
    expect(result.warnings.join(" ")).toContain("time or size limit");
  });
  it.each([
    { expectedRows: Infinity },
    { expectedRows: 50001 },
    { expectedRows: 2.5 },
    { rows: [{ ...row(0), text: null }] },
    { rows: [{ ...row(0), text: "a".repeat(100001) }] },
    { rows: [{ ...row(0), speaker: { name: "Alex" } }] },
    { rows: [{ ...row(0), start: NaN }] },
    { rows: [row(0), row(0)] },
    { duration: Infinity },
    { duration: -1 },
    { duration: 360001 },
    { warnings: "not an array" },
    { rowCursor: { ...capture.rowCursor, nextScrollTop: NaN } },
    { rowCursor: { ...capture.rowCursor, expectedRows: Infinity } },
    { rowCursor: { ...capture.rowCursor, speakerNames: [null] } },
    { rowCursor: { ...capture.rowCursor, timeUnits: [["minute", -60]] } },
  ])(
    "rejects malformed page metadata before checkpointing",
    async (invalid) => {
      setup([{ ...capture, ...invalid } as unknown as PageCapture]);
      const progress = vi.fn(async () => {});
      await expect(captureTab(1, progress)).rejects.toThrow("caption metadata");
      expect(progress).not.toHaveBeenCalled();
    },
  );
  it("validates resumed metadata before issuing any page script", async () => {
    const execute = setup([]);
    const initial = {
      ...capture,
      rowCursor: { ...capture.rowCursor!, nextScrollTop: Infinity },
    };
    await expect(captureTab(1, undefined, undefined, initial)).rejects.toThrow(
      "caption metadata",
    );
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(["vtt", "native"])(
    "bounds aggregate %s caption payload before checkpointing",
    async (kind) => {
      const tracks =
        kind === "vtt"
          ? [0, 1].map((index) => ({
              key: String(index),
              label: "Captions",
              language: "en",
              vtt: "WEBVTT\n\n" + "a".repeat(2_500_000),
            }))
          : [0, 1].map((index) => ({
              key: String(index),
              label: "Captions",
              language: "en",
              cues: Array.from({ length: 26 }, (_, i) => ({
                id: String(i),
                start: i,
                end: i + 1,
                text: "a".repeat(100000),
              })),
            }));
      setup([{ ...capture, tracks }]);
      const progress = vi.fn(async () => {});
      await expect(captureTab(1, progress)).rejects.toThrow("caption metadata");
      expect(progress).not.toHaveBeenCalled();
    },
  );
  it("accepts older captures with optional metadata absent", async () => {
    const minimal = {
      ...capture,
      duration: undefined,
      rowCursor: undefined,
      rows: [],
      expectedRows: 0,
    };
    setup([minimal]);
    await expect(captureTab(1)).resolves.toMatchObject({
      tracks: capture.tracks,
      rows: [],
    });
  });
  it("keeps complete usable tracks when another native track exceeds the aggregate budget", async () => {
    const native = ["English", "French"].map((label) => ({
      kind: "captions",
      label,
      language: label === "English" ? "en" : "fr",
      mode: "disabled",
      cues: Array.from({ length: 26 }, (_, index) => ({
        id: String(index),
        startTime: index,
        endTime: index + 1,
        text: "a".repeat(100000),
      })),
    }));
    const media = {
      textTracks: native,
      duration: 27,
      querySelectorAll: () => [],
    };
    vi.stubGlobal("location", new URL("https://video.example/recording"));
    vi.stubGlobal("navigator", { language: "en" });
    vi.stubGlobal("document", {
      title: "Recording",
      documentElement: { lang: "en" },
      querySelector: () => null,
      querySelectorAll: (selector: string) =>
        selector === "video,audio" ? [media] : [],
    });
    const result = await collectPage({ speakers: true, prepare: true });
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0].cues).toHaveLength(26);
    expect(result.tracks[0].cues?.[25].text).toHaveLength(100000);
    expect(result.warnings.join(" ")).toContain("omitted in full");
    expect(native.map((track) => track.mode)).toEqual(["disabled", "disabled"]);
  });
});
