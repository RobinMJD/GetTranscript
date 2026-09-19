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
import { build } from "esbuild";

let context: BrowserContext,
  folder: string,
  extensionId: string,
  collector: string;
const runtimeErrors: string[] = [];
const fixtureVtt =
  "WEBVTT\n\nmeeting/1-0\n00:00:09.651 --> 00:00:14.091\n<v Alex Morgan>Let’s start with the project updates.</v>\n\nmeeting/2-0\n00:00:16.731 --> 00:00:20.527\n<v Jordan Lee>The first milestone is ready to review.</v>\n\nmeeting/3-0\n00:00:21.000 --> 00:00:23.000\n<v Casey Chen>I will share the next steps.</v>\n";
const fixtureUrl =
  "https://fixture.sharepoint.com/personal/demo/_layouts/15/stream.aspx";
const html = `<!doctype html><html><head><title>Weekly project sync</title></head><body><video controls><track default kind="subtitles" label="English" srclang="en" src="/captions.vtt"></video></body></html>`;

test.beforeAll(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "gettranscript-browser-"));
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
  // Test-only permissions are confined to intercepted fixture origins, never the package.
  manifest.key = key.toString("base64");
  manifest.host_permissions = ["https://fixture.sharepoint.com/*"];
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
    page.on("pageerror", (error) => runtimeErrors.push(error.message)),
  );
  // Playwright's default allowAndName replaces real filenames with UUIDs.
  // Keep normal Chrome download naming in this disposable browser profile.
  const setup = await context.newPage();
  const session = await context.newCDPSession(setup);
  await session.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: path.join(folder, "downloads"),
  });
  await setup.close();
  await context.route("https://fixture.sharepoint.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: route.request().url().endsWith(".vtt")
        ? "text/vtt"
        : "text/html",
      body: route.request().url().endsWith(".vtt") ? fixtureVtt : html,
    }),
  );
  const bundle = await build({
    entryPoints: ["src/extractor/collect.ts"],
    bundle: true,
    format: "iife",
    globalName: "GetTranscriptExtractor",
    write: false,
    target: "chrome120",
  });
  collector = bundle.outputFiles[0].text;
});
test.afterAll(async () => {
  await context?.close();
  if (folder) await rm(folder, { recursive: true, force: true });
  expect(runtimeErrors).toEqual([]);
});
async function openPopup(target: Page) {
  const helper = await context.newPage();
  await helper.goto(`chrome-extension://${extensionId}/help.html`);
  const targetId = await helper.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => t.url === url)!.id;
  }, target.url());
  await helper.close();
  const popup = await context.newPage();
  // A tab-rendered popup lacks toolbar activeTab activation. Only redirect tab selection;
  // production scripting, MAIN-world extraction, storage and downloads run unchanged.
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
    { id: targetId, url: target.url() },
  );
  await popup.goto(`chrome-extension://${extensionId}/index.html`);
  // A real toolbar popup leaves the video tab active. Keep that behavior here too;
  // background-tab throttling otherwise delays source timers and virtualized rows.
  await target.bringToFront();
  return popup;
}

test("loaded extension exports all five formats and persists preferences", async () => {
  const video = await context.newPage();
  await video.goto(fixtureUrl);
  const popup = await openPopup(video);
  await expect(
    popup.getByRole("button", { name: "Download VTT" }),
  ).toBeEnabled();
  await expect(popup.getByText("3 captions", { exact: true })).toBeVisible();
  await expect(popup.getByText("3 speakers", { exact: true })).toBeVisible();
  for (const [format, needle] of [
    ["vtt", "<v Alex Morgan>"],
    ["srt", "Alex Morgan:"],
    ["txt", "[00:00:09.651]"],
    ["md", "**00:00:09.651"],
    ["json", '"timeUnit": "seconds"'],
  ]) {
    await popup.getByLabel(/^Format/).selectOption(format);
    await popup
      .getByRole("button", { name: `Download ${format.toUpperCase()}` })
      .click();
    await expect(popup.getByRole("status")).toHaveText(
      "Saved to your browser’s downloads.",
    );
    const download = await popup.evaluate(async () => {
      const items = await chrome.downloads.search({
        orderBy: ["-startTime"],
        limit: 1,
      });
      return items[0];
    });
    expect(download.state).toBe("complete");
    expect(download.filename).toMatch(new RegExp(`\\.${format}$`));
    const saved = await readFile(download.filename, "utf8");
    expect(saved).toContain(needle);
    expect(saved).toContain("Let’s start");
  }
  await popup.close();
  const again = await openPopup(video);
  await expect(again.getByLabel(/^Format/)).toHaveValue("json");
  await again.close();
  await video.close();
});

