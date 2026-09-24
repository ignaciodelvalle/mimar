// Unit tests for lib/metrics/impact-ranking.ts — PURE, DB-free.
//
// Pins the gap×población ranking's honesty guards: already-met rows are
// excluded (not ranked last, not shown with a fake zero gap), no-census rows
// are ranked LAST with a null impact (never a fabricated score), impact is
// always a rounded real-world unit count, and the "top N covers X%" summary
// never divides by an empty/zero known total.

import { describe, expect, it } from "vitest";

import {
  computeImpact,
  formatImpactUnits,
  formatTopImpactLine,
  isImpactMet,
  rankByImpact,
  summarizeTopImpact,
  totalImpactByJurisdiction,
} from "./impact-ranking";

describe("isImpactMet", () => {
  it("is true when coverage >= target (boundary inclusive)", () => {
    expect(isImpactMet({ coverage: 80, target: 80 })).toBe(true);
    expect(isImpactMet({ coverage: 85, target: 80 })).toBe(true);
  });

  it("is false when coverage is below target", () => {
    expect(isImpactMet({ coverage: 79, target: 80 })).toBe(false);
  });
});

describe("computeImpact", () => {
  it("computes the rounded estimated units uncovered", () => {
    // (80-60)/100 * 10000 = 2000
    expect(computeImpact({ coverage: 60, target: 80, population: 10_000 })).toBe(2000);
  });

  it("rounds — never a decimal unit count", () => {
    // (80-65)/100 * 777 = 116.55 -> 117
    expect(computeImpact({ coverage: 65, target: 80, population: 777 })).toBe(117);
  });

  it("returns null when population is null (no census row) — never fabricated", () => {
    expect(computeImpact({ coverage: 60, target: 80, population: null })).toBeNull();
  });

  it("returns null when population is zero or negative", () => {
    expect(computeImpact({ coverage: 60, target: 80, population: 0 })).toBeNull();
    expect(computeImpact({ coverage: 60, target: 80, population: -5 })).toBeNull();
  });

  it("returns null on a non-finite population", () => {
    expect(computeImpact({ coverage: 60, target: 80, population: Number.NaN })).toBeNull();
  });
});

