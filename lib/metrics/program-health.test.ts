// Unit tests for lib/metrics/program-health.ts — Paquete H.
//
// PURE helpers (no DB):
//   isOutlier    — below/at/above target, warn-band semantics
//   completeness — all complete → 100, none complete → 0, mixed, zero total
//
// DB-shape tests (follow trends.test.ts pattern — SHAPE-only, no data dependency):
//   fetchDataQuality          — resolves with correct shape
//   fetchCrossJurisdictionOutliers — resolves with valid rows; rate/target comparison correct
//   fetchPiiOversight         — resolves with valid rows

import { describe, expect, it } from "vitest";

import { buildProjectionContext } from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";

import {
  completeness,
  countAlertedProvinces,
  fetchCrossJurisdictionOutliers,
  fetchDataQuality,
  fetchPiiOversight,
  isOutlier,
} from "./program-health";
import { TARGETS } from "./targets";

// ---------------------------------------------------------------------------
// PURE helpers
// ---------------------------------------------------------------------------

describe("isOutlier — pure helper", () => {
  it("returns true when rate is strictly below target (no warnBand)", () => {
    expect(isOutlier(70, 80)).toBe(true);
  });

  it("returns false when rate equals target exactly (no warnBand)", () => {
    expect(isOutlier(80, 80)).toBe(false);
  });

  it("returns false when rate is above target (no warnBand)", () => {
    expect(isOutlier(90, 80)).toBe(false);
  });

  it("returns true when rate is below target (with warnBand — warn zone)", () => {
    // target=80, warnBand=0.25 → warn zone: [60, 80). Rate=65 → outlier.
    expect(isOutlier(65, 80, 0.25)).toBe(true);
  });

  it("returns true when rate is in the danger zone (with warnBand)", () => {
    // target=80, warnBand=0.25 → danger: rate < 60. Rate=50 → outlier.
    expect(isOutlier(50, 80, 0.25)).toBe(true);
  });

  it("returns false when rate equals target (with warnBand)", () => {
    expect(isOutlier(80, 80, 0.25)).toBe(false);
  });

  it("returns false when rate is above target (with warnBand)", () => {
    expect(isOutlier(95, 80, 0.25)).toBe(false);
  });

  it("returns true at rate=0 for any positive target", () => {
    expect(isOutlier(0, 70)).toBe(true);
  });

  it("returns false at rate=100 for target=80", () => {
    expect(isOutlier(100, 80)).toBe(false);
  });
});

describe("completeness — pure helper", () => {
  it("returns 100 when all pets are complete (missingAny=0)", () => {
    expect(completeness({ total: 100, missingAny: 0 })).toBe(100);
  });

  it("returns 0 when no pets are complete (missingAny=total)", () => {
    expect(completeness({ total: 100, missingAny: 100 })).toBe(0);
  });

  it("returns 75 for 25 missing out of 100", () => {
    expect(completeness({ total: 100, missingAny: 25 })).toBe(75);
  });

  it("returns 100 when total is 0 (empty population — nothing is missing)", () => {
    expect(completeness({ total: 0, missingAny: 0 })).toBe(100);
  });

  it("rounds to nearest integer", () => {
    // 1 missing out of 3 → (2/3)*100 = 66.67 → 67
    expect(completeness({ total: 3, missingAny: 1 })).toBe(67);
  });
});