test("virtualized Stream transcript yields complete speaker rows and restores scroll", async () => {
  const video = await context.newPage();
  await video.goto(fixtureUrl);
  await video.evaluate(() => {
    const scroller = document.createElement("div");
    scroller.id = "transcript-test";
    scroller.style.cssText = "height:220px;overflow-y:auto;position:relative";
    const canvas = document.createElement("div");
    canvas.style.cssText = "height:6000px;position:relative";
    scroller.append(canvas);
    document.body.append(scroller);
    const render = () => {
      const start = Math.max(0, Math.floor(scroller.scrollTop / 60) - 2);
      canvas.replaceChildren();
      for (let i = start; i < Math.min(100, start + 9); i++) {
        const entry = document.createElement("div");
        entry.id = `entry-${i}`;
        entry.setAttribute(
          "aria-label",
          `Speaker ${i % 3} ${Math.floor(i / 60)} minutes ${i % 60} seconds`,
        );
        entry.style.cssText = `position:absolute;top:${i * 60}px;height:60px`;
        const text = document.createElement("div");
        text.id = `sub-entry-${i}`;
        text.setAttribute("aria-setsize", "100");
        text.textContent = `Utterance ${i}`;
        entry.append(text);
        const header = document.createElement("div");
        header.id = `itemHeader-${i}`;
        header.innerHTML = `<span>Speaker ${i % 3}</span><div><span id="Header-timestamp-${i}">${Math.floor(i / 60)}:${String(i % 60).padStart(2, "0")}</span></div>`;
        entry.prepend(header);
        canvas.append(entry);
      }
    };
    scroller.addEventListener("scroll", render);
    scroller.scrollTop = 2400;
    render();
  });
  const result = await video.evaluate(async (code) => {
    return await (0, eval)(
      `(()=>{${code};return GetTranscriptExtractor.collectPage({speakers:true,prepare:false});})()`,
    );
  }, collector);
  expect(result.rows).toHaveLength(100);
  expect(result.completeRows).toBe(true);
  expect(
    await video.locator("#transcript-test").evaluate((el) => el.scrollTop),
  ).toBe(2400);
  await video.close();
});

test("unsupported page shows an actionable empty state and cannot download", async () => {
  const video = await context.newPage();
  await video.goto(fixtureUrl);
  await video.locator("video").evaluate((el) => el.remove());
  const popup = await openPopup(video);
  await expect(
    popup.getByRole("heading", { name: "No captions found yet" }),
  ).toBeVisible({ timeout: 10000 });
  await expect(popup.getByRole("button", { name: /Download/ })).toHaveCount(0);
  expect(
    await popup
      .locator(".shell")
      .evaluate((e) => e.getBoundingClientRect().height),
  ).toBeLessThan(320);
  await popup.close();
  await video.close();
});

