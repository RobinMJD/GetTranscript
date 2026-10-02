import { describe, expect, it, vi } from "vitest";
import {
  Collections,
  type CollectionDependencies,
  type CollectionCheckpoint,
} from "../src/lib/collection-session";
import {
  canonicalSource,
  type RecordingCollection,
} from "../src/lib/collection";
import type { PageCapture } from "../src/lib/types";

const first = "https://video.example/part-one";
const second = "https://video.example/part-two";
const capture = (url: string): PageCapture => ({
  title: url === first ? "First recording" : "Second recording",
  sourceUrl: url,
  duration: 4 * 3600 + 20,
  provider: "HTML5 video",
  rows: [],
  expectedRows: 0,
  completeRows: true,
  warnings: [],
  tracks: [
    {
      key: "en",
      label: "English",
      language: "en",
      vtt: `WEBVTT\n\nsame-id\n00:00:10.000 --> 00:00:12.000\n<v Alex>${url === first ? "First" : "Second"} words</v>\n`,
    },
  ],
});
function setup() {
  const states = new Map<number, RecordingCollection>();
  const checkpoints = new Map<number, CollectionCheckpoint>();
  let url = first;
  const deps: CollectionDependencies = {
    read: async (id) => structuredClone(states.get(id)),
    write: async (state) => {
      states.set(state.tabId, structuredClone(state));
    },
    remove: async (id) => {
      states.delete(id);
    },
    checkpoint: async (id, value) => {
      if (value) checkpoints.set(id, structuredClone(value));
      else checkpoints.delete(id);
    },
    readCheckpoint: async (id) => structuredClone(checkpoints.get(id)),
    source: async () => ({ url, title: "A long meeting" }),
    navigate: vi.fn(async (_id, next) => {
      url = next;
    }),
    capture: vi.fn(async (_id, progress) => {
      const c = capture(url);
      await progress(c);
      return c;
    }),
    discover: async () => [
      { url: second, title: "Part 2" },
      { url: "https://other.example/private", title: "Unrelated" },
    ],
    singleBusy: () => false,
    download: vi.fn(async () => [123]),
    downloadState: async () => "complete",
    working: async (fn) => fn(),
  };
  const manager = new Collections(deps);
  const send = (
    action: Parameters<typeof manager.handle>[0]["action"],
    rest: Partial<Parameters<typeof manager.handle>[0]> = {},
  ) => manager.handle({ target: "collection", tabId: 7, action, ...rest });
  return {
    manager,
    deps,
    states,
    checkpoints,
    send,
    setUrl: (next: string) => {
      url = next;
    },
    getUrl: () => url,
  };
}
const complete = async (s: ReturnType<typeof setup>) =>
  vi.waitFor(() => expect(s.states.get(7)?.phase).toBe("ready"));

