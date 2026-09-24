// Unit tests for lib/metrics/period.ts — pure, no DB.

import { describe, expect, it } from "vitest";

import { resolveAnalyticsPeriod, windows } from "./period";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-18T12:00:00Z").getTime();

describe("resolveAnalyticsPeriod (re-export)", () => {
  it("defaults to trailing 12 months when no period given", () => {
    const { since, until } = resolveAnalyticsPeriod({}, NOW);
    expect(until.getTime()).toBe(NOW);
    expect(NOW - since.getTime()).toBeCloseTo(365 * DAY_MS, -3);
  });

  it("resolves '7d' preset", () => {
    const { since, until } = resolveAnalyticsPeriod({ period: "7d" }, NOW);
    expect(until.getTime()).toBe(NOW);
    expect(NOW - since.getTime()).toBeCloseTo(7 * DAY_MS, -3);
  });

  it("resolves '30d' preset", () => {
    const { since } = resolveAnalyticsPeriod({ period: "30d" }, NOW);
    expect(NOW - since.getTime()).toBeCloseTo(30 * DAY_MS, -3);
  });

  it("resolves valid custom range", () => {
    const { since, until } = resolveAnalyticsPeriod(
      { period: "custom", from: "2026-01-01", to: "2026-03-31" },
      NOW,
    );
    expect(since.toISOString().startsWith("2026-01-01")).toBe(true);
    // until = end-of-day of the `to` date (2026-03-31T23:59:59.999Z), not next day.
    expect(until.toISOString().startsWith("2026-03-31")).toBe(true);
    expect(until.getTime()).toBe(
      new Date("2026-03-31T00:00:00Z").getTime() + 24 * 60 * 60 * 1000 - 1,
    );
  });
});

describe("windows factories", () => {
  it("trailing12m returns a window ~365 days wide", () => {
    const { since, until } = windows.trailing12m();
    expect(until.getTime() - since.getTime()).toBeCloseTo(365 * DAY_MS, -3);
  });

  it("trailing30d returns a window ~30 days wide", () => {
    const { since, until } = windows.trailing30d();
    expect(until.getTime() - since.getTime()).toBeCloseTo(30 * DAY_MS, -3);
  });

  it("trailing7d returns a window ~7 days wide", () => {
    const { since, until } = windows.trailing7d();
    expect(until.getTime() - since.getTime()).toBeCloseTo(7 * DAY_MS, -3);
  });

  it("trailing60d returns a ~60-day window (prior-30d comparison)", () => {
    const { since, until } = windows.trailing60d();
    expect(until.getTime() - since.getTime()).toBeCloseTo(60 * DAY_MS, -3);
  });
});
