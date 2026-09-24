// delta-scale — the zero-anchored diverging classes for delta-encoded layers
// (tendencia). Pins the three contracts that make the encoding honest:
//   1. MONOTONICITY: breaks strictly ascend (the MapLibre `step` fence — same
//      family as interpolate-stops-monotonicity).
//   2. POLARITY (inverted vs the compliance meta scale): MORE events than the
//      prior period paints the WARNING pole, FEWER the good pole — built from
//      the CVD-validated COLOR_DIVERGENT_* tokens, never a new raw palette.
//   3. ZERO ANCHOR: Δ = 0 lands in the neutral "sin cambio" class.

import { describe, expect, it } from "vitest";

import { colorForValue } from "@/components/panorama/class-scale";
import {
  DELTA_CLASS_COLORS,
  deltaClassScale,
  deltaProvinceClassScale,
} from "@/components/panorama/delta-scale";
import type { FeatureCollection } from "@/src/modules/panorama/domain/types";
import {
  COLOR_DIVERGENT_ABOVE,
  COLOR_DIVERGENT_BELOW,
  COLOR_DIVERGENT_NEUTRAL,
} from "@dim/contract/viz";

const fc = (props: Array<Record<string, unknown>>): FeatureCollection => ({
  type: "FeatureCollection",
  features: props.map((p) => ({ type: "Feature", geometry: null, properties: p })),
});

describe("deltaClassScale — structure", () => {
  it("returns strictly ascending breaks (step monotonicity fence)", () => {
    for (const values of [[-12, 4, 30], [0], [1, 2], [-100], [7, -7]]) {
      const scale = deltaClassScale(values);
      expect(scale).not.toBeNull();
      const breaks = scale?.breaks ?? [];
      for (let i = 1; i < breaks.length; i++) {
        expect(breaks[i]).toBeGreaterThan(breaks[i - 1]);
      }
      // colors.length === breaks.length + 1 (ClassScale invariant).
      expect(scale?.colors).toHaveLength(breaks.length + 1);
    }
  });

  it("anchors at zero: breaks are [-h, 0, 1, h] with h ≥ 2", () => {
    const scale = deltaClassScale([-12, 4, 30]);
    // maxAbs 30 → h = 15.
    expect(scale?.breaks).toEqual([-15, 0, 1, 15]);
    // Degenerate all-zero frame still yields a valid ascending layout.
    expect(deltaClassScale([0])?.breaks).toEqual([-2, 0, 1, 2]);
  });

  it("returns null when nothing numeric exists (caller paints neutral)", () => {
    expect(deltaClassScale([])).toBeNull();
    expect(deltaClassScale([Number.NaN])).toBeNull();
  });
});

describe("deltaClassScale — polarity (inverted vs meta) on validated tokens", () => {
  const scale = deltaClassScale([-20, 20]);
  if (scale === null) throw new Error("scale must resolve");

  it("a strong DECREASE paints the teal good pole (COLOR_DIVERGENT_ABOVE)", () => {
    expect(colorForValue(scale, -20)).toBe(COLOR_DIVERGENT_ABOVE);
  });

  it("a strong INCREASE paints the amber warning pole (COLOR_DIVERGENT_BELOW)", () => {
    expect(colorForValue(scale, 20)).toBe(COLOR_DIVERGENT_BELOW);
  });

  it("Δ = 0 lands in the neutral 'sin cambio' class", () => {
    expect(colorForValue(scale, 0)).toBe(COLOR_DIVERGENT_NEUTRAL);
  });

  it("uses ONLY colors derived from the divergent tokens (no new raw palette)", () => {
    // Poles + neutral are the tokens verbatim; the two mid-shades are lerps of
    // a pole toward neutral — pinned here so a future edit can't slip a raw hex.
    expect(DELTA_CLASS_COLORS[0]).toBe(COLOR_DIVERGENT_ABOVE);
    expect(DELTA_CLASS_COLORS[2]).toBe(COLOR_DIVERGENT_NEUTRAL);
    expect(DELTA_CLASS_COLORS[4]).toBe(COLOR_DIVERGENT_BELOW);
    for (const c of DELTA_CLASS_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("deltaProvinceClassScale — feature extraction", () => {
  it("classifies over non-suppressed numeric values only", () => {
    const scale = deltaProvinceClassScale(
      fc([
        { value: 8 },
        { value: -4 },
        // A suppressed cell must never shape the class hinge.
        { value: 999, suppressed: true },
        { value: null },
      ]),
    );
    // maxAbs 8 → h = 4 (the suppressed 999 did not widen it).
    expect(scale?.breaks).toEqual([-4, 0, 1, 4]);
  });

  it("returns null for an all-suppressed frame", () => {
    expect(deltaProvinceClassScale(fc([{ value: 3, suppressed: true }]))).toBeNull();
  });
});
