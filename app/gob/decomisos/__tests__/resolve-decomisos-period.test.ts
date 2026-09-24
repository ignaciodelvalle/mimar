// Unit tests for resolveDecomisosPeriod (F2b — /gob/decomisos period control
// wiring). PURE by construction: no DB, no auth session.
//
// Regression this pins: resolveAnalyticsPeriod's OWN fallback (no period
// param) is trailing 12 MONTHS (lib/analytics/analytics-period.ts
// defaultWindow), not trailing 30 days — see lib/metrics/period.test.ts
// "defaults to trailing 12 months when no period given". Before F2b, the
// page hardcoded windows.trailing30d() with no searchParam at all; wiring in
// resolveAnalyticsPeriod naively would have silently widened the default D5
// seizures window from 30d to 365d on first load.

import { describe, expect, it } from "vitest";

import { resolveDecomisosPeriod } from "../resolve-decomisos-period";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("resolveDecomisosPeriod", () => {
  it("defaults to trailing 30 days when no period/from param is present (no regression)", () => {
    const { since, until } = resolveDecomisosPeriod({});
    // windows.trailing30d() anchors "now" internally (not injectable), so
    // assert on the WIDTH of the window rather than a fixed NOW.
    expect(until.getTime() - since.getTime()).toBeCloseTo(30 * DAY_MS, -3);
  });

  it("an explicit period param changes the resolved window (e.g. '7d')", () => {
    const period = resolveDecomisosPeriod({ period: "7d" });
    expect(period.until.getTime() - period.since.getTime()).toBeCloseTo(7 * DAY_MS, -3);
  });

  it("an explicit '90d' period widens the window past the 30d default", () => {
    const period = resolveDecomisosPeriod({ period: "90d" });
    expect(period.until.getTime() - period.since.getTime()).toBeCloseTo(90 * DAY_MS, -3);
  });

  it("a custom range (from/to) resolves via resolveAnalyticsPeriod, not the 30d default", () => {
    const period = resolveDecomisosPeriod({
      period: "custom",
      from: "2026-01-01",
      to: "2026-01-31",
    });
    expect(period.since.toISOString().startsWith("2026-01-01")).toBe(true);
    expect(period.until.toISOString().startsWith("2026-01-31")).toBe(true);
  });

  it('`from` alone (without `period: "custom"`) still branches into resolveAnalyticsPeriod, whose own switch then falls to its 12-month default', () => {
    // Guards the `sp.period || sp.from` branch CONDITION itself, not the
    // resolved value: `from`/`to` alone is enough to skip the page's 30d
    // default and delegate to resolveAnalyticsPeriod — but that resolver's
    // `custom` case only fires when `sp.period === "custom"` (see
    // lib/analytics/analytics-period.ts), so an undefined `period` falls
    // through its switch to the 12-month default, NOT the custom range. This
    // is a pre-existing resolver quirk (identical in /gob/campanas' own
    // `sp.period || sp.from` ternary), not something introduced here.
    const period = resolveDecomisosPeriod({ from: "2026-01-01", to: "2026-01-31" });
    expect(period.until.getTime() - period.since.getTime()).toBeCloseTo(365 * DAY_MS, -3);
  });

  it("an unknown/garbage period value falls back to resolveAnalyticsPeriod's OWN default (12 months), not 30d", () => {
    // Once ANY period-shaped param is present, resolution is fully delegated —
    // an invalid preset does not fall back to the page's 30d default, it falls
    // back to resolveAnalyticsPeriod's internal 12-month default. This is a
    // pre-existing, documented resolver behavior (lib/analytics/analytics-period.ts),
    // not something this wiring changes.
    const period = resolveDecomisosPeriod({ period: "not-a-real-preset" });
    expect(period.until.getTime() - period.since.getTime()).toBeCloseTo(365 * DAY_MS, -3);
  });
});
