// Unit tests for lib/metrics/forecast-to-target.ts — PURE, DB-free.
//
// Covers every named branch (met / insufficient / receding / unreachable /
// months) plus the honesty invariants FORECAST-A-META requires: never a
// forecast from <3 points, never a line on a met target, receding never
// reads as progress, months are always integer/approximate.

import { describe, expect, it } from "vitest";

import {
  type ForecastTrendPoint,
  MAX_HORIZON_MONTHS,
  MIN_TREND_POINTS,
  forecastToTarget,
  resourceGap,
} from "./forecast-to-target";

const monthly = (values: number[]): ForecastTrendPoint[] =>
  values.map((value, i) => ({ period: `2026-${String(i + 1).padStart(2, "0")}`, value }));

describe("forecastToTarget — met", () => {
  it("reports 'met' with a null line when current already beats a higher-is-better target", () => {
    const result = forecastToTarget({ current: 85, target: 80, trend: [] });
    expect(result.kind).toBe("met");
    expect(result.line).toBeNull();
  });

  it("reports 'met' exactly at the target boundary (>=, not just >)", () => {
    const result = forecastToTarget({ current: 80, target: 80, trend: [] });
    expect(result.kind).toBe("met");
  });

  it("reports 'met' for a lower-is-better target when current is already at/below it", () => {
    const result = forecastToTarget({
      current: 8,
      target: 10,
      trend: [],
      higherIsBetter: false,
    });
    expect(result.kind).toBe("met");
    expect(result.line).toBeNull();
  });

  it("'met' short-circuits BEFORE the data-sufficiency guard — a thin trend doesn't matter once the target is reached", () => {
    const result = forecastToTarget({ current: 90, target: 80, trend: monthly([1]) });
    expect(result.kind).toBe("met");
  });
});

describe("forecastToTarget — insufficient (the <3-points honesty guard)", () => {
  it("never forecasts from an empty trend", () => {
    expect(forecastToTarget({ current: 10, target: 80, trend: [] }).kind).toBe("insufficient");
  });

  it("never forecasts from 1 point", () => {
    expect(forecastToTarget({ current: 10, target: 80, trend: monthly([10]) }).kind).toBe(
      "insufficient",
    );
  });

  it("never forecasts from 2 points (still below MIN_TREND_POINTS)", () => {
    expect(MIN_TREND_POINTS).toBe(3);
    expect(forecastToTarget({ current: 12, target: 80, trend: monthly([10, 12]) }).kind).toBe(
      "insufficient",
    );
  });

  it("insufficient always carries a null line, never an invented string", () => {
    const result = forecastToTarget({ current: 10, target: 80, trend: monthly([10, 11]) });
    expect(result.line).toBeNull();
  });

  it("3 points is enough — the boundary is inclusive", () => {
    const result = forecastToTarget({ current: 14, target: 80, trend: monthly([10, 12, 14]) });
    expect(result.kind).not.toBe("insufficient");
  });
});

describe("forecastToTarget — receding (never reads as progress)", () => {
  it("a higher-is-better metric falling away from its target reports 'receding', never 'months'", () => {
    const result = forecastToTarget({ current: 10, target: 80, trend: monthly([14, 12, 10]) });
    expect(result.kind).toBe("receding");
    expect(result.line).toBe("→ tendencia en retroceso");
  });

  it("a lower-is-better metric rising away from its (ceiling) target also reports 'receding'", () => {
    const result = forecastToTarget({
      current: 20,
      target: 10,
      trend: monthly([10, 15, 20]),
      higherIsBetter: false,
    });
    expect(result.kind).toBe("receding");
  });

  it("receding's line never contains an optimistic word like 'meta' or a month count", () => {
    const result = forecastToTarget({ current: 10, target: 80, trend: monthly([14, 12, 10]) });
    expect(result.line).not.toMatch(/meta/i);
    expect(result.line).not.toMatch(/\d/);
  });
});

describe("forecastToTarget — unreachable (flat and glacial trends)", () => {
  it("a perfectly flat trend (zero measured movement) is 'unreachable', not '0 meses'", () => {
    const result = forecastToTarget({ current: 10, target: 80, trend: monthly([10, 10, 10]) });
    expect(result.kind).toBe("unreachable");
    expect(result.line).toBe("→ al ritmo actual no se alcanza");
  });

  it("a technically-positive but glacial slope beyond MAX_HORIZON_MONTHS is 'unreachable', not a 3-digit ETA", () => {
    expect(MAX_HORIZON_MONTHS).toBe(120);
    // slope = 0.1/month; gap = 80 - 10.2 = 69.8 → monthsRaw = 698, far past 120.
    const result = forecastToTarget({
      current: 10.2,
      target: 80,
      trend: monthly([10, 10.1, 10.2]),
    });
    expect(result.kind).toBe("unreachable");
  });

  it("unreachable never carries a numeric month count in its line", () => {
    const result = forecastToTarget({ current: 10, target: 80, trend: monthly([10, 10, 10]) });
    expect(result.line).not.toMatch(/\d/);
  });
});

