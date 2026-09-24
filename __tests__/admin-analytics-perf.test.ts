// WP1 / P0 — admin analytics performance regression guard.
//
// Regression: /admin/programa hung (~135 s) because fetchDataQuality's
// orphan-detection `NOT EXISTS (SELECT 1 FROM ownerships o WHERE o.pet_id = ...)`
// had no general (pet_id) index on ownerships, so the planner seq-scanned
// ownerships once PER active pet. Migration 0112 added ownerships_pet_id_idx,
// cutting that fetcher from ~135 s to ~0.3 s (Index Only Scan).
//
// This test runs the REAL admin-scope (global) fetcher sets for /admin/censo,
// /admin/poblacion and /admin/programa against the local DB and asserts each
// page's DB layer resolves WITHOUT throwing and UNDER the demo budget. It does
// NOT replace e2e/executive-smoke.spec.ts (which asserts the rendered pages show
// no error boundary) — it guards the query layer, the part most prone to an
// index regression.
//
// Budget: the plan's page budget is 3 s. The measured DB-layer wall-clock with
// the full demo seed is ~400 ms (≈7x headroom), so this never flakes — but a
// missing-index regression (135 s) trips it instantly. The guard has teeth only
// against a populated DB: run after
//   pnpm db:bootstrap → seed:panorama → seed:test → seed:demo:scenario.
//
// Integration test — requires the local Supabase + Postgres stack.

import { describe, expect, it } from "vitest";

import { fetchMicrochipPenetration } from "@/lib/analytics/compliance-metrics";
import { buildProjectionContext } from "@/lib/metrics";
import {
  DORMANT_MONTHS_DEFAULT,
  identificationFunnel,
  registrationTrend,
  registryByProvince,
  registryCounts,
} from "@/lib/metrics/census";
import { windows } from "@/lib/metrics/period";
import {
  fetchActivePregnancies,
  fetchNetGrowth,
  fetchReproductiveOutcomes,
  fetchSterilizationCoverage,
  fetchSterilizationNatalidadRatio,
  fetchSterilizationTrend,
} from "@/lib/metrics/population-control";
import {
  fetchCrossJurisdictionOutliers,
  fetchDataQuality,
  fetchPiiOversight,
} from "@/lib/metrics/program-health";

const BUDGET_MS = 3000;

// Admin universal scope, trailing 12 months — the exact context the demo uses.
const ctx = buildProjectionContext({ role: "admin" }, [], windows.trailing12m());

async function timed(fn: () => Promise<unknown>): Promise<number> {
  const t = performance.now();
  await fn();
  return performance.now() - t;
}

describe("admin analytics perf — demo budget guard (WP1/P0)", () => {
  it("fetchDataQuality resolves under budget (orphan check uses ownerships_pet_id_idx)", async () => {
    const ms = await timed(() => fetchDataQuality(ctx));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("/admin/censo fetcher set resolves under budget", async () => {
    const ms = await timed(() =>
      Promise.all([
        registryCounts(ctx, DORMANT_MONTHS_DEFAULT),
        registrationTrend(ctx),
        identificationFunnel(ctx),
        registryByProvince(ctx),
      ]),
    );
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("/admin/poblacion fetcher set resolves under budget", async () => {
    const ms = await timed(() =>
      Promise.all([
        fetchSterilizationCoverage(ctx),
        fetchActivePregnancies(ctx),
        fetchReproductiveOutcomes(ctx),
        fetchNetGrowth(ctx),
        fetchSterilizationNatalidadRatio(ctx),
        fetchSterilizationTrend(ctx),
      ]),
    );
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("/admin/programa heavy fetcher set resolves under budget", async () => {
    const ms = await timed(() =>
      Promise.all([
        registryCounts(ctx, DORMANT_MONTHS_DEFAULT),
        fetchSterilizationCoverage(ctx),
        fetchMicrochipPenetration(ctx),
        fetchDataQuality(ctx),
        fetchCrossJurisdictionOutliers(ctx),
        fetchPiiOversight(ctx),
      ]),
    );
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});
