import { captureTab, startDownload } from "./lib/browser";
import { zipSync, strToU8 } from "fflate";
import {
  collectionKey,
  canonicalSource,
  type RecordingCollection,
} from "./lib/collection";
import {
  Collections,
  checkpointKey,
  type CollectionCheckpoint,
  type CollectionRequest,
} from "./lib/collection-session";
import { filename } from "./lib/transcript";
import { TabWork } from "./lib/tab-work";
import {
  Sessions,
  defaults,
  friendlyError,
  sessionKey,
  validOptions,
  type SessionRequest,
  type SessionReply,
  type TabSession,
} from "./lib/session";

// Only while an explicitly requested job is running: no permanent background polling.
async function whileWorking<T>(job: () => Promise<T>): Promise<T> {
  const keepAlive = setInterval(
    () => void chrome.runtime.getPlatformInfo(),
    20_000,
  );
  try {
    return await job();
  } finally {
    clearInterval(keepAlive);
  }
}
async function exportPreferences() {
  const { preferences } = await chrome.storage.local.get("preferences");
  return validOptions(preferences) ? preferences : { ...defaults };
}
const tabWork = new TabWork();
const sessions = new Sessions({
  read: async (tabId) =>
    (await chrome.storage.session.get(sessionKey(tabId)))[sessionKey(tabId)] as
      TabSession | undefined,
  write: async (state) =>
    chrome.storage.session.set({ [sessionKey(state.tabId)]: state }),
  remove: async (tabId) => chrome.storage.session.remove(sessionKey(tabId)),
  preferences: exportPreferences,
  savePreferences: async (preferences) =>
    chrome.storage.local.set({ preferences }),
  capture: (tabId) =>
    whileWorking(() => tabWork.run(tabId, () => captureTab(tabId))),
  sourceIdentity: async (tabId) => {
    const url = (await chrome.tabs.get(tabId)).url || "";
    try {
      return canonicalSource(url);
    } catch {
      return url;
    }
  },
  download: (text, mime, name) =>
    whileWorking(() => startDownload(text, mime, name)),
  downloadState: async (id) =>
    (await chrome.downloads.search({ id }))[0]?.state,
});
const collections = new Collections({
  preferences: exportPreferences,
  read: async (id) =>
    (await chrome.storage.session.get(collectionKey(id)))[collectionKey(id)] as
      RecordingCollection | undefined,
  write: (state) =>
    chrome.storage.session.set({ [collectionKey(state.tabId)]: state }),
  remove: (id) => chrome.storage.session.remove(collectionKey(id)),
  checkpoint: (id, value) =>
    value
      ? chrome.storage.session.set({ [checkpointKey(id)]: value })
      : chrome.storage.session.remove(checkpointKey(id)),
  readCheckpoint: async (id) =>
    (await chrome.storage.session.get(checkpointKey(id)))[checkpointKey(id)] as
      CollectionCheckpoint | undefined,
  source: async (id) => {
    const tab = await chrome.tabs.get(id);
    if (!tab.url)
      throw new Error(
        "Open GetTranscript on the video tab again to grant access.",
      );
    return { url: tab.url, title: tab.title || "Combined transcript" };
  },
  cachedCapture: async (id) => {
    const state = (await chrome.storage.session.get(sessionKey(id)))[
      sessionKey(id)
    ] as TabSession | undefined;
    return state?.phase === "ready" ? state.capture : undefined;
  },
  rememberPlayer: async (id) => {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: id },
        world: "MAIN",
        func: () => {
          const media = document.querySelector<HTMLMediaElement>("video,audio");
          return media
            ? {
                time: media.currentTime,
                paused: media.paused,
                muted: media.muted,
                volume: media.volume,
                rate: media.playbackRate,
              }
            : null;
        },
      });
      return result?.result;
    } catch {
      return null;
    }
  },
  restorePlayer: async (id, value) => {
    await chrome.scripting.executeScript({
      target: { tabId: id },
      world: "MAIN",
      args: [
        value as {
          time: number;
          paused: boolean;
          muted: boolean;
          volume: number;
          rate: number;
        },
      ],
      func: async (state) => {
        const deadline = Date.now() + 6000;
        let media: HTMLMediaElement | null = null;
        while (Date.now() < deadline) {
          media = document.querySelector<HTMLMediaElement>("video,audio");
          if (media && media.readyState >= 1) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        if (!media) return;
        media.muted = state.muted;
        media.volume = state.volume;
        media.playbackRate = state.rate;
        if (Number.isFinite(state.time) && state.time >= 0)
          try {
            media.currentTime = state.time;
          } catch {}
        if (state.paused) media.pause();
        else await media.play().catch(() => {});
      },
    });
  },
  navigate: async (id, url) => {
    await chrome.tabs.update(id, { url });
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      const tab = await chrome.tabs.get(id);
      if (tab.status === "complete") {
        if (!tab.url || canonicalSource(tab.url) !== canonicalSource(url))
          throw new Error(
            "The recording needs sign-in or could not be opened. Open it in the video tab, then try again.",
          );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(
      "This recording took too long to load. Retry it when the page is ready.",
    );
  },
  capture: (id, progress, continuing, initial) =>
    captureTab(id, progress, continuing, initial),
  discover: async (id) => {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: id },
      world: "MAIN",
      func: () => {
        const found = new Map<string, { url: string; title: string }>();
        for (const link of document.querySelectorAll<HTMLAnchorElement>(
          "a[href]",
        )) {
          try {
            const u = new URL(link.href);
            if (
              u.origin === location.origin &&
              /\/stream\.aspx$/i.test(u.pathname) &&
              u.searchParams.has("id")
            ) {
              u.search = new URLSearchParams({
                id: u.searchParams.get("id")!,
              }).toString();
              u.hash = "";
              found.set(u.href, {
                url: u.href,
                title: (link.textContent || "Recording").trim().slice(0, 250),
              });
            }
          } catch {
            /* Ignore non-web links. */
          }
          if (found.size >= 50) break;
        }
        return [...found.values()];
      },
    });
    return result?.result || [];
  },
  singleBusy: (id) => sessions.busy(id),
  working: whileWorking,
  exclusive: (id, job, signal) => tabWork.run(id, job, signal),
  download: async (files, title, archive) => {
    if (!archive && files.length === 1)
      return [
        await startDownload(files[0].text, files[0].mime, files[0].filename),
      ];
    const entries: Record<string, Uint8Array> = {};
    let size = 0;
    files.forEach((file, index) => {
      const bytes = strToU8(file.text);
      size += bytes.byteLength;
      if (size > 12_000_000)
        throw new Error(
          "This export is too large. Export fewer recordings at a time.",
        );
      entries[`${String(index + 1).padStart(2, "0")}-${file.filename}`] = bytes;
    });
    const zipped = zipSync(entries, { level: 6 });
    let binary = "";
    for (let i = 0; i < zipped.length; i += 16384)
      binary += String.fromCharCode(...zipped.subarray(i, i + 16384));
    return [
      await chrome.downloads.download({
        url: `data:application/zip;base64,${btoa(binary)}`,
        filename: filename(title, "", "json").replace(/\.json$/, ".zip"),
        conflictAction: "uniquify",
        saveAs: false,
      }),
    ];
  },
  downloadState: async (id) =>
    (await chrome.downloads.search({ id }))[0]?.state,
});
chrome.runtime.onMessage.addListener(
  (request: SessionRequest | CollectionRequest, sender, respond) => {
    if (
      !request ||
      typeof request !== "object" ||
      !Number.isInteger(request.tabId) ||
      request.tabId < 0
    )
      return;
    const isCollection =
      "target" in (request || {}) &&
      (request as CollectionRequest).target === "collection";
    const expected = chrome.runtime.getURL(
      isCollection ? "collection.html" : "index.html",
    );
    if (
      sender.id !== chrome.runtime.id ||
      !sender.url ||
      sender.url.split(/[?#]/)[0] !== expected
    )
      return;
    if (isCollection) {
      void collections
        .handle(request as CollectionRequest)
        .then(respond, (error) => respond({ error: friendlyError(error) }));
      return true;
    }
    if (collections.busy(request.tabId)) {
      respond({
        error:
          "A recording collection is being read in this tab. Reopen Combine recordings to view its progress.",
      });
      return;
    }
    let result: Promise<TabSession>;
    switch (request.action) {
      case "get":
        result = sessions.get(request.tabId);
        break;
      case "refresh":
        result = sessions.refresh(request.tabId);
        break;
      case "update":
      case "download":
        result = sessions.update(
          request.tabId,
          (
            request as Extract<
              SessionRequest,
              { action: "update" | "download" }
            >
          ).key,
          (
            request as Extract<
              SessionRequest,
              { action: "update" | "download" }
            >
          ).options,
          request.action === "download",
        );
        break;
      default:
        return;
    }
    void result.then(
      (session) => respond({ session }),
      (error) => respond({ error: friendlyError(error) }),
    );
    return true;
  },
);
chrome.tabs.onRemoved.addListener((tabId) => {
  void sessions.remove(tabId);
  void collections.remove(tabId);
});
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state) return;
  void chrome.storage.session.get(null).then(async (values) => {
    for (const [key, value] of Object.entries(values)) {
      const state = value as TabSession;
      if (key.startsWith("tab-session:") && state.downloadId === delta.id)
        await sessions.downloadChanged(state.tabId, delta.id);
      if (
        key.startsWith("collection:") &&
        (value as RecordingCollection).downloadIds?.includes(delta.id)
      )
        await collections.downloadChanged(
          (value as RecordingCollection).tabId,
          delta.id,
        );
    }
  });
});
