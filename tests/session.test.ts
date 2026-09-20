import { describe, it, expect, vi } from "vitest";
import {
  Sessions,
  defaults,
  type SessionDependencies,
  type TabSession,
} from "../src/lib/session";
import type { PageCapture } from "../src/lib/types";
const capture: PageCapture = {
  title: "A meeting",
  provider: "Player",
  rows: [],
  expectedRows: 0,
  completeRows: true,
  warnings: [],
  tracks: [
    {
      key: "en",
      label: "English",
      language: "en",
      vtt: "WEBVTT\n\n00:00.000 --> 00:02.000\n<v Alex>Ready</v>\n",
    },
  ],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function setup() {
  const states = new Map<number, TabSession>();
  const scan = deferred<PageCapture>();
  const deps: SessionDependencies = {
    read: async (id) => structuredClone(states.get(id)),
    write: async (state) => {
      states.set(state.tabId, structuredClone(state));
    },
    remove: async (id) => {
      states.delete(id);
    },
    preferences: async () => ({ ...defaults }),
    savePreferences: vi.fn(async () => {}),
    capture: vi.fn(() => scan.promise),
    download: vi.fn(async () => 123),
    downloadState: vi.fn(async () => "complete"),
  };
  return { states, scan, deps, sessions: new Sessions(deps) };
}
async function ready(s: ReturnType<typeof setup>, id = 1) {
  await s.sessions.get(id);
  s.scan.resolve(capture);
  await vi.waitFor(() => expect(s.states.get(id)?.phase).toBe("ready"));
}
describe("per-tab background sessions", () => {
  it("deduplicates concurrent opens and continues without a popup", async () => {
    const s = setup();
    const [a, b] = await Promise.all([s.sessions.get(1), s.sessions.get(1)]);
    expect(a.generation).toBe(b.generation);
    expect(s.deps.capture).toHaveBeenCalledTimes(1);
    s.scan.resolve(capture);
    await vi.waitFor(() => expect(s.states.get(1)?.phase).toBe("ready"));
    expect((await s.sessions.get(1)).capture).toEqual(capture);
    expect(s.deps.capture).toHaveBeenCalledTimes(1);
  });
  it("restores cached results and choices after worker suspension without collecting", async () => {
    const s = setup();
    await ready(s);
    await s.sessions.update(1, "en", {
      format: "md",
      speakers: false,
      visibleNames: false,
    });
    const resumed = new Sessions(s.deps);
    expect((await resumed.get(1)).options.format).toBe("md");
    expect((await resumed.get(1)).options.speakers).toBe(false);
    expect(s.deps.capture).toHaveBeenCalledTimes(1);
  });
  it("starts a fresh scan only on explicit refresh, preserving other tabs", async () => {
    const s = setup();
    await ready(s);
    await ready(s, 2);
    const other = await s.sessions.get(2);
    const original = await s.sessions.get(1);
    const next = await s.sessions.refresh(1);
    expect(next.generation).not.toBe(original.generation);
    expect(next.revision).toBeGreaterThan(original.revision);
    expect((await s.sessions.get(2)).generation).toBe(other.generation);
    expect(s.deps.capture).toHaveBeenCalledTimes(3);
  });
  it("never resurrects a closed tab when an in-flight scan finishes", async () => {
    const s = setup();
    await s.sessions.get(1);
    await s.sessions.remove(1);
    s.scan.resolve(capture);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.states.has(1)).toBe(false);
  });
  it("keeps an interrupted scan as an error until explicit refresh", async () => {
    const s = setup();
    await s.sessions.get(1);
    const resumed = new Sessions(s.deps);
    expect((await resumed.get(1)).error).toContain("interrupted");
    expect((await resumed.get(1)).phase).toBe("error");
    expect(s.deps.capture).toHaveBeenCalledTimes(1);
  });
  it("deduplicates export clicks and records completion after the popup disappears", async () => {
    const s = setup();
    await ready(s);
    const download = deferred<number>();
    s.deps.download = vi.fn(() => download.promise);
    await Promise.all([
      s.sessions.update(1, "en", defaults, true),
      s.sessions.update(1, "en", defaults, true),
    ]);
    expect(s.deps.download).toHaveBeenCalledTimes(1);
    download.resolve(123);
    await vi.waitFor(() => expect(s.states.get(1)?.download).toBe("complete"));
    expect((await new Sessions(s.deps).get(1)).download).toBe("complete");
  });
  it("reconciles long downloads on browser events or reopening after worker suspension", async () => {
    const s = setup();
    await ready(s);
    s.deps.downloadState = vi.fn(async () => "in_progress");
    await s.sessions.update(1, "en", defaults, true);
    await vi.waitFor(() => expect(s.states.get(1)?.downloadId).toBe(123));
    const resumed = new Sessions(s.deps);
    s.deps.downloadState = vi.fn(async () => "complete");
    await resumed.downloadChanged(1, 123);
    expect((await resumed.get(1)).download).toBe("complete");
  });
  it("retains failed export details and allows a deliberate retry", async () => {
    const s = setup();
    await ready(s);
    s.deps.download = vi.fn(async () => {
      throw new Error("Download interrupted");
    });
    await s.sessions.update(1, "en", defaults, true);
    await vi.waitFor(() => expect(s.states.get(1)?.download).toBe("error"));
    expect((await s.sessions.get(1)).error).toBe("Download interrupted");
    expect((await s.sessions.get(1)).capture).toEqual(capture);
    s.deps.download = vi.fn(async () => 124);
    await s.sessions.update(1, "en", defaults, true);
    await vi.waitFor(() => expect(s.states.get(1)?.download).toBe("complete"));
  });
  it("reports session quota exhaustion without evicting another tab", async () => {
    const s = setup();
    const write = s.deps.write;
    s.deps.write = async (state) => {
      if (state.capture) throw new Error("Quota exceeded");
      await write(state);
    };
    await s.sessions.get(1);
    s.scan.resolve(capture);
    await vi.waitFor(() => expect(s.states.get(1)?.phase).toBe("error"));
    expect(s.states.get(1)?.error).toContain("storage is full");
    expect(s.states.get(1)?.capture).toBeUndefined();
  });
});
