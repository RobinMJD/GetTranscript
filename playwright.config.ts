import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  timeout: 60000,
  workers: 1,
  reporter: "line",
  outputDir: "test-results",
  use: { headless: true },
});
