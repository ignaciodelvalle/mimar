// lib/metrics/census.test.ts — Pure unit tests for Paquete E census predicates.
//
// All tests here are DB-FREE. They cover:
//   1. isIncompleteProfile — truth table
//   2. classifyDormant — recent activity → not dormant; old activity → dormant;
//                        null → dormant; exact boundary
//   3. assertFunnelMonotonic — passes when monotonic; throws on each violation
//   4. funnelPercents — correct percentage calculation including zero-total guard
//
// DB-bound shape tests (registryCounts / registrationTrend / identificationFunnel)
// are described at the bottom as tsc-verified-only stubs (they match the real
// DB-bound trend test pattern in trends.test.ts and run only with a live Postgres).

import { describe, expect, it } from "vitest";

import type { AnalyticsPeriod } from "@/lib/analytics/analytics-period";
import { ANONYMITY_K } from "./anonymity";
import {
  ESTIMATED_DOGS_PER_INHABITANT,
  applyRegistryDisclosure,
  assertFunnelMonotonic,
  classifyDormant,
  computeCensusCoverage,
  estimateDogPopulation,
  funnelPercents,
  isIncompleteProfile,
} from "./census";
import { buildProjectionContext } from "./context";

// ---------------------------------------------------------------------------
// 1. isIncompleteProfile — truth table
// ---------------------------------------------------------------------------

