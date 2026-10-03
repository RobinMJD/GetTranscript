import {
  canonicalSource,
  sourceUrl,
  newPart,
  collectionKey,
  defaultCollectionOptions,
  prepareCollectionTracks,
  exportCollection,
  collectionOffsets,
  type RecordingCollection,
  type CollectionOptions,
} from "./collection";
import type { ExportOptions, PageCapture } from "./types";
import { friendlyError, validOptions } from "./session";

export type CollectionRequest = {
  target: "collection";
  action:
    | "get"
    | "add"
    | "remove"
    | "move"
    | "options"
    | "part"
    | "start"
    | "pause"
    | "reset"
    | "download"
    | "retry"
    | "discover";
  tabId: number;
  urls?: string[];
  partId?: string;
  direction?: -1 | 1;
  options?: CollectionOptions;
  selectedTrack?: string;
  offset?: number;
  title?: string;
};
export type CollectionReply =
  | {
      collection: RecordingCollection;
      candidates?: { url: string; title: string }[];
    }
  | { error: string };
export interface CollectionCheckpoint {
  partId: string;
  capture: PageCapture;
}
export const checkpointKey = (id: number) => `collection-progress:${id}`;
export interface CollectionDependencies {
  read(id: number): Promise<RecordingCollection | undefined>;
  write(state: RecordingCollection): Promise<void>;
  remove(id: number): Promise<void>;
  checkpoint(id: number, value?: CollectionCheckpoint): Promise<void>;
  readCheckpoint(id: number): Promise<CollectionCheckpoint | undefined>;
  source(id: number): Promise<{ url: string; title: string }>;
  cachedCapture?(id: number): Promise<PageCapture | undefined>;
  preferences?(): Promise<ExportOptions>;
  rememberPlayer?(id: number): Promise<unknown>;
  restorePlayer?(id: number, state: unknown): Promise<void>;
  navigate(id: number, url: string): Promise<void>;
  capture(
    id: number,
    progress: (capture: PageCapture) => Promise<void>,
    continuing: () => Promise<boolean>,
    initial?: PageCapture,
  ): Promise<PageCapture>;
  discover(id: number): Promise<{ url: string; title: string }[]>;
  singleBusy(id: number): boolean;
  download(
    files: ReturnType<typeof exportCollection>,
    title: string,
    archive: boolean,
  ): Promise<number[]>;
  downloadState(id: number): Promise<string | undefined>;
  working<T>(job: () => Promise<T>): Promise<T>;
  exclusive?<T>(
    tabId: number,
    job: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

/** Per-source-tab collections. Only bounded transactions are serialized; extraction is asynchronous. */
export class Collections {
  private queue: Promise<unknown> = Promise.resolve();
  private jobs = new Map<number, AbortController>();
  private downloads = new Set<number>();
  constructor(private deps: CollectionDependencies) {}
  busy(id: number) {
    return this.jobs.has(id);
  }
  private transaction<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }
  private async write(state: RecordingCollection) {
    state.revision++;
    // Leave headroom for a speaker-row checkpoint and other open tabs. Never silently evict them.
    if (new TextEncoder().encode(JSON.stringify(state)).length > 6_000_000)
      throw new Error(
        "This collection is too large for temporary storage. Export fewer parts at a time.",
      );
    try {
      await this.deps.write(state);
    } catch {
      throw new Error(
        "Temporary browser storage is full. Export fewer parts or close another video tab.",
      );
    }
    return state;
  }
  private async current(state: RecordingCollection) {
    const saved = await this.deps.read(state.tabId);
    return saved?.generation === state.generation ? saved : undefined;
  }
  private async load(id: number): Promise<RecordingCollection> {
    const saved = await this.deps.read(id);
    if (saved) {
      if ((saved.phase === "reading" || saved.busy) && !this.jobs.has(id)) {
        saved.phase = "paused";
        saved.busy = false;
        saved.activity = undefined;
        saved.error =
          "Reading was interrupted. Resume to continue from the saved progress.";
        await this.write(saved);
      }
      if (saved.download === "saving" && !this.downloads.has(id))
        await this.reconcile(saved);
      return saved;
    }
    const source = await this.deps.source(id);
    const url = sourceUrl(source.url);
    const part = newPart(url);
    const cached = await this.deps.cachedCapture?.(id);
    if (
      cached?.sourceUrl &&
      canonicalSource(cached.sourceUrl) === canonicalSource(url) &&
      cached.tracks.length
    ) {
      try {
        part.tracks = prepareCollectionTracks(cached);
        part.selectedTrack = part.tracks[0]?.key || "";
        part.title = cached.title || part.title;
        part.duration = cached.duration;
        part.status = "ready";
      } catch {
        /* An unusable cached result can be retried by the collection. */
      }
    }
    const preferences = await this.deps.preferences?.();
    return this.write({
      tabId: id,
      generation: crypto.randomUUID(),
      revision: 0,
      sourceUrl: url,
      title: source.title || "Combined transcript",
      parts: [part],
      phase: part.status === "ready" ? "ready" : "idle",
      error: "",
      options: {
        ...defaultCollectionOptions,
        ...(validOptions(preferences) ? preferences : {}),
      },
      download: "idle",
      downloadIds: [],
    });
  }
  async remove(id: number) {
    await this.transaction(async () => {
      this.jobs.get(id)?.abort();
      await this.deps.remove(id);
      await this.deps.checkpoint(id);
    });
  }
  handle(request: CollectionRequest): Promise<CollectionReply> {
    return this.transaction(async () => {
      const state = await this.load(request.tabId);
      if (request.action === "get") return { collection: state };
      if (request.action === "pause") {
        if (state.phase === "reading") {
          state.phase = "paused";
          state.error = "Pausing after the current reading step…";
          await this.write(state);
          this.jobs.get(state.tabId)?.abort();
        }
        return { collection: state };
      }
      if (request.action === "options") {
        if (this.downloads.has(state.tabId) || state.download === "saving")
          throw new Error(
            "Wait for the download to finish before changing export options.",
          );
        this.applyOptions(state, request);
        state.download = "idle";
        state.downloadIds = [];
        return { collection: await this.write(state) };
      }
      if (
        this.jobs.has(state.tabId) ||
        this.downloads.has(state.tabId) ||
        state.download === "saving"
      )
        throw new Error(
          "Wait for the current operation to finish before changing the collection.",
        );
      state.error = "";
      if (request.action === "reset") {
        await this.deps.checkpoint(state.tabId);
        state.generation = crypto.randomUUID();
        state.parts = state.parts.map((part) => ({
          ...part,
          tracks: [],
          selectedTrack: "",
          status: "pending",
          error: "",
          duration: undefined,
        }));
        state.phase = "idle";
        state.busy = false;
        state.activity = undefined;
        state.download = "idle";
        state.downloadIds = [];
        return { collection: await this.write(state) };
      }
      if (request.action === "discover") {
        const candidates = await this.deps.discover(state.tabId);
        return {
          collection: state,
          candidates: candidates.filter((c) => {
            try {
              sourceUrl(c.url, new URL(state.sourceUrl).origin);
              return !state.parts.some(
                (p) => canonicalSource(p.url) === canonicalSource(c.url),
              );
            } catch {
              return false;
            }
          }),
        };
      }
      if (request.action === "add") {
        if (!Array.isArray(request.urls) || request.urls.length > 20)
          throw new Error("Add up to 20 recording links.");
        const urls = request.urls.map((u) =>
          sourceUrl(u, new URL(state.sourceUrl).origin),
        );
        for (const url of urls)
          if (
            !state.parts.some(
              (p) => canonicalSource(p.url) === canonicalSource(url),
            )
          )
            state.parts.push(newPart(url));
        if (state.parts.length > 20)
          throw new Error("A collection can contain up to 20 recordings.");
      } else if (["remove", "move", "part", "retry"].includes(request.action)) {
        const index = state.parts.findIndex((p) => p.id === request.partId);
        if (index < 0)
          throw new Error("Choose a recording in this collection.");
        const part = state.parts[index];
        if (request.action === "remove") {
          state.parts.splice(index, 1);
          if ((await this.deps.readCheckpoint(state.tabId))?.partId === part.id)
            await this.deps.checkpoint(state.tabId);
        } else if (request.action === "move") {
          if (request.direction !== -1 && request.direction !== 1)
            throw new Error("Choose a valid recording order.");
          const to = index + request.direction;
          if (to >= 0 && to < state.parts.length)
            [state.parts[index], state.parts[to]] = [
              state.parts[to],
              state.parts[index],
            ];
        } else if (request.action === "part") {
          if (request.selectedTrack !== undefined) {
            if (!part.tracks.some((t) => t.key === request.selectedTrack))
              throw new Error("Choose an available caption track.");
            part.selectedTrack = request.selectedTrack;
          }
          if (request.offset !== undefined) {
            if (
              !Number.isFinite(request.offset) ||
              request.offset < 0 ||
              request.offset > 360000
            )
              throw new Error("Enter a start time between zero and 100 hours.");
            part.offset = request.offset;
          }
        } else {
          part.status = "pending";
          part.error = "";
          part.tracks = [];
        }
      }
      if (request.action === "start" || request.action === "retry") {
        if (!state.parts.length)
          throw new Error("Add at least one recording first.");
        state.phase = "reading";
        state.busy = true;
        state.activity = "waiting";
        state.download = "idle";
        state.downloadIds = [];
        const controller = new AbortController();
        this.jobs.set(state.tabId, controller);
        try {
          await this.write(state);
        } catch (error) {
          this.jobs.delete(state.tabId);
          throw error;
        }
        void this.deps
          .working(() =>
            this.deps.exclusive
              ? this.deps.exclusive(
                  state.tabId,
                  () => this.run(state),
                  controller.signal,
                )
              : this.run(state),
          )
          .catch((error) =>
            this.transaction(async () => {
              if (this.jobs.get(state.tabId) !== controller) return;
              const current = await this.current(state);
              if (!current) return;
              current.busy = false;
              current.activity = undefined;
              current.phase = "paused";
              current.error = controller.signal.aborted
                ? "Paused. Resume to continue from the saved progress."
                : friendlyError(error);
              await this.write(current);
            }),
          )
          .finally(() => {
            if (this.jobs.get(state.tabId) === controller)
              this.jobs.delete(state.tabId);
          })
          .catch(() => {});
        return { collection: state };
      }
      if (request.action === "download") {
        const files = exportCollection(state); // Validate before declaring an export in progress.
        state.download = "saving";
        state.downloadIds = [];
        await this.write(state);
        this.downloads.add(state.tabId);
        void this.deps
          .working(() => this.export(state, files))
          .catch(() => {})
          .finally(() => this.downloads.delete(state.tabId));
        return { collection: state };
      }
      state.phase =
        state.parts.length && state.parts.every((p) => p.status === "ready")
          ? "ready"
          : "idle";
      state.download = "idle";
      state.downloadIds = [];
      await this.write(state);
      return { collection: state };
    });
  }
  private applyOptions(state: RecordingCollection, request: CollectionRequest) {
    const o = request.options;
    if (
      !o ||
      !validOptions(o) ||
      !["combined", "individual"].includes(o.mode) ||
      !["continuous", "custom", "local"].includes(o.timeline) ||
      typeof o.includeSources !== "boolean"
    )
      throw new Error("Choose valid export options.");
    state.options = { ...o };
    if (
      o.timeline === "custom" &&
      state.parts.some((p) => p.offset === undefined)
    ) {
      try {
        const offsets = collectionOffsets(state.parts, "continuous");
        state.parts.forEach((part, index) => {
          part.offset ??= offsets[index];
        });
      } catch {
        if (state.parts[0]) state.parts[0].offset ??= 0;
      }
    }
    if (request.title !== undefined)
      state.title = request.title.trim().slice(0, 250) || "Combined transcript";
  }
  private async run(initial: RecordingCollection) {
    let expectedUrl = "";
    let restore = false;
    let returnUrl = initial.sourceUrl;
    let player: unknown;
    try {
      if ((await this.current(initial))?.phase !== "reading") return;
      const waitUntil = Date.now() + 620_000;
      while (!this.deps.exclusive && this.deps.singleBusy(initial.tabId)) {
        if ((await this.current(initial))?.phase !== "reading") return;
        if (Date.now() > waitUntil)
          throw new Error(
            "The video tab is still busy. Resume when its current reading finishes.",
          );
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      await this.transaction(async () => {
        const state = await this.current(initial);
        if (state?.phase === "reading") {
          state.activity = "reading";
          await this.write(state);
        }
      });
      const source = await this.deps.source(initial.tabId);
      returnUrl = sourceUrl(source.url, new URL(initial.sourceUrl).origin);
      expectedUrl = canonicalSource(returnUrl);
      player = await this.deps.rememberPlayer?.(initial.tabId);
      for (const entry of initial.parts) {
        let state = await this.current(initial);
        if (!state || state.phase !== "reading") break;
        const part = state.parts.find((p) => p.id === entry.id)!;
        if (part.status === "ready" || part.status === "error") continue;
        const currentSource = await this.deps.source(state.tabId);
        if (canonicalSource(currentSource.url) !== expectedUrl)
          throw new Error(
            "The video tab changed. Resume when you are ready to visit the selected recordings.",
          );
        const marked = await this.transaction(async () => {
          const latest = await this.current(initial);
          if (!latest || latest.phase !== "reading") return false;
          const reading = latest.parts.find((p) => p.id === part.id)!;
          reading.status = "reading";
          reading.error = "";
          latest.activity =
            expectedUrl === canonicalSource(part.url) ? "reading" : "opening";
          await this.write(latest);
          return true;
        });
        if (!marked) break;
        try {
          if (expectedUrl !== canonicalSource(part.url)) {
            expectedUrl = canonicalSource(part.url);
            await this.deps.navigate(state.tabId, part.url);
            restore = true;
          }
          const mayRead = await this.transaction(async () => {
            const latest = await this.current(initial);
            if (!latest || latest.phase !== "reading") return false;
            latest.activity = "reading";
            await this.write(latest);
            return true;
          });
          if (!mayRead) break;
          const checkpoint = await this.deps.readCheckpoint(state.tabId);
          const capture = await this.deps.capture(
            state.tabId,
            async (capture) => {
              await this.transaction(async () => {
                const active = await this.current(initial);
                if (active)
                  await this.deps.checkpoint(state!.tabId, {
                    partId: part.id,
                    capture,
                  });
              });
            },
            async () => {
              const active = await this.current(initial);
              return !!active && active.phase === "reading";
            },
            checkpoint?.partId === part.id ? checkpoint.capture : undefined,
          );
          if (
            capture.sourceUrl &&
            canonicalSource(capture.sourceUrl) !== canonicalSource(part.url)
          )
            throw new Error(
              "The video tab changed while reading. Retry this recording.",
            );
          await this.transaction(async () => {
            const latest = await this.current(initial);
            if (!latest) return;
            const done = latest.parts.find((p) => p.id === part.id)!;
            const tracks = prepareCollectionTracks(capture);
            if (!tracks.length)
              throw new Error(
                "No readable captions were found in this recording.",
              );
            done.tracks = tracks;
            done.title = capture.title || done.title;
            done.duration = capture.duration;
            done.selectedTrack = tracks.some(
              (t) => t.key === done.selectedTrack,
            )
              ? done.selectedTrack
              : tracks[0].key;
            done.status = "ready";
            done.error = "";
            // Release raw VTT/row checkpoint before storing normalized tracks.
            await this.deps.checkpoint(latest.tabId);
            await this.write(latest);
          });
        } catch (error) {
          await this.transaction(async () => {
            const latest = await this.current(initial);
            if (!latest) return;
            const failed = latest.parts.find((p) => p.id === part.id)!;
            if (latest.phase === "paused") {
              failed.status = "pending";
              failed.error = "";
            } else {
              failed.status = "error";
              failed.error = friendlyError(error);
              await this.deps.checkpoint(latest.tabId);
            }
            await this.write(latest);
          });
        }
      }
    } catch (error) {
      await this.transaction(async () => {
        const state = await this.current(initial);
        if (state) {
          state.phase = "paused";
          state.error = friendlyError(error);
          await this.write(state);
        }
      });
    } finally {
      // Do not overwrite a user navigation, a closed tab, or a newer collection.
      if (restore && (await this.current(initial))) {
        try {
          const current = await this.deps.source(initial.tabId);
          if (
            canonicalSource(current.url) === expectedUrl &&
            canonicalSource(returnUrl) !== expectedUrl
          ) {
            await this.transaction(async () => {
              const state = await this.current(initial);
              if (state) {
                state.activity = "restoring";
                await this.write(state);
              }
            });
            await this.deps.navigate(initial.tabId, returnUrl);
            if (player) await this.deps.restorePlayer?.(initial.tabId, player);
          }
        } catch {
          /* Source may have closed or its permission may have expired. */
        }
      }
      await this.transaction(async () => {
        const state = await this.current(initial);
        if (!state) return;
        state.busy = false;
        state.activity = undefined;
        for (const part of state.parts)
          if (part.status === "reading") part.status = "pending";
        if (state.phase === "reading") {
          state.phase = state.parts.every((p) => p.status === "ready")
            ? "ready"
            : "error";
          state.error =
            state.phase === "error"
              ? "Some recordings could not be read. Retry or remove them before exporting."
              : "";
        } else if (state.error.startsWith("Pausing"))
          state.error = "Paused. Resume to continue from the saved progress.";
        await this.write(state);
      });
    }
  }
  private async export(
    initial: RecordingCollection,
    files: ReturnType<typeof exportCollection>,
  ) {
    try {
      const ids = await this.deps.download(
        files,
        initial.title,
        initial.options.mode === "individual",
      );
      await this.transaction(async () => {
        const state = await this.current(initial);
        if (state) {
          state.downloadIds = ids;
          await this.write(state);
          await this.reconcile(state);
        }
      });
    } catch (error) {
      await this.transaction(async () => {
        const state = await this.current(initial);
        if (state) {
          state.download = "error";
          state.error = friendlyError(error);
          await this.write(state);
        }
      });
    }
  }
  private async reconcile(state: RecordingCollection) {
    const states = await Promise.all(
      state.downloadIds.map((id) => this.deps.downloadState(id)),
    );
    if (states.length && states.every((s) => s === "complete"))
      state.download = "complete";
    else if (states.some((s) => s === "in_progress")) return;
    else {
      state.download = "error";
      state.error =
        "The browser interrupted the export. Check Downloads before trying again.";
    }
    await this.write(state);
  }
  downloadChanged(id: number, downloadId: number) {
    return this.transaction(async () => {
      const state = await this.deps.read(id);
      if (
        state?.download === "saving" &&
        state.downloadIds.includes(downloadId)
      )
        await this.reconcile(state);
    });
  }
}
