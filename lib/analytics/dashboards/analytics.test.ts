// lib/analytics/dashboards/analytics.test.ts — Pure unit tests for
// acquisitionAdoptionRateSeries (FORECAST-A-META). DB-free: this only
// exercises the pure (month × method) → adoption-rate aggregation, not any
// DB-bound fetcher in this module.

import { describe, expect, it } from "vitest";

import { type AcquisitionTrendPoint, acquisitionAdoptionRateSeries } from "./analytics";

function point(periodStart: string, x: string, method: string, y: number): AcquisitionTrendPoint {
  return { x, y, method, periodStart };
}

describe("acquisitionAdoptionRateSeries", () => {
  it("computes the adoption rate (shelter_adoption / total) per month", () => {
    const points: AcquisitionTrendPoint[] = [
      point("2026-01-01T00:00:00.000Z", "ene 2026", "shelter_adoption", 3),
      point("2026-01-01T00:00:00.000Z", "ene 2026", "vecino_helps_stray", 7),
      point("2026-02-01T00:00:00.000Z", "feb 2026", "shelter_adoption", 5),
      point("2026-02-01T00:00:00.000Z", "feb 2026", "private_handover", 5),
    ];
    const series = acquisitionAdoptionRateSeries(points);
    expect(series).toEqual([
      { period: "ene 2026", value: 30 },
      { period: "feb 2026", value: 50 },
    ]);
  });

  it("returns points sorted chronologically regardless of input order", () => {
    const points: AcquisitionTrendPoint[] = [
      point("2026-03-01T00:00:00.000Z", "mar 2026", "shelter_adoption", 1),
      point("2026-01-01T00:00:00.000Z", "ene 2026", "shelter_adoption", 1),
      point("2026-02-01T00:00:00.000Z", "feb 2026", "shelter_adoption", 1),
    ];
    const series = acquisitionAdoptionRateSeries(points);
    expect(series.map((p) => p.period)).toEqual(["ene 2026", "feb 2026", "mar 2026"]);
  });

  it("omits a month with zero total registrations rather than fabricating a 0%", () => {
    // No row for this synthetic case — a month simply absent from `points`
    // (zero registrations of ANY method) never appears as a fabricated
    // {value: 0} entry, since there is nothing to group in the first place.
    const points: AcquisitionTrendPoint[] = [
      point("2026-01-01T00:00:00.000Z", "ene 2026", "shelter_adoption", 2),
      point("2026-01-01T00:00:00.000Z", "ene 2026", "other", 8),
    ];
    const series = acquisitionAdoptionRateSeries(points);
    expect(series).toHaveLength(1);
    expect(series[0]).toEqual({ period: "ene 2026", value: 20 });
  });

  it("a month with only non-adoption methods reads an honest 0%, not omitted", () => {
    const points: AcquisitionTrendPoint[] = [
      point("2026-01-01T00:00:00.000Z", "ene 2026", "vecino_helps_stray", 4),
      point("2026-01-01T00:00:00.000Z", "ene 2026", "private_handover", 6),
    ];
    const series = acquisitionAdoptionRateSeries(points);
    expect(series).toEqual([{ period: "ene 2026", value: 0 }]);
  });

  it("returns an empty series for an empty input", () => {
    expect(acquisitionAdoptionRateSeries([])).toEqual([]);
  });
});
