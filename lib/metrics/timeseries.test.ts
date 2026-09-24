// Unit tests for the pure time-series bucketing helpers (D1) — DB-FREE.
//
// These cover the branching parts of the trend projection: granularity choice,
// stacked pivot (ordering + 0-fill), and per-cell k-anonymity. The DB-bound
// fetchers in trends.ts delegate to these, so testing the transforms here gives
// the bucketing/scope/k-anon coverage the task requires without a live Postgres.

import { describe, expect, it } from "vitest";

import type { AnalyticsPeriod } from "@/lib/analytics/analytics-period";
import {
  type SeriesBucketRow,
  bucketGranularityFor,
  dateTruncUnit,
  enumerateBucketStarts,
  formatBucketLabel,
  futureBucketLabel,
  isoWeekLabel,
  pivotStackedSeries,
  suppressSmallBuckets,
  suppressSmallStackedCells,
  zeroFillLabeledBuckets,
  zeroFillStackedPoints,
} from "./timeseries";

const DAY_MS = 24 * 60 * 60 * 1000;
const period = (spanDays: number): AnalyticsPeriod => {
  const until = new Date("2026-06-20T00:00:00Z");
  return { since: new Date(until.getTime() - spanDays * DAY_MS), until };
};

describe("bucketGranularityFor", () => {
  it("uses weeks for short/medium windows (7d, 30d, 90d)", () => {
    expect(bucketGranularityFor(period(7))).toBe("week");
    expect(bucketGranularityFor(period(30))).toBe("week");
    expect(bucketGranularityFor(period(90))).toBe("week");
  });

  it("keeps weeks at the 120-day boundary (inclusive)", () => {
    expect(bucketGranularityFor(period(120))).toBe("week");
  });

  it("switches to months past the boundary (121d, 12m default)", () => {
    expect(bucketGranularityFor(period(121))).toBe("month");
    expect(bucketGranularityFor(period(365))).toBe("month");
  });

  it("dateTruncUnit echoes the granularity (drives SQL date_trunc)", () => {
    expect(dateTruncUnit("week")).toBe("week");
    expect(dateTruncUnit("month")).toBe("month");
  });
});

