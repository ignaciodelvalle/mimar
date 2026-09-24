import { describe, expect, it } from "vitest";

import { histogramPeak, valueHistogram } from "@/components/panorama/legend-histogram";

describe("valueHistogram — in-legend distribution (#5)", () => {
  it("buckets values into equal-width bins over the domain", () => {
    const bins = valueHistogram([10, 20, 25, 90], 0, 100, 10);
    expect(bins).toHaveLength(10);
    // 10 → bin[1], 20/25 → bin[2], 90 → bin[9].
    expect(bins[1].count).toBe(1);
    expect(bins[2].count).toBe(2);
    expect(bins[9].count).toBe(1);
    // Every value is accounted for.
    const total = bins.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(4);
  });

  it("clamps out-of-domain values into the edge bins rather than dropping them", () => {
    const bins = valueHistogram([-10, 250], 0, 100, 4);
    expect(bins[0].count).toBe(1); // -10 clamped to the low edge
    expect(bins[3].count).toBe(1); // 250 clamped to the high edge
  });

  it("puts the exact top-edge value in the last bin", () => {
    const bins = valueHistogram([100], 0, 100, 5);
    expect(bins[4].count).toBe(1);
  });

  it("shows the real coverage spread (34-65) sitting entirely below an 80% meta", () => {
    // The concrete defect scenario: no province reaches the neutral midpoint, and
    // the whole above-meta half is empty — the histogram makes that visible.
    const coverage = [34, 41, 48, 52, 58, 63, 65];
    const bins = valueHistogram(coverage, 0, 100, 10);
    const aboveMeta = bins.filter((b) => b.lo >= 80).reduce((s, b) => s + b.count, 0);
    expect(aboveMeta).toBe(0);
    const total = bins.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(coverage.length);
  });

  it("returns an empty histogram for a degenerate domain", () => {
    expect(valueHistogram([1, 2], 50, 50, 10)).toEqual([]);
    expect(valueHistogram([1, 2], 0, 100, 0)).toEqual([]);
  });
});

describe("histogramPeak", () => {
  it("returns the largest bucket count", () => {
    expect(histogramPeak(valueHistogram([1, 1, 1, 50], 0, 100, 10))).toBe(3);
  });

  it("returns 0 for an empty histogram", () => {
    expect(histogramPeak([])).toBe(0);
  });
});