describe("forecastToTarget — months (the honest ETA)", () => {
  it("computes an integer months estimate for a genuinely improving trend", () => {
    // slope = 2/month (10,12,14); gap = 80-14 = 66 → 33 months.
    const result = forecastToTarget({ current: 14, target: 80, trend: monthly([10, 12, 14]) });
    expect(result.kind).toBe("months");
    if (result.kind === "months") {
      expect(result.months).toBe(33);
      expect(Number.isInteger(result.months)).toBe(true);
      expect(result.line).toBe("→ a este ritmo: meta en ~33 meses");
    }
  });

  it("never shows false precision — a fractional projection rounds to a whole number", () => {
    // slope = (14-10)/2 = 2/month over index; construct a gap that doesn't
    // divide evenly (67 / 2 = 33.5) to force rounding.
    const result = forecastToTarget({ current: 13, target: 80, trend: monthly([9, 11, 13]) });
    expect(result.kind).toBe("months");
    if (result.kind === "months") {
      expect(result.line).not.toMatch(/\.\d/);
      expect(Number.isInteger(result.months)).toBe(true);
    }
  });

  it("uses the singular 'mes' when the estimate rounds to exactly 1", () => {
    // slope = 2/month; gap = 2 → 1 month exactly.
    const result = forecastToTarget({ current: 8, target: 10, trend: monthly([4, 6, 8]) });
    expect(result.kind).toBe("months");
    if (result.kind === "months") {
      expect(result.months).toBe(1);
      expect(result.line).toBe("→ a este ritmo: meta en ~1 mes");
    }
  });

  it("clamps a sub-1-month projection up to '~1 mes' rather than '~0 meses'", () => {
    // slope = 10/month; gap = 80-70=10 → monthsRaw = 1 exactly (not <1 here,
    // so use a bigger slope to force a fractional <1 raw estimate instead).
    const result = forecastToTarget({ current: 79, target: 80, trend: monthly([50, 65, 79]) });
    expect(result.kind).toBe("months");
    if (result.kind === "months") {
      expect(result.months).toBeGreaterThanOrEqual(1);
      expect(result.line).not.toContain("~0 ");
    }
  });

  it("computes correctly for a lower-is-better metric falling toward its ceiling target", () => {
    // values falling 20→16→12 (slope -4/month); target 10; gap=2 → closingSpeed=4 → 1 month? gap/4=0.5→round→1 (clamped).
    const result = forecastToTarget({
      current: 12,
      target: 10,
      trend: monthly([20, 16, 12]),
      higherIsBetter: false,
    });
    expect(result.kind).toBe("months");
  });

  it("respects stepMonths for non-monthly bucket granularities (e.g. weekly)", () => {
    // slopePerStep = 1/step; stepMonths=0.25 → slopePerMonth = 4. gap = 10-2=8 → 2 months.
    const weekly = forecastToTarget({
      current: 2,
      target: 10,
      trend: monthly([0, 1, 2]),
      stepMonths: 0.25,
    });
    expect(weekly.kind).toBe("months");
    if (weekly.kind === "months") expect(weekly.months).toBe(2);

    // Same series with the default stepMonths=1 (slopePerMonth=1) → 8 months —
    // proves stepMonths actually changes the output, not just a no-op default.
    const asMonthly = forecastToTarget({ current: 2, target: 10, trend: monthly([0, 1, 2]) });
    expect(asMonthly.kind).toBe("months");
    if (asMonthly.kind === "months") expect(asMonthly.months).toBe(8);
  });
});

describe("resourceGap — states WHAT is missing (PO decision 2, item 2)", () => {
  it("computes the rounded absolute units missing, with the padrón caveat baked in", () => {
    // (80-60)/100 * 1000 = 200
    const result = resourceGap({ current: 60, target: 80, denominator: 1000 }, "dosis");
    expect(result.kind).toBe("units");
    if (result.kind === "units") {
      expect(result.units).toBe(200);
      expect(result.line).toBe("faltan ~200 dosis sobre el padrón registrado");
    }
  });

  it("formats units with es-AR thousands separators", () => {
    // (80-20)/100 * 5000 = 3000
    const result = resourceGap({ current: 20, target: 80, denominator: 5000 }, "chips");
    expect(result.kind).toBe("units");
    if (result.kind === "units") {
      expect(result.line).toBe("faltan ~3.000 chips sobre el padrón registrado");
    }
  });

  it("reports 'met' with a null line when the target is already reached", () => {
    const result = resourceGap({ current: 85, target: 80, denominator: 1000 }, "dosis");
    expect(result.kind).toBe("met");
    expect(result.line).toBeNull();
  });

  it("respects higherIsBetter:false (a ceiling target)", () => {
    const result = resourceGap(
      { current: 5, target: 10, denominator: 1000, higherIsBetter: false },
      "casos",
    );
    expect(result.kind).toBe("met");
  });

  it("never fabricates a line when there is no denominator", () => {
    expect(resourceGap({ current: 20, target: 80, denominator: null }, "dosis").line).toBeNull();
    expect(resourceGap({ current: 20, target: 80, denominator: 0 }, "dosis").kind).toBe(
      "no_denominator",
    );
    expect(resourceGap({ current: 20, target: 80, denominator: -5 }, "dosis").kind).toBe(
      "no_denominator",
    );
  });

  it("never renders 'faltan ~0' — a sub-1-unit gap is 'negligible', not a fake zero ask", () => {
    // (80.4-80)/100 * 10 = 0.04 -> rounds to 0
    const result = resourceGap({ current: 80, target: 80.4, denominator: 10 }, "dosis");
    expect(result.kind).toBe("negligible");
    expect(result.line).toBeNull();
  });
});