describe("isoWeekLabel / formatBucketLabel", () => {
  it("formats a known date to its ISO-week label", () => {
    // 2026-01-15 is in ISO week 03 of 2026.
    expect(isoWeekLabel(new Date("2026-01-15T00:00:00Z"))).toBe("2026-W03");
  });

  it("rolls early-January dates into the prior ISO year when appropriate", () => {
    // 2027-01-01 is a Friday → ISO week 53 of 2026.
    expect(isoWeekLabel(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
  });

  it("month granularity uses the es-AR short month label WITH the year", () => {
    const label = formatBucketLabel(new Date("2026-03-01T00:00:00Z"), "month");
    // es-AR short month for March is "mar." (locale-dependent but stable family).
    expect(label.toLowerCase()).toContain("mar");
    // Year disambiguation (dataviz review 2026-07-23): month granularity only
    // applies to >120-day windows, which cross calendar years — the label must
    // carry the year or "jul." appears twice on one axis.
    expect(label).toContain("26");
  });

  it("week granularity returns the ISO-week label", () => {
    expect(formatBucketLabel(new Date("2026-01-15T00:00:00Z"), "week")).toBe("2026-W03");
  });
});

describe("zero-fill (dataviz review 2026-07-23 #2)", () => {
  const monthPeriod = {
    since: new Date("2026-01-10T00:00:00Z"),
    until: new Date("2026-07-01T00:00:00Z"),
  } as never;

  it("enumerates every month start the window spans (UTC month firsts)", () => {
    const starts = enumerateBucketStarts(monthPeriod, "month");
    expect(starts.map((d) => d.toISOString().slice(0, 10))).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
      "2026-04-01",
      "2026-05-01",
      "2026-06-01",
      "2026-07-01",
    ]);
  });

  it("enumerates ISO-week Mondays for week granularity", () => {
    const p = {
      since: new Date("2026-01-15T00:00:00Z"), // Thursday of W03
      until: new Date("2026-02-02T00:00:00Z"), // Monday of W06
    } as never;
    const starts = enumerateBucketStarts(p, "week");
    expect(starts.map((d) => d.toISOString().slice(0, 10))).toEqual([
      "2026-01-12", // Monday W03
      "2026-01-19",
      "2026-01-26",
      "2026-02-02",
    ]);
  });

  it("inserts y=0 buckets for months the SQL GROUP BY skipped", () => {
    const feb = new Date("2026-02-01T00:00:00Z");
    const may = new Date("2026-05-01T00:00:00Z");
    const labeled = [
      { start: feb.toISOString(), x: formatBucketLabel(feb, "month"), y: 7 },
      { start: may.toISOString(), x: formatBucketLabel(may, "month"), y: 3 },
    ];
    const filled = zeroFillLabeledBuckets(labeled, monthPeriod, "month");
    // ene..jun complete (jul is a trailing partial with no row → not fabricated);
    // the quiet months (ene, mar, abr, jun) are explicit zeros, not missing ticks.
    expect(filled.map((p) => p.y)).toEqual([0, 7, 0, 0, 3, 0]);
  });

  it("does not fabricate a zero for a trailing partial bucket, but keeps a real row there", () => {
    const p = {
      since: new Date("2026-01-01T00:00:00Z"),
      until: new Date("2026-03-10T00:00:00Z"), // March only partially covered
    } as never;
    const mar = new Date("2026-03-01T00:00:00Z");
    // No March row → no fake terminal collapse.
    expect(zeroFillLabeledBuckets([], p, "month").map((b) => b.x)).toHaveLength(2);
    // A real March row passes through untouched.
    const withMar = zeroFillLabeledBuckets(
      [{ start: mar.toISOString(), x: formatBucketLabel(mar, "month"), y: 4 }],
      p,
      "month",
    );
    expect(withMar.at(-1)?.y).toBe(4);
    expect(withMar).toHaveLength(3);
  });

  it("zero-fills stacked points with all-zero value maps, leaving rowless results empty", () => {
    const feb = new Date("2026-02-01T00:00:00Z");
    const series = {
      seriesKeys: ["natural", "disease"],
      points: [{ x: formatBucketLabel(feb, "month"), values: { natural: 5, disease: 2 } }],
    };
    const filled = zeroFillStackedPoints(series, monthPeriod, "month");
    expect(filled.points).toHaveLength(6); // ene..jun (jul trailing partial skipped)
    expect(filled.points[0].values).toEqual({ natural: 0, disease: 0 });
    expect(filled.points[1].values).toEqual({ natural: 5, disease: 2 });
    // Zero series → stays empty (the in-chart empty state owns that case).
    expect(
      zeroFillStackedPoints({ seriesKeys: [], points: [] }, monthPeriod, "month").points,
    ).toHaveLength(0);
  });

  it("futureBucketLabel names real calendar buckets after the last actual", () => {
    // monthPeriod spans ene..jul-01; a fully-plotted series has 7 actuals →
    // +1 is August, with the year-carrying month label.
    const plus1 = futureBucketLabel(monthPeriod, "month", 7, 1);
    expect(plus1.toLowerCase()).toContain("ago");
    expect(plus1).toContain("26");
    // When the trailing partial bucket was SKIPPED by the zero-fill (6
    // actuals), +1 must name that very bucket (July), not the one after it.
    const plus1Short = futureBucketLabel(monthPeriod, "month", 6, 1);
    expect(plus1Short.toLowerCase()).toContain("jul");
    // Degenerate window (until before since's month-floor → nothing to
    // enumerate) → legacy relative label, never a crash.
    expect(
      futureBucketLabel(
        {
          since: new Date("2026-07-02T00:00:00Z"),
          until: new Date("2026-06-15T00:00:00Z"),
        } as never,
        "month",
        0,
        2,
      ),
    ).toBe("+2");
  });
});

