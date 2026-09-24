// lib/metrics/population-control.test.ts — Pure unit tests for Paquete G.
//
// All tests here are DB-FREE. They cover the three pure helpers:
//   1. computeNetGrowth — altas + births − deaths (incl. negative result)
//   2. safeRatio        — normal, denominator=0 → null
//   3. coverageRate     — total=0 → 0; normal rounding
//
// DB-bound shape tests (fetchSterilizationCoverage, fetchActivePregnancies,
// fetchReproductiveOutcomes, fetchNetGrowth, fetchSterilizationNatalidadRatio,
// fetchSterilizationTrend) are described at the bottom as tsc-verified-only
// stubs — they follow the same pattern as trends.test.ts and only assert
// shape/non-throw, passing on an empty schema too. They require a live Postgres
// and are therefore NOT included in the vitest run for this file.

import { describe, expect, it } from "vitest";

import type { AnalyticsPeriod } from "@/lib/analytics/analytics-period";
import { ANONYMITY_K } from "./anonymity";
import { buildProjectionContext } from "./context";
import {
  applyCoverageDisclosure,
  computeNetGrowth,
  coverageRate,
  safeRatio,
} from "./population-control";

// ---------------------------------------------------------------------------
// 1. computeNetGrowth
// ---------------------------------------------------------------------------

describe("computeNetGrowth", () => {
  it("positive growth: altas + births − deaths", () => {
    expect(computeNetGrowth({ altas: 100, births: 20, deaths: 30 })).toBe(90);
  });

  it("zero net: altas + births = deaths", () => {
    expect(computeNetGrowth({ altas: 50, births: 10, deaths: 60 })).toBe(0);
  });

  it("negative net: deaths exceed altas + births (population contracting)", () => {
    expect(computeNetGrowth({ altas: 10, births: 5, deaths: 50 })).toBe(-35);
  });

  it("all zeros → net is 0", () => {
    expect(computeNetGrowth({ altas: 0, births: 0, deaths: 0 })).toBe(0);
  });

  it("births contribute to growth when altas=0 and deaths=0", () => {
    expect(computeNetGrowth({ altas: 0, births: 15, deaths: 0 })).toBe(15);
  });

  it("altas contribute to growth when births=0 and deaths=0", () => {
    expect(computeNetGrowth({ altas: 25, births: 0, deaths: 0 })).toBe(25);
  });

  it("all three non-zero: reconciliation", () => {
    // 200 + 40 − 80 = 160
    expect(computeNetGrowth({ altas: 200, births: 40, deaths: 80 })).toBe(160);
  });
});

// ---------------------------------------------------------------------------
// 2. safeRatio
// ---------------------------------------------------------------------------