describe("isIncompleteProfile", () => {
  it("complete profile → false", () => {
    expect(isIncompleteProfile({ hasChip: true, sex: "female", hasLocality: true })).toBe(false);
  });

  it("missing chip → true", () => {
    expect(isIncompleteProfile({ hasChip: false, sex: "female", hasLocality: true })).toBe(true);
  });

  it("unknown sex → true", () => {
    expect(isIncompleteProfile({ hasChip: true, sex: "unknown", hasLocality: true })).toBe(true);
  });

  it("missing locality → true", () => {
    expect(isIncompleteProfile({ hasChip: true, sex: "male", hasLocality: false })).toBe(true);
  });

  it("all three missing → true", () => {
    expect(isIncompleteProfile({ hasChip: false, sex: "unknown", hasLocality: false })).toBe(true);
  });

  it("chip + sex missing, locality present → true", () => {
    expect(isIncompleteProfile({ hasChip: false, sex: "unknown", hasLocality: true })).toBe(true);
  });

  it("chip present, sex known (male), locality missing → true", () => {
    expect(isIncompleteProfile({ hasChip: true, sex: "male", hasLocality: false })).toBe(true);
  });

  it("all present with sex=male → false", () => {
    expect(isIncompleteProfile({ hasChip: true, sex: "male", hasLocality: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. classifyDormant
// ---------------------------------------------------------------------------

const NOW = new Date("2026-06-21T12:00:00Z");
const MONTHS = 12;

describe("classifyDormant", () => {
  it("recent activity (1 month ago) → not dormant", () => {
    const lastEvent = new Date("2026-05-21T12:00:00Z"); // 1 month before NOW
    expect(classifyDormant(lastEvent, NOW, MONTHS)).toBe(false);
  });

  it("activity exactly at cutoff boundary → not dormant (>= cutoff is still active)", () => {
    // cutoff = 2025-06-21T12:00:00Z; activity exactly on cutoff is NOT dormant
    // classifyDormant returns true only when lastOwnerEventAt < cutoff
    const cutoff = new Date(NOW);
    cutoff.setMonth(cutoff.getMonth() - MONTHS);
    // Exactly at the cutoff: lastEvent === cutoff → NOT dormant (< is false)
    expect(classifyDormant(new Date(cutoff.getTime()), NOW, MONTHS)).toBe(false);
  });

  it("activity 1ms before cutoff → dormant", () => {
    const cutoff = new Date(NOW);
    cutoff.setMonth(cutoff.getMonth() - MONTHS);
    const lastEvent = new Date(cutoff.getTime() - 1);
    expect(classifyDormant(lastEvent, NOW, MONTHS)).toBe(true);
  });

  it("old activity (2 years ago) → dormant", () => {
    const lastEvent = new Date("2024-06-21T12:00:00Z");
    expect(classifyDormant(lastEvent, NOW, MONTHS)).toBe(true);
  });

  it("null lastOwnerEventAt (no events ever) → dormant", () => {
    expect(classifyDormant(null, NOW, MONTHS)).toBe(true);
  });

  it("respects the months parameter (3-month threshold)", () => {
    const recentEnough = new Date("2026-04-21T12:00:00Z"); // 2 months ago, threshold=3
    expect(classifyDormant(recentEnough, NOW, 3)).toBe(false);

    const tooOld = new Date("2026-02-20T12:00:00Z"); // ~4 months ago, threshold=3
    expect(classifyDormant(tooOld, NOW, 3)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. assertFunnelMonotonic
// ---------------------------------------------------------------------------

describe("assertFunnelMonotonic", () => {
  it("passes for perfectly monotonic stages", () => {
    expect(() =>
      assertFunnelMonotonic({ total: 100, chipped: 80, isoValid: 60, scanned: 20 }),
    ).not.toThrow();
  });

  it("passes when stages are equal (equality is allowed)", () => {
    expect(() =>
      assertFunnelMonotonic({ total: 50, chipped: 50, isoValid: 50, scanned: 50 }),
    ).not.toThrow();
  });

  it("passes when all stages are zero", () => {
    expect(() =>
      assertFunnelMonotonic({ total: 0, chipped: 0, isoValid: 0, scanned: 0 }),
    ).not.toThrow();
  });

  it("throws when total < chipped", () => {
    expect(() =>
      assertFunnelMonotonic({ total: 70, chipped: 80, isoValid: 60, scanned: 20 }),
    ).toThrow(/total.*chipped/i);
  });

  it("throws when chipped < isoValid", () => {
    expect(() =>
      assertFunnelMonotonic({ total: 100, chipped: 50, isoValid: 60, scanned: 20 }),
    ).toThrow(/chipped.*isoValid/i);
  });

  it("does NOT throw when scanned exceeds isoValid (scanned is an independent signal)", () => {
    // A pet can be scanned in the period WITHOUT having an ISO chip, so scanned
    // may legitimately exceed isoValid — it is not part of the chip subset chain
    // (total >= chipped >= isoValid). Asserting isoValid >= scanned was a false
    // invariant that crashed /admin/censo when scans outnumbered ISO chips.
    expect(() =>
      assertFunnelMonotonic({ total: 100, chipped: 80, isoValid: 30, scanned: 40 }),
    ).not.toThrow();
  });

  it("still throws when total < chipped or chipped < isoValid even if scanned is large", () => {
    expect(() =>
      assertFunnelMonotonic({ total: 100, chipped: 80, isoValid: 90, scanned: 999 }),
    ).toThrow(/chipped.*isoValid/i);
  });
});

// ---------------------------------------------------------------------------
// 4. funnelPercents
// ---------------------------------------------------------------------------

describe("funnelPercents", () => {
  it("total is always 100%", () => {
    const pct = funnelPercents({ total: 200, chipped: 160, isoValid: 100, scanned: 40 });
    expect(pct.total).toBe(100);
  });

  it("computes chipped % of total correctly", () => {
    const pct = funnelPercents({ total: 200, chipped: 160, isoValid: 100, scanned: 40 });
    expect(pct.chipped).toBe(80); // 160/200 = 80%
  });

  it("computes isoValid % of total correctly", () => {
    const pct = funnelPercents({ total: 200, chipped: 160, isoValid: 100, scanned: 40 });
    expect(pct.isoValid).toBe(50); // 100/200 = 50%
  });

  it("computes scanned % of total correctly", () => {
    const pct = funnelPercents({ total: 200, chipped: 160, isoValid: 100, scanned: 40 });
    expect(pct.scanned).toBe(20); // 40/200 = 20%
  });

  it("returns 0 for all stages when total is 0 (no division by zero)", () => {
    const pct = funnelPercents({ total: 0, chipped: 0, isoValid: 0, scanned: 0 });
    expect(pct.total).toBe(100);
    expect(pct.chipped).toBe(0);
    expect(pct.isoValid).toBe(0);
    expect(pct.scanned).toBe(0);
  });

  it("rounds to one decimal place", () => {
    // 1/3 ≈ 33.3%
    const pct = funnelPercents({ total: 300, chipped: 100, isoValid: 0, scanned: 0 });
    expect(pct.chipped).toBe(33.3);
  });
});

// ---------------------------------------------------------------------------
// 5. estimateDogPopulation — human census → estimated canine population
// ---------------------------------------------------------------------------

describe("estimateDogPopulation", () => {
  it("applies the dogs-per-inhabitant factor and rounds to a whole dog", () => {
    // 2.000.000 hab × 0,158 = 316.000 perros estimados.
    expect(estimateDogPopulation(2_000_000)).toBe(316_000);
  });

  it("reproduces the ~493k EAH CABA 2022 anchor from the human census (3,12 M hab)", () => {
    // CABA INDEC 2022 (definitivo) = 3.121.707 hab → ≈ 493.230 perros, the
    // GCBA EAH 2022 anchor (493.676 perros censados) this factor is derived
    // from — see ESTIMATED_DOGS_PER_INHABITANT's doc comment.
    expect(estimateDogPopulation(3_121_707)).toBe(
      Math.round(3_121_707 * ESTIMATED_DOGS_PER_INHABITANT),
    );
    expect(estimateDogPopulation(3_121_707)).toBeGreaterThan(490_000);
    expect(estimateDogPopulation(3_121_707)).toBeLessThan(497_000);
  });

  it("returns null when there is no usable human population (no census row)", () => {
    expect(estimateDogPopulation(0)).toBeNull();
    expect(estimateDogPopulation(-1)).toBeNull();
    expect(estimateDogPopulation(Number.NaN)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. computeCensusCoverage — the double denominator's second half
// ---------------------------------------------------------------------------

describe("computeCensusCoverage", () => {
  it("returns the estimated canine denominator and the registry-of-census %", () => {
    // 2.000.000 hab → 316.000 perros estimados; 15.200 registrados → 4,8%.
    const cov = computeCensusCoverage(15_200, 2_000_000);
    expect(cov).toEqual({ censusDenominator: 316_000, censusCoveragePct: 4.8 });
  });

  it("rounds the coverage percentage to one decimal", () => {
    // 100.000 hab → 15.800 perros estimados; 1.000 registrados → 6,329… → 6,3%.
    const cov = computeCensusCoverage(1_000, 100_000);
    expect(cov?.censusDenominator).toBe(15_800);
    expect(cov?.censusCoveragePct).toBe(6.3);
  });

  it("returns 0% coverage when the registry is empty but a census estimate exists", () => {
    const cov = computeCensusCoverage(0, 1_000_000);
    expect(cov).toEqual({ censusDenominator: 158_000, censusCoveragePct: 0 });
  });

  it("returns null when no census estimate is available (no census row → graceful)", () => {
    expect(computeCensusCoverage(12_480, 0)).toBeNull();
    expect(computeCensusCoverage(12_480, -5)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. applyRegistryDisclosure — the D.10 rule as registryByProvince applies it
// ---------------------------------------------------------------------------
//
// This is the EXACT function the fetcher calls after its query, so the tests pin
// production behaviour, not a re-implementation of it. On a density projection
// the published count IS the protected population, which is why every consumer
// of registryByProvince (the /admin/censo ranked table, the /gob/censo
// choropleth, the /gob/censo/export CSV) reads these rows and never a raw one.

const disclosurePeriod = {
  since: new Date("2025-08-01T00:00:00.000Z"),
  until: new Date("2026-08-01T00:00:00.000Z"),
} as unknown as AnalyticsPeriod;

const chubutOperator = () =>
  buildProjectionContext(
    { role: "govt" },
    [{ province: "Chubut", locality: "" }],
    disclosurePeriod,
  );
const censoAdmin = () => buildProjectionContext({ role: "admin" }, [], disclosurePeriod);

describe("applyRegistryDisclosure", () => {
  it("keeps the operator's OWN province at its real count, below k", () => {
    const out = applyRegistryDisclosure(chubutOperator(), [{ province: "Chubut", count: 2 }]);

    expect(out.rows).toEqual([{ province: "Chubut", suppressed: false, count: 2 }]);
    expect(out.suppressedCount).toBe(0);
  });

  it("withholds a foreign sub-k province as NULL — never 0", () => {
    // A false zero is worse than a gap: it asserts "no hay mascotas acá".
    const out = applyRegistryDisclosure(censoAdmin(), [
      { province: "Tierra del Fuego", count: 3 },
      { province: "Santa Cruz", count: 4 },
      { province: "Buenos Aires", count: 90_000 },
    ]);

    const tdf = out.rows.find((r) => r.province === "Tierra del Fuego");
    expect(tdf).toEqual({ province: "Tierra del Fuego", suppressed: true, count: null });
    expect(tdf?.count).not.toBe(0);
  });

  it(`does NOT withhold at exactly k (${ANONYMITY_K})`, () => {
    const out = applyRegistryDisclosure(censoAdmin(), [
      { province: "Santa Cruz", count: ANONYMITY_K },
      { province: "Buenos Aires", count: 90_000 },
    ]);

    expect(out.suppressedCount).toBe(0);
    expect(out.rows.every((r) => r.suppressed === false)).toBe(true);
  });

  it("keeps withheld rows IN the array — absence must not become the channel", () => {
    const out = applyRegistryDisclosure(censoAdmin(), [
      { province: "Tierra del Fuego", count: 3 },
      { province: "Santa Cruz", count: 4 },
      { province: "Buenos Aires", count: 90_000 },
    ]);

    expect(out.rows).toHaveLength(3);
    expect(out.rows.map((r) => r.province)).toContain("Tierra del Fuego");
  });

  it("suppressedCount reflects reality (the #40 follow-up failure: hid data, reported 0)", () => {
    const out = applyRegistryDisclosure(censoAdmin(), [
      { province: "Tierra del Fuego", count: 3 },
      { province: "Santa Cruz", count: 4 },
      { province: "Buenos Aires", count: 90_000 },
    ]);

    expect(out.suppressedCount).toBe(2);
    expect(out.suppressedCount).toBe(out.rows.filter((r) => r.suppressed).length);
  });

  it("withholds the row total when a single hidden cell would be recoverable from it", () => {
    const out = applyRegistryDisclosure(chubutOperator(), [
      { province: "Chubut", count: 40 },
      { province: "Santa Cruz", count: 3 },
    ]);

    expect(out.suppressedCount).toBe(1);
    expect(out.assignedTotal).toBeNull();
  });

  it("empty input is a clean zero, not a suppression", () => {
    const out = applyRegistryDisclosure(censoAdmin(), []);
    expect(out).toEqual({
      rows: [],
      suppressedCount: 0,
      assignedTotal: 0,
      // Nothing to withhold, so nothing bars the scope headline either.
      scopeTotalPublishable: true,
    });
  });
});
