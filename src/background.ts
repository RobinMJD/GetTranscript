import { captureTab, startDownload } from "./lib/browser";
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
const sessions = new Sessions({
  read: async (tabId) =>
    (await chrome.storage.session.get(sessionKey(tabId)))[sessionKey(tabId)] as
      TabSession | undefined,
  write: async (state) =>
    chrome.storage.session.set({ [sessionKey(state.tabId)]: state }),
  remove: async (tabId) => chrome.storage.session.remove(sessionKey(tabId)),
  preferences: async () => {
    const { preferences } = await chrome.storage.local.get("preferences");
    return validOptions(preferences) ? preferences : { ...defaults };
  },
  savePreferences: async (preferences) =>
    chrome.storage.local.set({ preferences }),
  capture: (tabId) => whileWorking(() => captureTab(tabId)),
  download: (text, mime, name) =>
    whileWorking(() => startDownload(text, mime, name)),
  downloadState: async (id) =>
    (await chrome.downloads.search({ id }))[0]?.state,
});
chrome.runtime.onMessage.addListener(
  (request: SessionRequest, sender, respond: (reply: SessionReply) => void) => {
    if (
      sender.id !== chrome.runtime.id ||
      sender.url !== chrome.runtime.getURL("index.html")
    )
      return;
    if (!request || !Number.isInteger(request.tabId) || request.tabId < 0)
      return;
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
          request.key,
          request.options,
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
});
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state) return;
  void chrome.storage.session.get(null).then(async (values) => {
    for (const [key, value] of Object.entries(values)) {
      const state = value as TabSession;
      if (key.startsWith("tab-session:") && state.downloadId === delta.id)
        await sessions.downloadChanged(state.tabId, delta.id);
    }
  });
});
