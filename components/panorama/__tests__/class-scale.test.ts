// Unit tests for the threshold-classed choropleth scale helpers (pure — no
// maplibre runtime, no DOM). Verifies meta / quantile / equal-interval break
// policies, color assignment off the dark ramp, and the step-expression + legend
// swatch builders stay in sync.

import { describe, expect, it } from "vitest";

import { SCALE_BLUE_SEQ } from "@dim/contract/viz";
import {
  CLASS_COUNT,
  classColors,
  classSwatches,
  colorForValue,
  computeClassScale,
  stepColorExpr,
} from "../class-scale";

describe("classColors", () => {
  it("returns the full ramp for n === CLASS_COUNT (5)", () => {
    expect(classColors(5)).toEqual([...SCALE_BLUE_SEQ]);
  });

  it("keeps both poles for 4 classes (drops a mid stop)", () => {
    const c = classColors(4);
    expect(c).toHaveLength(4);
    expect(c[0]).toBe(SCALE_BLUE_SEQ[0]);
    expect(c[3]).toBe(SCALE_BLUE_SEQ[4]);
  });

  it("returns a single mid-ramp color for n === 1 (flat class)", () => {
    expect(classColors(1)).toEqual([SCALE_BLUE_SEQ[2]]);
  });
});

describe("computeClassScale — meta policy", () => {
  it("cuts at half / three-quarters / the meta (80 → 40,60,80)", () => {
    const scale = computeClassScale([34, 50, 65, 72, 81], { target: 80 });
    expect(scale.method).toBe("meta");
    expect(scale.breaks).toEqual([40, 60, 80]);
    // 3 breaks → 4 classes → 4 colors.
    expect(scale.colors).toHaveLength(4);
  });
});

describe("computeClassScale — quantile policy", () => {
  it("produces CLASS_COUNT-1 ascending breaks for a spread value set", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const scale = computeClassScale(values);
    expect(scale.method).toBe("quantile");
    expect(scale.breaks).toHaveLength(CLASS_COUNT - 1);
    // Strictly ascending (MapLibre `step` requires it).
    for (let i = 1; i < scale.breaks.length; i++) {
      expect(scale.breaks[i]).toBeGreaterThan(scale.breaks[i - 1]);
    }
    expect(scale.colors).toHaveLength(scale.breaks.length + 1);
  });

  it("falls back to equal-interval when there are fewer units than classes", () => {
    const scale = computeClassScale([0, 100]);
    expect(scale.method).toBe("interval");
    expect(scale.breaks[0]).toBeGreaterThan(0);
    expect(scale.breaks[scale.breaks.length - 1]).toBeLessThan(100);
  });

  it("collapses an all-equal value set to a flat class", () => {
    const scale = computeClassScale([7, 7, 7, 7, 7, 7]);
    expect(scale.method).toBe("flat");
    expect(scale.breaks).toEqual([]);
    expect(scale.colors).toHaveLength(1);
  });

  it("MAP-1: a right-skewed distribution classes by QUANTILE, NOT equal-interval", () => {
    // A skewed dept distribution (many small, a few large) — the shape that made
    // the dead equal-interval branch read "flat". Quantile breaks must follow the
    // DATA density (bunched low, sparse high), so the interior break gaps are NOT
    // uniform. Regression guard for the dead quantile branch.
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 200, 400];
    const scale = computeClassScale(values);
    expect(scale.method).toBe("quantile");
    expect(scale.breaks).toHaveLength(CLASS_COUNT - 1);
    // Equal-interval over [1,400] would put the breaks ~80 apart (uniform gaps).
    // Quantile hugs the dense low tail, so consecutive gaps differ markedly.
    const gaps = scale.breaks.slice(1).map((b, i) => b - scale.breaks[i]);
    const allGapsEqual = gaps.every((g) => Math.abs(g - gaps[0]) < 1e-9);
    expect(allGapsEqual).toBe(false);
    // Concretely: the low breaks sit in the single digits (data density), far from
    // the ~80/160/240 an equal-interval split of [1,400] would produce.
    expect(scale.breaks[0]).toBeLessThan(10);
  });
});

