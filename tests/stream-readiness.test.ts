import { afterEach, expect, it, vi } from "vitest";
import { collectStreamPage } from "../src/extractor/stream";

const origin = "https://fixture.sharepoint.com";
const source = `${origin}/personal/demo/_layouts/15/stream.aspx?id=%2FMeeting.mp4`;
const item = `${origin}/personal/demo/_api/v2.1/drives/d1/items/i1`;
const token = "Bearer fixture-only";

function setup(
  options: {
    metadata?: boolean;
    loading?: boolean;
    indicator?: boolean;
    authorization?: boolean;
    wrongItem?: boolean;
    control?: boolean;
    notes?: boolean;
    expanded?: boolean;
    controls?: boolean;
  } = {},
) {
  const observers = new Set<() => void>();
  class Observer {
    constructor(private callback: () => void) {}
    observe() {
      observers.add(this.callback);
    }
    disconnect() {
      observers.delete(this.callback);
    }
  }
  const json = (value: unknown) => new Response(JSON.stringify(value));
  const originalFetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (new URL(url).pathname.endsWith("/cdnmedia/transcripts"))
      return json({});
    if (
      options.authorization &&
      new Headers(init?.headers).get("Authorization") !== token
    )
      return new Response("", { status: 401 });
    if (new URL(url).pathname.endsWith("/streamContent"))
      return json({
        entries: [
          {
            id: "1",
            text: "Ready in a background tab",
            speakerDisplayName: "Alex",
            startOffset: "00:00:01",
            endOffset: "00:00:02",
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
  const window: { g_fileInfo?: unknown; fetch: typeof originalFetch } = {
    ...(options.metadata !== false
      ? { g_fileInfo: { ".spItemUrl": item } }
      : {}),
    fetch: originalFetch,
  };
  let open = false;
  let notesOpen = !!options.notes;
  let controlMounted = options.control !== false;
  const panel = {
    hidden: false,
    getAttribute: () => null,
    getClientRects: () => (open ? [{}] : []),
  };
  const notesPanel = {
    hidden: false,
    getAttribute: () => null,
    getClientRects: () => (notesOpen ? [{}] : []),
  };
  const notes = {
    id: "opaque-notes",
    isConnected: true,
    querySelector: () => null,
    getAttribute: (name: string) =>
      name === "aria-controls" ? "notes-pane" : null,
    hasAttribute: () => false,
    click: vi.fn(() => {
      notesOpen = !notesOpen;
      open = false;
    }),
  };
  const button = {
    id: "opaque-player-control",
    get isConnected() {
      return controlMounted;
    },
    querySelector: () => null,
    getAttribute: (name: string) => {
      if (name === "aria-controls" && options.controls !== false)
        return "transcript-pane";
      if (name === "data-automation-id") return "show_transcript";
      if (name === "aria-expanded" && options.expanded) return String(open);
      return null;
    },
    hasAttribute: () => false,
    closest: () => ({ querySelectorAll: () => [button, notes] }),
    click: vi.fn(() => {
      open = !open;
      if (open) {
        notesOpen = false;
        void window.fetch(
          `${origin}/_api_cached/v2.1/drives/d1/items/${options.wrongItem ? "other" : "i1"}/cdnmedia/transcripts`,
          { headers: { "x-authorization": token } },
        );
      }
    }),
  };
  const document = {
    readyState: options.loading ? "loading" : "complete",
    visibilityState: "hidden",
    documentElement: {},
    querySelector: () => (options.indicator ? {} : null),
    querySelectorAll: (selector: string) =>
      selector.startsWith("button")
        ? controlMounted
          ? [button, notes]
          : []
        : [],
    getElementById: (id: string) =>
      id === "transcript-pane" && open
        ? panel
        : id === "notes-pane" && notesOpen
          ? notesPanel
          : null,
  };
  vi.stubGlobal("location", new URL(source));
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("fetch", originalFetch);
  vi.stubGlobal("MutationObserver", Observer);
  return {
    window,
    document,
    button,
    notes,
    originalFetch,
    observers,
    isOpen: () => open,
    notesOpen: () => notesOpen,
    setControl: () => {
      controlMounted = true;
    },
    mutate: () => {
      for (const callback of [...observers]) callback();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("waits briefly for cold metadata without depending on a foreground render", async () => {
  vi.useFakeTimers();
  const s = setup({ metadata: false, loading: true });
  const reading = collectStreamPage();
  await vi.advanceTimersByTimeAsync(250);
  s.window.g_fileInfo = { ".spItemUrl": item };
  s.document.readyState = "complete";
  s.mutate();
  expect((await reading)?.tracks[0].cues?.[0].speaker).toBe("Alex");
  expect(s.originalFetch).toHaveBeenCalledTimes(2);
  expect(s.observers.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("samples a late metadata global even without a DOM mutation", async () => {
  vi.useFakeTimers();
  const s = setup({ metadata: false, indicator: true });
  const reading = collectStreamPage();
  await vi.advanceTimersByTimeAsync(250);
  s.window.g_fileInfo = { ".spItemUrl": item };
  await vi.advanceTimersByTimeAsync(250);
  expect((await reading)?.tracks).toHaveLength(1);
  expect(s.observers.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds the wait on a complete page lacking Stream metadata or a loading signal", async () => {
  vi.useFakeTimers();
  const s = setup({ metadata: false });
  const reading = collectStreamPage();
  await vi.advanceTimersByTimeAsync(2000);
  expect(await reading).toBeUndefined();
  expect(s.originalFetch).not.toHaveBeenCalled();
  expect(s.observers.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("accepts metadata mounted after document completion without a loading indicator", async () => {
  vi.useFakeTimers();
  const s = setup({ metadata: false });
  const reading = collectStreamPage();
  await vi.advanceTimersByTimeAsync(250);
  s.window.g_fileInfo = { ".spItemUrl": item };
  await vi.advanceTimersByTimeAsync(250);
  expect((await reading)?.tracks).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds metadata readiness to two seconds and releases its observer and timers", async () => {
  vi.useFakeTimers();
  const s = setup({ metadata: false, loading: true });
  const reading = collectStreamPage();
  await vi.advanceTimersByTimeAsync(2000);
  expect(await reading).toBeUndefined();
  expect(s.originalFetch).not.toHaveBeenCalled();
  expect(s.observers.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("ignores late metadata after the source recording changes", async () => {
  vi.useFakeTimers();
  const s = setup({ metadata: false, loading: true });
  const reading = collectStreamPage();
  await vi.advanceTimersByTimeAsync(250);
  vi.stubGlobal(
    "location",
    new URL(source.replace("Meeting.mp4", "Other.mp4")),
  );
  s.window.g_fileInfo = { ".spItemUrl": item };
  s.mutate();
  expect(await reading).toBeUndefined();
  expect(s.originalFetch).not.toHaveBeenCalled();
  expect(s.observers.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("restores a plain transcript control and the previous panel using their relationships", async () => {
  const s = setup({ authorization: true, notes: true });
  expect((await collectStreamPage())?.tracks[0].cues?.[0].speaker).toBe("Alex");
  expect(s.button.click).toHaveBeenCalledTimes(2);
  expect(s.notes.click).toHaveBeenCalledTimes(1);
  expect(s.isOpen()).toBe(false);
  expect(s.notesOpen()).toBe(true);
  expect(s.window.fetch).toBe(s.originalFetch);
});

it("finds a late auth control despite its unrelated id and without an expanded attribute", async () => {
  vi.useFakeTimers();
  const s = setup({ authorization: true, control: false });
  const reading = collectStreamPage();
  await vi.advanceTimersByTimeAsync(250);
  s.setControl();
  s.mutate();
  expect((await reading)?.tracks).toHaveLength(1);
  expect(s.button.click).toHaveBeenCalledTimes(2);
  expect(s.isOpen()).toBe(false);
  expect(s.window.fetch).toBe(s.originalFetch);
  expect(s.observers.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("matches a stable automation id independently of the unrelated element id", async () => {
  const s = setup({ authorization: true, expanded: true, controls: false });
  expect((await collectStreamPage())?.tracks).toHaveLength(1);
  expect(s.button.click).toHaveBeenCalledTimes(2);
  expect(s.isOpen()).toBe(false);
});

it("restores plain controls and fetch when no matching authorization arrives", async () => {
  vi.useFakeTimers();
  const s = setup({ authorization: true, wrongItem: true, notes: true });
  const reading = collectStreamPage();
  await vi.advanceTimersByTimeAsync(4000);
  expect(await reading).toBeUndefined();
  expect(s.button.click).toHaveBeenCalledTimes(2);
  expect(s.isOpen()).toBe(false);
  expect(s.notesOpen()).toBe(true);
  expect(s.window.fetch).toBe(s.originalFetch);
  expect(vi.getTimerCount()).toBe(0);
});
