import { chromium, type BrowserContext } from "@playwright/test";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Real tab visibility: the normal Playwright launcher forces focus emulation. */
export async function nativeContext(
  profile: string,
  extension: string,
): Promise<{
  context: BrowserContext;
  close: () => Promise<void>;
}> {
  const process = spawn(
    globalThis.process.env.BROWSER_BIN || chromium.executablePath(),
    [
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let launchError: Error | undefined;
  process.once("error", (error) => {
    launchError = error;
  });
  try {
    let port = "";
    const deadline = Date.now() + 15000;
    while (!port) {
      if (launchError) throw launchError;
      if (process.exitCode !== null)
        throw new Error("Fixture browser exited before connecting.");
      try {
        port = (
          await readFile(path.join(profile, "DevToolsActivePort"), "utf8")
        ).split("\n")[0];
      } catch {
        if (Date.now() > deadline)
          throw new Error("Fixture browser did not expose its debugging port.");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
      noDefaults: true,
    });
    return {
      context: browser.contexts()[0],
      close: async () => {
        await browser.close();
        process.kill("SIGTERM");
        if (process.exitCode === null)
          await new Promise<void>((resolve) =>
            process.once("exit", () => resolve()),
          );
      },
    };
  } catch (error) {
    process.kill("SIGTERM");
    throw error;
  }
}
