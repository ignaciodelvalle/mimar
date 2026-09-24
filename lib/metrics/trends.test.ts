// Integration regression tests for the bucketed trend fetchers (D1 / U1).
//
// These MUST hit the local Postgres: the bug they guard against was a SQL-plan
// failure — date_trunc($1, ts) with the unit as a bind param — which a pure
// unit test cannot catch (the pure bucketing logic lives in timeseries.test.ts).
// Before the fix these calls rejected (digests 3570919338 / 1487991369, crashing
// /gob/mortalidad and /gob/analytics); now they resolve. The setup file forces
// the local DATABASE_URL, so any query here runs against the bootstrapped DB.
//
// Assertions are SHAPE-only (no row-count requirement) so they pass on an empty
// schema too — what regresses is the query throwing, not the data.

import { describe, expect, it } from "vitest";

import { buildProjectionContext } from "@/lib/metrics";
import {
  fetchBitesTrend,
  fetchDeathCausesTrend,
  fetchOutbreakSignalsTrend,
  fetchRabiesVaccinationTrend,
} from "./trends";

// A 12-month admin (universal-scope) window → month buckets, exercising the
// exact date_trunc unit that broke.
function adminCtx12m() {
  return buildProjectionContext({ role: "admin" }, [], {
    since: new Date(Date.now() - 365 * 86_400_000),
    until: new Date(Date.now() + 86_400_000),
  });
}

describe("trend fetchers — date_trunc bind-param regression (U1)", () => {
  it("fetchDeathCausesTrend resolves with a valid stacked shape", async () => {
    const r = await fetchDeathCausesTrend(adminCtx12m());
    expect(["week", "month"]).toContain(r.granularity);
    expect(Array.isArray(r.series.seriesKeys)).toBe(true);
    expect(Array.isArray(r.series.points)).toBe(true);
    expect(typeof r.suppressedCount).toBe("number");
  });

  it("fetchOutbreakSignalsTrend resolves with a valid single-series shape", async () => {
    const r = await fetchOutbreakSignalsTrend(adminCtx12m());
    expect(Array.isArray(r.points)).toBe(true);
    expect(typeof r.suppressedCount).toBe("number");
  });

  it("fetchBitesTrend resolves without throwing", async () => {
    const r = await fetchBitesTrend(adminCtx12m());
    expect(Array.isArray(r.points)).toBe(true);
  });

  it("fetchRabiesVaccinationTrend resolves without throwing", async () => {
    const r = await fetchRabiesVaccinationTrend(adminCtx12m());
    expect(Array.isArray(r.points)).toBe(true);
  });
});
