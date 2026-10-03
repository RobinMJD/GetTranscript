import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectStreamPage } from "../src/extractor/stream";

const origin = "https://fixture-my.sharepoint.com";
const source = `${origin}/personal/demo/_layouts/15/stream.aspx?id=%2Fpersonal%2Fdemo%2FDocuments%2FMeeting.mp4`;
const item = `${origin}/personal/demo/_api/v2.0/drives/drive!123/items/item456`;
const entry = {
  id: "entry-1",
  text: "Bonjour مرحبًا 日本語",
  speakerId: "private-speaker-id",
  speakerDisplayName: "Alex Morgan",
  startOffset: "00:00:26.6924708",
  endOffset: "00:00:27.0924708",
  spokenLanguageTag: "fr-fr",
};
const transcript = {
  id: "transcript-123",
  languageTag: "",
  displayName: "",
  isVisible: true,
  isDefault: true,
  temporaryDownloadUrl: "https://untrusted.example/private?token=do-not-use",
};
function metadata(tracks: unknown[] = [transcript]) {
  return {
    name: "Long meeting.mp4",
    video: { duration: 14_400_064 },
    media: { transcripts: tracks },
    unrelatedSecret: "not-exported",
  };
}
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
function setup(
  meta: unknown = metadata(),
  contents: unknown[] = [{ entries: [entry], events: [{ text: "ignore" }] }],
  itemUrl = item,
) {
  vi.stubGlobal("location", new URL(source + "&referrer=secret#ignored"));
  vi.stubGlobal("window", { g_fileInfo: { ".spItemUrl": itemUrl } });
  const fetch = vi.fn().mockResolvedValueOnce(json(meta));
  contents.forEach((content) => fetch.mockResolvedValueOnce(json(content)));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("structured Stream transcripts", () => {
  it("reads the exact metadata and JSON endpoints with native speakers and precise timings", async () => {
    const fetch = setup();
    const result = await collectStreamPage();
    expect(result).toEqual({
      title: "Long meeting",
      provider: "Microsoft Stream",
      sourceUrl: source,
      duration: 14_400.064,
      tracks: [
        {
          key: "stream:0",
          label: "French (France)",
          language: "fr-FR",
          textFormat: "plain",
          cues: [
            {
              id: "entry-1",
              text: entry.text,
              speaker: "Alex Morgan",
              start: 26.6924708,
              end: 27.0924708,
            },
          ],
        },
      ],
      rows: [],
      expectedRows: 0,
      completeRows: true,
      warnings: [],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const metaUrl = new URL(fetch.mock.calls[0][0]);
    expect(metaUrl.pathname).toBe(
      "/personal/demo/_api/v2.1/drives/drive!123/items/item456",
    );
    expect(Object.fromEntries(metaUrl.searchParams)).toEqual({
      $select: "name,video,media",
      $expand: "media/transcripts",
    });
    const contentUrl = new URL(fetch.mock.calls[1][0]);
    expect(contentUrl.pathname).toBe(
      metaUrl.pathname + "/media/transcripts/transcript-123/streamContent",
    );
    expect(Object.fromEntries(contentUrl.searchParams)).toEqual({
      format: "json",
      applyhighlights: "false",
      applymediaedits: "false",
    });
    for (const [, request] of fetch.mock.calls)
      expect(request).toMatchObject({
        method: "GET",
        credentials: "include",
        redirect: "error",
        headers: { Accept: "application/json" },
      });
    expect(JSON.stringify(result)).not.toMatch(
      /temporaryDownloadUrl|untrusted|private-speaker-id|unrelatedSecret|referrer/,
    );
  });

  it("retains only an existing tempauth query, never returning authentication values", async () => {
    const fetch = setup(
      metadata(),
      [{ entries: [entry] }],
      item.replace("v2.0", "v2.1") +
        "?tempauth=existing%2Bauth%2Fvalue&authkey=ignored&unknown=ignored#fragment",
    );
    const result = await collectStreamPage();
    for (const [url] of fetch.mock.calls) {
      const parsed = new URL(url);
      expect(parsed.searchParams.get("tempauth")).toBe("existing+auth/value");
      expect(parsed.searchParams.has("authkey")).toBe(false);
      expect(parsed.searchParams.has("unknown")).toBe(false);
      expect(parsed.hash).toBe("");
    }
    expect(JSON.stringify(result)).not.toMatch(/tempauth|existing|authkey/);
  });

  it("keeps mixed spoken languages in one und track without splitting or relabeling speakers", async () => {
    setup(metadata(), [
      {
        entries: [
          entry,
          {
            ...entry,
            id: "entry-2",
            speakerDisplayName: "ليلى",
            spokenLanguageTag: "ar-sa",
            startOffset: "13:10:26.1234567",
            endOffset: "13:10:27.7654321",
          },
        ],
      },
    ]);
    const result = await collectStreamPage();
    expect(result?.tracks).toHaveLength(1);
    expect(result?.tracks[0]).toMatchObject({
      language: "und",
      label: "Spoken languages",
    });
    expect(result?.tracks[0].cues?.[1]).toMatchObject({
      speaker: "ليلى",
      start: 47_426.1234567,
      end: 47_427.7654321,
    });
  });

  it("reads only visible tracks, prioritizes the default, and preserves language associations", async () => {
    const fetch = setup(
      metadata([
        { ...transcript, id: "hidden", isVisible: false },
        { ...transcript, id: "unspecified", isVisible: undefined },
        {
          ...transcript,
          id: "japanese",
          isDefault: false,
          languageTag: "ja-jp",
          displayName: "日本語",
        },
        {
          ...transcript,
          id: "german",
          languageTag: "de-de",
          displayName: "Deutsch",
        },
      ]),
      [
        { entries: [{ ...entry, text: "Guten Tag" }] },
        { entries: [{ ...entry, text: "こんにちは" }] },
      ],
    );
    const result = await collectStreamPage();
    expect(
      result?.tracks.map(({ language, label, cues }) => [
        language,
        label,
        cues?.[0].text,
      ]),
    ).toEqual([
      ["de-DE", "Deutsch", "Guten Tag"],
      ["ja-JP", "日本語", "こんにちは"],
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[1][0]).toContain("/transcripts/german/");
    expect(fetch.mock.calls[2][0]).toContain("/transcripts/japanese/");
  });

  it("leaves entries without display names unnamed even when another entry shares the speaker ID", async () => {
    setup(metadata(), [
      {
        entries: [
          entry,
          { ...entry, id: "entry-2", speakerDisplayName: undefined },
        ],
      },
    ]);
    const result = await collectStreamPage();
    expect(result?.tracks[0].cues?.[1].speaker).toBeUndefined();
    expect(result?.warnings.join(" ")).toContain("remain unnamed");
  });

  it.each([
    "https://other.sharepoint.com/_api/v2.0/drives/d/items/i",
    "https://fixture-my.sharepoint.com.attacker.test/_api/v2.0/drives/d/items/i",
    "http://fixture-my.sharepoint.com/_api/v2.0/drives/d/items/i",
    `${origin}/_api/v2.0/drives/d/items/i/children`,
    `${origin}/_api/v2.0/drives/d/items/i/media/transcripts`,
    `${origin}/_api/v2.0/drives/d/items/i%2Fother`,
    `${origin}/_api/v2.0/drives/d%5Cother/items/i`,
    `${origin}/_api/v1.0/drives/d/items/i`,
    `https://user:password@fixture-my.sharepoint.com/_api/v2.0/drives/d/items/i`,
  ])("does not request an unsupported item endpoint: %s", async (itemUrl) => {
    const fetch = setup(metadata(), [], itemUrl);
    expect(await collectStreamPage()).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "https://example.com/_layouts/15/stream.aspx?id=recording",
    `${origin}/personal/demo/_layouts/15/view.aspx?id=recording`,
    `${origin}/personal/demo/_layouts/15/stream.aspx`,
  ])("does not inspect an unsupported page: %s", async (url) => {
    const fetch = setup();
    vi.stubGlobal("location", new URL(url));
    expect(await collectStreamPage()).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 500])(
    "falls back without another endpoint or authorization attempt after HTTP %s",
    async (status) => {
      const fetch = setup();
      fetch.mockReset().mockResolvedValue(new Response("", { status }));
      expect(await collectStreamPage()).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects partial results when any visible transcript cannot be read", async () => {
    const fetch = setup(
      metadata([transcript, { ...transcript, id: "second" }]),
      [{ entries: [entry] }],
    );
    fetch.mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));
    expect(await collectStreamPage()).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    {},
    { entries: [] },
    { entries: [{ ...entry, startOffset: "00:60:00.0000000" }] },
    { entries: [{ ...entry, endOffset: "00:00:20.0" }] },
    { entries: [{ ...entry, startOffset: "-1:00:00" }] },
    { entries: [{ ...entry, endOffset: "101:00:00" }] },
    { entries: [{ ...entry, text: null }] },
    { entries: [{ ...entry, text: "   " }] },
    { entries: [{ ...entry, text: "x".repeat(100_001) }] },
    { entries: [{ ...entry, speakerDisplayName: "x".repeat(201) }] },
  ])(
    "rejects malformed or oversized entries without exporting a partial transcript",
    async (content) => {
      setup(metadata(), [content]);
      expect(await collectStreamPage()).toBeUndefined();
    },
  );

  it("bounds cue count and aggregate text rather than silently truncating", async () => {
    const fetch = setup();
    fetch.mockReset().mockResolvedValueOnce(json(metadata()));
    fetch.mockResolvedValueOnce(
      json({ entries: Array.from({ length: 50_001 }, () => ({})) }),
    );
    expect(await collectStreamPage()).toBeUndefined();
    setup(metadata(), [
      {
        entries: Array.from({ length: 51 }, () => ({
          ...entry,
          text: "x".repeat(100_000),
        })),
      },
    ]);
    expect(await collectStreamPage()).toBeUndefined();
  });

  it("bounds declared and streamed response sizes before JSON parsing", async () => {
    const fetch = setup();
    fetch
      .mockReset()
      .mockResolvedValue(
        new Response("{}", { headers: { "Content-Length": "1000001" } }),
      );
    expect(await collectStreamPage()).toBeUndefined();
    let canceled = false;
    fetch.mockReset().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1_000_001));
          },
          cancel() {
            canceled = true;
          },
        }),
      ),
    );
    expect(await collectStreamPage()).toBeUndefined();
    expect(canceled).toBe(true);
  });

  it("aborts the whole collection within its bounded deadline", async () => {
    vi.useFakeTimers();
    const fetch = setup();
    fetch.mockReset().mockImplementation(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const pending = collectStreamPage();
    await vi.advanceTimersByTimeAsync(18_000);
    expect(await pending).toBeUndefined();
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a recording change while a response is loading", async () => {
    const fetch = setup();
    fetch.mockReset().mockImplementationOnce(async () => {
      vi.stubGlobal("location", new URL(source.replace("Meeting", "Other")));
      return json(metadata());
    });
    expect(await collectStreamPage()).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([NaN, Infinity, -100, 0, 360_000_001, "14400064"])(
    "does not publish an untrustworthy duration: %s",
    async (duration) => {
      setup({ ...metadata(), video: { duration } });
      const result = await collectStreamPage();
      expect(result?.tracks).toHaveLength(1);
      expect(result?.duration).toBeUndefined();
    },
  );

  it("runs when serialized into a fresh MAIN-world context without module helpers", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(metadata()))
      .mockResolvedValueOnce(json({ entries: [entry] }));
    const result = await runInNewContext(
      `(${collectStreamPage.toString()})()`,
      {
        URL,
        AbortController,
        TextDecoder,
        setTimeout,
        clearTimeout,
        fetch,
        location: new URL(source),
        window: { g_fileInfo: { ".spItemUrl": item } },
      },
    );
    expect(result?.tracks[0].cues[0].speaker).toBe("Alex Morgan");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
