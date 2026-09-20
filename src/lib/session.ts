import { PageAccessError, prepareTranscript } from "./browser";
import { exportTranscript, filename } from "./transcript";
import { FORMATS, type ExportOptions, type PageCapture } from "./types";

export const sessionKey = (tabId: number) => `tab-session:${tabId}`;
export const defaults: ExportOptions = {
  format: "vtt",
  speakers: true,
  visibleNames: false,
};
export interface TabSession {
  tabId: number;
  generation: string;
  revision: number;
  phase: "reading" | "ready" | "error";
  capture?: PageCapture;
  key: string;
  options: ExportOptions;
  error: string;
  restricted: boolean;
  download: "idle" | "saving" | "complete" | "error";
  downloadId?: number;
}
export type SessionRequest =
  | { action: "get" | "refresh"; tabId: number }
  | {
      action: "update" | "download";
      tabId: number;
      key: string;
      options: ExportOptions;
    };
export type SessionReply = { session: TabSession } | { error: string };
export const friendlyError = (error: unknown) =>
  error instanceof PageAccessError
    ? error.message
    : error instanceof Error &&
        !/https?:\/\/|token|script|permission/i.test(error.message)
      ? error.message
      : "This page could not be read. Open the original video page, turn captions on, and try again.";
export function validOptions(value: unknown): value is ExportOptions {
  const p = value as ExportOptions | null;
  return (
    !!p &&
    FORMATS.some((f) => f.value === p.format) &&
    typeof p.speakers === "boolean" &&
    typeof p.visibleNames === "boolean"
  );
}
export interface SessionDependencies {
  read(tabId: number): Promise<TabSession | undefined>;
  write(session: TabSession): Promise<void>;
  remove(tabId: number): Promise<void>;
  preferences(): Promise<ExportOptions>;
  savePreferences(options: ExportOptions): Promise<void>;
  capture(tabId: number): Promise<PageCapture>;
  download(text: string, mime: string, name: string): Promise<number>;
  downloadState(id: number): Promise<string | undefined>;
}

// Short storage transactions are serialized; collection runs outside the queue.
// Generation checks prevent a closed tab or an obsolete scan from writing back.
export class Sessions {
  private queue: Promise<unknown> = Promise.resolve();
  private jobs = new Set<string>();
  constructor(private deps: SessionDependencies) {}
  private transaction<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }
  private async write(state: TabSession) {
    state.revision++;
    try {
      await this.deps.write(state);
    } catch {
      // Never silently evict a different tab's transcript to fit the memory quota.
      const failed: TabSession = {
        ...state,
        capture: undefined,
        phase: "error",
        download: "idle",
        error:
          "Temporary browser storage is full. Close another GetTranscript video tab, then refresh.",
      };
      await this.deps.write(failed);
      Object.assign(state, failed);
    }
    return state;
  }
  private async current(state: TabSession) {
    const current = await this.deps.read(state.tabId);
    return current?.generation === state.generation ? current : undefined;
  }
  private async begin(tabId: number): Promise<TabSession> {
    const state: TabSession = {
      tabId,
      generation: crypto.randomUUID(),
      revision: (await this.deps.read(tabId))?.revision || 0,
      phase: "reading",
      key: "",
      options: await this.deps.preferences(),
      error: "",
      restricted: false,
      download: "idle",
    };
    await this.write(state);
    this.jobs.add(state.generation);
    void this.collect(state);
    return state;
  }
  private async collect(state: TabSession) {
    try {
      const capture = await this.deps.capture(state.tabId);
      await this.transaction(async () => {
        const current = await this.current(state);
        if (current)
          await this.write({
            ...current,
            capture,
            key: capture.tracks[0]?.key || "",
            phase: "ready",
          });
      });
    } catch (error) {
      await this.transaction(async () => {
        const current = await this.current(state);
        if (current)
          await this.write({
            ...current,
            phase: "error",
            error: friendlyError(error),
            restricted: error instanceof PageAccessError,
          });
      });
    } finally {
      this.jobs.delete(state.generation);
    }
  }
  get(tabId: number) {
    return this.transaction(async () => {
      const state = await this.deps.read(tabId);
      if (!state) return this.begin(tabId);
      if (state.phase === "reading" && !this.jobs.has(state.generation)) {
        state.phase = "error";
        state.error =
          "Reading was interrupted by the browser. Refresh to try again.";
        return this.write(state);
      }
      if (state.download === "saving") {
        if (state.downloadId !== undefined) return this.reconcile(state);
        if (!this.jobs.has(`download:${state.generation}`)) {
          state.download = "error";
          state.error =
            "The browser interrupted the export. Check Downloads before trying again.";
          return this.write(state);
        }
      }
      return state;
    });
  }
  refresh(tabId: number) {
    return this.transaction(async () => {
      const current = await this.deps.read(tabId);
      // Do not run two collectors against the same player's controls simultaneously.
      if (
        current &&
        (this.jobs.has(current.generation) || current.download === "saving")
      )
        return current;
      return this.begin(tabId);
    });
  }
  remove(tabId: number) {
    return this.transaction(() => this.deps.remove(tabId));
  }
  update(tabId: number, key: string, options: ExportOptions, download = false) {
    return this.transaction(async () => {
      const state = await this.deps.read(tabId);
      if (!state || state.phase !== "ready" || !state.capture)
        throw new Error("Refresh to read the transcript first.");
      if (state.download === "saving") return state;
      if (
        !validOptions(options) ||
        !state.capture.tracks.some((t) => t.key === key)
      )
        throw new Error("Choose an available caption language and format.");
      state.key = key;
      state.options = { ...options };
      state.error = "";
      state.download = download ? "saving" : "idle";
      delete state.downloadId;
      await this.deps.savePreferences(options);
      await this.write(state);
      if (download && state.phase === "ready") {
        this.jobs.add(`download:${state.generation}`);
        void this.export(state);
      }
      return state;
    });
  }
  private async export(state: TabSession) {
    try {
      const transcript = prepareTranscript(state.capture!, state.key);
      const output = exportTranscript(transcript, state.options);
      const id = await this.deps.download(
        output.text,
        output.mime,
        filename(transcript.title, transcript.language, state.options.format),
      );
      await this.transaction(async () => {
        const current = await this.current(state);
        if (current) {
          current.downloadId = id;
          await this.write(current);
          // A tiny data-URL download can complete before its ID has been stored.
          await this.reconcile(current);
        }
      });
    } catch (error) {
      await this.transaction(async () => {
        const current = await this.current(state);
        if (current)
          await this.write({
            ...current,
            download: "error",
            error: friendlyError(error),
          });
      });
    } finally {
      this.jobs.delete(`download:${state.generation}`);
    }
  }
  private async reconcile(state: TabSession) {
    const status = await this.deps.downloadState(state.downloadId!);
    if (status === "in_progress") return state;
    state.download = status === "complete" ? "complete" : "error";
    state.error =
      status === "complete"
        ? ""
        : "The browser interrupted the download. Check Downloads and try again.";
    return this.write(state);
  }
  downloadChanged(tabId: number, id: number) {
    return this.transaction(async () => {
      const state = await this.deps.read(tabId);
      if (state?.download === "saving" && state.downloadId === id)
        await this.reconcile(state);
    });
  }
}
