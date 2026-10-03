import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { mkdtemp, cp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync, createHash } from "node:crypto";
import type { RecordingCollection } from "../../src/lib/collection";
import { nativeContext } from "./native-context";

let context: BrowserContext, folder: string, extensionId: string;
let closeNative: (() => Promise<void>) | undefined;
const errors: string[] = [];
const origin = "https://stream-api.sharepoint.com";
const sourceUrl = `${origin}/personal/demo/_layouts/15/stream.aspx?id=${encodeURIComponent("/personal/demo/Recordings/Workshop.mp4")}`;
const itemPath =
  "/personal/demo/_api/v2.1/drives/fixture-drive/items/fixture-item";
const names = ["Alex Morgan", "ليلى أحمد", "田中 花子"];
const cueCount = 120;
const offset = (seconds: number) =>
  `00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.2000000`;
const entries = Array.from({ length: cueCount }, (_, index) => ({
  id: String(index + 1),
  text: `API caption ${index + 1}.`,
  speakerId: `speaker-${index % 3}`,
  speakerDisplayName: names[index % 3],
  startOffset: offset(index * 2),
  endOffset: offset(index * 2 + 1),
  spokenLanguageTag: "en-US",
}));

test.beforeAll(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "gettranscript-stream-api-"));
  const ext = path.join(folder, "extension");
  await cp("dist", ext, { recursive: true });
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = publicKey.export({ type: "spki", format: "der" });
  extensionId = createHash("sha256")
    .update(key)
    .digest("hex")
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
  const manifest = JSON.parse(
    await readFile(path.join(ext, "manifest.json"), "utf8"),
  );
  manifest.key = key.toString("base64");
  // Fixture-only access; production retains its user-granted activeTab scope.
  manifest.host_permissions = [`${origin}/*`];
  await writeFile(path.join(ext, "manifest.json"), JSON.stringify(manifest));
  if (process.env.HEADED === "1") {
    const native = await nativeContext(path.join(folder, "profile"), ext);
    context = native.context;
    closeNative = native.close;
  } else
    context = await chromium.launchPersistentContext(
      path.join(folder, "profile"),
      {
        channel: "chromium",
        executablePath: process.env.BROWSER_BIN,
        headless: process.env.HEADED !== "1",
        args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
      },
    );
  context.on("page", (page) =>
    page.on("pageerror", (e) => errors.push(e.message)),
  );
});
test.afterAll(async () => {
  if (closeNative) await closeNative();
  else await context?.close();
  if (folder) await rm(folder, { recursive: true, force: true });
  expect(errors).toEqual([]);
});
async function openWorkspace(video: Page) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/help.html`);
  const id = await page.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    video.url(),
  );
  await page.goto(
    `chrome-extension://${extensionId}/collection.html?tabId=${id}`,
  );
  await expect(page.locator(".part")).toHaveCount(1);
  return { page, id };
}

