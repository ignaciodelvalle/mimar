// Unit tests for the per-province data-quality score (Task #44.3).
// Pure functions only — no DB, no Next.js runtime.

import { describe, expect, it } from "vitest";

import type { ProvinceDataQualitySignals } from "./territorial-data-quality";
import { computeQualityScore, rankProvinceQuality } from "./territorial-data-quality";

function signals(overrides: Partial<ProvinceDataQualitySignals> = {}): ProvinceDataQualitySignals {
  return {
    total: 100,
    missingLocality: 0,
    missingSex: 0,
    missingChip: 0,
    orphans: 0,
    dormant: 0,
    ghosts: 0,
    replacedChips: 0,
    ...overrides,
  };
}

describe("computeQualityScore", () => {
  it("scores 100 when nothing is missing", () => {
    expect(computeQualityScore(signals())).toBe(100);
  });

  it("scores 0 when every signal fails for every record", () => {
    expect(
      computeQualityScore(
        signals({
          missingLocality: 100,
          missingSex: 100,
          missingChip: 100,
          orphans: 100,
          dormant: 100,
        }),
      ),
    ).toBe(0);
  });

  it("averages the five ratios with equal weights", () => {
    // One ratio at 50%, four perfect → mean = (0.5 + 4) / 5 = 0.9 → 90.
    expect(computeQualityScore(signals({ missingChip: 50 }))).toBe(90);
  });

  it("ignores replacedChips and ghosts in the score (context columns)", () => {
    expect(computeQualityScore(signals({ replacedChips: 100, ghosts: 100 }))).toBe(100);
  });

  it("returns 100 for an empty province (consistent with completeness())", () => {
    expect(computeQualityScore(signals({ total: 0 }))).toBe(100);
  });
});

describe("rankProvinceQuality", () => {
  it("ranks best score first with 1-based ranks", () => {
    const rows = rankProvinceQuality([
      { province: "Chaco", ...signals({ missingChip: 80 }) }, // 84
      { province: "Salta", ...signals() }, // 100
      { province: "Jujuy", ...signals({ missingChip: 40 }) }, // 92
    ]);
    expect(rows.map((r) => r.province)).toEqual(["Salta", "Jujuy", "Chaco"]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.score)).toEqual([100, 92, 84]);
  });

  it("breaks ties alphabetically (es collation)", () => {
    const rows = rankProvinceQuality([
      { province: "Mendoza", ...signals() },
      { province: "Chubut", ...signals() },
    ]);
    expect(rows.map((r) => r.province)).toEqual(["Chubut", "Mendoza"]);
  });

  it("preserves all signal columns for the UI", () => {
    const [row] = rankProvinceQuality([
      { province: "CABA", ...signals({ ghosts: 7, replacedChips: 3, dormant: 20 }) },
    ]);
    expect(row.ghosts).toBe(7);
    expect(row.replacedChips).toBe(3);
    expect(row.dormant).toBe(20);
    // dormant 20/100 → ratios (1,1,1,1,0.8) → 96
    expect(row.score).toBe(96);
  });
});
