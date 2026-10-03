import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { mkdtemp, cp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync, createHash } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import type { RecordingCollection } from "../../src/lib/collection";
import { nativeContext } from "./native-context";

let context: BrowserContext, folder: string, extensionId: string;
let closeNative: (() => Promise<void>) | undefined;
const errors: string[] = [];
const source =
  "https://collection.sharepoint.com/personal/demo/_layouts/15/stream.aspx";
const urls = [0, 1, 2].map(
  (i) =>
    `${source}?id=${encodeURIComponent(`/personal/demo/Recordings/Workshop${i ? ` ${i}` : ""}.mp4`)}`,
);
const durations = [14405, 14402, 6000];
const fixtureVtt = (part: number) =>
  `WEBVTT\n\nmeeting/1\n00:00:09.651 --> 00:00:14.091\n<v ${part === 1 ? "Jordan Lee" : "Alex Morgan"}>Recording ${part + 1} has its own captions.</v>\n\nmeeting/2\n00:00:16.731 --> 00:00:20.527\n<v Casey Chen>The next action belongs to part ${part + 1}.</v>\n`;

test.beforeAll(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "gettranscript-collection-"));
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
  // Test-only access is limited to this intercepted fixture origin.
  manifest.key = key.toString("base64");
  manifest.host_permissions = ["https://collection.sharepoint.com/*"];
  await writeFile(path.join(ext, "manifest.json"), JSON.stringify(manifest));
  await mkdir(path.join(folder, "profile", "Default"), { recursive: true });
  await mkdir(path.join(folder, "downloads"));
  await writeFile(
    path.join(folder, "profile", "Default", "Preferences"),
    JSON.stringify({
      download: {
        default_directory: path.join(folder, "downloads"),
        prompt_for_download: false,
      },
    }),
  );
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
        acceptDownloads: true,
        downloadsPath: path.join(folder, "downloads"),
        args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
      },
    );
  context.on("page", (page) =>
    page.on("pageerror", (e) => errors.push(e.message)),
  );
  const setup = await context.newPage();
  const cdp = await context.newCDPSession(setup);
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: path.join(folder, "downloads"),
  });
  await setup.close();
  await context.route("https://collection.sharepoint.com/**", (route) => {
    const url = new URL(route.request().url());
    const caption = /\/captions-(\d)\.vtt$/.exec(url.pathname);
    const part = Math.max(
      0,
      urls.findIndex(
        (candidate) =>
          new URL(candidate).searchParams.get("id") ===
          url.searchParams.get("id"),
      ),
    );
    return route.fulfill({
      status: 200,
      contentType: caption
        ? "text/vtt;charset=utf-8"
        : "text/html;charset=utf-8",
      body: caption
        ? fixtureVtt(+caption[1])
        : `<!doctype html><html><head><title>Planning workshop — part ${part + 1}</title></head><body><video controls><track default kind="subtitles" label="English" srclang="en" src="/captions-${part}.vtt"></video><script>Object.defineProperty(document.querySelector('video'),'duration',{value:${durations[part]}})</script>${urls.map((u, i) => `<a href="${u}">Workshop part ${i + 1}</a>`).join("")}</body></html>`,
    });
  });
});
test.afterAll(async () => {
  if (closeNative) await closeNative();
  else await context?.close();
  if (folder) await rm(folder, { recursive: true, force: true });
  expect(errors).toEqual([]);
});
async function tabId(video: Page) {
  const helper = await context.newPage();
  await helper.goto(`chrome-extension://${extensionId}/help.html`);
  const id = await helper.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((t) => t.url === url)!.id!,
    video.url(),
  );
  await helper.close();
  return id;
}
async function workspace(video: Page, id?: number) {
  const page = await context.newPage();
  await page.goto(
    `chrome-extension://${extensionId}/collection.html?tabId=${id ?? (await tabId(video))}`,
  );
  await expect(
    page.getByRole("heading", { name: "Combine recordings", exact: true }),
  ).toBeVisible();
  return page;
}
async function lastDownload(page: Page) {
  return page.evaluate(
    async () =>
      (await chrome.downloads.search({ orderBy: ["-startTime"], limit: 1 }))[0],
  );
}

