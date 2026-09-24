import { describe, expect, it } from "vitest";

import {
  BUBBLE_R_MAX,
  BUBBLE_R_MIN,
  bubbleRadius,
  buildGraduatedScale,
  graduatedMaxCount,
  graduatedSampleValues,
} from "@/components/panorama/graduated-scale";

describe("bubbleRadius — area-proportional (#7)", () => {
  it("floors non-positive or empty inputs at BUBBLE_R_MIN", () => {
    expect(bubbleRadius(0, 100)).toBe(BUBBLE_R_MIN);
    expect(bubbleRadius(10, 0)).toBe(BUBBLE_R_MIN);
    expect(bubbleRadius(-5, 100)).toBe(BUBBLE_R_MIN);
  });

  it("caps the observed maximum at BUBBLE_R_MAX", () => {
    expect(bubbleRadius(100, 100)).toBeCloseTo(BUBBLE_R_MAX);
    // A value above the max is clamped (never exceeds the cap).
    expect(bubbleRadius(200, 100)).toBeCloseTo(BUBBLE_R_MAX);
  });

  it("scales AREA (not radius) with value: 4x value ⇒ ~2x radius delta", () => {
    const max = 100;
    // Radius delta above the floor must grow as sqrt(value): quadrupling the
    // value doubles the delta, so AREA (∝ r²) quadruples — the honest encoding.
    const d1 = bubbleRadius(25, max) - BUBBLE_R_MIN;
    const d4 = bubbleRadius(100, max) - BUBBLE_R_MIN;
    expect(d4 / d1).toBeCloseTo(2, 5);
  });
});

