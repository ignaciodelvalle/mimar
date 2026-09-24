// Unit tests for the jurisdiction composite index (Task #44.1).
// Pure functions only — no DB, no Next.js runtime.

import { describe, expect, it } from "vitest";

import type { OutlierRow } from "@/lib/metrics";

import {
  INDEX_COMPONENT_ORDER,
  computeJurisdictionIndex,
  selectLowestScoringJurisdictions,
  targetAttainment,
} from "./territorial-index";

function row(
  province: string,
  metric: OutlierRow["metric"],
  rate: number,
  target: number,
  // The base the rate was divided by (OutlierRow.denominator). This module only
  // normalizes and averages RATES, so the value is irrelevant to every
  // assertion below — it has to be present and >= K_ANON_MIN, and that is all.
  denominator = 100,
): OutlierRow {
  return {
    province,
    metric,
    rate,
    target,
    gap: Math.round((target - rate) * 10) / 10,
    isOutlier: rate < target,
    denominator,
  };
}

describe("targetAttainment", () => {
  it("scores 100 when the rate meets the target exactly", () => {
    expect(targetAttainment(80, 80)).toBe(100);
  });

  it("caps at 100 when the rate exceeds the target", () => {
    expect(targetAttainment(95, 80)).toBe(100);
  });

  it("scores proportionally below target (one decimal)", () => {
    // 40 / 80 = 50%
    expect(targetAttainment(40, 80)).toBe(50);
    // 52.5 / 70 = 75%
    expect(targetAttainment(52.5, 70)).toBe(75);
  });

  it("returns 0 for a zero rate and guards a zero target", () => {
    expect(targetAttainment(0, 80)).toBe(0);
    expect(targetAttainment(50, 0)).toBe(0);
  });
});

describe("computeJurisdictionIndex", () => {
  it("returns an empty array for empty input", () => {
    expect(computeJurisdictionIndex([])).toEqual([]);
  });

  it("averages the three component attainments with equal weights", () => {
    const rows = [
      row("Córdoba", "rabies", 80, 80), // attainment 100
      row("Córdoba", "sterilization", 35, 70), // attainment 50
      row("Córdoba", "microchip", 60, 80), // attainment 75
    ];
    const [cordoba] = computeJurisdictionIndex(rows);
    expect(cordoba.province).toBe("Córdoba");
    expect(cordoba.componentsUsed).toBe(3);
    // mean(100, 50, 75) = 75
    expect(cordoba.score).toBe(75);
  });

  it("computes a partial score when the rabies component is k-anon-omitted upstream", () => {
    const rows = [
      row("Formosa", "sterilization", 70, 70), // attainment 100
      row("Formosa", "microchip", 40, 80), // attainment 50
    ];
    const [formosa] = computeJurisdictionIndex(rows);
    expect(formosa.componentsUsed).toBe(2);
    expect(formosa.components.rabies).toBeUndefined();
    // mean(100, 50) = 75
    expect(formosa.score).toBe(75);
  });

  it("ranks provinces by score descending with 1-based ranks", () => {
    const rows = [
      row("Salta", "microchip", 80, 80), // score 100
      row("Chaco", "microchip", 40, 80), // score 50
      row("Jujuy", "microchip", 60, 80), // score 75
    ];
    const result = computeJurisdictionIndex(rows);
    expect(result.map((r) => r.province)).toEqual(["Salta", "Jujuy", "Chaco"]);
    expect(result.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("breaks score ties alphabetically by province (es collation)", () => {
    const rows = [row("Mendoza", "microchip", 40, 80), row("Chubut", "microchip", 40, 80)];
    const result = computeJurisdictionIndex(rows);
    expect(result.map((r) => r.province)).toEqual(["Chubut", "Mendoza"]);
  });

  it("keeps per-component rate/target/attainment detail for the UI", () => {
    const rows = [row("CABA", "sterilization", 35, 70)];
    const [caba] = computeJurisdictionIndex(rows);
    expect(caba.components.sterilization).toEqual({ rate: 35, target: 70, attainment: 50 });
  });

  it("INDEX_COMPONENT_ORDER covers exactly the three outlier metrics", () => {
    expect([...INDEX_COMPONENT_ORDER].sort()).toEqual(["microchip", "rabies", "sterilization"]);
  });
});

// D-2 (Lote D) — the /admin home compliance teaser's selector. It must be a
// REORDERING of the index, never a second scoring opinion: the teaser's
// "puesto N de M" is the same rank the full /admin/inteligencia table prints.
describe("selectLowestScoringJurisdictions — the outlier tail", () => {
  const index = computeJurisdictionIndex([
    row("Salta", "microchip", 80, 80), // score 100 → rank 1
    row("Jujuy", "microchip", 60, 80), // score 75  → rank 2
    row("Chaco", "microchip", 40, 80), // score 50  → rank 3
    row("Formosa", "microchip", 8, 80), // score 10  → rank 4
  ]);

  it("returns the worst provinces FIRST, keeping each row's original rank", () => {
    const tail = selectLowestScoringJurisdictions(index, 2);
    expect(tail.map((r) => r.province)).toEqual(["Formosa", "Chaco"]);
    expect(tail.map((r) => r.rank)).toEqual([4, 3]);
    expect(tail.map((r) => r.score)).toEqual([10, 50]);
  });

  it("does not depend on the input arriving best-first (a filtered caller must get the same tail)", () => {
    const shuffled = [index[2], index[0], index[3], index[1]];
    expect(selectLowestScoringJurisdictions(shuffled, 2).map((r) => r.province)).toEqual([
      "Formosa",
      "Chaco",
    ]);
  });

  it("returns every row when the limit exceeds the index, and none for a non-positive limit", () => {
    expect(selectLowestScoringJurisdictions(index, 99)).toHaveLength(4);
    expect(selectLowestScoringJurisdictions(index, 0)).toEqual([]);
    expect(selectLowestScoringJurisdictions([], 4)).toEqual([]);
  });

  it("leaves the caller's array untouched (no in-place sort of the shared index)", () => {
    const before = index.map((r) => r.province);
    selectLowestScoringJurisdictions(index, 3);
    expect(index.map((r) => r.province)).toEqual(before);
  });

  it("keeps a k-anon-partial province in the tail — hiding it would bias the ranking", () => {
    const partial = computeJurisdictionIndex([
      row("Salta", "microchip", 80, 80),
      row("Salta", "sterilization", 70, 70),
      row("Salta", "rabies", 80, 80),
      // Only 2 of 3 components: rabies suppressed for <5 active dogs.
      row("Chaco", "microchip", 10, 80),
      row("Chaco", "sterilization", 7, 70),
    ]);
    const [worst] = selectLowestScoringJurisdictions(partial, 1);
    expect(worst.province).toBe("Chaco");
    expect(worst.componentsUsed).toBe(2);
  });
});
