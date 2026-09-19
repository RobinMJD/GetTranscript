import { test, expect, chromium } from "@playwright/test";
import { mkdtemp, cp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { generateKeyPairSync, createHash } from "node:crypto";
import path from "node:path";

test("real toolbar popup stays compact and usable through every state", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "gettranscript-toolbar-")),
    ext = path.join(folder, "extension");
  await cp("dist", ext, { recursive: true });
  const key = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  }).publicKey.export({ type: "spki", format: "der" });
  const id = createHash("sha256")
    .update(key)
    .digest("hex")
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
  const manifest = JSON.parse(
    await readFile(path.join(ext, "manifest.json"), "utf8"),
  );
  manifest.key = key.toString("base64");
  manifest.host_permissions = ["https://fixture.example/*"];
  await writeFile(path.join(ext, "manifest.json"), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(
    path.join(folder, "profile"),
    {
      channel: "chromium",
      executablePath: process.env.BROWSER_BIN,
      headless: false,
      viewport: null,
      args: [
        `--disable-extensions-except=${ext}`,
        `--load-extension=${ext}`,
        "--no-first-run",
        ...(process.env.TOOLBAR_SCALE
          ? [`--force-device-scale-factor=${process.env.TOOLBAR_SCALE}`]
          : []),
      ],
    },
  );
  const errors: string[] = [];
  context.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
  const artifacts = process.env.TOOLBAR_ARTIFACTS;
  if (artifacts) await mkdir(artifacts, { recursive: true });
  const markup =
    '<!doctype html><meta charset="utf-8"><title>Weekly project sync</title><video controls></video><script>const t=document.querySelector("video").addTextTrack("subtitles","English","en");t.mode="hidden";t.addCue(new VTTCue(9,14,"<v Alex Morgan>Let’s start with the project updates.</v>"));t.addCue(new VTTCue(16,21,"<v Jordan Lee>The first milestone is ready to review.</v>"));</script>';
  await context.route("https://fixture.example/**", (r) =>
    r.fulfill({ contentType: "text/html; charset=utf-8", body: markup }),
  );
  try {
    const video = await context.newPage();
    await video.goto("https://fixture.example/video");
    const helper = await context.newPage();
    await helper.goto(`chrome-extension://${id}/help.html`);
    const targetId = await helper.evaluate(
      async () =>
        (await chrome.tabs.query({})).find(
          (t) => t.url === "https://fixture.example/video",
        )!.id!,
    );
    const control = await context.newCDPSession(helper);
    let sequence = 0;
    const pending = new Map<
      number,
      { resolve: (v: any) => void; reject: (e: Error) => void }
    >();
    control.on("Target.receivedMessageFromTarget", (event) => {
      const data = JSON.parse(event.message);
      if (data.method === "Runtime.exceptionThrown")
        errors.push(data.params.exceptionDetails.text);
      const request = pending.get(data.id);
      if (request) {
        pending.delete(data.id);
        if (data.error) request.reject(new Error(data.error.message));
        else request.resolve(data.result);
      }
    });
    const open = async () => {
      await helper.evaluate(async (id) => {
        await chrome.tabs.update(id, { active: true });
        await chrome.action.openPopup();
      }, targetId);
      let target: string | undefined;
      await expect
        .poll(async () => {
          target = (await control.send("Target.getTargets")).targetInfos.find(
            (t) => t.url === `chrome-extension://${id}/index.html`,
          )?.targetId;
          return !!target;
        })
        .toBe(true);
      const { sessionId } = await control.send("Target.attachToTarget", {
        targetId: target!,
        flatten: false,
      });
      const send = (method: string, params: Record<string, unknown> = {}) =>
        new Promise<any>((resolve, reject) => {
          const requestId = ++sequence;
          const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error(`Popup command timed out: ${method}`));
          }, 8000);
          pending.set(requestId, {
            resolve: (v) => {
              clearTimeout(timer);
              resolve(v);
            },
            reject: (e) => {
              clearTimeout(timer);
              reject(e);
            },
          });
          void control
            .send("Target.sendMessageToTarget", {
              sessionId,
              message: JSON.stringify({ id: requestId, method, params }),
            })
            .catch(reject);
        });
      await send("Runtime.enable");
      const read = async (expression: string) => {
        const result = await send("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        if (result.exceptionDetails)
          throw new Error(result.exceptionDetails.text);
        return result.result.value;
      };
      return {
        read,
        send,
        close: () => control.send("Target.closeTarget", { targetId: target! }),
      };
    };
    let popup = await open();
    const ready = async () =>
      expect
        .poll(() =>
          popup.read(`!!document.querySelector('.primary:not(:disabled)')`),
        )
        .toBe(true);
    const measure = async (max: number) => {
      await expect
        .poll(() =>
          popup.read(
            `Math.abs(innerHeight-document.querySelector('.shell').getBoundingClientRect().height)<1`,
          ),
        )
        .toBe(true);
      const size = await popup.read(
        `({width:innerWidth,height:innerHeight,docWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,shell:document.querySelector('.shell').getBoundingClientRect().height})`,
      );
      expect(size.width).toBe(520);
      expect(size.docWidth).toBe(520);
      expect(size.bodyWidth).toBe(520);
      expect(size.height).toBeLessThanOrEqual(max);
      expect(size.shell).toBeLessThanOrEqual(max);
      console.log(
        JSON.stringify({ state: max === 560 ? "ready" : "compact", ...size }),
      );
    };
    const screenshot = async (name: string) => {
      if (artifacts) {
        const r = await popup.send("Page.captureScreenshot", { format: "png" });
        await writeFile(
          path.join(artifacts, name),
          Buffer.from(r.data, "base64"),
        );
      }
    };
    await ready();
    await measure(560);
    expect(
      await popup.read(
        `document.body.innerText.includes('Let’s start with the project updates.')`,
      ),
    ).toBe(true);
    await screenshot("popup-ready.png");
    await popup.read(`document.querySelectorAll('select')[1].focus()`);
    expect(
      await popup.read(
        `document.activeElement===document.querySelectorAll('select')[1]`,
      ),
    ).toBe(true);
    // Native platform select menus are outside the renderer; exercise the same change event
    // here and verify native keyboard operation separately on desktop.
    await popup.read(
      `{const select=document.querySelectorAll('select')[1];select.value='md';select.dispatchEvent(new Event('change',{bubbles:true}));}`,
    );
    await expect
      .poll(() =>
        popup.read(`document.querySelector('.primary').textContent.trim()`),
      )
      .toBe("Download MD");
    await popup.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
    });
    await popup.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
    });
    expect(
      await popup.read(`document.activeElement?.getAttribute('role')`),
    ).toBe("switch");
    await popup.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: " ",
      code: "Space",
      windowsVirtualKeyCode: 32,
    });
    await popup.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: " ",
      code: "Space",
      windowsVirtualKeyCode: 32,
    });
    expect(
      await popup.read(`document.querySelector('[role="switch"]').checked`),
    ).toBe(false);
    await popup.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: " ",
      code: "Space",
      windowsVirtualKeyCode: 32,
    });
    await popup.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: " ",
      code: "Space",
      windowsVirtualKeyCode: 32,
    });
    await video.evaluate(() => {
      document.title = "A very long meeting title ".repeat(16);
      const longTrack = document
        .querySelector("video")!
        .addTextTrack(
          "subtitles",
          "English with a very long regional caption label ".repeat(6),
          "en",
        );
      longTrack.mode = "hidden";
      longTrack.addCue(
        new VTTCue(
          0,
          3,
          `<v ${"Alexandra Morgan ".repeat(10)}>A caption with a long speaker name.</v>`,
        ),
      );
      document
        .querySelector("video")!
        .textTracks[0].addCue(
          new VTTCue(
            25,
            28,
            "<v ليلى أحمد>مراجعة الخطوات التالية باللغة العربية.</v>",
          ),
        );
    });
    await popup.read(
      `document.querySelector('[aria-label="Refresh transcript"]').click()`,
    );
    await expect
      .poll(() => popup.read(`document.body.innerText.includes('3 captions')`))
      .toBe(true);
    await measure(560);
    expect(
      await popup.read(
        `Array.from(document.querySelectorAll('.preview-row p')).find(e=>e.textContent.includes('مراجعة')).closest('[dir]').getAttribute('dir')`,
      ),
    ).toBe("auto");
    await popup.read(
      `{const language=document.querySelector('select');language.selectedIndex=1;language.dispatchEvent(new Event('change',{bubbles:true}));}`,
    );
    await expect
      .poll(() =>
        popup.read(
          `document.body.innerText.includes('A caption with a long speaker name.')`,
        ),
      )
      .toBe(true);
    await measure(560);
    expect(
      await popup.read(
        `Array.from(document.querySelectorAll('select,.icon-button,.primary')).every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})`,
      ),
    ).toBe(true);
    await popup.read(
      `chrome.downloads.download=async()=>{throw new Error('Download was interrupted. Try again.')};document.querySelector('.primary').click()`,
    );
    await expect
      .poll(() =>
        popup.read(
          `document.querySelector('[role="alert"]')?.textContent || ''`,
        ),
      )
      .toContain("Download was interrupted");
    await measure(560);
    await popup.close();
    await video.evaluate(() => {
      document.body.replaceChildren();
      document.title = "Empty page";
    });
    popup = await open();
    await expect
      .poll(() =>
        popup.read(`document.body.innerText.includes('No captions found yet')`),
      )
      .toBe(true);
    await measure(330);
    expect(await popup.read(`!!document.querySelector('.primary')`)).toBe(
      false,
    );
    await screenshot("popup-empty.png");
    await popup.close();
    await video.goto("about:blank");
    popup = await open();
    await expect
      .poll(() =>
        popup.read(`document.body.innerText.includes('Open a video page')`),
      )
      .toBe(true);
    await measure(330);
    await screenshot("popup-restricted.png");
    await popup.close();
    await context.route("https://fixture.example/slow.vtt", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1800));
      await route.fulfill({
        contentType: "text/vtt",
        body: "WEBVTT\n\n00:00.000 --> 00:02.000\nA caption after loading.\n",
      });
    });
    await video.goto("https://fixture.example/video");
    await video.evaluate(() => {
      document.body.innerHTML =
        '<video><track kind="subtitles" label="English" srclang="en" src="/slow.vtt"></video>';
    });
    popup = await open();
    await expect
      .poll(() =>
        popup.read(`document.querySelector('main')?.getAttribute('aria-busy')`),
      )
      .toBe("true");
    await measure(360);
    expect(await popup.read(`!!document.querySelector('.primary')`)).toBe(
      false,
    );
    await screenshot("popup-loading.png");
    await ready();
    await popup.close();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await rm(folder, { recursive: true, force: true });
  }
});
