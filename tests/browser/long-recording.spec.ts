import { test, expect, chromium } from "@playwright/test";
import { build } from "esbuild";
import type { PageCapture, RowCursor } from "../../src/lib/types";

test("long virtualized recordings resume without reloading tracks and restore the player", async () => {
  test.setTimeout(120_000);
  const browser = await chromium.launch({
    channel: "chromium",
    executablePath: process.env.BROWSER_BIN,
    headless: true,
  });
  const page = await browser.newPage();
  const source =
    "https://fixture.sharepoint.com/personal/demo/_layouts/15/stream.aspx?id=%2Flong.mp4";
  let fetches = 0;
  await page.route("https://fixture.sharepoint.com/**", async (route) => {
    if (route.request().url().endsWith(".vtt")) {
      fetches++;
      await route.fulfill({
        contentType: "text/vtt",
        body: "WEBVTT\n\n1\n00:00.000 --> 00:01.000\nHello\n",
      });
    } else
      await route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><title>Thirteen hour recording</title><video><track kind="subtitles" srclang="fr" label="French" src="/captions.vtt"></video><a href="?id=%2Fpart2.mp4&referrer=Stream">Part 2</a><a href="?id=%2Fpart2.mp4">Duplicate link</a><a href="https://another.sharepoint.com/_layouts/15/stream.aspx?id=%2Fsecret.mp4">Other tenant</a>',
      });
  });
  try {
    await page.goto(source + "&referrer=Stream");
    await page.evaluate(() => {
      Object.defineProperty(document.querySelector("video")!, "duration", {
        value: 46800.625,
      });
      const scroller = document.createElement("div");
      scroller.id = "long-transcript";
      scroller.style.cssText = "height:220px;overflow-y:auto;position:relative";
      const canvas = document.createElement("div");
      canvas.style.cssText = "height:39600px;position:relative";
      scroller.append(canvas);
      document.body.append(scroller);
      const render = () => {
        const first = Math.max(0, Math.floor(scroller.scrollTop / 60) - 2);
        canvas.replaceChildren();
        for (let i = first; i < Math.min(660, first + 9); i++) {
          const entry = document.createElement("div");
          entry.id = `entry-${i}`;
          entry.style.cssText = `position:absolute;top:${i * 60}px;height:60px`;
          const seconds = i * 70;
          const time = `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
          entry.innerHTML = `<div id="itemHeader-${i}"><span>Speaker ${i % 3}</span><div><span id="Header-timestamp-${i}">${time}</span></div></div><div id="sub-entry-${i}" aria-setsize="660">Utterance ${i}</div>`;
          canvas.append(entry);
        }
      };
      scroller.addEventListener("scroll", render);
      scroller.scrollTop = 2400;
      render();
    });
    const bundle = await build({
      entryPoints: ["src/extractor/collect.ts"],
      bundle: true,
      format: "iife",
      globalName: "LongRecordingExtractor",
      write: false,
      target: "chrome120",
    });
    const code = bundle.outputFiles[0].text;
    const rows = new Map<number, PageCapture["rows"][number]>();
    let resume: RowCursor | undefined;
    let chunks = 0;
    let initialFetches = 0;
    do {
      const result: PageCapture = await page.evaluate(
        async ({ code, resume }) => {
          return await (0, eval)(
            `(()=>{${code};return LongRecordingExtractor.collectPage(${JSON.stringify({ speakers: true, prepare: false, resume })});})()`,
          );
        },
        { code, resume },
      );
      chunks++;
      result.rows.forEach((row) => rows.set(row.index, row));
      if (chunks === 1) {
        expect(result.tracks).toHaveLength(1);
        expect(result.rowCursor).toBeDefined();
        expect(result.sourceUrl).toBe(source);
        expect(result.duration).toBe(46800.625);
        expect(result.linkedRecordings).toEqual([
          {
            url: source.replace("long.mp4", "part2.mp4"),
            title: "Duplicate link",
          },
        ]);
        initialFetches = fetches;
      } else {
        expect(result.tracks).toEqual([]);
        expect(fetches).toBe(initialFetches);
      }
      expect(
        await page.locator("#long-transcript").evaluate((el) => el.scrollTop),
      ).toBe(2400);
      expect(
        await page
          .locator("track")
          .evaluate((el: HTMLTrackElement) => el.track.mode),
      ).toBe("disabled");
      resume = result.rowCursor;
    } while (resume && chunks < 6);
    expect(resume).toBeUndefined();
    expect(chunks).toBeGreaterThan(1);
    expect(rows.size).toBe(660);
    expect(rows.get(659)).toMatchObject({
      text: "Utterance 659",
      start: 659 * 70,
      speaker: "Speaker 2",
    });
    await page.evaluate(() =>
      history.replaceState(null, "", "?id=%2Fother.mp4"),
    );
    await expect(
      page.evaluate(
        async ({ code, source }) => {
          return await (0, eval)(
            `(()=>{${code};return LongRecordingExtractor.collectPage(${JSON.stringify({ speakers: true, prepare: false, resume: { sourceUrl: source, nextScrollTop: 0, expectedRows: 660 } })});})()`,
          );
        },
        { code, source },
      ),
    ).rejects.toThrow("recording changed");
  } finally {
    await browser.close();
  }
});
