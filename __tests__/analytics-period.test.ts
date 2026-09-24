// Unit tests for lib/analytics-period — pure resolver, no DB required.

import { describe, expect, it } from "vitest";

import { resolveAnalyticsPeriod } from "@/lib/analytics/analytics-period";

const DAY_MS = 24 * 60 * 60 * 1000;

// Fixed "now" anchor for deterministic assertions.
const NOW = new Date("2026-06-11T12:00:00Z").getTime();

describe("resolveAnalyticsPeriod", () => {
  describe("preset chips", () => {
    it("7d → 7-day window ending now", () => {
      const { since, until } = resolveAnalyticsPeriod({ period: "7d" }, NOW);
      expect(until.getTime()).toBe(NOW);
      expect(since.getTime()).toBe(NOW - 7 * DAY_MS);
    });

    it("30d → 30-day window ending now", () => {
      const { since, until } = resolveAnalyticsPeriod({ period: "30d" }, NOW);
      expect(until.getTime()).toBe(NOW);
      expect(since.getTime()).toBe(NOW - 30 * DAY_MS);
    });

    it("90d → 90-day window ending now", () => {
      const { since, until } = resolveAnalyticsPeriod({ period: "90d" }, NOW);
      expect(until.getTime()).toBe(NOW);
      expect(since.getTime()).toBe(NOW - 90 * DAY_MS);
    });

    it("ytd → Jan 1 of current year to now", () => {
      const { since, until } = resolveAnalyticsPeriod({ period: "ytd" }, NOW);
      expect(until.getTime()).toBe(NOW);
      expect(since.toISOString().startsWith("2026-01-01")).toBe(true);
    });

    it("trailing12m → 365-day window ending now", () => {
      const { since, until } = resolveAnalyticsPeriod({ period: "trailing12m" }, NOW);
      expect(until.getTime()).toBe(NOW);
      expect(since.getTime()).toBe(NOW - 365 * DAY_MS);
    });

    it("3y → 3-year window ending now (Panorama multi-year default)", () => {
      const { since, until } = resolveAnalyticsPeriod({ period: "3y" }, NOW);
      expect(until.getTime()).toBe(NOW);
      expect(since.getTime()).toBe(NOW - 3 * 365 * DAY_MS);
    });

    it("5y → 5-year window ending now", () => {
      const { since, until } = resolveAnalyticsPeriod({ period: "5y" }, NOW);
      expect(until.getTime()).toBe(NOW);
      expect(since.getTime()).toBe(NOW - 5 * 365 * DAY_MS);
    });
  });

  describe("custom range", () => {
    it("valid from/to → window from midnight of `from` to end-of-day of `to`", () => {
      const { since, until } = resolveAnalyticsPeriod(
        { period: "custom", from: "2026-01-01", to: "2026-03-31" },
        NOW,
      );
      expect(since.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      // until = end of 2026-03-31 = 2026-04-01T00:00:00Z - 1ms
      expect(until.getTime()).toBe(new Date("2026-04-01T00:00:00Z").getTime() - 1);
    });

    it("from === to → single-day window", () => {
      const { since, until } = resolveAnalyticsPeriod(
        { period: "custom", from: "2026-05-15", to: "2026-05-15" },
        NOW,
      );
      expect(since.toISOString()).toBe("2026-05-15T00:00:00.000Z");
      expect(until.getTime()).toBe(new Date("2026-05-16T00:00:00Z").getTime() - 1);
    });

    it("from > to → falls back to 12m default", () => {
      const { since } = resolveAnalyticsPeriod(
        { period: "custom", from: "2026-06-01", to: "2026-01-01" },
        NOW,
      );
      expect(since.getTime()).toBeCloseTo(NOW - 365 * DAY_MS, -3);
    });

    it("missing `from` → falls back to 12m default", () => {
      const { since } = resolveAnalyticsPeriod({ period: "custom", to: "2026-06-01" }, NOW);
      expect(since.getTime()).toBeCloseTo(NOW - 365 * DAY_MS, -3);
    });

    it("missing `to` → falls back to 12m default", () => {
      const { since } = resolveAnalyticsPeriod({ period: "custom", from: "2026-01-01" }, NOW);
      expect(since.getTime()).toBeCloseTo(NOW - 365 * DAY_MS, -3);
    });

    it("malformed `from` → falls back to 12m default", () => {
      const { since } = resolveAnalyticsPeriod(
        { period: "custom", from: "not-a-date", to: "2026-06-01" },
        NOW,
      );
      expect(since.getTime()).toBeCloseTo(NOW - 365 * DAY_MS, -3);
    });
  });

  describe("fallback to 12m default", () => {
    it("absent period → 12m window", () => {
      const { since } = resolveAnalyticsPeriod({}, NOW);
      expect(since.getTime()).toBeCloseTo(NOW - 365 * DAY_MS, -3);
    });

    it("unknown preset → 12m window", () => {
      const { since } = resolveAnalyticsPeriod({ period: "6m" }, NOW);
      expect(since.getTime()).toBeCloseTo(NOW - 365 * DAY_MS, -3);
    });

    it("empty string period → 12m window", () => {
      const { since } = resolveAnalyticsPeriod({ period: "" }, NOW);
      expect(since.getTime()).toBeCloseTo(NOW - 365 * DAY_MS, -3);
    });

    it("12m default window is 365 days", () => {
      const { since, until } = resolveAnalyticsPeriod({}, NOW);
      const windowDays = (until.getTime() - since.getTime()) / DAY_MS;
      expect(windowDays).toBeCloseTo(365, 0);
    });
  });

  describe("window ordering invariant", () => {
    it("since is always before until for every preset", () => {
      for (const period of ["7d", "30d", "90d", "ytd"] as const) {
        const { since, until } = resolveAnalyticsPeriod({ period }, NOW);
        expect(since.getTime()).toBeLessThan(until.getTime());
      }
    });
  });
});
