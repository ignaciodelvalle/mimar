import { randomInt } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config that runs the e2e suite against the DEPLOYED staging
 * origin (https://dim-staging.vercel.app by default, STAGING_URL to override).
 * Used by the nightly workflow (dim-interno:.github/workflows/e2e-nightly.yml) and for
 * ad-hoc staging passes.
 *
 * Differences from playwright.config.ts (the local :3333 self-built config):
 *   - NO webServer block — the target is already deployed; nothing to build
 *     or start (and no risk of the ".next clobber under running server"
 *     failure mode).
 *   - Serial (workers: 1). Several suites are multi-actor journeys that
 *     mutate shared seed fixtures (mark-lost, adoption custody); parallel
 *     workers would collide on the same staging rows.
 *   - Remote timeouts — cold serverless starts on Vercel need more headroom
 *     than a warm local server (same rationale as playwright.local3000).
 *   - NO trace, NO video, NO HTML report — see "SECRETS IN ARTIFACTS" below.
 *   - demo/ (narrated 15-18 min recordings) and perf/ are excluded; they are
 *     not regression tests.
 *
 * ===========================================================================
 * THE x-real-ip HEADER BELOW IS INERT AGAINST STAGING. Measured 2026-08-26.
 * ===========================================================================
 * IT USED TO BE DOCUMENTED AS A RATE-LIMIT WORKAROUND: "the login limiter
 * trusts x-real-ip", so a random RFC-5737 documentation IP per run would make
 * consecutive nightly runs land in fresh per-IP buckets. That mechanism does
 * not work here and never did.
 *
 * Measured against https://dim-staging.vercel.app: 80 concurrent requests to
 * `/api/v1/me/pets` with a ROTATED x-real-ip (one distinct address per request)
 * produced 60×401 then 20×429, where the fixed-address control on `/api/v1/me`
 * produced 59×401 then 21×429 — the same ceiling one request apart, not a
 * different behaviour. Vercel's edge overwrites the header before `callerIp()`
 * sees it. The method, including the positive control that makes the null result
 * mean something, is written out in `lib/infra/rate-limit.ts` above `callerIp()`.
 *
 * WHY IT STAYS ANYWAY, and it is not sentiment. STAGING_URL is an override, and
 * the thing it overrides to is not always a Vercel deployment — a `next start`
 * on a tunnel, a self-hosted preview, a future non-Vercel origin all have no
 * rewriting edge, and there this header IS honoured. It costs one header on
 * each request and it documents an intent that is correct wherever it can be.
 * What it must not do is be BELIEVED against staging, which is what this
 * paragraph is for.
 *
 * WHAT THAT MEANS FOR THE NIGHTLY RUN, stated so nobody re-derives it under
 * pressure at 03:00 AR:
 *   · The `/api/v1` per-IP ceilings are 600/min per bucket since WU-EAS-2, and
 *     the two api-v1 specs spend at most FOUR counter writes into any one of
 *     them per run — the refusal cases send no Authorization header, and the
 *     bearer-shape check runs before the limiter, so those cost nothing at all.
 *     No margin problem there, header or no header.
 *   · `auth_login_ip` is the one to watch, and it is the one the deleted
 *     sentence claimed to have solved. A serial suite whose specs each sign in,
 *     with `retries: 1` on CI, shares ONE hourly login budget from the runner's
 *     egress address, and no header changes that. The ceiling is NOT restated
 *     here — it is `LOGIN_IP_LIMIT` in
 *     `src/modules/auth/application/login-limits.ts`, with the derivation next
 *     to it; a number transcribed into a second file is a number that goes
 *     stale, which is what happened to the pair that used to sit on this line.
 *
 *     IT HAS NOT BEEN HAPPENING, and that is measured rather than assumed. On
 *     2026-08-27 the six most recent nightly runs were searched for all three
 *     signatures a login refusal leaves — the es-AR throttle copy, the helper's
 *     refusal message, and the `rate_limited` code — and every one of the six
 *     returned zero of all three. The nightly HAS been failing, on every one of
 *     those nights, on seed data and missing fixtures. It has not been failing
 *     on this.
 *
 *     WHAT TO DO IF IT EVER DOES. Do not re-derive it at 03:00: `loginAs`
 *     raises `LOGIN_BUDGET_MARKER` — the literal string `LOGIN BUDGET
 *     EXHAUSTED` — on a refusal that is a rate limit rather than a credential
 *     failure, and the message explains what is suspect afterwards. Grep the job
 *     log for it. If it is absent, the budget is not your problem, whatever else
 *     the run looks like.
 * Suites that need per-context uniqueness (e.g. authz-ab-isolation) override
 * this header per context with their own uniqueIp(); that override is subject to
 * exactly the same measurement and is equally inert against a Vercel origin.
 *
 * ===========================================================================
 * SECRETS IN ARTIFACTS (security review of C4b, 2026-09-23)
 * ===========================================================================
 * Every login here types E2E_STAGING_PASSWORD, the real password of eight
 * staging accounts. Three Playwright outputs would carry it in clear text:
 *   · a TRACE records every fill() value and the login POST body;
 *   · the HTML REPORT titles each step with its value — playwright-core 1.60.0
 *     declares `Frame.fill` with the title 'Fill "{value}"' (coreBundle.js);
 *   · a VIDEO would show whatever the page showed.
 * This repo is PUBLIC: a workflow artifact is downloadable by any signed-in
 * GitHub user for its whole retention. So all three are OFF here, and the
 * nightly uploads no report at all (dim-interno:.github/workflows/e2e-nightly.yml) — the
 * `github` + `list` reporters put each failure in the job log instead. That
 * log is NOT value-free by construction: an error message can quote what a
 * step was given. The control that keeps the password out of it is GitHub's
 * secret masking, which replaces the EXACT bytes of E2E_STAGING_PASSWORD with
 * `***` — so never transform or re-encode E2E_STAGING_PASSWORD (URL-encode,
 * base64, slice, JSON-escape…) before typing it; a transformed value is not
 * the secret GitHub knows and is printed in clear.
 *
 * Screenshots stay on failure: they land only in the local test-results/
 * (nothing uploads them), and the password field is `type="password"`
 * (LnPasswordInput, components/ui/Field.tsx) — masked unless someone clicks
 * "Mostrar contraseña", which no spec does. Do NOT turn trace, video or the
 * HTML reporter back on for this config.
 */

const BASE_URL = (process.env.STAGING_URL?.trim() || "https://dim-staging.vercel.app").replace(
  /\/+$/,
  "",
);

// One random documentation-range IP per run (TEST-NET-3, RFC 5737). Honoured
// only by an origin with no rewriting edge in front of it — see above.
const RUN_IP = `203.0.113.${randomInt(1, 255)}`;

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e",
  testIgnore: ["demo/**", "perf/**"],
  fullyParallel: false,
  workers: 1,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  // No "html": its step titles carry fill() values (see SECRETS IN ARTIFACTS).
  reporter: isCI ? [["github"], ["list"]] : [["list"]],
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },

  use: {
    baseURL: BASE_URL,
    // OFF, not "on-first-retry": a trace records the password typed at login.
    trace: "off",
    screenshot: "only-on-failure",
    video: "off",
    // Fail fast on drifted selectors instead of waiting out the full test
    // budget (rationale documented in playwright.local3000.config.ts).
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    extraHTTPHeaders: { "x-real-ip": RUN_IP },
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