test("collection reads three distinct recordings, restores source, exports combined Markdown and separate ZIP", async () => {
  test.setTimeout(120000);
  const video = await context.newPage();
  await video.goto(urls[0]);
  const id = await tabId(video);
  let page = await workspace(video, id);
  await expect(page.locator(".part")).toHaveCount(1);
  await page.getByLabel("Format", { exact: true }).selectOption("md");
  await expect(page.locator(".advanced")).not.toHaveAttribute("open");
  await expect(page.getByLabel("Paste recording links")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Add recordings", exact: true })
    .click();
  await page
    .getByLabel("Paste recording links")
    .fill(`${urls[1]}\n${urls[2]}\n${urls[1]}&referrer=duplicate`);
  await page.getByRole("button", { name: "Add links", exact: true }).click();
  await expect(page.locator(".part")).toHaveCount(3);
  await page
    .getByRole("button", { name: "Read recordings", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await page.close();
  // Closing/reopening the workspace must reconnect to the background-owned job.
  page = await workspace(video, id);
  await expect(
    page.getByText("All recordings are ready", { exact: true }),
  ).toBeVisible({ timeout: 90000 });
  await expect(video).toHaveURL(urls[0]);
  await expect(page.locator(".part h3")).toHaveText([
    "Planning workshop — part 1",
    "Planning workshop — part 2",
    "Planning workshop — part 3",
  ]);
  await expect(
    page.getByRole("button", { name: "Download MD", exact: true }),
  ).toBeEnabled();
  // Invalid custom drafts must not survive switching away from their fields.
  await page.locator("summary").click();
  await page.getByLabel("Timeline", { exact: true }).selectOption("custom");
  const customStart = page.locator(".offset-field input").first();
  await customStart.fill("04:99:00");
  await customStart.press("Enter");
  await expect(
    page.getByRole("button", { name: "Download MD", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Timeline", { exact: true }).selectOption("continuous");
  await expect(
    page.getByRole("button", { name: "Download MD", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Timeline", { exact: true }).selectOption("custom");
  await expect(customStart).toHaveValue("00:00:00");
  await expect(customStart).not.toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByRole("button", { name: "Download MD", exact: true }),
  ).toBeEnabled();
  await customStart.fill("invalid");
  await customStart.press("Enter");
  await page.getByLabel("Export", { exact: true }).selectOption("individual");
  await expect(
    page.getByRole("button", { name: "Download ZIP (3 files)", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Export", { exact: true }).selectOption("combined");
  await expect(customStart).toHaveValue("00:00:00");
  await expect(
    page.getByRole("button", { name: "Download MD", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Timeline", { exact: true }).selectOption("continuous");
  await page.locator("summary").click();
  await page.getByRole("button", { name: "Download MD", exact: true }).click();
  await expect(
    page.getByText("Saved to your browser’s downloads.", { exact: true }),
  ).toBeVisible();
  let file = await lastDownload(page);
  expect(file.state).toBe("complete");
  const text = await readFile(file.filename, "utf8");
  expect(text).toContain("Recording 1 has its own captions.");
  expect(text).toContain("Recording 2 has its own captions.");
  expect(text).toContain("Recording 3 has its own captions.");
  expect(text).toContain("04:00:14.651");
  expect(text).toContain("08:00:16.651");
  expect(text).toContain("Jordan Lee");
  await page.getByLabel("Export", { exact: true }).selectOption("individual");
  await page.getByLabel("Format", { exact: true }).selectOption("vtt");
  await page
    .getByRole("button", { name: "Download ZIP (3 files)", exact: true })
    .click();
  await expect(
    page.getByText("Saved to your browser’s downloads.", { exact: true }),
  ).toBeVisible();
  file = await lastDownload(page);
  expect(file.filename).toMatch(/\.zip$/);
  const entries = unzipSync(new Uint8Array(await readFile(file.filename)));
  expect(Object.keys(entries)).toHaveLength(3);
  for (const [i, content] of Object.values(entries).entries()) {
    const vtt = strFromU8(content);
    expect(vtt).toContain("00:00:09.651 --> 00:00:14.091");
    expect(vtt).toContain(`Recording ${i + 1} has its own captions.`);
  }
  await page.reload();
  await expect(page.getByLabel("Export", { exact: true })).toHaveValue(
    "individual",
  );
  await expect(
    page.getByText("Saved to your browser’s downloads.", { exact: true }),
  ).toBeVisible();
  await video.close();
  await expect(
    page.getByRole("heading", { name: "The source video tab was closed" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        async (id) =>
          (await chrome.storage.session.get(`collection:${id}`))[
            `collection:${id}`
          ],
        id,
      ),
    )
    .toBeUndefined();
  await page.close();
});

test("discovered links require selection; ordering, advanced controls and mobile layout work", async () => {
  const video = await context.newPage();
  await video.goto(urls[0]);
  const page = await workspace(video);
  await page
    .getByRole("button", { name: "Add recordings", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Find links on source page", exact: true })
    .click();
  await expect(page.locator(".candidates label")).toHaveCount(2);
  await page.getByLabel("Workshop part 3", { exact: true }).uncheck();
  await page
    .getByRole("button", { name: "Add selected recordings", exact: true })
    .click();
  await expect(page.locator(".part")).toHaveCount(2);
  const before = await page.locator(".part h3").allTextContents();
  await page
    .getByRole("button", { name: "Move part 2 up", exact: true })
    .click();
  await expect(page.locator(".part h3")).toHaveText([...before].reverse());
  await page.locator("summary").click();
  await page.getByLabel("Timeline", { exact: true }).selectOption("custom");
  await expect(page.locator(".offset-field")).toHaveCount(2);
  const startTime = page.locator(".offset-field input").nth(1);
  await startTime.fill("04:99:00");
  await startTime.press("Enter");
  await expect(startTime).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByText("Enter HH:MM:SS or seconds, between 0 and 100 hours.", {
      exact: true,
    }),
  ).toBeVisible();
  await startTime.fill("04:02:00");
  await startTime.press("Enter");
  await expect(startTime).not.toHaveAttribute("aria-invalid", "true");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const tabId = Number(new URLSearchParams(location.search).get("tabId"));
        const state = (await chrome.storage.session.get(`collection:${tabId}`))[
          `collection:${tabId}`
        ] as RecordingCollection;
        return state.parts[1].offset;
      }),
    )
    .toBe(14520);
  await page.getByLabel("Include speaker names", { exact: false }).uncheck();
  await page.reload();
  await page.locator("summary").click();
  await expect(
    page.getByLabel("Include speaker names", { exact: false }),
  ).not.toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Remove part 2", exact: true })
    .click();
  await expect(page.locator(".part")).toHaveCount(1);
  await page.close();
  await video.close();
});

test("a failed part opens for manual Transcript recovery and retries without reloading or losing ready parts", async () => {
  test.setTimeout(90000);
  const video = await context.newPage();
  await video.route("https://collection.sharepoint.com/**", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("id") !== new URL(urls[1]).searchParams.get("id"))
      return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "text/html;charset=utf-8",
      body: `<!doctype html><html><head><title>Recovered workshop recording</title></head><body>
        <video controls></video><button id="manual-open" disabled>Transcript</button>
        <script>
          const button = document.getElementById('manual-open');
          const media = document.querySelector('video');
          Object.defineProperty(media, 'duration', { value: ${durations[1]} });
          // This deliberately unsupported control exercises the user-assisted
          // fallback after automatic discovery was unable to expose captions.
          setTimeout(() => { button.disabled = false; }, 3000);
          button.onclick = () => {
            if (media.querySelector('track')) return;
            const track = document.createElement('track');
            track.kind = 'subtitles'; track.default = true;
            track.label = 'Original captions'; track.src = '/captions-1.vtt';
            media.append(track);
            button.textContent = 'Transcript opened';
          };
        </script></body></html>`,
    });
  });
  await video.goto(urls[0]);
  const id = await tabId(video);
  const page = await workspace(video, id);
  try {
    await page
      .getByRole("button", { name: "Read recordings", exact: true })
      .click();
    await expect(
      page.getByText("All recordings are ready", { exact: true }),
    ).toBeVisible({ timeout: 45000 });
    const readyPart = (await storedCollection(page, id)).parts[0];
    await page
      .getByRole("button", { name: "Add recordings", exact: true })
      .click();
    await page.getByLabel("Paste recording links").fill(urls[1]);
    await page.getByRole("button", { name: "Add links", exact: true }).click();
    await expect(page.locator(".part")).toHaveCount(2);
    // Restore a failed job as it would appear after a previous bounded read.
    // Extraction and navigation below use the real worker and player collector.
    await page.evaluate(async (id) => {
      const key = `collection:${id}`;
      const state = (await chrome.storage.session.get(key))[
        key
      ] as RecordingCollection;
      state.revision++;
      state.phase = "error";
      state.parts[1].status = "error";
      state.parts[1].error =
        "This recording has not exposed readable captions yet.";
      await chrome.storage.session.set({ [key]: state });
    }, id);
    const failed = page.locator(".part").nth(1);
    await expect(
      failed.getByText("Needs attention", { exact: true }),
    ).toBeVisible();
    await expect(failed.locator(".part-recovery")).toHaveText(
      "If the player needs help, open this recording, select Transcript, then return here and retry.",
    );
    await page.screenshot({
      path: test.info().outputPath("failed-part-recovery.png"),
      fullPage: true,
    });
    let sourceNavigations = 0;
    video.on("framenavigated", (frame) => {
      if (frame === video.mainFrame()) sourceNavigations++;
    });
    await failed
      .getByRole("button", { name: "Open recording", exact: true })
      .click();
    await expect(video).toHaveURL(urls[1]);
    await expect
      .poll(() =>
        page.evaluate(async (id) => (await chrome.tabs.get(id)).active, id),
      )
      .toBe(true);
    await expect(
      failed.getByRole("button", { name: "Retry this part", exact: true }),
    ).toBeEnabled();
    expect((await storedCollection(page, id)).parts[0]).toEqual(readyPart);
    await video
      .getByRole("button", { name: "Transcript", exact: true })
      .click();
    await expect(video.locator("track")).toHaveCount(1);
    expect(sourceNavigations).toBe(1);
    await page.bringToFront();
    await failed
      .getByRole("button", { name: "Retry this part", exact: true })
      .click();
    await expect(
      page.getByText("All recordings are ready", { exact: true }),
    ).toBeVisible({ timeout: 45000 });
    expect(sourceNavigations).toBe(1);
    const recovered = await storedCollection(page, id);
    expect(recovered.parts[0]).toEqual(readyPart);
    expect(recovered.parts[1].tracks[0].transcript.cues[0].text).toBe(
      "Recording 2 has its own captions.",
    );
    await expect(failed.locator(".part-recovery")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Download/ })).toBeEnabled();
  } finally {
    await page.close();
    await video.close();
  }
});

test("popup More options opens the collection workspace for its source video", async () => {
  const video = await context.newPage();
  await video.goto(urls[0]);
  const id = await tabId(video);
  const popup = await context.newPage();
  await popup.addInitScript(
    ({ id, url }) => {
      chrome.tabs.query = async () => [
        {
          id,
          url,
          active: true,
          index: 0,
          pinned: false,
          highlighted: true,
          incognito: false,
          selected: true,
          windowId: 1,
          discarded: false,
          autoDiscardable: true,
          frozen: false,
          groupId: -1,
          lastAccessed: Date.now(),
        },
      ];
    },
    { id, url: urls[0] },
  );
  await popup.goto(`chrome-extension://${extensionId}/index.html`);
  await expect(
    popup.getByRole("button", { name: "Download VTT", exact: true }),
  ).toBeEnabled({ timeout: 45000 });
  await expect(
    popup.getByRole("button", { name: /Combine recordings/ }),
  ).toHaveCount(0);
  await popup
    .getByRole("button", { name: "More options", exact: true })
    .click();
  await expect(
    popup.getByRole("button", { name: /Combine recordings/ }),
  ).toBeVisible();
  await popup.keyboard.press("Escape");
  await expect(
    popup.getByRole("button", { name: "More options", exact: true }),
  ).toBeFocused();
  await popup
    .getByRole("button", { name: "More options", exact: true })
    .click();
  const opening = context.waitForEvent("page");
  await popup.getByRole("button", { name: /Combine recordings/ }).click();
  const collection = await opening;
  await expect(collection).toHaveURL(
    `chrome-extension://${extensionId}/collection.html?tabId=${id}`,
  );
  await expect(collection.locator(".part")).toHaveCount(1);
  expect(
    await popup
      .locator(".shell")
      .evaluate((el) => el.getBoundingClientRect().width),
  ).toBe(520);
  await collection.close();
  await popup.close();
  await video.close();
});

test("cached caption overhang shows one timing warning and preserves original timestamps on download", async () => {
  const video = await context.newPage();
  await video.goto(urls[0]);
  const id = await tabId(video);
  const page = await workspace(video, id);
  const warning =
    "Caption timestamps extend 3.370 seconds beyond this video's reported duration. Original caption timings and video duration are preserved.";
  try {
    await page.evaluate(async (id) => {
      const key = `collection:${id}`;
      const state = (await chrome.storage.session.get(key))[
        key
      ] as RecordingCollection;
      state.revision++;
      state.phase = "ready";
      state.options.format = "vtt";
      state.parts[0] = {
        ...state.parts[0],
        duration: 60,
        status: "ready",
        selectedTrack: "original",
        tracks: [
          {
            key: "original",
            label: "Original captions",
            language: "und",
            transcript: {
              title: "Timing drift workshop",
              provider: "Microsoft Stream",
              language: "und",
              cues: [
                {
                  id: "final",
                  start: 58,
                  end: 63.37,
                  text: "The closing words remain intact.",
                  speaker: "Alex Morgan",
                },
              ],
              warnings: [],
            },
          },
        ],
      };
      await chrome.storage.session.set({ [key]: state });
    }, id);
    // The warning is derived for cached results, even when no warning was saved.
    await page.reload();
    await expect(page.getByText(warning, { exact: true })).toHaveCount(1);
    await expect(page.getByText("00:01:00", { exact: true })).toBeVisible();
    // Older/exported results may already carry the same warning; do not repeat it.
    await page.evaluate(
      async ({ id, warning }) => {
        const key = `collection:${id}`;
        const state = (await chrome.storage.session.get(key))[
          key
        ] as RecordingCollection;
        state.revision++;
        state.parts[0].tracks[0].transcript.warnings = [warning, warning];
        await chrome.storage.session.set({ [key]: state });
      },
      { id, warning },
    );
    await expect(page.getByText(warning, { exact: true })).toHaveCount(1);
    await page
      .getByRole("button", { name: "Download VTT", exact: true })
      .click();
    await expect(
      page.getByText("Saved to your browser’s downloads.", { exact: true }),
    ).toBeVisible();
    const file = await lastDownload(page);
    const vtt = await readFile(file.filename, "utf8");
    expect(vtt).toContain("00:00:58.000 --> 00:01:03.370");
    expect(vtt).toContain("The closing words remain intact.");
    expect((await storedCollection(page, id)).parts[0].duration).toBe(60);
  } finally {
    await page.close();
    await video.close();
  }
});

test("a queued collection pauses immediately and keeps format editable during a slow popup read", async () => {
  test.setTimeout(90000);
  const video = await context.newPage();
  await video.goto(urls[0]);
  const id = await tabId(video);
  const worker = context.serviceWorkers()[0];
  await worker.evaluate(() => {
    const original = chrome.scripting.executeScript;
    const state = globalThis as typeof globalThis & {
      queuedReadCalls: number;
      releaseQueuedRead: () => void;
      restoreQueuedRead: () => void;
    };
    state.queuedReadCalls = 0;
    const gate = new Promise<void>((resolve) => {
      state.releaseQueuedRead = resolve;
    });
    chrome.scripting.executeScript = (async (
      ...args: Parameters<typeof original>
    ) => {
      state.queuedReadCalls++;
      if (state.queuedReadCalls === 1) await gate;
      return original(...args);
    }) as unknown as typeof original;
    state.restoreQueuedRead = () => {
      state.releaseQueuedRead();
      chrome.scripting.executeScript = original;
    };
  });
  let navigationCount = 0;
  video.on("framenavigated", (frame) => {
    if (frame === video.mainFrame()) navigationCount++;
  });
  const popup = await context.newPage();
  await popup.addInitScript(
    ({ id, url }) => {
      chrome.tabs.query = async () => [
        {
          id,
          url,
          active: true,
          index: 0,
          pinned: false,
          highlighted: true,
          incognito: false,
          selected: true,
          windowId: 1,
          discarded: false,
          autoDiscardable: true,
          frozen: false,
          groupId: -1,
          lastAccessed: Date.now(),
        },
      ];
    },
    { id, url: urls[0] },
  );
  let page: Page | undefined;
  try {
    await popup.goto(`chrome-extension://${extensionId}/index.html`);
    await expect(
      popup.getByRole("heading", { name: "Reading this page…", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        worker.evaluate(
          () =>
            (globalThis as typeof globalThis & { queuedReadCalls: number })
              .queuedReadCalls,
        ),
      )
      .toBe(1);
    page = await workspace(video, id);
    await page
      .getByRole("button", { name: "Add recordings", exact: true })
      .click();
    await page
      .getByLabel("Paste recording links")
      .fill(`${urls[1]}\n${urls[2]}`);
    await page.getByRole("button", { name: "Add links", exact: true }).click();
    await page
      .getByRole("button", { name: "Read recordings", exact: true })
      .click();
    await expect(
      page.getByText("Waiting for the current page read…", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Add recordings", exact: true }),
    ).toBeDisabled();
    await expect(page.getByLabel("Format", { exact: true })).toBeEnabled();
    await expect(page.getByLabel("Export", { exact: true })).toBeEnabled();
    await page.getByLabel("Format", { exact: true }).selectOption("srt");
    await expect(page.getByLabel("Format", { exact: true })).toHaveValue("srt");
    await page.getByLabel("Format", { exact: true }).selectOption("vtt");
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByText("Reading paused", { exact: true })).toBeVisible(
      { timeout: 3000 },
    );
    await expect
      .poll(
        () =>
          page!.evaluate(async (id) => {
            const value = (
              await chrome.storage.session.get(`collection:${id}`)
            )[`collection:${id}`] as RecordingCollection;
            return {
              phase: value.phase,
              busy: value.busy,
              format: value.options.format,
              statuses: value.parts.map((p) => p.status),
            };
          }, id),
        { timeout: 3000 },
      )
      .toEqual({
        phase: "paused",
        busy: false,
        format: "vtt",
        statuses: ["pending", "pending", "pending"],
      });
    await expect(page.getByLabel("Format", { exact: true })).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Continue reading", exact: true }),
    ).toBeEnabled();
    expect(navigationCount).toBe(0);
    expect(
      await worker.evaluate(
        () =>
          (globalThis as typeof globalThis & { queuedReadCalls: number })
            .queuedReadCalls,
      ),
    ).toBe(1);
    await worker.evaluate(() =>
      (
        globalThis as typeof globalThis & { releaseQueuedRead: () => void }
      ).releaseQueuedRead(),
    );
    await expect(popup.getByRole("button", { name: /^Download/ })).toBeEnabled({
      timeout: 45000,
    });
    await worker.evaluate(() =>
      (
        globalThis as typeof globalThis & { restoreQueuedRead: () => void }
      ).restoreQueuedRead(),
    );
    await page
      .getByRole("button", { name: "Continue reading", exact: true })
      .click();
    await expect(
      page.getByText("All recordings are ready", { exact: true }),
    ).toBeVisible({ timeout: 60000 });
    await expect(
      page.getByRole("button", { name: "Download VTT", exact: true }),
    ).toBeEnabled();
    await expect(page.getByLabel("Format", { exact: true })).toHaveValue("vtt");
    await expect(video).toHaveURL(urls[0]);
  } finally {
    await worker
      .evaluate(() =>
        (
          globalThis as typeof globalThis & { restoreQueuedRead?: () => void }
        ).restoreQueuedRead?.(),
      )
      .catch(() => {});
    await page?.close();
    await popup.close();
    await video.close();
  }
});

const coldCueCount = 120;
const coldCaption = (index: number) => `Cold recording caption ${index + 1}.`;
const coldVtt =
  "WEBVTT\n\n" +
  Array.from({ length: coldCueCount }, (_, index) => {
    const start = index * 2;
    const stamp = (seconds: number) =>
      `00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.200`;
    return `cold/${index + 1}\n${stamp(start)} --> ${stamp(start + 1)}\n${coldCaption(index)}\n`;
  }).join("\n");

for (const startup of [
  "disabled Transcript control",
  "late caption response",
] as const) {
  test(`cold Stream waits for ${startup} instead of returning an empty part`, async () => {
    test.setTimeout(60000);
    const video = await context.newPage();
    await video.route("https://collection.sharepoint.com/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/startup-captions.vtt") {
        if (startup === "late caption response")
          await new Promise((resolve) => setTimeout(resolve, 8000));
        return route.fulfill({
          status: 200,
          contentType: "text/vtt;charset=utf-8",
          body: fixtureVtt(0),
        });
      }
      if (!url.searchParams.has("startupFixture")) return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: "text/html;charset=utf-8",
        body: `<!doctype html><html><head><title>Delayed player startup</title></head><body>
          <video controls>${startup === "late caption response" ? '<track default kind="subtitles" label="Original captions" src="/startup-captions.vtt">' : ""}</video>
          ${startup === "disabled Transcript control" ? '<button id="transcript-toggle" aria-controls="transcript-pane" aria-expanded="false" disabled>記録</button>' : ""}
          <script>
            const media = document.querySelector('video');
            Object.defineProperty(media, 'duration', { value: 60 });
            const button = document.getElementById('transcript-toggle');
            window.transcriptActivations = 0;
            if (button) {
              setTimeout(() => { button.disabled = false; }, 4500);
              button.onclick = () => {
                const pane = document.getElementById('transcript-pane');
                if (pane) { pane.remove(); button.setAttribute('aria-expanded', 'false'); return; }
                window.transcriptActivations++;
                button.setAttribute('aria-expanded', 'true');
                const panel = document.createElement('section'); panel.id = 'transcript-pane'; document.body.append(panel);
                if (!media.querySelector('track')) {
                  const track = document.createElement('track'); track.default = true; track.kind = 'subtitles';
                  track.label = 'Original captions'; track.src = '/startup-captions.vtt'; media.append(track);
                }
              };
            }
          </script></body></html>`,
      });
    });
    await video.goto(
      `${urls[0]}&startupFixture=${encodeURIComponent(startup)}`,
      { waitUntil: "domcontentloaded" },
    );
    const id = await tabId(video);
    const page = await workspace(video, id);
    try {
      if (process.env.HEADED === "1") {
        await page.bringToFront();
        await page.evaluate(async () => {
          const tab = await chrome.tabs.getCurrent();
          await chrome.tabs.update(tab!.id!, { active: true });
        });
        await expect
          .poll(() => video.evaluate(() => document.visibilityState))
          .toBe("hidden");
      }
      if (startup === "late caption response")
        expect(
          await video
            .locator("track")
            .evaluate((track: HTMLTrackElement) => track.readyState),
        ).not.toBe(2);
      await page
        .getByRole("button", { name: "Read recordings", exact: true })
        .click();
      await expect(
        page.getByText("All recordings are ready", { exact: true }),
      ).toBeVisible({ timeout: 45000 });
      const state = await storedCollection(page, id);
      expect(state.parts[0].tracks[0].transcript.cues).toHaveLength(2);
      expect(state.parts[0].tracks[0].transcript.cues[0].speaker).toBe(
        "Alex Morgan",
      );
      if (startup === "disabled Transcript control") {
        expect(
          await video.evaluate(
            () =>
              (window as typeof window & { transcriptActivations: number })
                .transcriptActivations,
          ),
        ).toBe(1);
        await expect(video.locator("#transcript-pane")).toHaveCount(0);
      }
      await expect(
        page.getByRole("button", { name: /^Download/ }),
      ).toBeEnabled();
    } finally {
      await page.close();
      await video.close();
    }
  });
}

async function coldStream(video: Page) {
  await video.route("https://collection.sharepoint.com/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/cold-captions.vtt")
      return route.fulfill({
        status: 200,
        contentType: "text/vtt;charset=utf-8",
        body: coldVtt,
      });
    if (!url.searchParams.has("coldFixture")) return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "text/html;charset=utf-8",
      body: `<!doctype html><html><head><meta charset="utf-8"><title>Cold transcript workshop</title></head><body><video controls></video><script>
      const names = ['Alex Morgan', 'Jordan Lee', 'Casey Chen'];
      const media = document.querySelector('video');
      Object.defineProperty(media, 'duration', { value: 250 });
      setTimeout(() => {
        const button = document.createElement('button');
        button.id = 'transcript-toggle';
        button.setAttribute('aria-controls', 'transcript-pane');
        button.innerHTML = '<i data-icon-name="SlideText"></i>記録';
        button.onclick = () => {
          const old = document.getElementById('transcript-pane');
          if (old) { old.remove(); return; }
          setTimeout(() => {
            if (!media.querySelector('track')) {
              const track = document.createElement('track'); track.kind = 'subtitles'; track.label = 'English'; track.srclang = 'en'; track.src = '/cold-captions.vtt'; media.append(track);
            }
            const panel = document.createElement('section'); panel.id = 'transcript-pane';
            const scroller = document.createElement('div'); scroller.id = 'cold-scroll'; scroller.style.cssText = 'height:220px;overflow-y:auto;position:relative';
            const canvas = document.createElement('div'); canvas.style.cssText = 'height:${coldCueCount * 60}px;position:relative';
            scroller.append(canvas); panel.append(scroller); document.body.append(panel);
            const render = () => {
              const start = Math.max(0, Math.floor(scroller.scrollTop / 60) - 2); canvas.replaceChildren();
              for (let i = start; i < Math.min(${coldCueCount}, start + 9); i++) {
                const row = document.createElement('div'); row.id = 'entry-' + i; row.style.cssText = 'position:absolute;top:' + i * 60 + 'px;height:60px';
                const header = document.createElement('div'); header.id = 'itemHeader-' + i;
                const speaker = document.createElement('span'); speaker.textContent = names[i % 3];
                const time = document.createElement('span'); time.id = 'Header-timestamp-' + i; time.textContent = Math.floor(i * 2 / 60) + ':' + String(i * 2 % 60).padStart(2,'0');
                const timing = document.createElement('div'); timing.append(time); header.append(speaker, timing);
                const text = document.createElement('div'); text.id = 'sub-entry-' + i; text.setAttribute('aria-setsize', '${coldCueCount}'); text.textContent = 'Cold recording caption ' + (i + 1) + '.';
                row.append(header, text); canvas.append(row);
              }
            };
            scroller.addEventListener('scroll', () => { if (!document.hidden) requestAnimationFrame(render); });
            document.addEventListener('visibilitychange', () => { if (!document.hidden && panel.isConnected) requestAnimationFrame(render); });
            render();
          }, 250);
        };
        document.body.append(button);
      }, 900);
    </script></body></html>`,
    });
  });
  await video.goto(`${urls[0]}&coldFixture=1`);
}
async function storedCollection(page: Page, id: number) {
  return page.evaluate(
    async (id) =>
      (await chrome.storage.session.get(`collection:${id}`))[
        `collection:${id}`
      ] as RecordingCollection,
    id,
  );
}

