import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/toolbar",
  timeout: 60000,
  workers: 1,
  reporter: "line",
  outputDir: "test-results/toolbar",
});
