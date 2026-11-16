import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  workers: 1,
  globalSetup: "./tests/e2e/verify-isolated-runtime.ts",
  use: {
    baseURL: process.env.PW_BASE_URL ?? "http://127.0.0.1:8810",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // Optional: use an already-installed Chromium instead of downloading the pinned build.
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : undefined,
  },
  webServer: {
    command: "pnpm dev:e2e",
    url: "http://127.0.0.1:8810/api/health",
    // Opt-in only. Reusing an already-running 8810 server can accidentally hit the wrong DB.
    reuseExistingServer: process.env.PW_REUSE_EXISTING_SERVER === "1",
    timeout: 120_000,
  },
  reporter: process.env.CI ? [["github"]] : [["list"]],
  retries: process.env.CI ? 1 : 0,
});
