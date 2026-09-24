// Bivariate palette — LIGHT-canvas CVD + contrast fence (design §8 fork #2).
//
// The design doc gated P3 on re-validating BIVARIATE_PALETTE for color-vision
// deficiency on the light v2C canvas. Measured 2026-07-14 (Machado et al. 2009
// severity-1.0 simulation in linear RGB + CIE76 deltaE), the dark-canvas-era
// palette FAILED: two teal cells below the WCAG 1.4.11 3:1 non-text floor vs
// the land, and under protanopia the RISK corner collapsed into a calm teal
// (dE ≈ 3.8) — the alarm/calm distinction the encoding exists to carry. The
// PO approved the replacement the same day (hill-climbed Lab targets, hue
// families + 3×3 layout preserved, luminance-diagonal structure).
//
// This suite is the PERMANENT fence: any palette edit must keep clearing every
// gate below. Pure — no DOM, no map.

import { describe, expect, it } from "vitest";

import { BIVARIATE_PALETTE } from "@/components/panorama/bivariate-fill";

/** The RETIRED dark-canvas palette — pinned so an accidental revert (e.g. a
 *  stale-branch merge resolving the constant backwards) fails loudly. */
const RETIRED_DARK_CANVAS_PALETTE: readonly string[] = [
  "#4a566e",
  "#3f8183",
  "#33b0a0",
  "#9c6079",
  "#7c8093",
  "#54a9ad",
  "#f0567a",
  "#c063a1",
  "#8f79d1",
] as const;

const LAND = "#eef1f4"; // SituationalMap COLOR_LAND (light v2C)

// --- color math (self-contained, mirrors viz-scales.test idiom) --------------

const hex2rgb = (h: string): number[] =>
  [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const relLum = (h: string): number => {
  const [r, g, b] = hex2rgb(h).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const la = relLum(a);
  const lb = relLum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/** Machado et al. (2009) severity-1.0 dichromacy matrices (linear RGB). */
const SIM: Record<"protanopia" | "deuteranopia", number[][]> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
};
const clamp01 = (c: number): number => Math.min(1, Math.max(0, c));
const simulate = (h: string, M: number[][]): number[] => {
  const rgb = hex2rgb(h).map(lin);
  return M.map((row) => clamp01(row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]));
};
const linToLab = (rgb: number[]): number[] => {
  const [x, y, z] = [
    0.4124 * rgb[0] + 0.3576 * rgb[1] + 0.1805 * rgb[2],
    0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2],
    0.0193 * rgb[0] + 0.1192 * rgb[1] + 0.9505 * rgb[2],
  ];
  const ref = [0.95047, 1, 1.08883];
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [x / ref[0], y / ref[1], z / ref[2]].map(f);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
};
const deltaE = (a: number[], b: number[]): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function minPairwise(palette: readonly string[], mode?: "protanopia" | "deuteranopia"): number {
  const labs = palette.map((h) => linToLab(mode ? simulate(h, SIM[mode]) : hex2rgb(h).map(lin)));
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < labs.length; i++) {
    for (let j = i + 1; j < labs.length; j++) min = Math.min(min, deltaE(labs[i], labs[j]));
  }
  return min;
}

/** Min separation of the RISK corner (index 6) vs the calm teal cells (2, 5, 8). */
function riskVsTeals(palette: readonly string[], mode: "protanopia" | "deuteranopia"): number {
  const labs = palette.map((h) => linToLab(simulate(h, SIM[mode])));
  return Math.min(deltaE(labs[6], labs[2]), deltaE(labs[6], labs[5]), deltaE(labs[6], labs[8]));
}

// --- the shipped palette must clear every light-canvas gate -------------------

describe("BIVARIATE_PALETTE — light-canvas CVD fence (PO-approved 2026-07-14)", () => {
  it("every cell ≥ 3:1 vs the light land (WCAG 1.4.11 non-text)", () => {
    for (const c of BIVARIATE_PALETTE) {
      expect(contrast(c, LAND), c).toBeGreaterThanOrEqual(3);
    }
  });

  it("normal-vision min all-pairs dE ≥ 10 (no confusable cells)", () => {
    expect(minPairwise(BIVARIATE_PALETTE)).toBeGreaterThanOrEqual(10);
  });

  it("protanopia + deuteranopia min all-pairs dE ≥ 9 (structural, not luck)", () => {
    expect(minPairwise(BIVARIATE_PALETTE, "protanopia")).toBeGreaterThanOrEqual(9);
    expect(minPairwise(BIVARIATE_PALETTE, "deuteranopia")).toBeGreaterThanOrEqual(9);
  });

  it("the RISK corner stays ALARM vs every calm teal under both simulations (≥ 15)", () => {
    expect(riskVsTeals(BIVARIATE_PALETTE, "protanopia")).toBeGreaterThanOrEqual(15);
    expect(riskVsTeals(BIVARIATE_PALETTE, "deuteranopia")).toBeGreaterThanOrEqual(15);
  });

  it("keeps the 3×3 layout contract (9 cells) and is NOT the retired dark-canvas palette", () => {
    expect(BIVARIATE_PALETTE).toHaveLength(9);
    // The retired palette fails the protanopia gate (RISK vs calm teal dE ≈ 3.8);
    // a merge that resolves the constant backwards must fail loudly here.
    expect([...BIVARIATE_PALETTE]).not.toEqual([...RETIRED_DARK_CANVAS_PALETTE]);
    expect(minPairwise(RETIRED_DARK_CANVAS_PALETTE, "protanopia")).toBeLessThan(5);
  });
});
