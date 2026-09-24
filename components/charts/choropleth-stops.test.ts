// Unit tests — choropleth interpolate stop construction (QA round 2 #3).
//
// MapLibre rejects the entire fill-color expression when interpolate stops
// are not strictly ascending, killing the regions-fill layer on the
// panorama/vigilancia/analytics maps. These tests pin the guarantee for
// every degenerate data shape that can produce duplicate or invalid stops:
// all-equal values, a single region, empty data, NaN poisoning, and
// divergent targets outside the observed domain.

import { describe, expect, it } from "vitest";

import {
  choroplethClassed,
  choroplethColorStops,
  choroplethDomain,
  divergentLegendBins,
  sanitizeStops,
} from "@/components/charts/choropleth-stops";
import { CLASS_COUNT, colorForValue, stepColorExpr } from "@/components/panorama/class-scale";
import {
  COLOR_DIVERGENT_ABOVE,
  COLOR_DIVERGENT_NEUTRAL,
  RAMP_BLUE,
  SCALE_BLUE_SEQ,
} from "@dim/contract/viz";

/** Assert the MapLibre invariant: stop inputs strictly ascend. */
function expectStrictlyAscending(stops: Array<[number, string]>): void {
  expect(stops.length).toBeGreaterThanOrEqual(2);
  for (let i = 1; i < stops.length; i++) {
    expect(stops[i][0]).toBeGreaterThan(stops[i - 1][0]);
  }
  for (const [value, color] of stops) {
    expect(Number.isFinite(value)).toBe(true);
    expect(typeof color).toBe("string");
  }
}

describe("choroplethDomain", () => {
  it("widens a uniform domain (every region same value — the QA repro)", () => {
    expect(choroplethDomain([7, 7, 7, 7])).toEqual({ minVal: 7, maxVal: 8 });
  });

  it("widens a single-value domain", () => {
    expect(choroplethDomain([3])).toEqual({ minVal: 3, maxVal: 4 });
  });

  it("falls back to [0, 1] on empty data", () => {
    expect(choroplethDomain([])).toEqual({ minVal: 0, maxVal: 1 });
  });

  it("ignores NaN and Infinity instead of poisoning min/max", () => {
    expect(choroplethDomain([Number.NaN, 2, 5, Number.POSITIVE_INFINITY])).toEqual({
      minVal: 2,
      maxVal: 5,
    });
  });

  it("falls back when every value is non-finite", () => {
    expect(choroplethDomain([Number.NaN, Number.NaN])).toEqual({ minVal: 0, maxVal: 1 });
  });

  it("passes a healthy domain through untouched", () => {
    expect(choroplethDomain([10, 40, 25])).toEqual({ minVal: 10, maxVal: 40 });
  });
});

describe("choroplethColorStops — sequential", () => {
  it("builds ascending stops for a healthy domain", () => {
    const stops = choroplethColorStops({
      domain: { minVal: 0, maxVal: 100 },
      colorScale: RAMP_BLUE,
    });
    expect(stops).toEqual([
      [0, RAMP_BLUE[0]],
      [100, RAMP_BLUE[1]],
    ]);
  });

  it("stays ascending on a widened uniform domain", () => {
    const stops = choroplethColorStops({
      domain: choroplethDomain([12, 12, 12]),
      colorScale: RAMP_BLUE,
    });
    expectStrictlyAscending(stops);
  });
});