describe("recording collection jobs", () => {
  it("refreshes every part without removing the collection or resetting its order", async () => {
    const s = setup();
    await s.send("add", { urls: [second] });
    await s.send("start");
    await complete(s);
    const generation = s.states.get(7)!.generation;
    await s.send("reset");
    expect(s.states.get(7)!.generation).not.toBe(generation);
    expect(s.states.get(7)!.parts.map((p) => p.url)).toEqual([first, second]);
    expect(
      s.states
        .get(7)!
        .parts.every((p) => p.status === "pending" && !p.tracks.length),
    ).toBe(true);
    expect(s.states.get(7)!.phase).toBe("idle");
  });
  it("requests a ZIP for individual output even when there is only one recording", async () => {
    const s = setup();
    await s.send("start");
    await complete(s);
    await s.send("options", {
      options: { ...s.states.get(7)!.options, mode: "individual" },
    });
    await s.send("download");
    await vi.waitFor(() => expect(s.states.get(7)?.download).toBe("complete"));
    expect(s.deps.download).toHaveBeenCalledWith(
      expect.any(Array),
      "A long meeting",
      true,
    );
  });
  it("reuses a cached capture only when it belongs to the current recording", async () => {
    const s = setup();
    s.deps.cachedCapture = async () => capture(second);
    await s.send("get");
    expect(s.states.get(7)!.parts[0].status).toBe("pending");
    await s.manager.remove(7);
    s.deps.cachedCapture = async () => capture(first);
    await s.send("get");
    expect(s.states.get(7)!.parts[0].status).toBe("ready");
    expect(s.deps.capture).not.toHaveBeenCalled();
  });
  it("visits unique ordered recordings, matches per source and restores the original tab", async () => {
    const s = setup();
    await s.send("add", { urls: [second, first, second] });
    await s.send("start");
    await complete(s);
    const state = s.states.get(7)!;
    expect(state.parts).toHaveLength(2);
    expect(state.parts.map((p) => p.tracks[0].transcript.cues[0].text)).toEqual(
      ["First words", "Second words"],
    );
    expect(
      state.parts.every(
        (p) => p.tracks[0].transcript.cues[0].speaker === "Alex",
      ),
    ).toBe(true);
    expect(s.getUrl()).toBe(first);
    expect(s.checkpoints.size).toBe(0);
    await s.send("get");
    expect(s.deps.capture).toHaveBeenCalledTimes(2);
  });
  it("rejects cross-origin/credential links atomically and filters discovery", async () => {
    const s = setup();
    await s.send("get");
    await expect(
      s.send("add", { urls: [second, "https://other.example/part"] }),
    ).rejects.toThrow();
    expect(s.states.get(7)?.parts).toHaveLength(1);
    await expect(
      s.send("add", { urls: ["https://name:password@video.example/part"] }),
    ).rejects.toThrow();
    const result = await s.send("discover");
    expect("candidates" in result && result.candidates).toEqual([
      { url: second, title: "Part 2" },
    ]);
  });
  it("keeps a missing part visible and refuses a silently partial export", async () => {
    const s = setup();
    s.deps.capture = vi.fn(async () => {
      if (s.getUrl() === second) throw Error("No captions");
      return capture(s.getUrl());
    });
    await s.send("add", { urls: [second] });
    await s.send("start");
    await vi.waitFor(() => expect(s.states.get(7)?.phase).toBe("error"));
    expect(s.states.get(7)?.parts[1].error).toBe("No captions");
    await expect(s.send("download")).rejects.toThrow();
    expect(s.deps.download).not.toHaveBeenCalled();
    s.deps.capture = vi.fn(async () => capture(s.getUrl()));
    await s.send("retry", { partId: s.states.get(7)!.parts[1].id });
    await complete(s);
    expect(s.deps.capture).toHaveBeenCalledTimes(1);
  });
  it("continues after its view closes and reconciles saved downloads on reopen", async () => {
    const s = setup();
    await s.send("start");
    await complete(s);
    s.deps.downloadState = async () => "in_progress";
    await s.send("download");
    await vi.waitFor(() => expect(s.states.get(7)?.downloadIds).toEqual([123]));
    expect(s.states.get(7)?.download).toBe("saving");
    s.deps.downloadState = async () => "complete";
    const reconnected = new Collections(s.deps);
    const reply = await reconnected.handle({
      target: "collection",
      action: "get",
      tabId: 7,
    });
    expect("collection" in reply && reply.collection.download).toBe("complete");
    expect(s.deps.download).toHaveBeenCalledTimes(1);
  });
  it("never resurrects collection/checkpoint data after the source tab closes", async () => {
    const s = setup();
    let finish!: (c: PageCapture) => void;
    s.deps.capture = vi.fn(
      () =>
        new Promise<PageCapture>((resolve) => {
          finish = resolve;
        }),
    );
    await s.send("start");
    await vi.waitFor(() => expect(s.deps.capture).toHaveBeenCalledTimes(1));
    await s.manager.remove(7);
    finish(capture(first));
    await vi.waitFor(() => expect(s.manager.busy(7)).toBe(false));
    expect(s.states.size).toBe(0);
    expect(s.checkpoints.size).toBe(0);
  });
  it("pauses without racing edits and resumes a saved extraction checkpoint", async () => {
    const s = setup();
    s.deps.capture = vi.fn(async (_id, progress, continuing) => {
      await progress(capture(first));
      while (await continuing()) await new Promise((r) => setTimeout(r, 5));
      throw Error("Reading was canceled.");
    });
    await s.send("start");
    await vi.waitFor(() => expect(s.checkpoints.size).toBe(1));
    await expect(
      s.send("remove", { partId: s.states.get(7)!.parts[0].id }),
    ).rejects.toThrow("Wait");
    await s.send("pause");
    await vi.waitFor(() => expect(s.manager.busy(7)).toBe(false));
    expect(s.states.get(7)?.parts[0].status).toBe("pending");
    s.deps.capture = vi.fn(async (_id, _progress, _continuing, initial) => {
      expect(initial?.sourceUrl).toBe(first);
      return capture(first);
    });
    await s.send("start");
    await complete(s);
  });
  it("detects worker interruption without silently restarting and preserves completed parts", async () => {
    const s = setup();
    await s.send("get");
    s.states.get(7)!.phase = "reading";
    const reply = await new Collections(s.deps).handle({
      target: "collection",
      action: "get",
      tabId: 7,
    });
    expect("collection" in reply && reply.collection.phase).toBe("paused");
    expect(s.deps.capture).not.toHaveBeenCalled();
  });
  it("does not navigate over a user's new page after a recording finishes", async () => {
    const s = setup();
    await s.send("add", { urls: [second] });
    s.deps.capture = vi.fn(async () => {
      const c = capture(s.getUrl());
      if (s.getUrl() === second) s.setUrl("https://video.example/unrelated");
      return c;
    });
    await s.send("start");
    await complete(s);
    expect(s.getUrl()).toBe("https://video.example/unrelated");
  });
  it("reports session quota failures without dropping previously completed parts", async () => {
    const s = setup();
    const write = s.deps.write;
    s.deps.write = async (state) => {
      if (state.parts.some((p) => p.tracks.length)) throw Error("Quota");
      await write(state);
    };
    await s.send("start");
    await vi.waitFor(() => expect(s.states.get(7)?.phase).toBe("error"));
    expect(s.states.get(7)?.parts[0].error).toContain("storage is full");
  });
});
