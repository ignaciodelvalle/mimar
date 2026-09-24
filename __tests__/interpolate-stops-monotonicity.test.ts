// Interpolate/step INPUT monotonicity — one guard over every stop/scale builder.
//
// MapLibre THROWS on the whole expression when an `interpolate` / `step` input
// series is not STRICTLY ascending ("Input/output pairs … must be arranged with
// input values in strictly ascending order"), taking the layer down. Each builder
// has its own unit tests, but this is the single cross-cutting fence: feed every
// stop/scale builder a matrix of domains — normal, wide, fractional, and the
// DEGENERATE ones that trip the guard (empty, single value, all-equal, NaN,
// sub-0.005 fractional) — and assert the input series it emits is strictly
// ascending. A new builder that forgets the dedupe/ascending guarantee is caught
// here even if its own tests miss the degenerate case.

import { describe, expect, it } from "vitest";

import {
  choroplethColorStops,
  choroplethDomain,
  sanitizeStops,
} from "@/components/charts/choropleth-stops";
import { computeClassScale } from "@/components/panorama/class-scale";
import { buildGraduatedScale, graduatedMaxCount } from "@/components/panorama/graduated-scale";
import {
  provinceMetaClassScale,
  provinceSeqClassScale,
} from "@/components/panorama/province-choropleth-style";
import type { FeatureCollection } from "@/src/modules/panorama/domain/types";
import { RAMP_BLUE, divergentStops } from "@dim/contract/viz";

/** Strictly ascending — every element less than the next (vacuously true for
 *  0- or 1-length series, which MapLibre also accepts). */
function isStrictlyAscending(xs: number[]): boolean {
  for (let i = 1; i < xs.length; i++) if (!(xs[i] > xs[i - 1])) return false;
  return true;
}

const ascMsg = (xs: number[]) => `not strictly ascending: [${xs.join(", ")}]`;

// Value sets covering normal, wide, fractional, and degenerate domains.
const VALUE_SETS: Array<{ name: string; values: number[] }> = [
  { name: "empty", values: [] },
  { name: "single", values: [5] },
  { name: "all-equal", values: [5, 5, 5] },
  { name: "with-NaN", values: [Number.NaN, 5, 7] },
  { name: "all-NaN", values: [Number.NaN, Number.NaN] },
  { name: "small-int", values: [1, 2, 3, 4] },
  { name: "full-int", values: [1, 2, 3, 4, 5, 6, 7, 8] },
  { name: "wide", values: [100, 100_000] },
  { name: "negatives", values: [-3, -1, 0, 2] },
  { name: "fractional", values: [0.008, 0.01, 0.4, 0.4, 1.2] },
  { name: "tiny-fractional", values: [0.001, 0.002, 0.003] },
];

// Graduated-symbol observed maxima (integer + fractional-mode).
const INT_MAXES = [0, 1, 2, 4, 6, 7, 9, 23, 100, 500];
const FRACTIONAL_MAXES = [0.008, 0.01, 0.1, 0.4, 0.83, 12.3];

function provinceFC(cells: Array<{ provinceCode: string; value: number }>): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: cells.map((c) => ({
      type: "Feature",
      geometry: null,
      properties: { provinceCode: c.provinceCode, province: c.provinceCode, value: c.value },
    })),
  } as unknown as FeatureCollection;
}