describe("pivotStackedSeries", () => {
  const rows: SeriesBucketRow[] = [
    { bucketStart: "2026-01-05", bucketLabel: "2026-W02", seriesKey: "natural", count: 8 },
    { bucketStart: "2026-01-05", bucketLabel: "2026-W02", seriesKey: "disease", count: 3 },
    { bucketStart: "2026-01-12", bucketLabel: "2026-W03", seriesKey: "natural", count: 5 },
    // disease absent in W03 → must be 0-filled.
  ];

  it("orders buckets chronologically by bucketStart", () => {
    const { points } = pivotStackedSeries(rows);
    expect(points.map((p) => p.x)).toEqual(["2026-W02", "2026-W03"]);
  });

  it("orders series keys by total descending (dominant band first)", () => {
    const { seriesKeys } = pivotStackedSeries(rows);
    // natural total 13 > disease total 3
    expect(seriesKeys).toEqual(["natural", "disease"]);
  });

  it("0-fills missing series so the stack has no gaps", () => {
    const { points } = pivotStackedSeries(rows);
    const w3 = points.find((p) => p.x === "2026-W03");
    expect(w3?.values).toEqual({ natural: 5, disease: 0 });
  });

  it("returns empty shape for an empty window", () => {
    expect(pivotStackedSeries([])).toEqual({ seriesKeys: [], points: [] });
  });
});

describe("suppressSmallBuckets (single-series k-anon)", () => {
  it("masks non-zero counts below k=5 and tallies them", () => {
    const { points, suppressedCount } = suppressSmallBuckets([
      { x: "W01", y: 9 },
      { x: "W02", y: 3 }, // suppressed
      { x: "W03", y: 1 }, // suppressed
    ]);
    // Masked buckets carry the `suppressed` flag (suprimido ≠ cero) so
    // renderers can draw a gap instead of a fake zero.
    expect(points).toEqual([
      { x: "W01", y: 9 },
      { x: "W02", y: 0, suppressed: true },
      { x: "W03", y: 0, suppressed: true },
    ]);
    expect(suppressedCount).toBe(2);
  });

  it("keeps the boundary value k=5 visible", () => {
    const { points, suppressedCount } = suppressSmallBuckets([{ x: "W01", y: 5 }]);
    expect(points[0]?.y).toBe(5);
    expect(suppressedCount).toBe(0);
  });

  it("never masks a genuine zero (true non-identifying dip)", () => {
    const { points, suppressedCount } = suppressSmallBuckets([{ x: "W01", y: 0 }]);
    expect(points[0]?.y).toBe(0);
    expect(suppressedCount).toBe(0);
  });

  it("respects a custom k", () => {
    const { points, suppressedCount } = suppressSmallBuckets([{ x: "W01", y: 2 }], 3);
    expect(points[0]?.y).toBe(0);
    expect(suppressedCount).toBe(1);
  });

  it("handles an empty series", () => {
    expect(suppressSmallBuckets([])).toEqual({ points: [], suppressedCount: 0 });
  });
});

describe("suppressSmallStackedCells (multi-series k-anon)", () => {
  it("masks small non-zero cells per (bucket, series) and counts them", () => {
    const pivoted = pivotStackedSeries([
      { bucketStart: "2026-01-05", bucketLabel: "W02", seriesKey: "natural", count: 10 },
      { bucketStart: "2026-01-05", bucketLabel: "W02", seriesKey: "disease", count: 2 }, // suppressed
      { bucketStart: "2026-01-12", bucketLabel: "W03", seriesKey: "natural", count: 1 }, // suppressed
      { bucketStart: "2026-01-12", bucketLabel: "W03", seriesKey: "disease", count: 7 },
    ]);
    const { series, suppressedCount } = suppressSmallStackedCells(pivoted, 5);
    expect(suppressedCount).toBe(2);
    const w2 = series.points.find((p) => p.x === "W02");
    const w3 = series.points.find((p) => p.x === "W03");
    // The masked value STAYS 0 — deliberate, and identical to the single-series
    // rule: every numeric consumer keeps working. What was missing, and what the
    // next test pins, is the flag that says the 0 is a mask and not a count.
    expect(w2?.values).toEqual({ natural: 10, disease: 0 });
    expect(w3?.values).toEqual({ natural: 0, disease: 7 });
  });

  it("leaves all cells intact when every cell meets k", () => {
    const pivoted = pivotStackedSeries([
      { bucketStart: "2026-01-05", bucketLabel: "W02", seriesKey: "natural", count: 10 },
      { bucketStart: "2026-01-05", bucketLabel: "W02", seriesKey: "disease", count: 6 },
    ]);
    const { suppressedCount } = suppressSmallStackedCells(pivoted, 5);
    expect(suppressedCount).toBe(0);
  });

  it("handles an empty stacked series", () => {
    const { series, suppressedCount } = suppressSmallStackedCells({ seriesKeys: [], points: [] });
    expect(series).toEqual({ seriesKeys: [], points: [] });
    expect(suppressedCount).toBe(0);
  });
});