describe("choroplethColorStops — divergent", () => {
  it("anchors at a target inside the domain, strictly ascending", () => {
    const stops = choroplethColorStops({
      domain: { minVal: 20, maxVal: 95 },
      colorScale: RAMP_BLUE,
      scaleMode: "divergent",
      target: 80,
    });
    expectStrictlyAscending(stops);
    expect(stops.map(([v]) => v)).toEqual([20, 80, 95]);
    expect(stops[1][1]).toBe(COLOR_DIVERGENT_NEUTRAL);
  });

  it("stays ascending when every region sits AT the target (single bucket)", () => {
    const domain = choroplethDomain([80, 80, 80]);
    const stops = choroplethColorStops({
      domain,
      colorScale: RAMP_BLUE,
      scaleMode: "divergent",
      target: 80,
    });
    expectStrictlyAscending(stops);
  });

  it("stays ascending when the target falls outside the domain (clamped)", () => {
    for (const target of [0, 100]) {
      const stops = choroplethColorStops({
        domain: { minVal: 30, maxVal: 60 },
        colorScale: RAMP_BLUE,
        scaleMode: "divergent",
        target,
      });
      expectStrictlyAscending(stops);
    }
  });

  it("falls back to sequential when target is missing or non-finite", () => {
    for (const target of [undefined, Number.NaN]) {
      const stops = choroplethColorStops({
        domain: { minVal: 1, maxVal: 9 },
        colorScale: RAMP_BLUE,
        scaleMode: "divergent",
        target,
      });
      expect(stops).toEqual([
        [1, RAMP_BLUE[0]],
        [9, RAMP_BLUE[1]],
      ]);
    }
  });
});

describe("sanitizeStops", () => {
  it("sorts out-of-order stops", () => {
    const stops = sanitizeStops(
      [
        [50, "#b"],
        [10, "#a"],
      ],
      RAMP_BLUE,
    );
    expect(stops.map(([v]) => v)).toEqual([10, 50]);
    expectStrictlyAscending(stops);
  });

  it("dedupes equal inputs (first occurrence wins)", () => {
    const stops = sanitizeStops(
      [
        [10, "#a"],
        [10, "#b"],
        [20, "#c"],
      ],
      RAMP_BLUE,
    );
    expect(stops).toEqual([
      [10, "#a"],
      [20, "#c"],
    ]);
  });

  it("drops non-finite inputs and synthesizes a second stop if needed", () => {
    const stops = sanitizeStops(
      [
        [Number.NaN, "#a"],
        [5, "#b"],
      ],
      RAMP_BLUE,
    );
    expect(stops).toEqual([
      [5, "#b"],
      [6, RAMP_BLUE[1]],
    ]);
  });

  it("returns the fallback ramp when every stop is invalid", () => {
    const stops = sanitizeStops([[Number.NaN, "#a"]], RAMP_BLUE);
    expect(stops).toEqual([
      [0, RAMP_BLUE[0]],
      [1, RAMP_BLUE[1]],
    ]);
    expectStrictlyAscending(stops);
  });

  it("guarantees >= 2 ascending stops with COLOR_DIVERGENT_ABOVE-style 3-stop input", () => {
    const stops = sanitizeStops(
      [
        [0, "#below"],
        [80, COLOR_DIVERGENT_NEUTRAL],
        [100, COLOR_DIVERGENT_ABOVE],
      ],
      RAMP_BLUE,
    );
    expectStrictlyAscending(stops);
    expect(stops).toHaveLength(3);
  });
});