test("speaker toggles change actual output without modifying source timings", async () => {
  const video = await context.newPage();
  await video.goto(fixtureUrl);
  const popup = await openPopup(video);
  await popup.getByLabel(/^Format/).selectOption("vtt");
  await popup
    .getByRole("switch", { name: "Show names in captions", exact: true })
    .check();
  await popup.getByRole("button", { name: "Download VTT" }).click();
  await expect(popup.getByRole("status")).toHaveText(
    "Saved to your browser’s downloads.",
  );
  let file = await popup.evaluate(
    async () =>
      (await chrome.downloads.search({ orderBy: ["-startTime"], limit: 1 }))[0]
        .filename,
  );
  expect(await readFile(file, "utf8")).toContain("<v Alex Morgan>Alex Morgan:");
  await popup.getByRole("switch", { name: /Include speaker names/ }).uncheck();
  await popup.getByRole("button", { name: "Download VTT" }).click();
  await expect(popup.getByRole("status")).toHaveText(
    "Saved to your browser’s downloads.",
  );
  file = await popup.evaluate(
    async () =>
      (await chrome.downloads.search({ orderBy: ["-startTime"], limit: 1 }))[0]
        .filename,
  );
  const plain = await readFile(file, "utf8");
  expect(plain).not.toContain("Alex Morgan");
  expect(plain).toContain("00:00:09.651 --> 00:00:14.091");
  await popup.close();
  await video.close();
});

