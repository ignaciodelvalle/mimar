import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config that runs the e2e suite against the ALREADY-RUNNING
 * production server on http://localhost:3000 (the QA server started by
 * `pwsh scripts/qa-up.ps1`).
 *
 * Unlike playwright.config.ts, there is NO `webServer` block: this config
 * never builds or starts its own server, so it can't clobber the live :3000
 * build (the ".next clobber under running server" failure mode) and never
 * spins the default self-built server on :3333 (which caused false
 * alta-hang failures when the fresh build was slow to warm up).
 *
 * Reuse the existing server — start it once with qa-up.ps1, then:
 *   pnpm exec playwright test --config=playwright.local3000.config.ts
 *
 * PORT — `QA_PORT` (default 3000). It pairs with `qa-up.ps1 -Port`, the script
 * that starts the very server this config attaches to; run the two with the
 * same number:
 *   pwsh scripts/qa-up.ps1 -Port 3001
 *   QA_PORT=3001 pnpm exec playwright test --config=playwright.local3000.config.ts
 * The override is not cosmetic: :3000 on the PO's box can be held by a zombie
 * listener owned by another security context (qa-up.ps1 documents it — the PID
 * survives Stop-Process), and before this was configurable the only way to run
 * a spec elsewhere was to fabricate a throwaway config.
 *
 * Deliberately NOT the bare `PORT` variable: that one is Next's own server port
 * (qa-up.ps1 sets `$env:PORT`, and playwright.config.ts injects it into its
 * webServer), so a client-side config reading it would silently follow whatever
 * a server-side tool left in the shell.
 *
 * Runs serially (workers: 1). The crisis seams are multi-actor journeys that
 * relogin the shared `page` across roles and mutate shared demo fixtures
 * (mark-lost, adoption custody), so parallel workers would collide on the
 * same seed rows.
 */
const QA_PORT = Number(process.env.QA_PORT?.trim() || 3000);

// CI=true reproduces the CI job's TIMING against a local server, so a spec that
// only passes because local budgets are twice as generous is caught here rather
// than in the gate. Everything else (origin, no webServer) stays local.
const asCI = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e",
  // Same exclusions as playwright.config.ts and playwright.staging.config.ts —
  // this was the FOURTH config and the one out of step. demo/*.spec.ts declare
  // 116 minutes of test.setTimeout() between six recordings and perf/ measures
  // a deployed origin, so a local full-suite run through this config inherited
  // both. Keep the four in sync.
  testIgnore: ["demo/**", "perf/**"],
  timeout: asCI ? 30_000 : 120_000,
  expect: {
    timeout: asCI ? 8_000 : 15_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: asCI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${QA_PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // Bound individual actions so a selector that drifted from the current UI
    // (a renamed button, a data-state branch the recording didn't anticipate)
    // FAILS FAST with its own screenshot instead of silently waiting out the
    // whole 18-25 min test budget. Playwright's default actionTimeout is 0
    // (unbounded → inherits the test timeout), which turned every diverged
    // click into an 18-minute hang. 20s is generous for a warm local server.
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    ...devices["Desktop Chrome"],
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
