import { defineConfig, devices } from "@playwright/test";

/**
 * Demo-recording Playwright config (separate from playwright.config.ts).
 *
 * Records a clean .webm per demo segment (one spec = one profile). Videos are
 * forced ON at 1280x720, sequential (workers: 1) so the walkthrough renders in
 * order without parallel interleaving. Point at an already-built app on :3333.
 *
 * Usage (stack up + app built with NEXT_PUBLIC_DEMO_MODE=true):
 *   NEXT_BUILT=1 pnpm start --port 3333        # in one terminal (or via webServer below)
 *   pnpm exec playwright test -c playwright.demo.config.ts
 *   node scripts/collect-demo-videos.mjs        # rename test-results → dim-interno:docs/demo/videos
 */

const PORT = 3333;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e/demo",
  outputDir: "test-results/demo",
  fullyParallel: false,
  workers: 1,
  forbidOnly: false,
  retries: 0,
  reporter: [["list"]],
  // Demo walks are long (whole nav + forms + full scroll). Generous per-test cap.
  timeout: 20 * 60_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 720 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: { mode: "on", size: { width: 1280, height: 720 } },
    // Slow the automation a touch so actions are visible in the recording.
    launchOptions: { slowMo: 120 },
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    // App must already be built (NEXT_PUBLIC_DEMO_MODE baked in at build time).
    command: `pnpm start --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 180_000,
    env: { PORT: String(PORT), NEXT_PUBLIC_DEMO_MODE: "true", NEXT_BUILT: "1" },
  },
});
