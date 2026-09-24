// Unit tests for the pure trend-projection lib (Paquete J, Fase J0) — DB-FREE.
//
// These cover the branching parts of the forecast: OLS slope/extrapolation, the
// widening confidence band (interval monotonicity), the insufficient-data
// abstention, and target-crossing estimation. No Postgres, no Next.js runtime —
// pure input/output, mirroring lib/metrics/timeseries.test.ts.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_HORIZON,
  MIN_POINTS,
  type SeriesPoint,
  projectSeries,
  targetCrossing,
} from "./forecast";

// A perfectly linear rising series: y = 10 + 5·index → slope 5, intercept 10.
const RISING: SeriesPoint[] = [
  { x: "2026-W01", y: 10 },
  { x: "2026-W02", y: 15 },
  { x: "2026-W03", y: 20 },
  { x: "2026-W04", y: 25 },
  { x: "2026-W05", y: 30 },
  { x: "2026-W06", y: 35 },
];

// A flat series — slope ~0.
const FLAT: SeriesPoint[] = [
  { x: "2026-W01", y: 20 },
  { x: "2026-W02", y: 20 },
  { x: "2026-W03", y: 20 },
  { x: "2026-W04", y: 20 },
  { x: "2026-W05", y: 20 },
];

describe("projectSeries — rising linear series", () => {
  it("recovers a positive slope and extrapolates the line", () => {
    const result = projectSeries(RISING, { horizon: 3 });
    expect(result.insufficient).toBe(false);
    expect(result.slopePerBucket).toBeCloseTo(5, 1);

    const forecast = result.points.filter((p) => p.kind === "forecast");
    expect(forecast).toHaveLength(3);

    // Last actual is 35 at index 5; next bucket should extrapolate to ≈40.
    expect(forecast[0].y).toBeCloseTo(40, 1);
    expect(forecast[1].y).toBeCloseTo(45, 1);
    expect(forecast[2].y).toBeCloseTo(50, 1);
  });

  it("keeps actuals as a degenerate band (lo = hi = y)", () => {
    const result = projectSeries(RISING, { horizon: 3 });
    const actuals = result.points.filter((p) => p.kind === "actual");
    expect(actuals).toHaveLength(RISING.length);
    for (const a of actuals) {
      expect(a.lo).toBe(a.y);
      expect(a.hi).toBe(a.y);
    }
  });

  it("the band contains the central projection (lo ≤ y ≤ hi)", () => {
    const result = projectSeries(RISING, { horizon: 3 });
    for (const p of result.points.filter((p) => p.kind === "forecast")) {
      expect(p.lo).toBeLessThanOrEqual(p.y);
      expect(p.hi).toBeGreaterThanOrEqual(p.y);
    }
  });

  it("defaults to horizon 3 when not specified", () => {
    const result = projectSeries(RISING);
    expect(result.points.filter((p) => p.kind === "forecast")).toHaveLength(DEFAULT_HORIZON);
  });

  it("defaults to the linear method", () => {
    expect(projectSeries(RISING).method).toBe("linear");
  });
});

describe("projectSeries — band widens with horizon (interval monotonicity)", () => {
  it("the last forecast bucket has a wider band than the first", () => {
    // Use a noisy-but-rising series so residual SE > 0 (a perfect line has SE 0
    // and a degenerate band). Slight wobble keeps residuals non-zero.
    const noisy: SeriesPoint[] = [
      { x: "W01", y: 10 },
      { x: "W02", y: 14 },
      { x: "W03", y: 19 },
      { x: "W04", y: 26 },
      { x: "W05", y: 29 },
      { x: "W06", y: 37 },
    ];
    const result = projectSeries(noisy, { horizon: 3 });
    const forecast = result.points.filter((p) => p.kind === "forecast");
    const firstWidth = forecast[0].hi - forecast[0].lo;
    const lastWidth = forecast.at(-1)!.hi - forecast.at(-1)!.lo;
    expect(lastWidth).toBeGreaterThan(firstWidth);
  });
});