describe("choroplethClassed — classed sequential scale (dataviz review #5)", () => {
  const datum = (value: number, suppressed = false) => ({ value, suppressed });

  it("legend bins and painted classes are the SAME scale (single source of truth)", () => {
    // Wide spread → quantile classing. Every bin's color must be the scale's
    // class color, and every bin's boundaries must be the scale's breaks.
    const { scale, bins } = choroplethClassed([2, 5, 9, 14, 30, 55, 80, 120].map((v) => datum(v)));
    expect(scale.method).toBe("quantile");
    expect(bins).toHaveLength(scale.colors.length);
    expect(bins.map((b) => b.color)).toEqual(scale.colors);
    // Interior boundaries tile the breaks exactly: bin i ends where break i sits.
    expect(bins.map((b) => b.hi).slice(0, -1)).toEqual(scale.breaks);
    expect(bins.map((b) => b.lo).slice(1)).toEqual(scale.breaks);
    expect(bins[0].lo).toBeNull();
    expect(bins[bins.length - 1].hi).toBeNull();
  });

  it("a value paints the same class color its legend bin claims (step semantics)", () => {
    const { scale, bins } = choroplethClassed([2, 5, 9, 14, 30, 55, 80, 120].map((v) => datum(v)));
    for (const bin of bins) {
      // Probe a value inside the half-open bin: lo itself (or just under hi).
      const probe = bin.lo ?? (bin.hi as number) - 0.001;
      expect(colorForValue(scale, probe)).toBe(bin.color);
    }
  });

  it("collapses a narrow INTEGER domain to one bucket per value (visual review 2026-07-23 #3)", () => {
    // The /gob/vigilancia "Casos abiertos" repro: counts 4→6.
    const { scale, bins } = choroplethClassed([4, 5, 6, 4, 5].map((v) => datum(v)));
    expect(bins.map((b) => b.label)).toEqual(["4", "5", "6"]);
    expect(scale.breaks).toEqual([5, 6]);
    // Each integer paints exactly its bucket's color.
    expect(colorForValue(scale, 4)).toBe(bins[0].color);
    expect(colorForValue(scale, 5)).toBe(bins[1].color);
    expect(colorForValue(scale, 6)).toBe(bins[2].color);
    // Half-open filter bounds: lo inclusive, hi exclusive, last open above.
    expect(bins[0]).toMatchObject({ lo: 4, hi: 5 });
    expect(bins[2]).toMatchObject({ lo: 6, hi: null });
  });

  it("classes come from the governed SCALE_BLUE_SEQ ramp, palest → darkest", () => {
    const { scale } = choroplethClassed([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => datum(v)));
    expect(scale.colors[0]).toBe(SCALE_BLUE_SEQ[0]);
    expect(scale.colors[scale.colors.length - 1]).toBe(SCALE_BLUE_SEQ[SCALE_BLUE_SEQ.length - 1]);
    expect(scale.colors.length).toBe(CLASS_COUNT);
  });

  it("excludes suppressed (k-anon) and non-finite values from the classing", () => {
    const withOutlier = choroplethClassed([
      datum(1),
      datum(2),
      datum(3),
      datum(1_000_000, true), // suppressed — must not stretch the classes
      { value: Number.NaN },
    ]);
    const clean = choroplethClassed([datum(1), datum(2), datum(3)]);
    expect(withOutlier.scale.breaks).toEqual(clean.scale.breaks);
  });

  it("NO unsuppressed values yields a flat class and no bins — nothing to key", () => {
    const { scale, bins } = choroplethClassed([{ value: Number.NaN }, datum(9, true)]);
    expect(scale.breaks).toEqual([]);
    expect(bins).toEqual([]);
    // The step expression degrades to a plain color string MapLibre accepts.
    expect(typeof stepColorExpr(["get", "v"], scale)).toBe("string");
  });

  it("a UNIFORM domain keys the one value it paints (demo review 2026-08-01 #1)", () => {
    // THE FINDING, live on /gob/vigilancia with alcance CABA: the scope resolves
    // to a single province cell worth 32 open cases, so min === max, the scale
    // goes flat and this used to return ZERO bins. MapChoropleth gates BOTH the
    // scale-label line and the bin row on `bins.length > 0`, so the whole legend
    // collapsed to its "Sin datos" swatch — directly above a "Ver datos" table
    // printing 32. "Every unit holds the same value" is a result, not an absence.
    for (const values of [[32], [32, 32, 32]]) {
      const { scale, bins } = choroplethClassed(values.map((v) => datum(v)));
      expect(scale.breaks).toEqual([]);
      expect(bins).toHaveLength(1);
      expect(bins[0].label).toBe("32");
      // Painted with the flat class colour the map actually used, and clickable
      // over exactly the units it describes.
      expect(bins[0].color).toBe(scale.colors[0]);
      expect(colorForValue(scale, 32)).toBe(bins[0].color);
      expect(bins[0]).toMatchObject({ lo: 32, hi: null });
      expect(typeof stepColorExpr(["get", "v"], scale)).toBe("string");
    }
  });

  it("a uniform NON-integer domain keys its value exactly, not rounded away", () => {
    const { bins } = choroplethClassed([datum(64.4), datum(64.4)]);
    expect(bins.map((b) => b.label)).toEqual(["64,4"]);
  });

  it("no legend bin may describe an impossible range (demo review 2026-08-01 #4)", () => {
    // THE FINDING, live on /gob/vigilancia nacional: 24 provinces of integer
    // case counts produced interpolated quantile breaks [12.6, 13, 16, 19]; the
    // first two both rounded to "13" and the key published
    // `< 13 | 13 – <13 | 13 – <16 | 16 – <19 | ≥ 19`. The second bucket cannot
    // contain anything.
    const casesByProvince = [
      8, 9, 10, 11, 12, 13, 13, 13, 13, 13, 13, 14, 15, 16, 16, 17, 18, 18, 19, 19, 20, 21, 22, 23,
    ];
    const { scale, bins } = choroplethClassed(casesByProvince.map((v) => datum(v)));

    expect(bins.map((b) => b.label)).toEqual(["< 13", "13 – <16", "16 – <19", "≥ 19"]);
    // A count metric's class boundary is a count: no "12,6 casos abiertos".
    expect(scale.breaks).toEqual([13, 16, 19]);
    for (const b of scale.breaks) expect(Number.isInteger(b)).toBe(true);
    // Snapping preserved class membership — every value paints the class its
    // own label claims.
    for (const bin of bins) {
      const probe = bin.lo ?? (bin.hi as number) - 1;
      expect(colorForValue(scale, probe)).toBe(bin.color);
    }
  });

  it("no two bins share a bound label, and none opens onto an empty class", () => {
    // The general invariant behind #4, swept over shapes that make quantile
    // breaks tie: heavy ties at the floor, at the ceiling, and in the middle.
    const shapes: number[][] = [
      [
        8, 9, 10, 11, 12, 13, 13, 13, 13, 13, 13, 14, 15, 16, 16, 17, 18, 18, 19, 19, 20, 21, 22,
        23,
      ],
      [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 6, 7, 8, 40, 41, 42, 43, 44, 45, 46],
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9],
      [0.11, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17, 0.18, 0.19, 0.2],
      [10.01, 10.02, 10.03, 10.04, 10.05, 10.06, 10.07, 10.08],
    ];
    for (const values of shapes) {
      const { scale, bins } = choroplethClassed(values.map((v) => datum(v)));
      const min = Math.min(...values);
      const max = Math.max(...values);
      // No bin renders a zero-width range like "13 – <13".
      for (const bin of bins) expect(bin.label).not.toMatch(/^(.+) – <\1$/);
      // Labels are the legend's identity — MapChoropleth keys the buttons on
      // them, so duplicates would also collide in React.
      expect(new Set(bins.map((b) => b.label)).size).toBe(bins.length);
      // Every break admits at least one real value on each side of it.
      for (const b of scale.breaks) {
        expect(b).toBeGreaterThan(min);
        expect(b).toBeLessThanOrEqual(max);
      }
    }
  });

  it("builds a valid MapLibre step expression from the same scale", () => {
    const { scale } = choroplethClassed([2, 5, 9, 14, 30, 55, 80, 120].map((v) => datum(v)));
    const expr = stepColorExpr(["get", "choropleth_value"], scale) as unknown[];
    expect(expr[0]).toBe("step");
    // Thresholds strictly ascend — MapLibre rejects the expression otherwise.
    const thresholds = expr.filter((_, i) => i >= 3 && i % 2 === 1) as number[];
    for (let i = 1; i < thresholds.length; i++) {
      expect(thresholds[i]).toBeGreaterThan(thresholds[i - 1]);
    }
    expect(thresholds).toEqual(scale.breaks);
  });
});

describe("divergentLegendBins", () => {
  it("splits at the compliance target with half-open bounds (AT target → sobre meta)", () => {
    expect(divergentLegendBins(80)).toEqual([
      { label: "bajo meta (< 80)", lo: null, hi: 80 },
      { label: "sobre meta (≥ 80)", lo: 80, hi: null },
    ]);
  });

  it("returns no bins for a non-finite target", () => {
    expect(divergentLegendBins(Number.NaN)).toEqual([]);
  });
});