describe("computeClassScale — locked breaks (scrub scale-lock)", () => {
  it("reuses the frozen live-edge breaks verbatim (frame-stable colors)", () => {
    const frozen = [3, 5, 8, 200];
    const a = computeClassScale([5], { lockedBreaks: frozen });
    const b = computeClassScale([95], { lockedBreaks: frozen });
    // Honest label (adversarial review 2026-07-11 LOW #4): the lock stores
    // breaks only — the origin method (quantile vs interval) is unknown here,
    // so the locked path reports "locked", never a fabricated "quantile".
    expect(a.method).toBe("locked");
    // The frozen breaks are painted verbatim — NOT re-derived as equal-interval.
    expect(a.breaks).toEqual([3, 5, 8, 200]);
    // Frame-stable: same breaks regardless of the frame's own values.
    expect(b.breaks).toEqual(a.breaks);
  });

  it("locked breaks win over a meta target", () => {
    const scale = computeClassScale([50], {
      target: 80,
      lockedBreaks: [3, 5, 8, 200],
    });
    expect(scale.method).toBe("locked");
    expect(scale.breaks).toEqual([3, 5, 8, 200]);
  });

  it("empty locked breaks fall through to the live computation", () => {
    const scale = computeClassScale([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { lockedBreaks: [] });
    expect(scale.method).toBe("quantile");
  });
});

describe("stepColorExpr", () => {
  it("builds a MapLibre step with color0 + (threshold,color) pairs", () => {
    const scale = computeClassScale([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const expr = stepColorExpr(["get", "value"], scale) as unknown[];
    expect(expr[0]).toBe("step");
    expect(expr[1]).toEqual(["get", "value"]);
    expect(expr[2]).toBe(scale.colors[0]);
    // (threshold, color) pairs follow the base color.
    expect(expr).toHaveLength(3 + scale.breaks.length * 2);
  });

  it("returns a flat color string for a break-less (flat) scale", () => {
    const scale = computeClassScale([7, 7, 7, 7, 7, 7]);
    expect(stepColorExpr(["get", "value"], scale)).toBe(scale.colors[0]);
  });
});

describe("colorForValue — scalar JS mirror of the step expression", () => {
  // META scale for target 80 → breaks [40, 60, 80], 4 class colors.
  const scale = computeClassScale([], { target: 80 });

  it("maps a value below the first break to the base (low) color", () => {
    expect(colorForValue(scale, 12)).toBe(scale.colors[0]);
    // Class boundaries are half-open [lo, hi): exactly at a break lands in the
    // upper class, mirroring MapLibre `step` semantics.
    expect(colorForValue(scale, 39.99)).toBe(scale.colors[0]);
  });

  it("maps a value in an interior class to that class color (break is inclusive-low)", () => {
    expect(colorForValue(scale, 40)).toBe(scale.colors[1]);
    expect(colorForValue(scale, 55)).toBe(scale.colors[1]);
    expect(colorForValue(scale, 60)).toBe(scale.colors[2]);
  });

  it("maps a value at/above the meta to the top (open-above) class color", () => {
    expect(colorForValue(scale, 80)).toBe(scale.colors[3]);
    expect(colorForValue(scale, 99)).toBe(scale.colors[scale.colors.length - 1]);
  });

  it("agrees with the painted step expression at every class", () => {
    // Decode the step the map fill renders, then check colorForValue lands in the
    // same class for representative values — legend/inset chip never disagrees.
    const step = stepColorExpr(["get", "value"], scale) as unknown[];
    const painted = (v: number): string => {
      let color = step[2] as string;
      for (let i = 3; i < step.length; i += 2) {
        if (v >= (step[i] as number)) color = step[i + 1] as string;
      }
      return color;
    };
    for (const v of [0, 40, 59, 60, 79, 80, 100]) {
      expect(colorForValue(scale, v)).toBe(painted(v));
    }
  });

  it("NaN hardening: returns null (no-data) instead of silently falling into the lowest class", () => {
    // Every `value >= breaks[i]` comparison is false for NaN, so an unguarded
    // version fell through to idx=0 (colors[0], the LOWEST class) —
    // indistinguishable from a genuinely low real value. Must return null so
    // the caller renders its own no-data state instead of a fake "low" color.
    expect(colorForValue(scale, Number.NaN)).toBeNull();
    expect(colorForValue(scale, Number.POSITIVE_INFINITY)).toBeNull();
    expect(colorForValue(scale, Number.NEGATIVE_INFINITY)).toBeNull();
  });
});

describe("classSwatches", () => {
  it("expands a scale into open-below … open-above class ranges", () => {
    const scale = computeClassScale([34, 50, 65, 72, 81], { target: 80 });
    const rows = classSwatches(scale);
    expect(rows).toHaveLength(scale.colors.length);
    expect(rows[0].lo).toBeNull(); // first class is open below
    expect(rows[0].hi).toBe(40);
    expect(rows[rows.length - 1].hi).toBeNull(); // last class is open above
    expect(rows[rows.length - 1].lo).toBe(80);
  });
});
