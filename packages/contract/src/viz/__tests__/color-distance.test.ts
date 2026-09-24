import { describe, expect, it } from "vitest";

import {
  MAP_FILL_DISTINCT_FLOOR,
  contrastRatio,
  deltaE00,
  relLuminance,
} from "../color-distance.ts";

describe("deltaE00", () => {
  it("is zero for a color against itself", () => {
    expect(deltaE00("#9ecae1", "#9ecae1")).toBe(0);
    expect(deltaE00("#000000", "#000000")).toBe(0);
  });

  it("is exactly 100 for black vs white (the canonical CIEDE2000 anchor)", () => {
    // Precision 4, not more: the closed form accumulates ~4e-6 of float noise
    // through the cbrt/atan2 chain. That is the arithmetic, not the color.
    expect(deltaE00("#000000", "#ffffff")).toBeCloseTo(100, 4);
  });

  it("is symmetric", () => {
    expect(deltaE00("#9ecae1", "#2171b5")).toBeCloseTo(deltaE00("#2171b5", "#9ecae1"), 12);
  });

  it("accepts hex with or without the leading #, and either case", () => {
    expect(deltaE00("#EEF1F4", "eef1f4")).toBe(0);
  });

  it("rejects malformed hex rather than scoring it", () => {
    expect(() => deltaE00("#fff", "#eef1f4")).toThrow(/bad hex/);
    expect(() => deltaE00("rgb(1,2,3)", "#eef1f4")).toThrow(/bad hex/);
  });

  it("reproduces the measurements the D.5 investigation was decided on", () => {
    // These four numbers are the evidence the PO chose option (c) from. They
    // were produced by an independent implementation before this module existed;
    // reproducing them here is a genuine cross-check of the math, not a
    // restatement of it. If this test moves, the decision record is stale.
    expect(deltaE00("#eff3ff", "#eef1f4")).toBeCloseTo(4.21, 2); // old class-1 vs land
    expect(deltaE00("#e7eaed", "#eef1f4")).toBeCloseTo(1.48, 2); // no-data vs land
    expect(deltaE00("#e7eaed", "#d1d5db")).toBeCloseTo(4.93, 2); // no-data vs suppressed
    expect(deltaE00("#9ecae1", "#eef1f4")).toBeCloseTo(16.38, 2); // new class-1 vs land
  });

  it("applies the blue-region correction that plain Euclidean distance misses", () => {
    // The reason this module computes ΔE00 and not CIE76: in the blue quadrant
    // where this palette lives, CIE76 overstates separation. Two near-white
    // blues that CIE76 would call comfortably apart are not.
    const naive = Math.hypot(0xef - 0xee, 0xf3 - 0xf1, 0xff - 0xf4); // sRGB Euclidean
    expect(naive).toBeGreaterThan(10);
    expect(deltaE00("#eff3ff", "#eef1f4")).toBeLessThan(MAP_FILL_DISTINCT_FLOOR);
  });
});

describe("relLuminance / contrastRatio", () => {
  it("bounds luminance at black and white", () => {
    expect(relLuminance("#000000")).toBe(0);
    expect(relLuminance("#ffffff")).toBeCloseTo(1, 12);
  });

  it("gives WCAG's 21:1 for black on white and 1:1 for a color on itself", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 6);
    expect(contrastRatio("#9ecae1", "#9ecae1")).toBeCloseTo(1, 12);
  });

  it("is order-independent", () => {
    expect(contrastRatio("#08519c", "#ffffff")).toBeCloseTo(
      contrastRatio("#ffffff", "#08519c"),
      12,
    );
  });
});