describe("suppressed≠zero (dataviz review 2026-07-23 #6)", () => {
  it("flags masked buckets so renderers can distinguish them from true zeros", () => {
    const { points, suppressedCount } = suppressSmallBuckets(
      [
        { x: "a", y: 0 },
        { x: "b", y: 3 },
        { x: "c", y: 8 },
      ],
      5,
    );
    expect(suppressedCount).toBe(1);
    expect(points[0].suppressed).toBeUndefined(); // a true zero is never masked
    expect(points[1]).toEqual({ x: "b", y: 0, suppressed: true });
    expect(points[2].suppressed).toBeUndefined();
  });

  // The stacked path survived the 2026-07-23 fix for two months because its flag
  // would have had to live INSIDE the point (a map keyed by series), so nothing
  // about the signature looked incomplete while it was missing. The cost was
  // /gob/mortalidad's "Ver datos" table printing 0 for a month with 1..4 rabies
  // deaths — under a header that already said "N celdas ocultas (privacidad)".
  it("flags masked CELLS per (bucket, series), not just an aggregate count", () => {
    const pivoted = pivotStackedSeries([
      { bucketStart: "2026-01-05", bucketLabel: "W02", seriesKey: "natural", count: 10 },
      { bucketStart: "2026-01-05", bucketLabel: "W02", seriesKey: "disease", count: 2 },
      { bucketStart: "2026-01-12", bucketLabel: "W03", seriesKey: "natural", count: 9 },
      { bucketStart: "2026-01-12", bucketLabel: "W03", seriesKey: "disease", count: 7 },
    ]);
    const { series } = suppressSmallStackedCells(pivoted, 5);
    const w2 = series.points.find((p) => p.x === "W02");
    const w3 = series.points.find((p) => p.x === "W03");

    // Only the masked key is present — the renderer asks `suppressed?.[key]`.
    expect(w2?.suppressed).toEqual({ disease: true });
    expect(w2?.suppressed?.natural).toBeUndefined();
    // A bucket with nothing masked carries NO map at all, so an empty object in
    // a payload never reads as "this bucket participates in suppression".
    expect(w3?.suppressed).toBeUndefined();
  });

  it("never masks a genuine zero cell in a stacked series", () => {
    // A cause absent from a bucket is 0-filled by pivotStackedSeries. A zero is
    // non-identifying and is the signal the operator most needs to see.
    const pivoted = pivotStackedSeries([
      { bucketStart: "2026-01-05", bucketLabel: "W02", seriesKey: "natural", count: 10 },
      { bucketStart: "2026-01-12", bucketLabel: "W03", seriesKey: "natural", count: 8 },
      { bucketStart: "2026-01-12", bucketLabel: "W03", seriesKey: "disease", count: 6 },
    ]);
    const { series, suppressedCount } = suppressSmallStackedCells(pivoted, 5);
    const w2 = series.points.find((p) => p.x === "W02");
    expect(w2?.values.disease).toBe(0);
    expect(w2?.suppressed).toBeUndefined();
    expect(suppressedCount).toBe(0);
  });
});