describe("projectSeries — flat series", () => {
  it("recovers a slope of ≈0", () => {
    const result = projectSeries(FLAT, { horizon: 3 });
    expect(result.slopePerBucket).toBeCloseTo(0, 5);
  });

  it("projects a flat continuation", () => {
    const result = projectSeries(FLAT, { horizon: 3 });
    for (const p of result.points.filter((p) => p.kind === "forecast")) {
      expect(p.y).toBeCloseTo(20, 1);
    }
  });
});

describe("projectSeries — insufficient data", () => {
  it("flags insufficient and emits NO forecast points below MIN_POINTS", () => {
    const short: SeriesPoint[] = [
      { x: "W01", y: 5 },
      { x: "W02", y: 8 },
      { x: "W03", y: 11 },
    ];
    expect(short.length).toBeLessThan(MIN_POINTS);
    const result = projectSeries(short, { horizon: 3 });
    expect(result.insufficient).toBe(true);
    expect(result.points.filter((p) => p.kind === "forecast")).toHaveLength(0);
    // Actuals are still returned untouched.
    expect(result.points).toHaveLength(short.length);
    expect(result.slopePerBucket).toBe(0);
  });

  it("treats an empty series as insufficient", () => {
    const result = projectSeries([], { horizon: 3 });
    expect(result.insufficient).toBe(true);
    expect(result.points).toHaveLength(0);
  });
});

describe("projectSeries — non-negative clamp", () => {
  it("never projects a flow count below zero", () => {
    // Steeply falling series whose linear extrapolation would go negative.
    const falling: SeriesPoint[] = [
      { x: "W01", y: 20 },
      { x: "W02", y: 14 },
      { x: "W03", y: 9 },
      { x: "W04", y: 3 },
    ];
    const result = projectSeries(falling, { horizon: 3 });
    for (const p of result.points.filter((p) => p.kind === "forecast")) {
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.lo).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("targetCrossing", () => {
  it("returns the expected bucket count for a known slope + target", () => {
    // RISING: last actual = 35, slope = 5. Target 50 → +1:40, +2:45, +3:50.
    // First bucket reaching ≥ 50 is the 3rd forecast bucket.
    const result = projectSeries(RISING, { horizon: 3 });
    expect(targetCrossing(result, 50, "above")).toBe(3);
  });

  it("returns the first crossing bucket, not a later one", () => {
    const result = projectSeries(RISING, { horizon: 5 });
    // Target 42 → reached at +2 (45), since +1 is 40.
    expect(targetCrossing(result, 42, "above")).toBe(2);
  });

  it("returns null when the target is not reached within the horizon", () => {
    const result = projectSeries(RISING, { horizon: 3 });
    // Target 100 is far beyond +3 (50).
    expect(targetCrossing(result, 100, "above")).toBeNull();
  });

  it("returns null for a flat series already on the target side (above)", () => {
    // FLAT sits at 20; target 15 with direction 'above' is already met.
    const result = projectSeries(FLAT, { horizon: 3 });
    expect(targetCrossing(result, 15, "above")).toBeNull();
  });

  it("detects a downward crossing (direction 'below')", () => {
    const falling: SeriesPoint[] = [
      { x: "W01", y: 50 },
      { x: "W02", y: 45 },
      { x: "W03", y: 40 },
      { x: "W04", y: 35 },
    ];
    // slope -5, last actual 35. Target 25 → +1:30, +2:25 → crosses at +2.
    const result = projectSeries(falling, { horizon: 3 });
    expect(targetCrossing(result, 25, "below")).toBe(2);
  });

  it("returns null when insufficient", () => {
    const short: SeriesPoint[] = [
      { x: "W01", y: 5 },
      { x: "W02", y: 8 },
    ];
    const result = projectSeries(short, { horizon: 3 });
    expect(targetCrossing(result, 10, "above")).toBeNull();
  });
});

describe("projectSeries — holt method", () => {
  it("produces forecast points and reports method 'holt'", () => {
    const result = projectSeries(RISING, { horizon: 3, method: "holt" });
    expect(result.method).toBe("holt");
    expect(result.points.filter((p) => p.kind === "forecast")).toHaveLength(3);
    // A rising series under Holt should still trend upward.
    expect(result.slopePerBucket).toBeGreaterThan(0);
  });
});