test("cold Stream player loads captions and restores the caption menu", async () => {
  const video = await context.newPage();
  await video.goto(fixtureUrl);
  await video.evaluate((vtt) => {
    document.body.replaceChildren();
    setTimeout(() => {
      document.body.innerHTML =
        '<video><track kind="subtitles" label="English" srclang="en"></video><button role="menuitem" aria-label="Captions" aria-expanded="false"><i data-icon-name="ClosedCaptions"></i>Captions</button>';
      const button = document.querySelector("button")!;
      let selected = "Off";
      button.onclick = () => {
        const oldMenu = document.getElementById("caption-menu");
        if (oldMenu) {
          oldMenu.remove();
          button.setAttribute("aria-expanded", "false");
          return;
        }
        button.setAttribute("aria-expanded", "true");
        const menu = document.createElement("div");
        menu.id = "caption-menu";
        for (const label of ["Off", "English"]) {
          const item = document.createElement("button");
          item.role = "menuitemradio";
          item.textContent = label;
          item.setAttribute("aria-checked", String(selected === label));
          item.onclick = () => {
            selected = label;
            button.dataset.selected = label;
            if (label === "English")
              document.querySelector("track")!.src = URL.createObjectURL(
                new Blob([vtt], { type: "text/vtt" }),
              );
            menu.remove();
            button.setAttribute("aria-expanded", "false");
          };
          menu.append(item);
        }
        document.body.append(menu);
      };
    }, 200);
  }, fixtureVtt);
  const result = await video.evaluate(
    async (code) =>
      await (0, eval)(
        `(()=>{${code};return GetTranscriptExtractor.collectPage({speakers:false,prepare:true});})()`,
      ),
    collector,
  );
  expect(result.tracks).toHaveLength(1);
  expect(result.tracks[0].vtt).toBe(fixtureVtt);
  await expect(
    video.getByRole("menuitem", { name: "Captions", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(
    video.getByRole("menuitem", { name: "Captions", exact: true }),
  ).toHaveAttribute("data-selected", "Off");
  expect(
    await video
      .locator("track")
      .evaluate((el) => (el as HTMLTrackElement).track.mode),
  ).toBe("disabled");
  await video.close();
});

for (const locale of ["en", "fr", "de", "es", "ja", "ar"]) {
  test(`localized Stream controls and speaker metadata: ${locale}`, async () => {
    const video = await context.newPage();
    await video.goto(fixtureUrl);
    await video.evaluate(
      ({ locale, vtt }) => {
        document.documentElement.lang = locale;
        const digit = new Intl.NumberFormat(locale, { useGrouping: false });
        const name =
          locale === "ar"
            ? "ليلى أحمد"
            : locale === "ja"
              ? "田中 花子"
              : "Alex 2 Morgan";
        const duration = (sec: number) =>
          `${new Intl.NumberFormat(locale, { style: "unit", unit: "minute", unitDisplay: "long" }).format(0)} ${new Intl.NumberFormat(locale, { style: "unit", unit: "second", unitDisplay: "long" }).format(sec)}`;
        document.body.innerHTML =
          '<video><track kind="subtitles"></video><button role="menuitem" aria-label="任意のラベル" aria-expanded="false"><i data-icon-name="SlideText"></i></button>';
        const track = document.querySelector("track")!;
        track.srclang = locale;
        track.label = new Intl.DisplayNames([locale], { type: "language" }).of(
          locale,
        )!;
        track.src = URL.createObjectURL(
          new Blob([vtt.replace(/<v [^>]+>|<\/v>/g, "")], { type: "text/vtt" }),
        );
        const button = document.querySelector("button")!;
        button.onclick = () => {
          const old = document.getElementById("transcript");
          if (old) {
            old.remove();
            button.setAttribute("aria-expanded", "false");
            return;
          }
          const panel = document.createElement("div");
          panel.id = "transcript";
          for (let i = 0; i < 3; i++) {
            const sec = [9, 16, 21][i];
            const row = document.createElement("div");
            row.id = `entry-${i}`;
            row.setAttribute("aria-label", `${name} ${duration(sec)}`);
            // Alternate full headers with consecutive rows that use locale-derived metadata.
            if (i !== 1) {
              const header = document.createElement("div");
              header.id = `itemHeader-${i}`;
              const speaker = document.createElement("span");
              speaker.textContent = name;
              const timing = document.createElement("div");
              const time = document.createElement("span");
              time.id = `Header-timestamp-${i}`;
              time.textContent = `${digit.format(0)}:${digit.format(sec).padStart(2, "0")}`;
              timing.append(time);
              header.append(speaker, timing);
              row.append(header);
            }
            const text = document.createElement("div");
            text.id = `sub-entry-${i}`;
            text.setAttribute("aria-setsize", "3");
            text.textContent = [
              "Let’s start with the project updates.",
              "The first milestone is ready to review.",
              "I will share the next steps.",
            ][i];
            row.append(text);
            panel.append(row);
          }
          document.body.append(panel);
          button.setAttribute("aria-expanded", "true");
        };
      },
      { locale, vtt: fixtureVtt },
    );
    const result = await video.evaluate(
      async (code) =>
        await (0, eval)(
          `(()=>{${code};return GetTranscriptExtractor.collectPage({speakers:true,prepare:true});})()`,
        ),
      collector,
    );
    expect(result.rows).toHaveLength(3);
    expect(result.rows.map((r: { start: number }) => r.start)).toEqual([
      9, 16, 21,
    ]);
    expect(result.rows.every((r: { speaker: string }) => !!r.speaker)).toBe(
      true,
    );
    expect(result.tracks[0].language).toBe(locale);
    expect(result.completeRows).toBe(true);
    await expect(video.locator('button[role="menuitem"]')).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    const popup = await openPopup(video);
    await expect(popup.getByText("1 speaker", { exact: true })).toBeVisible();
    await expect(popup.getByRole("button", { name: /Download/ })).toBeEnabled();
    expect(
      await popup
        .locator("html")
        .evaluate((e) => e.getBoundingClientRect().width),
    ).toBe(520);
    expect(
      await popup
        .locator(".shell")
        .evaluate((e) => e.getBoundingClientRect().height),
    ).toBeLessThanOrEqual(560);
    await popup.close();
    await video.close();
  });
}

test("restricted Store page has a compact explanation and never injects", async () => {
  const target = await context.newPage();
  await target.goto(fixtureUrl);
  const popup = await openPopup(target);
  await popup.evaluate(() => {
    chrome.tabs.query = async () =>
      [
        {
          id: 999,
          url: "https://microsoftedge.microsoft.com/addons/detail/sample",
          active: true,
        },
      ] as chrome.tabs.Tab[];
    chrome.scripting.executeScript = async () => {
      throw new Error("Injection must not run");
    };
  });
  await popup.getByRole("button", { name: "Refresh transcript" }).click();
  await expect(
    popup.getByRole("heading", { name: "Open a video page" }),
  ).toBeVisible();
  await expect(popup.getByRole("button", { name: /Download/ })).toHaveCount(0);
  expect(
    await popup
      .locator(".shell")
      .evaluate((e) => e.getBoundingClientRect().height),
  ).toBeLessThan(330);
  await popup.close();
  await target.close();
});

test("failed downloads retain the transcript and allow retry", async () => {
  const video = await context.newPage();
  await video.goto(fixtureUrl);
  const popup = await openPopup(video);
  await expect(popup.getByRole("button", { name: /Download/ })).toBeEnabled();
  await popup.evaluate(() => {
    chrome.downloads.download = async () => {
      throw new Error("Download was interrupted. Try again.");
    };
  });
  await popup.getByRole("button", { name: /Download/ }).click();
  await expect(popup.getByRole("alert")).toContainText(
    "Download was interrupted",
  );
  await expect(popup.getByRole("button", { name: /Download/ })).toBeEnabled();
  await expect(popup.getByLabel(/^Language/)).toBeVisible();
  await popup.close();
  await video.close();
});

test("every exposed language is read, including independently lazy caption tracks", async () => {
  const video = await context.newPage();
  await video.goto(fixtureUrl);
  await video.evaluate(() => {
    document.body.innerHTML =
      '<video></video><button role="menuitem" aria-expanded="true"><i data-icon-name="ClosedCaptions"></i></button>';
    const media = document.querySelector("video")!;
    const languages = [
      "en",
      "fr",
      "de",
      "es",
      "ja",
      "ar",
      "it",
      "pt",
      "nl",
      "sv",
      "pl",
      "hi",
      "zh",
      "ko",
    ];
    const labels = new Intl.DisplayNames(["en"], { type: "language" });
    for (const language of languages) {
      const track = document.createElement("track");
      track.kind = "subtitles";
      track.srclang = language;
      track.label = labels.of(language)!;
      media.append(track);
    }
    const toggle = document.querySelector("button")!;
    let selected = "—";
    toggle.dataset.selected = selected;
    const render = () => {
      const menu = document.createElement("div");
      menu.role = "menu";
      menu.id = "languages";
      for (const label of [
        "—",
        ...Array.from(media.querySelectorAll("track")).map((t) => t.label),
      ]) {
        const item = document.createElement("button");
        item.role = "menuitemradio";
        item.textContent = label;
        item.setAttribute("aria-checked", String(selected === label));
        item.onclick = () => {
          selected = label;
          toggle.dataset.selected = label;
          for (const track of media.querySelectorAll("track")) {
            track.track.mode = track.label === label ? "showing" : "disabled";
            if (track.label === label)
              track.src = URL.createObjectURL(
                new Blob(
                  [
                    `WEBVTT\n\n00:00.000 --> 00:02.000\nLanguage ${track.srclang}\n`,
                  ],
                  { type: "text/vtt" },
                ),
              );
          }
          menu.remove();
          toggle.setAttribute("aria-expanded", "false");
        };
        menu.append(item);
      }
      document.body.append(menu);
    };
    toggle.onclick = () => {
      const old = document.getElementById("languages");
      if (old) {
        old.remove();
        toggle.setAttribute("aria-expanded", "false");
      } else {
        toggle.setAttribute("aria-expanded", "true");
        // Cold choices can mount after the menu itself has expanded.
        setTimeout(render, 180);
      }
    };
    render();
    // An unrelated radio menu must not be mistaken for the caption selection.
    const unrelated = document.createElement("div");
    unrelated.role = "menu";
    unrelated.innerHTML =
      '<button role="menuitemradio" aria-checked="true">Speed setting</button>';
    document.body.prepend(unrelated);
  });
  const result = await video.evaluate(
    async (code) =>
      await (0, eval)(
        `(()=>{${code};return GetTranscriptExtractor.collectPage({speakers:false,prepare:true});})()`,
      ),
    collector,
  );
  expect(result.tracks).toHaveLength(14);
  for (const track of result.tracks)
    expect(track.vtt).toContain(`Language ${track.language}`);
  await expect(video.locator('button[role="menuitem"]')).toHaveAttribute(
    "data-selected",
    "—",
  );
  await expect(video.locator('button[role="menuitem"]')).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(
    await video
      .locator("track")
      .evaluateAll((es) =>
        es.every((e) => (e as HTMLTrackElement).track.mode === "disabled"),
      ),
  ).toBe(true);
  await video.close();
});