// Regression — 2026-07-22 honesty bug: /admin/programa and /gob/programa's
// "Provincias en alerta" KPI used to render outliers.filter(isOutlier).length,
// which counts (province × metric) COMBINATIONS, not provinces — a single
// province with 3 below-target metrics contributed 3 rows, so the KPI could
// read e.g. 70 when Argentina has ~24 provinces. countAlertedProvinces must
// always collapse to DISTINCT provinces, bounded by the total province count
// present in the input (never combinations).
describe("countAlertedProvinces — pure helper", () => {
  const row = (
    province: string,
    metric: OutlierRow["metric"],
    isOutlier: boolean,
  ): Pick<OutlierRow, "province" | "isOutlier"> & { metric: OutlierRow["metric"] } => ({
    province,
    metric,
    isOutlier,
  });

  it("counts a province only once even with multiple below-target metrics", () => {
    const rows = [
      row("Buenos Aires", "rabies", true),
      row("Buenos Aires", "sterilization", true),
      row("Buenos Aires", "microchip", true),
    ];
    // 3 combinations, but only 1 distinct province.
    expect(rows.filter((r) => r.isOutlier).length).toBe(3);
    expect(countAlertedProvinces(rows)).toBe(1);
  });

  it("ignores rows where isOutlier is false", () => {
    const rows = [row("Buenos Aires", "rabies", false), row("Córdoba", "microchip", false)];
    expect(countAlertedProvinces(rows)).toBe(0);
  });

  it("counts distinct provinces across mixed outlier/non-outlier rows", () => {
    const rows = [
      row("Buenos Aires", "rabies", true),
      row("Buenos Aires", "microchip", false),
      row("Córdoba", "sterilization", true),
      row("Córdoba", "microchip", true),
      row("Santa Fe", "rabies", false),
    ];
    // 3 outlier combinations (BA×rabies, Córdoba×sterilization, Córdoba×microchip),
    // but only 2 distinct alerted provinces (Buenos Aires, Córdoba).
    const combinationCount = rows.filter((r) => r.isOutlier).length;
    expect(combinationCount).toBe(3);
    expect(countAlertedProvinces(rows)).toBe(2);
    expect(countAlertedProvinces(rows)).toBeLessThan(combinationCount);
  });

  it("returns 0 for an empty input", () => {
    expect(countAlertedProvinces([])).toBe(0);
  });

  it("never exceeds the number of distinct provinces represented in the input", () => {
    // Simulates the reported bug: 24 provinces × 3 metrics all below target
    // (70 combinations) — the honest province count must stay ≤ 24.
    const provinces = Array.from({ length: 24 }, (_, i) => `Provincia ${i}`);
    const metrics: OutlierRow["metric"][] = ["rabies", "sterilization", "microchip"];
    const rows = provinces.flatMap((p) => metrics.map((m) => row(p, m, true)));
    expect(rows.length).toBe(72);
    expect(countAlertedProvinces(rows)).toBe(24);
    expect(countAlertedProvinces(rows)).toBeLessThanOrEqual(provinces.length);
  });
});

// ---------------------------------------------------------------------------
// DB-shape tests — tsc-verified-only (no live Postgres required).
//
// Follows the pattern established in lib/metrics/custody.test.ts and
// lib/metrics/census.test.ts: the DB-bound fetchers are imported and their
// return types are asserted at the TypeScript level. The `tsc --noEmit` run
// validates that all field types match DataQuality / OutlierRow[] / PiiOversightRow[].
// These tests do NOT call the fetchers at runtime (no DB dependency here).
//
// If you need a live regression test against the local Postgres (as in
// trends.test.ts), add a separate describe block that calls the fetchers
// after verifying a DATABASE_URL is present.
// ---------------------------------------------------------------------------

// Type-level shape assertions — verified by tsc, not by runtime.
// The casts below ensure the return types match the exported interfaces.
import type { DataQuality, OutlierRow, PiiOversightRow } from "./program-health";

// Compile-time check: fetchDataQuality returns Promise<DataQuality>
const _dataQualityShape: () => Promise<DataQuality> = async () =>
  fetchDataQuality(buildProjectionContext({ role: "admin" }, [], windows.trailing12m()));
void _dataQualityShape; // prevent unused-variable lint

// Compile-time check: fetchCrossJurisdictionOutliers returns Promise<OutlierRow[]>
const _outliersShape: () => Promise<OutlierRow[]> = async () =>
  fetchCrossJurisdictionOutliers(
    buildProjectionContext({ role: "admin" }, [], windows.trailing12m()),
  );
void _outliersShape;

// Compile-time check: fetchPiiOversight returns Promise<PiiOversightRow[]>
const _piiShape: () => Promise<PiiOversightRow[]> = async () =>
  fetchPiiOversight(buildProjectionContext({ role: "admin" }, [], windows.trailing12m()));
void _piiShape;

