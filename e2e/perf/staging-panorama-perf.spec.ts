import { expect, test } from "@playwright/test";

import { resolveStagingUrl } from "../_base-url";
import { ACCOUNTS, loginAs } from "../demo/_helpers";

/**
 * Panorama performance measurement — the SAME method used for the pre-gru1
 * baseline (2026-07-10), so BEFORE/AFTER is comparable apples-to-apples.
 *
 * WHY this exists: the panorama latency work (cross-request cache) + the
 * `gru1` region pin (functions co-located with Supabase sa-east-1) only take
 * effect AFTER a production redeploy. This spec re-measures staging so we can
 * confirm the projected saving actually lands. Run it AFTER the redeploy.
 *
 *   STAGING_URL=https://<deploy>.vercel.app \
 *     pnpm exec playwright test e2e/perf/staging-panorama-perf.spec.ts \
 *     --config=playwright.local3000.config.ts
 *
 * It logs in as the demo govt operator, warms the console, then times:
 *   - the KPI API across N sequential requests (first MISS → later HITs),
 *     reading x-kpi-cache to label each,
 *   - two layer APIs, reading x-layer-cache,
 *   - the auth-only floor (a credential-less request that 401s before any
 *     data work — pure auth-chain + cross-region cost),
 *   - /api/health pingMs (a single DB round-trip from the function — the
 *     cleanest cross-region signal; only exists once the redeploy ships it).
 *
 * It asserts nothing about absolute numbers (they vary with instance load) —
 * it PRINTS a labeled table. The pre-gru1 baseline is embedded below so the
 * comparison is self-contained in the run output.
 */

// Staging-only by construction: this spec PRINTS deployed latency against a
// recorded baseline and asserts nothing, so pointed at a localhost build it
// measures nothing. resolveStagingUrl() returns null when no deployed origin is
// configured — do NOT substitute a localhost fallback here (see _base-url.ts).
const BASE = resolveStagingUrl() ?? "";
if (BASE) test.use({ baseURL: BASE });
test.describe.configure({ mode: "serial", timeout: 180_000 });

// Measured 2026-07-10, pre-gru1 (functions iad1, DB sa-east-1). See
// dim-interno:docs/reviews/2026-07-10-auth-floor-and-perf-breakdown.md.
const BASELINE = {
  kpiSequenceMs: [13548, 21115, 6824, 961],
  kpiFirstHitMs: 961,
  authFloorMs: 2750, // 401, auth-only, no data
  note: "layer + KPI fan-out routinely exceeded their 8s/20s budgets → degraded",
};

async function timeFetch(
  page: import("@playwright/test").Page,
  path: string,
  cacheHeader: string,
  credentials: RequestCredentials,
): Promise<{ ms: number; status: number; cache: string | null }> {
  return page.evaluate(
    async ({ path, cacheHeader, credentials }) => {
      const t0 = performance.now();
      const r = await fetch(path, { credentials });
      // Drain the body so timing includes full transfer, like a real client.
      await r.arrayBuffer().catch(() => {});
      const t1 = performance.now();
      return {
        ms: Math.round(t1 - t0),
        status: r.status,
        cache: r.headers.get(cacheHeader),
      };
    },
    { path, cacheHeader, credentials },
  );
}

test("panorama perf — staging re-measure (gru1)", async ({ page }) => {
  test.skip(!BASE, "Set STAGING_URL to a deployed origin.");

  await loginAs(page, ACCOUNTS.govt);
  await page.goto("/gob/panorama");
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

  // KPI API: 4 sequential (first MISS, later HITs after the cache warms).
  const kpi: Array<{ ms: number; status: number; cache: string | null }> = [];
  for (let i = 0; i < 4; i++) {
    kpi.push(await timeFetch(page, "/api/panorama/kpis?period=90d", "x-kpi-cache", "include"));
  }

  // Two layer APIs (read x-layer-cache — added this batch).
  const perdidas = await timeFetch(
    page,
    "/api/panorama/perdidas?period=90d",
    "x-layer-cache",
    "include",
  );
  const cobertura = await timeFetch(
    page,
    "/api/panorama/cobertura?period=90d",
    "x-layer-cache",
    "include",
  );

  // Auth-only floor: credential-less → 401 before any data work.
  const authFloor = await timeFetch(page, "/api/panorama/kpis?period=90d", "x-kpi-cache", "omit");

  // /api/health pingMs — a single DB round-trip from the function.
  const health = await page.evaluate(async () => {
    const t0 = performance.now();
    const r = await fetch("/api/health");
    const body = (await r.json().catch(() => null)) as {
      db?: { pingMs?: number };
      stuckBackends?: number;
      degraded?: boolean;
    } | null;
    return {
      ms: Math.round(performance.now() - t0),
      status: r.status,
      pingMs: body?.db?.pingMs ?? null,
      stuckBackends: body?.stuckBackends ?? null,
      degraded: body?.degraded ?? null,
    };
  });

  const kpiFirstHit = kpi.find((k) => k.cache === "hit");

  const lines = [
    "",
    "═══════════════════════════════════════════════════════════════",
    `  PANORAMA PERF — ${BASE}`,
    "═══════════════════════════════════════════════════════════════",
    "",
    "  KPI API (4 sequential):",
    ...kpi.map(
      (k, i) =>
        `    ${i + 1}. ${String(k.ms).padStart(6)}ms  [${k.cache ?? "?"}]  http ${k.status}`,
    ),
    `    → first cache HIT: ${kpiFirstHit ? `${kpiFirstHit.ms}ms` : "none observed"}   (baseline: ${BASELINE.kpiFirstHitMs}ms)`,
    "",
    "  Layer API:",
    `    perdidas:  ${String(perdidas.ms).padStart(6)}ms  [${perdidas.cache ?? "?"}]  http ${perdidas.status}`,
    `    cobertura: ${String(cobertura.ms).padStart(6)}ms  [${cobertura.cache ?? "?"}]  http ${cobertura.status}`,
    "",
    `  Auth-only floor (401): ${authFloor.ms}ms   (baseline: ${BASELINE.authFloorMs}ms)`,
    `  /api/health: ${health.ms}ms  pingMs=${health.pingMs}  stuck=${health.stuckBackends}  degraded=${health.degraded}`,
    "",
    `  Baseline (pre-gru1): KPI seq ${BASELINE.kpiSequenceMs.join("/")}ms; ${BASELINE.note}`,
    "═══════════════════════════════════════════════════════════════",
    "",
  ];
  console.log(lines.join("\n"));

  // Only sanity gates — the value is the printed table, not a pass/fail.
  expect(health.status, "/api/health reachable").toBe(200);
  expect(authFloor.status, "auth floor is a real 401").toBe(401);
});
