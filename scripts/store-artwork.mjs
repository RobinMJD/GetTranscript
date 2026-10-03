// Render Store artwork from the actual development UI and fictional demo data.
// Run: node scripts/store-artwork.mjs
// Optional: BROWSER_BIN=/path/to/chrome-for-testing
import { createServer } from "vite";
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const server = await createServer({
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
let browser;
try {
  await server.listen();
  const base = server.resolvedUrls.local[0];
  browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_BIN
      ? { executablePath: process.env.BROWSER_BIN }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });
  context.setDefaultTimeout(15000);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error")
      errors.push(`${message.text()} ${message.location().url}`);
  });
  await mkdir("docs/images", { recursive: true });

  await page.goto(new URL("scripts/store-preview.html", base).href);
  const popup = page.frameLocator("iframe");
  await popup.getByText("Weekly project sync", { exact: true }).waitFor();
  await popup.locator("#format").selectOption("md");
  await popup
    .getByRole("button", { name: "Download MD", exact: true })
    .waitFor();
  await popup.locator("#format").selectOption("vtt");
  await popup
    .getByRole("button", { name: "Download VTT", exact: true })
    .waitFor();
  await popup
    .getByRole("button", { name: "More options", exact: true })
    .click();
  await popup.getByRole("button", { name: /Combine recordings/ }).waitFor();
  await popup
    .getByRole("button", { name: "More options", exact: true })
    .click();
  if (await popup.getByText("Detected language", { exact: true }).count()) {
    throw new Error(
      "Popup artwork still contains a whole-transcript language field.",
    );
  }
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: path.resolve("docs/images/store-1280x800.png"),
    animations: "disabled",
  });

  await page.goto(new URL("collection.html?demo", base).href);
  await page.getByText("All recordings are ready", { exact: true }).waitFor();
  await page.getByLabel("Format", { exact: true }).selectOption("vtt");
  await page
    .getByRole("button", { name: "Download VTT", exact: true })
    .waitFor();
  const advanced = page.locator("summary");
  await advanced.click();
  if (!(await page.locator("details").evaluate((element) => element.open))) {
    throw new Error("Advanced options did not open.");
  }
  await advanced.click();
  if (
    await page.locator(".part").getByText("English", { exact: true }).count()
  ) {
    throw new Error(
      "Collection artwork still contains a single-language badge.",
    );
  }
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: path.resolve("docs/images/store-collection-1280x800.png"),
    animations: "disabled",
  });
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "Rendered both Store images at 1280x800 from current fictional demos; interactions and console checks passed.",
  );
} finally {
  await browser?.close();
  await server.close();
}
