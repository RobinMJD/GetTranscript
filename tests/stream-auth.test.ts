import { afterEach, expect, it, vi } from "vitest";
import { collectStreamPage } from "../src/extractor/stream";

const origin = "https://fixture.sharepoint.com";
const item = `${origin}/personal/demo/_api/v2.1/drives/drive1/items/item1`;
const token = "Bearer fixture-token";
function setup(
  playerUrl = `${origin}/_api_cached/v2.1/drives/drive1/items/item1/cdnmedia/transcripts`,
  denied = 401,
) {
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json" },
    });
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/cdnmedia/transcripts")) return json({});
    if (new Headers(init?.headers).get("Authorization") !== token)
      return new Response("", { status: denied });
    if (path.endsWith("/streamContent"))
      return json({
        entries: [
          {
            id: "1",
            text: "Available caption",
            speakerDisplayName: "Alex",
            startOffset: "00:00:01.0000000",
            endOffset: "00:00:02.0000000",
          },
        ],
      });
    return json({
      name: "Meeting.mp4",
      video: { duration: 10000 },
      media: {
        transcripts: [{ id: "t1", isVisible: true, languageTag: "en" }],
      },
    });
  });
  const window = { g_fileInfo: { ".spItemUrl": item }, fetch };
  let open = false;
  const button = {
    id: "transcriptButton",
    isConnected: true,
    querySelector: () => null,
    getAttribute: (name: string) =>
      name === "aria-expanded" ? String(open) : null,
    hasAttribute: () => false,
    closest: () => null,
    click: vi.fn(() => {
      open = !open;
      if (open)
        void window.fetch(playerUrl, { headers: { "x-authorization": token } });
    }),
  };
  vi.stubGlobal(
    "location",
    new URL(
      `${origin}/personal/demo/_layouts/15/stream.aspx?id=%2FMeeting.mp4`,
    ),
  );
  vi.stubGlobal("window", window);
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("document", {
    querySelectorAll: (selector: string) =>
      selector.startsWith("button") ? [button] : [],
    querySelector: () => null,
    getElementById: () => null,
  });
  return { window, fetch, button, isOpen: () => open };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("reuses only the current item's own player authorization and restores the closed panel/fetch", async () => {
  const s = setup();
  const result = await collectStreamPage();
  expect(result?.tracks[0].cues).toHaveLength(1);
  expect(result?.tracks[0].cues?.[0].speaker).toBe("Alex");
  expect(s.button.click).toHaveBeenCalledTimes(2);
  expect(s.isOpen()).toBe(false);
  expect(s.window.fetch).toBe(s.fetch);
  expect(s.fetch).toHaveBeenCalledTimes(4);
  expect(s.fetch.mock.calls[1][1]).toEqual({
    headers: { "x-authorization": token },
  });
  expect(JSON.stringify(result)).not.toContain("fixture-token");
  expect(JSON.stringify(result)).not.toContain("Authorization");
});

it.each([
  "https://other.sharepoint.com/_api_cached/v2.1/drives/drive1/items/item1/cdnmedia/transcripts",
  `${origin}/_api_cached/v2.1/drives/drive1/items/other-item/cdnmedia/transcripts`,
])(
  "ignores credentials outside the exact same-origin item (%s)",
  async (url) => {
    vi.useFakeTimers();
    const s = setup(url);
    const reading = collectStreamPage();
    await vi.waitFor(() => expect(s.button.click).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(4000);
    expect(await reading).toBeUndefined();
    expect(s.fetch).toHaveBeenCalledTimes(2);
    expect(s.window.fetch).toBe(s.fetch);
    expect(s.isOpen()).toBe(false);
  },
);

it("does not activate a control or retry when the API denies access", async () => {
  const s = setup(undefined, 403);
  expect(await collectStreamPage()).toBeUndefined();
  expect(s.fetch).toHaveBeenCalledTimes(1);
  expect(s.button.click).not.toHaveBeenCalled();
  expect(s.window.fetch).toBe(s.fetch);
});