describe("graduatedSampleValues — data-driven bins (#6)", () => {
  it("reflects a genuinely tiny range as individual integers (1..4)", () => {
    // The real defect: per-locality signals run 1–4 but the legend advertised
    // 1–9 / 10–49 / … / 500+. A tiny max must yield a tiny, honest legend.
    expect(graduatedSampleValues(4)).toEqual([1, 2, 3, 4]);
    expect(graduatedSampleValues(1)).toEqual([1]);
  });

  it("lists every integer up to the tiny-range boundary (max = 6) as a literal", () => {
    // Mutation gate: the `m <= 6` boundary and the `i + 1` offset must both be
    // exact — a mutant shifting either survives range-shape assertions but not
    // this literal.
    expect(graduatedSampleValues(6)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("uses nice-rounded breakpoints for larger ranges and ends at the observed max", () => {
    const s = graduatedSampleValues(340);
    expect(s[0]).toBe(1);
    expect(s[s.length - 1]).toBe(340); // exact observed max, never a rounded 500+
    // Ascending and distinct.
    for (let i = 1; i < s.length; i++) expect(s[i]).toBeGreaterThan(s[i - 1]);
  });

  it("returns nothing for an empty range", () => {
    expect(graduatedSampleValues(0)).toEqual([]);
  });
});

describe("buildGraduatedScale", () => {
  it("produces ≥2 strictly-ascending interpolate stops for a tiny range", () => {
    const scale = buildGraduatedScale(4);
    expect(scale.maxValue).toBe(4);
    expect(scale.bins.map((b) => b.value)).toEqual([1, 2, 3, 4]);
    expect(scale.radiusStops.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < scale.radiusStops.length; i++) {
      expect(scale.radiusStops[i][0]).toBeGreaterThan(scale.radiusStops[i - 1][0]);
    }
    // The map's biggest bubble equals the legend's biggest bubble for max value.
    const topBin = scale.bins[scale.bins.length - 1];
    expect(topBin.r).toBeCloseTo(BUBBLE_R_MAX);
  });

  it("degrades to an empty legend (no bins) when there is no data", () => {
    const scale = buildGraduatedScale(0);
    expect(scale.bins).toEqual([]);
    expect(scale.radiusStops.length).toBeGreaterThanOrEqual(1);
  });
});

describe("graduatedMaxCount", () => {
  it("scans the observed max across collections, ignoring suppressed (null)", () => {
    const fc = {
      features: [
        { properties: { count: 3 } },
        { properties: { count: null } },
        { properties: { count: 7 } },
        { properties: null },
      ],
    };
    expect(graduatedMaxCount([fc])).toBe(7);
  });

  it("returns 0 when no positive count exists", () => {
    expect(graduatedMaxCount([{ features: [{ properties: { count: null } }] }])).toBe(0);
    expect(graduatedMaxCount([])).toBe(0);
  });
});

describe("buildGraduatedScale — fractional mode (panorama-percapita)", () => {
  it("supports sub-1 maxima instead of flooring them to an empty scale", () => {
    // A per-10k rate over a large province is routinely < 1 (e.g. 12 denuncias
    // over 17,5 M hab. ≈ 0,01). The integer scale floors that to 0 → no legend,
    // every bubble at the floor radius — the per-cápita map would read broken.
    const scale = buildGraduatedScale(0.8, { fractional: true });
    expect(scale.maxValue).toBeCloseTo(0.8);
    expect(scale.bins.length).toBeGreaterThanOrEqual(2);
    const values = scale.bins.map((b) => b.value);
    // Ascending, distinct, ending exactly at the observed max.
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
    expect(values[values.length - 1]).toBeCloseTo(0.8);
    // The top legend bubble is the map's top bubble.
    expect(scale.bins[scale.bins.length - 1].r).toBeCloseTo(BUBBLE_R_MAX);
  });

  it("labels fractional bins in es-AR with decimals (no fabricated integers)", () => {
    const scale = buildGraduatedScale(0.8, { fractional: true });
    expect(scale.bins[0].label).toMatch(/\d,\d/);
  });

  it("keeps nice decimal steps and the exact max for mid-range maxima", () => {
    const scale = buildGraduatedScale(3.19, { fractional: true });
    const values = scale.bins.map((b) => b.value);
    expect(values[values.length - 1]).toBeCloseTo(3.19);
    for (const v of values) expect(v).toBeGreaterThan(0);
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
  });

  it("produces strictly-ascending interpolate stops from 0", () => {
    const scale = buildGraduatedScale(0.42, { fractional: true });
    expect(scale.radiusStops[0]).toEqual([0, BUBBLE_R_MIN]);
    for (let i = 1; i < scale.radiusStops.length; i++) {
      expect(scale.radiusStops[i][0]).toBeGreaterThan(scale.radiusStops[i - 1][0]);
    }
  });

  it("degrades to an empty legend when there is no data", () => {
    const scale = buildGraduatedScale(0, { fractional: true });
    expect(scale.bins).toEqual([]);
  });

  it("does NOT change the integer scale for existing callers", () => {
    const plain = buildGraduatedScale(340);
    const explicit = buildGraduatedScale(340, { fractional: false });
    expect(explicit).toEqual(plain);
    expect(plain.maxValue).toBe(340);
  });
});

describe("buildGraduatedScale — fractional near-zero regression (F1)", () => {
  // Repro: a per-10k max ≲ 0.011 made the first nice decimal step round to 0
  // (round2(0.002) → 0), so fractionalSampleValues emitted a 0 sample. The scale
  // then seeded radiusStops [[0, MIN]] and pushed another [0, r] → a DUPLICATE
  // input value, which MapLibre's `interpolate` rejects ("strictly ascending"),
  // so the graduated layer failed to add and the per-cápita map read as broken.
  for (const max of [0.006, 0.008, 0.01]) {
    it(`emits only positive samples and strictly-ascending stops for max=${max}`, () => {
      const scale = buildGraduatedScale(max, { fractional: true });
      // No fabricated 0 sample and no "0" legend label.
      for (const b of scale.bins) {
        expect(b.value).toBeGreaterThan(0);
        expect(b.label).not.toBe("0");
      }
      // Distinct bin values (no two near-identical collapsing bubbles).
      const values = scale.bins.map((b) => b.value);
      expect(new Set(values).size).toBe(values.length);
      // The MapLibre contract: interpolate inputs are strictly ascending from 0.
      expect(scale.radiusStops[0]).toEqual([0, BUBBLE_R_MIN]);
      for (let i = 1; i < scale.radiusStops.length; i++) {
        expect(scale.radiusStops[i][0]).toBeGreaterThan(scale.radiusStops[i - 1][0]);
      }
    });
  }

  it("structural guard: buildGraduatedScale never emits a stop whose input ≤ the previous", () => {
    // Defense (b) — independent of the sampler, for every future caller.
    const inputs = buildGraduatedScale(0.01, { fractional: true }).radiusStops.map((s) => s[0]);
    for (let i = 1; i < inputs.length; i++) expect(inputs[i]).toBeGreaterThan(inputs[i - 1]);
  });

  it("leaves the integer scale byte-identical (the guard is a no-op for ascending samples)", () => {
    expect(buildGraduatedScale(4)).toEqual(buildGraduatedScale(4, { fractional: false }));
    expect(buildGraduatedScale(4).radiusStops.map((s) => s[0])).toEqual([0, 1, 2, 3, 4]);
  });
});
