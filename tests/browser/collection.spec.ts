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

let context: BrowserContext, folder: string, extensionId: string;
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
  context = await chromium.launchPersistentContext(
    path.join(folder, "profile"),
    {
      channel: "chromium",
      executablePath: process.env.BROWSER_BIN,
      headless: true,
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
  await context?.close();
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
  ).toBeEnabled();
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