describe("interpolate/step input monotonicity — all stop/scale builders", () => {
  describe("buildGraduatedScale.radiusStops (circle-radius interpolate)", () => {
    it("emits ≥2 strictly-ascending inputs for every integer max", () => {
      for (const max of INT_MAXES) {
        const stops = buildGraduatedScale(max).radiusStops;
        const inputs = stops.map((s) => s[0]);
        // ≥1: a no-data max (0) legitimately yields a single [0, R_MIN] sentinel
        // stop (vacuously ascending); real data always yields ≥2.
        expect(stops.length).toBeGreaterThanOrEqual(1);
        expect(isStrictlyAscending(inputs), `max=${max}: ${ascMsg(inputs)}`).toBe(true);
      }
    });

    it("emits strictly-ascending inputs in fractional mode (per-cápita rates)", () => {
      for (const max of FRACTIONAL_MAXES) {
        const stops = buildGraduatedScale(max, { fractional: true }).radiusStops;
        const inputs = stops.map((s) => s[0]);
        // ≥1: a no-data max (0) legitimately yields a single [0, R_MIN] sentinel
        // stop (vacuously ascending); real data always yields ≥2.
        expect(stops.length).toBeGreaterThanOrEqual(1);
        expect(isStrictlyAscending(inputs), `max=${max}: ${ascMsg(inputs)}`).toBe(true);
      }
    });

    it("holds when the max is derived from feature collections (incl. no data)", () => {
      const fcs = [
        { features: [{ properties: { count: 3 } }, { properties: { count: 9 } }] },
        { features: [{ properties: { count: null } }] },
        { features: [] },
      ];
      const max = graduatedMaxCount(fcs);
      const inputs = buildGraduatedScale(max).radiusStops.map((s) => s[0]);
      expect(isStrictlyAscending(inputs), ascMsg(inputs)).toBe(true);
    });
  });

  describe("choropleth fill-color stops", () => {
    for (const { name, values } of VALUE_SETS) {
      it(`domain is finite with maxVal > minVal — ${name}`, () => {
        const { minVal, maxVal } = choroplethDomain(values);
        expect(Number.isFinite(minVal)).toBe(true);
        expect(Number.isFinite(maxVal)).toBe(true);
        expect(maxVal).toBeGreaterThan(minVal);
      });

      it(`sequential stops strictly ascending — ${name}`, () => {
        const domain = choroplethDomain(values);
        const inputs = choroplethColorStops({ domain, colorScale: RAMP_BLUE }).map((s) => s[0]);
        expect(inputs.length).toBeGreaterThanOrEqual(2);
        expect(isStrictlyAscending(inputs), ascMsg(inputs)).toBe(true);
      });

      it(`divergent stops strictly ascending — ${name}`, () => {
        const domain = choroplethDomain(values);
        // Target inside and outside the domain both exercised.
        for (const target of [domain.minVal, (domain.minVal + domain.maxVal) / 2, domain.maxVal]) {
          const inputs = choroplethColorStops({
            domain,
            colorScale: RAMP_BLUE,
            scaleMode: "divergent",
            target,
          }).map((s) => s[0]);
          expect(isStrictlyAscending(inputs), `target=${target}: ${ascMsg(inputs)}`).toBe(true);
        }
      });
    }

    it("sanitizeStops dedupes and orders arbitrary input pairs", () => {
      const messy: Array<[number, string]> = [
        [5, "#a"],
        [1, "#b"],
        [5, "#c"], // duplicate input
        [Number.NaN, "#d"], // non-finite
        [3, "#e"],
      ];
      const inputs = sanitizeStops(messy, RAMP_BLUE).map((s) => s[0]);
      expect(inputs.length).toBeGreaterThanOrEqual(2);
      expect(isStrictlyAscending(inputs), ascMsg(inputs)).toBe(true);
    });
  });

  describe("divergentStops (compliance/rate choropleth)", () => {
    const cases: Array<[number, number, number]> = [
      [80, 34, 65],
      [80, 80, 80], // degenerate: all at target
      [80, 90, 95], // all above
      [80, 20, 40], // all below
      [50, 50, 50], // degenerate
      [0, 0, 0], // degenerate zero
      [80, 100, 100], // degenerate above
    ];
    for (const [t, lo, hi] of cases) {
      it(`strictly ascending — target ${t}, [${lo}, ${hi}]`, () => {
        const inputs = divergentStops(t, lo, hi).map((s) => s[0]);
        expect(inputs.length).toBeGreaterThanOrEqual(2);
        expect(isStrictlyAscending(inputs), ascMsg(inputs)).toBe(true);
      });
    }
  });

  describe("computeClassScale.breaks (step thresholds)", () => {
    for (const { name, values } of VALUE_SETS) {
      it(`breaks strictly ascending — ${name} (quantile/interval)`, () => {
        const breaks = computeClassScale(values).breaks;
        expect(isStrictlyAscending(breaks), ascMsg(breaks)).toBe(true);
      });

      it(`breaks strictly ascending — ${name} (meta target)`, () => {
        const breaks = computeClassScale(values, { target: 80 }).breaks;
        expect(isStrictlyAscending(breaks), ascMsg(breaks)).toBe(true);
      });

      it(`breaks strictly ascending — ${name} (locked breaks)`, () => {
        const breaks = computeClassScale(values, {
          lockedBreaks: [10, 10, 20, 5, 30], // deliberately messy — must be deduped/sorted
        }).breaks;
        expect(isStrictlyAscending(breaks), ascMsg(breaks)).toBe(true);
      });
    }
  });

  describe("province choropleth class scales", () => {
    const featureSets: Array<{
      name: string;
      cells: Array<{ provinceCode: string; value: number }>;
    }> = [
      {
        name: "spread",
        cells: [
          { provinceCode: "AR-B", value: 61 },
          { provinceCode: "AR-X", value: 9 },
          { provinceCode: "AR-S", value: 22 },
          { provinceCode: "AR-C", value: 40 },
          { provinceCode: "AR-M", value: 77 },
        ],
      },
      {
        name: "all-equal",
        cells: [
          { provinceCode: "AR-B", value: 30 },
          { provinceCode: "AR-X", value: 30 },
        ],
      },
      {
        name: "fractional",
        cells: [
          { provinceCode: "AR-B", value: 0.4 },
          { provinceCode: "AR-X", value: 0.8 },
          { provinceCode: "AR-S", value: 0.41 },
        ],
      },
    ];

    for (const { name, cells } of featureSets) {
      it(`provinceSeqClassScale breaks strictly ascending — ${name}`, () => {
        const scale = provinceSeqClassScale(provinceFC(cells));
        const breaks = scale?.breaks ?? [];
        expect(isStrictlyAscending(breaks), ascMsg(breaks)).toBe(true);
      });

      it(`provinceMetaClassScale breaks strictly ascending — ${name}`, () => {
        const scale = provinceMetaClassScale(provinceFC(cells), 80);
        const breaks = scale?.breaks ?? [];
        expect(isStrictlyAscending(breaks), ascMsg(breaks)).toBe(true);
      });
    }
  });
});
