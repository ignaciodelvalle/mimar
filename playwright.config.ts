import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for DIM e2e tests.
 *
 * Runs against the built Next.js app (`next build && next start`) on a fixed
 * port so tests hit the same code path that staging/production use — not the
 * hot-reload dev server.
 *
 * In CI, Supabase must be started and `pnpm db:bootstrap` run before this
 * suite. See .github/workflows/ci.yml (e2e job).
 *
 * Local usage when the stack is up:
 *   pnpm e2e
 *
 * ─── ⚠ DO NOT USE THIS CONFIG AGAINST A LIVE QA SERVER ────────────────────
 * This is the DEFAULT config (`pnpm e2e` / a bare `playwright test` picks it
 * up), and it owns a `webServer` block that runs `pnpm build && pnpm start`.
 * Running it while `scripts/qa-up.ps1` has a server up REWRITES `.next` under
 * that live process — the served JS chunks 404 and the QA session dies
 * mid-run. It has burned this project more than once.
 *
 * To drive an already-running QA server, use the no-webServer configs:
 *   pnpm exec playwright test --config=playwright.local3000.config.ts
 *   (port via QA_PORT, matching `qa-up.ps1 -Port`)
 *
 * The 3333 below is deliberate: it must never collide with the QA server's
 * port so a mistake here cannot bind over a live one. Do not "unify" it with
 * QA_PORT — the separation IS the guard.
 */

const PORT = 3333;
const BASE_URL = `http://localhost:${PORT}`;

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e",
  // demo/ and perf/ are NOT regression tests, and leaving them in this config
  // is what cost the project its e2e verdict in CI (measured 2026-07-31 over
  // runs 30513536370 / 30521111221 / 30521116031).
  //
  //   - demo/*.spec.ts are narrated recording scripts that declare their own
  //     per-test budgets via test.setTimeout(): 15 + 18 + 25 + 15 + 18 + 25 =
  //     116 minutes for SIX tests, doubled to ~232 by `retries: 1` below. On a
  //     job capped at 30 minutes that is unpayable by construction. In all
  //     three runs the suite reached demo/02-dueno at ~minute 7 of the step and
  //     then sat inside its 18-minute budget until the JOB timeout killed it —
  //     which reports as `cancelled`, not `failure`, so nobody read it as red.
  //     They are recordings, not assertions; playwright.demo.config.ts owns
  //     them (its own testDir, webServer and 20-minute cap), so excluding them
  //     here costs no coverage.
  //   - perf/staging-panorama-perf.spec.ts targets the DEPLOYED staging origin
  //     and asserts nothing (it prints a labeled latency table). Pointed at a
  //     localhost build it measures nothing and burns its 180s budget.
  //
  // playwright.staging.config.ts already carried this exact exclusion and
  // e2e/README.md already said "do not run these as part of a normal e2e
  // pass" — this config was the one place out of step. FOUR configs now carry
  // it (here, staging, local3000, and demo by virtue of its own testDir);
  // playwright.local3000.config.ts was the one missed in that pass, so a local
  // full-suite run still inherited demo/'s 116 minutes. Keep them in sync.
  testIgnore: ["demo/**", "perf/**"],
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  // Serial in CI ON PURPOSE — do not "optimise" this to workers > 1. Several
  // suites are multi-actor journeys that relogin and mutate shared seed rows
  // (mark-lost, adoption custody, vaccine signing); parallel workers collide on
  // the same fixtures. The remaining 156 tests run in ~9 min serially against a
  // warm server (measured locally 2026-07-31), so there is nothing to buy here.
  workers: isCI ? 1 : undefined,
  reporter: isCI ? [["html", { open: "never" }], ["github"]] : [["html", { open: "never" }]],
  timeout: 30_000,
  // Playwright — not the GitHub job clock — is the run-length detector. A job
  // that blows `timeout-minutes` is `cancelled`: no verdict, no HTML report,
  // and the `if: failure()` artifact step never fires, which is precisely how
  // three consecutive dead e2e runs went unnoticed. globalTimeout makes an
  // overrun a real FAILURE with a report attached. It covers the whole run
  // including the webServer boot below, and the ci.yml `timeout-minutes` sits
  // above it as a backstop for runner pathology, not as the primary alarm.
  globalTimeout: isCI ? 22 * 60_000 : undefined,
  expect: {
    timeout: 8_000,
  },

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
    // Playwright's default actionTimeout is 0 — NO LIMIT. A locator action on
    // an element that never appears (a submit button that lives on the NEXT
    // wizard step, a field a sheet did not render) therefore waits forever:
    // it never throws, so try/catch cannot catch it, and the test dies on its
    // own budget reporting "Test timeout exceeded" with nothing naming the
    // cause. That signature cost three CI runs to diagnose across two specs
    // (owner-ia-p6 test 10's mark-lost submit; race-battery (c)'s cleanup
    // fill, which sat inside a try/catch that a hang can never reach).
    // A bounded action turns the same bug into a normal, LEGIBLE failure
    // naming the locator. 15s is well clear of the slowest legitimate
    // interaction measured on a cold CI runner.
    actionTimeout: 15_000,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  // Serve the built Next.js app. In CI the "Build Next.js app" step runs
  // first, so we only need `pnpm start`. Locally we build + start together.
  // Set NEXT_BUILT=1 in the environment to skip the build step (CI does this).
  webServer: {
    command: process.env.NEXT_BUILT
      ? `pnpm start --port ${PORT}`
      : `pnpm build && pnpm start --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !isCI,
    timeout: 180_000,
    env: {
      PORT: String(PORT),
    },
  },
});
