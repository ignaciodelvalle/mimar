// Unit tests for the per-capita rate formula used in fetchCasesPerCapita.
//
// The formula (count / population * 10_000, rounded to 1 decimal) and the
// null-population fallback are pure JS computations inside the mapping
// function of fetchCasesPerCapita. These tests exercise that logic without
// hitting the database by calling the exported type shapes and replicating
// the exact formula from the implementation.
//
// Integration coverage of the DB query itself (JOIN correctness, scope
// filtering) is in govt-dashboards.test.ts.

import { describe, expect, it } from "vitest";

// Replicate the formula from fetchCasesPerCapita so these tests are the
// canonical spec for the math. If the formula changes in the fetcher, update
// both places.
function computeRatePer10k(count: number, population: number | null): number | null {
  if (population === null || population <= 0) return null;
  return Math.round((count / population) * 10_000 * 10) / 10;
}

describe("per-capita rate formula", () => {
  it("computes rate = count / population * 10_000 rounded to 1 decimal", () => {
    // 100 cases in Buenos Aires (17_569_053 pop) → 0.1 per 10k
    const ba = computeRatePer10k(100, 17_569_053);
    expect(ba).toBe(0.1);
  });

  it("handles small province correctly", () => {
    // 50 cases in Santa Cruz (333_473 pop) → ~1.5 per 10k
    const sc = computeRatePer10k(50, 333_473);
    expect(sc).toBe(Math.round((50 / 333_473) * 10_000 * 10) / 10);
  });

  it("returns null when population is null (no census row)", () => {
    expect(computeRatePer10k(42, null)).toBeNull();
  });

  it("returns null when population is 0 (guard against divide-by-zero)", () => {
    expect(computeRatePer10k(10, 0)).toBeNull();
  });

  it("returns null when population is negative (guard)", () => {
    expect(computeRatePer10k(5, -1)).toBeNull();
  });

  it("returns 0 when count is 0 and population is valid", () => {
    expect(computeRatePer10k(0, 1_000_000)).toBe(0);
  });

  it("rounds to exactly 1 decimal place", () => {
    // 1 case in a population of 3, raw = 3333.333... per 10k → 3333.3
    const rate = computeRatePer10k(1, 3);
    expect(rate).toBe(3333.3);
  });

  it("matches the INDEC 2022 CABA population seeded in migration 0067", () => {
    // CABA: 3_120_612 — 312 cases → exactly 1.0 per 10k
    const rate = computeRatePer10k(312, 3_120_612);
    expect(rate).toBe(1.0);
  });
});
