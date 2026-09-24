// Unit tests for sparklinePath — pure SVG path math (no React, no DOM).
//
// F4 Panorama v2: the sparkline plots the unit-history trend series.
// These tests cover the documented contract of sparklinePath:
//   - empty series → ""
//   - single point → one coordinate at horizontal center
//   - flat series (all equal) → horizontal mid-line
//   - normal series → min=bottom(y=height), max=top(y=0), correct count

import { describe, expect, it } from "vitest";

import { sparklinePath, sparklineSegments } from "../Sparkline";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse "x,y x,y …" into [x, y][] pairs. */
function parsePoints(pts: string): [number, number][] {
  if (!pts) return [];
  return pts.split(" ").map((p) => {
    const [x, y] = p.split(",").map(Number);
    return [x, y];
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sparklinePath", () => {
  it("returns empty string for an empty series", () => {
    expect(sparklinePath([], 120, 32)).toBe("");
  });

  it("returns a single point at horizontal center for a single-value series", () => {
    const pts = parsePoints(sparklinePath([42], 120, 32));
    expect(pts).toHaveLength(1);
    // x should be at the midpoint of the width
    expect(pts[0][0]).toBe(60);
    // y should be at the vertical center (flat / single → height/2)
    expect(pts[0][1]).toBe(16);
  });

  it("renders a flat series as a horizontal mid-line (y = height/2 for all points)", () => {
    const pts = parsePoints(sparklinePath([7, 7, 7, 7], 120, 32));
    expect(pts).toHaveLength(4);
    for (const [, y] of pts) {
      expect(y).toBe(16); // height / 2
    }
  });

  it("maps min value to y=height and max value to y=0", () => {
    // [0, 10] over width=60, height=30
    const pts = parsePoints(sparklinePath([0, 10], 60, 30));
    expect(pts).toHaveLength(2);
    const [, yMin] = pts[0]; // value=0 (min) → bottom
    const [, yMax] = pts[1]; // value=10 (max) → top
    expect(yMin).toBe(30); // height
    expect(yMax).toBe(0);
  });

  it("produces the correct number of coordinate pairs for a normal series", () => {
    const values = [3, 1, 4, 1, 5, 9, 2, 6];
    const pts = parsePoints(sparklinePath(values, 120, 32));
    expect(pts).toHaveLength(values.length);
  });

  it("spaces x coordinates evenly across the full width", () => {
    // 5 points over width=100 → x = 0, 25, 50, 75, 100
    const pts = parsePoints(sparklinePath([1, 2, 3, 4, 5], 100, 40));
    const xs = pts.map(([x]) => x);
    expect(xs[0]).toBe(0);
    expect(xs[xs.length - 1]).toBe(100);
    // Each step should be 25
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i] - xs[i - 1]).toBeCloseTo(25, 1);
    }
  });

  it("handles a two-point series with negative values correctly", () => {
    // min=-5, max=5, range=10; height=10
    // value=-5 → y=10 (bottom); value=5 → y=0 (top)
    const pts = parsePoints(sparklinePath([-5, 5], 40, 10));
    expect(pts[0][1]).toBe(10);
    expect(pts[1][1]).toBe(0);
  });

  it("mid-point of a normal series lands between 0 and height", () => {
    // [0, 5, 10] → y for value=5 should be exactly height/2
    const pts = parsePoints(sparklinePath([0, 5, 10], 100, 20));
    expect(pts[1][1]).toBe(10); // height/2
  });
});

// A masked bucket (k-anonimato) carries y: 0 and a `suppressed` flag. Drawn as
// the number 0 it becomes the series MINIMUM and pins to the bottom of the box —
// a trough a reader cannot tell from a week where nothing happened. The caller
// hands the bucket over as `null` and the line breaks instead.
describe("sparklineSegments — a masked bucket is a HOLE, never a floor value", () => {
  it("splits the line around a hole instead of dipping through it", () => {
    const segments = sparklineSegments([8, 9, null, 9, 8], 100, 20);
    expect(segments).toHaveLength(2);
    expect(parsePoints(segments[0])).toHaveLength(2);
    expect(parsePoints(segments[1])).toHaveLength(2);
  });

  it("keeps the hole's x slot, so the time base is not compressed", () => {
    // 5 buckets over width=100 → x = 0, 25, 50, 75, 100. The masked third
    // bucket owns x=50 and nobody else may take it: closing the gap would slide
    // every later bucket left and quietly redraw WHEN things happened.
    const segments = sparklineSegments([8, 9, null, 9, 8], 100, 20);
    expect(parsePoints(segments[0]).map(([x]) => x)).toEqual([0, 25]);
    expect(parsePoints(segments[1]).map(([x]) => x)).toEqual([75, 100]);
  });

  it("scales over the PLOTTED values only — a hole is not a zero in the range", () => {
    // Were the hole read as 0, min would be 0 and the two 8s would sit high in
    // the box. With only 8 and 9 plotted, 8 is the floor and 9 the ceiling.
    const [first] = sparklineSegments([8, 9, null], 100, 20);
    const ys = parsePoints(first).map(([, y]) => y);
    expect(ys[0]).toBe(20); // 8 → bottom
    expect(ys[1]).toBe(0); // 9 → top
  });

  it("returns no segments when every bucket is masked", () => {
    // The caller renders its dashed placeholder — an all-masked series has no
    // shape to show, and inventing one would be the original defect at scale.
    expect(sparklineSegments([null, null, null], 100, 20)).toEqual([]);
  });

  it("is byte-identical to sparklinePath for a hole-free series", () => {
    // The guard that lets sparklinePath keep its narrow signature and its own
    // suite: one segment in, one string out, unchanged.
    const values = [3, 1, 4, 1, 5];
    expect(sparklineSegments(values, 120, 32)).toEqual([sparklinePath(values, 120, 32)]);
  });
});