describe("rankByImpact — exclusion + ranking", () => {
  it("excludes already-met rows entirely (not ranked, not shown with a fake gap)", () => {
    const rows = [{ jurisdiction: "Met Province", coverage: 90, target: 80, population: 50_000 }];
    expect(rankByImpact(rows)).toEqual([]);
  });

  it("ranks below-target rows by impact, descending", () => {
    const rows = [
      { jurisdiction: "Small Gap Big Pop", coverage: 78, target: 80, population: 100_000 }, // impact 2000
      { jurisdiction: "Big Gap Small Pop", coverage: 20, target: 80, population: 1_000 }, // impact 600
      { jurisdiction: "Biggest", coverage: 10, target: 80, population: 200_000 }, // impact 140000
    ];
    const ranked = rankByImpact(rows);
    expect(ranked.map((r) => r.jurisdiction)).toEqual([
      "Biggest",
      "Small Gap Big Pop",
      "Big Gap Small Pop",
    ]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(ranked[0].impact).toBe(140_000);
  });

  it("ranks no-census rows LAST with impact: null — never a fabricated score", () => {
    const rows = [
      { jurisdiction: "Zeta (no census)", coverage: 50, target: 80, population: null },
      { jurisdiction: "Alfa", coverage: 50, target: 80, population: 1_000 }, // impact 300
      { jurisdiction: "Alfa (no census)", coverage: 50, target: 80, population: null },
    ];
    const ranked = rankByImpact(rows);
    expect(ranked[0].jurisdiction).toBe("Alfa");
    expect(ranked[0].impact).toBe(300);
    // No-census rows come after every known-impact row, sorted alphabetically
    // among themselves (never fabricating an order from a null score).
    expect(ranked[1].jurisdiction).toBe("Alfa (no census)");
    expect(ranked[1].impact).toBeNull();
    expect(ranked[2].jurisdiction).toBe("Zeta (no census)");
    expect(ranked[2].impact).toBeNull();
  });

  it("preserves extra fields on the input row (e.g. a `metric` discriminator)", () => {
    const rows = [
      {
        jurisdiction: "Córdoba",
        coverage: 50,
        target: 80,
        population: 1_000,
        metric: "rabies" as const,
      },
    ];
    const [row] = rankByImpact(rows);
    expect(row.metric).toBe("rabies");
    expect(row.impact).toBe(300);
  });
});

describe("totalImpactByJurisdiction", () => {
  it("sums impact across multiple rows for the same jurisdiction", () => {
    const rows = [
      { jurisdiction: "Chaco", coverage: 50, target: 80, population: 1_000 }, // 300
      { jurisdiction: "Chaco", coverage: 60, target: 70, population: 1_000 }, // 100
    ];
    const totals = totalImpactByJurisdiction(rows);
    expect(totals).toEqual([{ jurisdiction: "Chaco", impact: 400 }]);
  });

  it("excludes a jurisdiction whose every row is already met", () => {
    const rows = [{ jurisdiction: "Met", coverage: 90, target: 80, population: 1_000 }];
    expect(totalImpactByJurisdiction(rows)).toEqual([]);
  });

  it("reports impact: null when NONE of a jurisdiction's rows have a population", () => {
    const rows = [
      { jurisdiction: "SinCenso", coverage: 50, target: 80, population: null },
      { jurisdiction: "SinCenso", coverage: 40, target: 70, population: null },
    ];
    const totals = totalImpactByJurisdiction(rows);
    expect(totals).toEqual([{ jurisdiction: "SinCenso", impact: null }]);
  });

  it("sums only the known-population rows when a jurisdiction mixes known/unknown", () => {
    const rows = [
      { jurisdiction: "Mixed", coverage: 50, target: 80, population: 1_000 }, // 300
      { jurisdiction: "Mixed", coverage: 40, target: 70, population: null },
    ];
    const totals = totalImpactByJurisdiction(rows);
    expect(totals).toEqual([{ jurisdiction: "Mixed", impact: 300 }]);
  });
});

describe("summarizeTopImpact", () => {
  it("returns null when no jurisdiction has a known population", () => {
    const totals = [{ jurisdiction: "A", impact: null }];
    expect(summarizeTopImpact(totals)).toBeNull();
  });

  it("returns null when the known total is zero", () => {
    const totals = [{ jurisdiction: "A", impact: 0 }];
    expect(summarizeTopImpact(totals)).toBeNull();
  });

  it("computes topJurisdictions/topImpact/totalImpact/sharePct correctly", () => {
    const totals = [
      { jurisdiction: "A", impact: 600 },
      { jurisdiction: "B", impact: 300 },
      { jurisdiction: "C", impact: 100 },
    ];
    const summary = summarizeTopImpact(totals, 2);
    expect(summary).not.toBeNull();
    if (!summary) return;
    expect(summary.topJurisdictions).toEqual(["A", "B"]);
    expect(summary.topImpact).toBe(900);
    expect(summary.totalImpact).toBe(1000);
    expect(summary.sharePct).toBe(90);
  });

  it("the top-N sum never exceeds the total (sharePct always <= 100)", () => {
    const totals = Array.from({ length: 20 }, (_, i) => ({
      jurisdiction: `J${i}`,
      impact: i + 1,
    }));
    const summary = summarizeTopImpact(totals, 5);
    expect(summary).not.toBeNull();
    if (!summary) return;
    expect(summary.topImpact).toBeLessThanOrEqual(summary.totalImpact);
    expect(summary.sharePct).toBeLessThanOrEqual(100);
  });

  it("when topN >= known.length, sharePct is exactly 100 (the whole gap is the top N)", () => {
    const totals = [
      { jurisdiction: "A", impact: 50 },
      { jurisdiction: "B", impact: 50 },
    ];
    const summary = summarizeTopImpact(totals, 5);
    expect(summary?.sharePct).toBe(100);
  });
});

describe("formatImpactUnits", () => {
  it("formats with es-AR thousands separators", () => {
    expect(formatImpactUnits(1982)).toBe("1.982");
    expect(formatImpactUnits(100)).toBe("100");
  });
});

describe("formatTopImpactLine", () => {
  it("builds the PO's 'El X% del gap nacional está en: ...' line for national scope", () => {
    const summary = {
      topJurisdictions: ["Buenos Aires", "Córdoba", "Santa Fe"],
      topImpact: 600,
      totalImpact: 1000,
      sharePct: 60,
    };
    expect(formatTopImpactLine(summary, "national")).toBe(
      "El 60% del gap nacional está en: Buenos Aires, Córdoba, Santa Fe",
    );
  });

  it("mandate scope says 'gap de tu cobertura', never 'nacional' (red-team #5)", () => {
    // A gob operator's summary covers ONLY their fenced assignments — calling
    // their 3-province mandate "el gap nacional" misstates the universe.
    const summary = {
      topJurisdictions: ["CABA", "Santa Cruz", "Tierra del Fuego"],
      topImpact: 100,
      totalImpact: 100,
      sharePct: 100,
    };
    expect(formatTopImpactLine(summary, "mandate")).toBe(
      "El 100% del gap de tu cobertura está en: CABA, Santa Cruz, Tierra del Fuego",
    );
  });

  it("uses a comma decimal separator for a non-integer share (es-AR)", () => {
    const summary = {
      topJurisdictions: ["A"],
      topImpact: 1,
      totalImpact: 3,
      sharePct: 33.3,
    };
    expect(formatTopImpactLine(summary, "national")).toBe("El 33,3% del gap nacional está en: A");
  });
});