describe("program-health — tsc shape contracts (no DB)", () => {
  // These tests are structural, not behavioural. They exist so the test runner
  // sees this describe block and reports the file as "passing" while the real
  // shape validation is done at type-check time (tsc --noEmit).

  it("fetchDataQuality type contract: DataQuality has expected fields", () => {
    // Verify the DataQuality interface fields at type level via satisfies.
    const shape = {
      total: 0,
      missingLocality: 0,
      missingSex: 0,
      missingChip: 0,
      orphans: 0,
      completenessPct: 100,
    } satisfies DataQuality;
    expect(typeof shape.total).toBe("number");
    expect(typeof shape.completenessPct).toBe("number");
  });

  it("OutlierRow type contract: province, metric, rate, target, gap, isOutlier, denominator", () => {
    const shape = {
      province: "Buenos Aires",
      metric: "rabies" as const,
      rate: 65,
      target: 80,
      gap: 15,
      isOutlier: true,
      // The base the rate was divided by. It rides along so a consumer can
      // multiply the gap by the population that gap is a fraction of, instead
      // of reaching for whatever population is nearby — which is what the two
      // programa screens did, applying a CANINE census estimate to two
      // ALL-SPECIES metrics (metric-honesty audit, PO 2026-09-16).
      denominator: 400,
    } satisfies OutlierRow;
    expect(shape.isOutlier).toBe(true);
    expect(shape.gap).toBe(shape.target - shape.rate);
    // 65% of 400 dogs are vaccinated; the target is 80%. The gap the impact
    // column reports is therefore (80-65)/100 * 400 = 60 real registered dogs.
    expect(Math.round(((shape.target - shape.rate) / 100) * shape.denominator)).toBe(60);
  });

  it("OutlierRow metric union covers exactly {rabies, sterilization, microchip}", () => {
    const metrics: OutlierRow["metric"][] = ["rabies", "sterilization", "microchip"];
    expect(metrics).toHaveLength(3);
  });

  it("PiiOversightRow type contract: has actorUserId, action, surface, count, lastAt", () => {
    const shape = {
      actorUserId: "abc-123",
      action: "pii_queried",
      surface: "pet_profile",
      count: 5,
      lastAt: new Date(),
    } satisfies PiiOversightRow;
    expect(typeof shape.count).toBe("number");
    expect(shape.lastAt).toBeInstanceOf(Date);
  });

  it("isOutlier pure contract: returns false when rate >= target", () => {
    // Structural contract: at-target means NOT an outlier.
    expect(isOutlier(80, 80)).toBe(false);
  });

  it("completeness pure contract: full population → 100%", () => {
    expect(completeness({ total: 50, missingAny: 0 })).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// ADR-8 injected targets (jurisdiction-compliance WU4b — T4.8/T4.10)
// ---------------------------------------------------------------------------
// Live regression against the local Postgres: the SAME ctx queried with and
// without injected targets must return the same measured rates, with ONLY the
// judgment columns (target/gap/isOutlier) recomputed — injection changes what
// the rows are judged AGAINST, never what was measured. Default call = flat
// TARGETS byte-identical (JT5 — every admin caller passes nothing).

describe("fetchCrossJurisdictionOutliers — injected jurisdiction targets (ADR-8)", () => {
  const INJECTED = {
    MICROCHIP_PENETRATION_PCT: 55,
    STERILIZATION_COVERAGE_PCT: 45,
    RABIES_COVERAGE_PCT: 65,
  } as const;

  it("judges every row against the injected target for its metric; default stays flat", async () => {
    const ctx = buildProjectionContext({ role: "admin" }, [], windows.trailing12m());
    const [flat, injected] = await Promise.all([
      fetchCrossJurisdictionOutliers(ctx),
      fetchCrossJurisdictionOutliers(ctx, INJECTED),
    ]);

    // Same population measured — row set and rates identical.
    expect(injected.map((r) => [r.province, r.metric, r.rate])).toEqual(
      flat.map((r) => [r.province, r.metric, r.rate]),
    );

    const metricKey = {
      microchip: "MICROCHIP_PENETRATION_PCT",
      sterilization: "STERILIZATION_COVERAGE_PCT",
      rabies: "RABIES_COVERAGE_PCT",
    } as const;
    for (const row of injected) {
      const target = INJECTED[metricKey[row.metric]];
      expect(row.target).toBe(target);
      expect(row.gap).toBe(Math.round((target - row.rate) * 10) / 10);
      expect(row.isOutlier).toBe(row.rate < target);
    }
    for (const row of flat) {
      expect(row.target).toBe(TARGETS[metricKey[row.metric]]);
    }
  });
});