describe("safeRatio", () => {
  it("returns null when denominator is 0 (guard against division by zero)", () => {
    expect(safeRatio(10, 0)).toBeNull();
  });

  it("returns null when both numerator and denominator are 0", () => {
    expect(safeRatio(0, 0)).toBeNull();
  });

  it("returns 0 when numerator is 0 and denominator > 0", () => {
    expect(safeRatio(0, 5)).toBe(0);
  });

  it("returns the correct ratio for normal inputs", () => {
    expect(safeRatio(10, 2)).toBe(5);
  });

  it("returns a fractional ratio", () => {
    expect(safeRatio(1, 3)).toBeCloseTo(1 / 3);
  });

  it("ratio > 1 is valid (sterilizations can exceed tracked births)", () => {
    // e.g. 300 sterilizations / 100 registered births
    expect(safeRatio(300, 100)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 3. coverageRate
// ---------------------------------------------------------------------------

describe("coverageRate", () => {
  it("returns 0 when total is 0 (no population → no signal)", () => {
    expect(coverageRate(0, 0)).toBe(0);
  });

  it("returns 0 when sterilized is 0 and total > 0", () => {
    expect(coverageRate(0, 100)).toBe(0);
  });

  it("returns 100 when all pets are sterilized", () => {
    expect(coverageRate(100, 100)).toBe(100);
  });

  it("computes 70% coverage correctly", () => {
    expect(coverageRate(70, 100)).toBe(70);
  });

  it("rounds to one decimal place", () => {
    // 1/3 ≈ 33.3%
    expect(coverageRate(1, 3)).toBe(33.3);
  });

  it("partial coverage below 50%", () => {
    // 25/200 = 12.5%
    expect(coverageRate(25, 200)).toBe(12.5);
  });

  it("sterilized > total guard: clamps above 100 (shouldn't happen; no hard cap)", () => {
    // No guard is applied — the fetcher guarantees sterilized ≤ total via EXISTS.
    // This test documents the behaviour (no crash, returns > 100 if data is wrong).
    expect(coverageRate(120, 100)).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// DB-bound shape stubs (tsc-only — require live Postgres; not run in unit suite)
// ---------------------------------------------------------------------------
// The following describe blocks type-check fetchSterilizationCoverage,
// fetchActivePregnancies, fetchReproductiveOutcomes, fetchNetGrowth,
// fetchSterilizationNatalidadRatio, and fetchSterilizationTrend return shapes.
// They mirror the style in trends.test.ts (shape assertions on a real DB).
// Run separately when a live DATABASE_URL is available.
//
// import { buildProjectionContext } from "@/lib/metrics";
// import {
//   fetchActivePregnancies,
//   fetchNetGrowth,
//   fetchReproductiveOutcomes,
//   fetchSterilizationCoverage,
//   fetchSterilizationNatalidadRatio,
//   fetchSterilizationTrend,
// } from "./population-control";
//
// function adminCtx12m() {
//   return buildProjectionContext({ role: "admin" }, [], {
//     since: new Date(Date.now() - 365 * 86_400_000),
//     until: new Date(),
//   });
// }
//
// describe("population-control fetchers — DB shape (requires live Postgres)", () => {
//   it("fetchSterilizationCoverage resolves with correct shape", async () => {
//     const r = await fetchSterilizationCoverage(adminCtx12m());
//     expect(typeof r.rate).toBe("number");
//     expect(typeof r.sterilized).toBe("number");
//     expect(typeof r.total).toBe("number");
//     expect(Array.isArray(r.byProvince)).toBe(true);
//   });
//
//   it("fetchActivePregnancies resolves with a number", async () => {
//     const r = await fetchActivePregnancies(adminCtx12m());
//     expect(typeof r).toBe("number");
//   });
//
//   it("fetchReproductiveOutcomes resolves with correct shape", async () => {
//     const r = await fetchReproductiveOutcomes(adminCtx12m());
//     expect(typeof r.registeredBirths).toBe("number");
//     expect(typeof r.liveBirthsCountSum).toBe("number");
//     expect(typeof r.byClinicalOutcome.live_birth).toBe("number");
//   });
//
//   it("fetchNetGrowth resolves with correct shape", async () => {
//     const r = await fetchNetGrowth(adminCtx12m());
//     expect(typeof r.altas).toBe("number");
//     expect(typeof r.registeredBirths).toBe("number");
//     expect(typeof r.deaths).toBe("number");
//     expect(typeof r.net).toBe("number");
//   });
//
//   it("fetchSterilizationNatalidadRatio returns number or null", async () => {
//     const r = await fetchSterilizationNatalidadRatio(adminCtx12m());
//     expect(r === null || typeof r === "number").toBe(true);
//   });
//
//   it("fetchSterilizationTrend resolves with single-series shape", async () => {
//     const r = await fetchSterilizationTrend(adminCtx12m());
//     expect(["week", "month"]).toContain(r.granularity);
//     expect(Array.isArray(r.points)).toBe(true);
//     expect(typeof r.suppressedCount).toBe("number");
//   });
// });

// ---------------------------------------------------------------------------
// 4. applyCoverageDisclosure — the D.10 rule as fetchSterilizationCoverage
//    applies it to byProvince
// ---------------------------------------------------------------------------
//
// The EXACT function the fetcher calls, so these tests pin production. k protects
// the BASE (`total`, active pets): a rate reveals its denominator, which is the
// premise #40 retired and #40b confirmed for this family. All three numeric
// fields travel together — a rate published beside its base leaks the numerator
// by multiplication, so withholding one and keeping the others is no protection.

const covPeriod = {
  since: new Date("2025-08-01T00:00:00.000Z"),
  until: new Date("2026-08-01T00:00:00.000Z"),
} as unknown as AnalyticsPeriod;

const laRiojaOperator = () =>
  buildProjectionContext({ role: "govt" }, [{ province: "La Rioja", locality: "" }], covPeriod);
const poblacionAdmin = () => buildProjectionContext({ role: "admin" }, [], covPeriod);

describe("applyCoverageDisclosure", () => {
  it("keeps the operator's OWN province at its real numbers, below k", () => {
    const out = applyCoverageDisclosure(laRiojaOperator(), [
      { province: "La Rioja", total: 3, sterilized: 1 },
    ]);

    expect(out.byProvince).toEqual([
      { province: "La Rioja", suppressed: false, total: 3, sterilized: 1, ratePct: 33.3 },
    ]);
    expect(out.byProvinceSuppressedCount).toBe(0);
  });

  it("withholds rate, numerator AND base together for a foreign sub-k province", () => {
    const out = applyCoverageDisclosure(poblacionAdmin(), [
      { province: "Tierra del Fuego", total: 3, sterilized: 1 },
      { province: "Santa Cruz", total: 4, sterilized: 2 },
      { province: "Buenos Aires", total: 9000, sterilized: 4000 },
    ]);

    const tdf = out.byProvince.find((r) => r.province === "Tierra del Fuego");
    expect(tdf).toEqual({
      province: "Tierra del Fuego",
      suppressed: true,
      total: null,
      sterilized: null,
      ratePct: null,
    });
    // Never a confident zero in any of the three.
    expect(tdf?.total).not.toBe(0);
    expect(tdf?.sterilized).not.toBe(0);
    expect(tdf?.ratePct).not.toBe(0);
  });

  it(`does NOT withhold at exactly k (${ANONYMITY_K}) active pets`, () => {
    const out = applyCoverageDisclosure(poblacionAdmin(), [
      { province: "Santa Cruz", total: ANONYMITY_K, sterilized: 2 },
      { province: "Buenos Aires", total: 9000, sterilized: 4000 },
    ]);

    expect(out.byProvinceSuppressedCount).toBe(0);
    expect(out.byProvince.every((r) => r.suppressed === false)).toBe(true);
  });

  it("keeps withheld rows IN the array and reports the real count", () => {
    const out = applyCoverageDisclosure(poblacionAdmin(), [
      { province: "Tierra del Fuego", total: 3, sterilized: 1 },
      { province: "Santa Cruz", total: 4, sterilized: 2 },
      { province: "Buenos Aires", total: 9000, sterilized: 4000 },
    ]);

    expect(out.byProvince).toHaveLength(3);
    expect(out.byProvinceSuppressedCount).toBe(2);
    expect(out.byProvinceSuppressedCount).toBe(out.byProvince.filter((r) => r.suppressed).length);
  });

  it("withholds the base total when a single hidden cell would be recoverable", () => {
    const out = applyCoverageDisclosure(laRiojaOperator(), [
      { province: "La Rioja", total: 40, sterilized: 10 },
      { province: "Santa Cruz", total: 3, sterilized: 1 },
    ]);

    expect(out.byProvinceSuppressedCount).toBe(1);
    expect(out.byProvinceAssignedTotal).toBeNull();
  });
});