let foregroundTranscript: RecordingCollection["parts"][number]["tracks"][number]["transcript"];
for (const { visibility, playerAuthorization } of [
  { visibility: "visible", playerAuthorization: false },
  { visibility: "hidden", playerAuthorization: false },
  { visibility: "hidden", playerAuthorization: true },
] as const) {
  test(`direct Stream metadata preserves all captions and speakers with source ${visibility} and closed cold panel${playerAuthorization ? " using the player's scoped authorization" : ""}`, async () => {
    test.setTimeout(60000);
    test.skip(
      visibility === "hidden" && process.env.HEADED !== "1",
      "A real background tab requires a headed browser; run with HEADED=1.",
    );
    const requests: string[] = [];
    const video = await context.newPage();
    await video.route(`${origin}/**`, (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === itemPath) {
        if (
          playerAuthorization &&
          route.request().headers().authorization !== "Bearer fixture-token"
        ) {
          requests.push("metadata-unauthorized");
          return route.fulfill({
            status: 401,
            body: "Use the player's existing authorization",
          });
        }
        requests.push("metadata");
        expect(url.searchParams.get("$select")).toBe("name,video,media");
        expect(url.searchParams.get("$expand")).toBe("media/transcripts");
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            name: "Workshop.mp4",
            video: { duration: 14400064 },
            media: {
              transcripts: [
                {
                  id: "track-en",
                  languageTag: "en-US",
                  isVisible: true,
                  isDefault: true,
                  displayName: "English",
                },
              ],
            },
          }),
        });
      }
      if (
        url.pathname === `${itemPath}/media/transcripts/track-en/streamContent`
      ) {
        requests.push("transcript");
        if (playerAuthorization)
          expect(route.request().headers().authorization).toBe(
            "Bearer fixture-token",
          );
        expect(url.searchParams.get("format")).toBe("json");
        expect(url.searchParams.get("applyhighlights")).toBe("false");
        expect(url.searchParams.get("applymediaedits")).toBe("false");
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ entries, events: [] }),
        });
      }
      if (
        url.pathname ===
        "/_api_cached/v2.1/drives/fixture-drive/items/fixture-item/cdnmedia/transcripts"
      ) {
        requests.push("player-request");
        expect(route.request().headers()["x-authorization"]).toBe(
          "Bearer fixture-token",
        );
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "{}",
        });
      }
      if (url.pathname.endsWith("/stream.aspx"))
        return route.fulfill({
          status: 200,
          contentType: "text/html;charset=utf-8",
          body: `<!doctype html><html><head><meta charset="utf-8"><title>API transcript workshop</title></head><body><h1>API transcript workshop</h1>${playerAuthorization ? '<button id="transcript-toggle" aria-controls="transcript-pane" aria-expanded="false">Transcript</button>' : ""}<script>
            window.g_fileInfo={'.spItemUrl':location.origin+'/personal/demo/_api/v2.0/drives/fixture-drive/items/fixture-item'};
            window.fixtureFetch = window.fetch;
            const button = document.querySelector('button');
            if (button) button.onclick = () => {
              const wasOpen = button.getAttribute('aria-expanded') === 'true';
              button.setAttribute('aria-expanded', String(!wasOpen));
              if (!wasOpen) fetch(location.origin + '/_api_cached/v2.1/drives/fixture-drive/items/fixture-item/cdnmedia/transcripts', {headers:{'x-authorization':'Bearer fixture-token'}});
            };
          </script></body></html>`,
        });
      return route.fulfill({ status: 404, body: "No fixture endpoint" });
    });
    await video.goto(sourceUrl);
    const { page, id } = await openWorkspace(video);
    if (visibility === "visible") await video.bringToFront();
    else await page.bringToFront();
    await page.evaluate(
      async ({ id, visible }) => {
        const tab = visible ? { id } : await chrome.tabs.getCurrent();
        await chrome.tabs.update(tab!.id!, { active: true });
      },
      { id, visible: visibility === "visible" },
    );
    await expect
      .poll(() => video.evaluate(() => document.visibilityState))
      .toBe(visibility);
    // No video element, caption track, open panel or rendered speaker rows exist.
    await expect(video.locator("video,track,[id^=entry-]")).toHaveCount(0);
    await page.evaluate(
      (tabId) =>
        chrome.runtime.sendMessage({
          target: "collection",
          action: "start",
          tabId,
        }),
      id,
    );
    await expect
      .poll(
        () =>
          page
            .evaluate(
              async (id) =>
                (await chrome.storage.session.get(`collection:${id}`))[
                  `collection:${id}`
                ] as RecordingCollection,
              id,
            )
            .then((state) => state.phase),
        { timeout: 20000 },
      )
      .toBe("ready");
    const state = await page.evaluate(
      async (id) =>
        (await chrome.storage.session.get(`collection:${id}`))[
          `collection:${id}`
        ] as RecordingCollection,
      id,
    );
    expect(state.parts[0].duration).toBeCloseTo(14400.064, 3);
    const transcript = state.parts[0].tracks[0].transcript;
    expect(transcript.cues).toHaveLength(cueCount);
    expect(transcript.cues.filter((cue) => cue.speaker)).toHaveLength(cueCount);
    expect([...new Set(transcript.cues.map((cue) => cue.speaker))]).toEqual(
      names,
    );
    expect(transcript.cues.at(-1)).toMatchObject({
      start: 238.2,
      end: 239.2,
      text: "API caption 120.",
    });
    expect(transcript.warnings).toEqual([]);
    expect(requests).toEqual(
      playerAuthorization
        ? ["metadata-unauthorized", "player-request", "metadata", "transcript"]
        : ["metadata", "transcript"],
    );
    expect(
      await video.evaluate(
        () =>
          window.fetch ===
          (window as typeof window & { fixtureFetch: typeof fetch })
            .fixtureFetch,
      ),
    ).toBe(true);
    if (playerAuthorization)
      await expect(video.locator("#transcript-toggle")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    expect(JSON.stringify(state)).not.toContain("fixture-token");
    if (visibility === "visible") foregroundTranscript = transcript;
    else if (foregroundTranscript)
      expect(transcript).toEqual(foregroundTranscript);
    await expect(video.locator("video,track,[id^=entry-]")).toHaveCount(0);
    await expect(video).toHaveURL(sourceUrl);
    await page.close();
    await video.close();
  });
}
