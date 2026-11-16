import { defineConfig } from "@playwright/test";

// Runs the specs the recorder writes into ./generated.
export default defineConfig({
  testDir: "./generated",
  testMatch: /.*\.spec\.ts/,
  use: { headless: true },
});