for (const sourceVisibility of ["visible", "hidden"] as const) {
  test(`cold Stream DOM fallback preserves captions with source ${sourceVisibility}`, async () => {
    test.setTimeout(60000);
    test.skip(
      sourceVisibility === "hidden" && process.env.HEADED !== "1",
      "A real background tab requires a headed browser; run with HEADED=1.",
    );
    const video = await context.newPage();
    await coldStream(video);
    const id = await tabId(video);
    const page = await workspace(video, id);
    if (sourceVisibility === "visible") await video.bringToFront();
    else await page.bringToFront();
    await page.evaluate(
      async ({ id, visible }) => {
        const tab = visible ? { id } : await chrome.tabs.getCurrent();
        await chrome.tabs.update(tab!.id!, { active: true });
      },
      { id, visible: sourceVisibility === "visible" },
    );
    await expect
      .poll(() => video.evaluate(() => document.visibilityState))
      .toBe(sourceVisibility);
    await expect(video.locator("#transcript-pane")).toHaveCount(0);
    await expect(video.locator("track")).toHaveCount(0);
    // Begin through the extension's real message boundary without changing the
    // foreground tab: this isolates visibility from the workspace interaction.
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
      .poll(async () => (await storedCollection(page, id)).phase, {
        timeout: sourceVisibility === "hidden" ? 25000 : 45000,
      })
      .toBe("ready");
    const state = await storedCollection(page, id);
    const transcript = state.parts[0].tracks[0].transcript;
    expect(transcript.cues).toHaveLength(coldCueCount);
    expect(transcript.cues.at(-1)?.text).toBe(coldCaption(coldCueCount - 1));
    const named = transcript.cues.filter((cue) => cue.speaker).length;
    if (sourceVisibility === "visible") {
      expect(named).toBe(coldCueCount);
      expect(new Set(transcript.cues.map((cue) => cue.speaker)).size).toBe(3);
    } else {
      expect(named).toBeLessThan(coldCueCount);
      expect(transcript.warnings.join(" ")).toMatch(
        /visible|foreground|background|speaker/i,
      );
      await expect(page.locator(".part-warning")).not.toHaveCount(0);
    }
    await expect(video.locator("#transcript-pane")).toHaveCount(0);
    await page.close();
    await video.close();
  });
}
