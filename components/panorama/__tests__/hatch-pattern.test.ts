// Hatch pattern — the k-anon "Protegido" fill mark shared by the SituationalMap,
// the CABA inset, and the legend swatches.
//
// LIGHT-SKIN REGRESSION GUARD (2026-07-15): the hatch stroke was originally
// slate-300 (`rgba(203,213,225,…)`), tuned for the RETIRED dark-navy canvas. On
// the v2C light canvas (near-white land / no-data) that light stroke is invisible,
// so a suppressed cell read as blank "sin datos". These tests pin the stroke DARK
// enough to read on the light canvas and pin the legend swatch to the SAME color,
// so map mark and legend key can never drift — and a future skin change that
// silently reverts to a light hatch fails here instead of on the map.

import { describe, expect, it } from "vitest";

import {
  HATCH_STROKE_RGBA,
  HATCH_SWATCH_CSS,
  layerPaintsZero,
} from "@/components/panorama/hatch-pattern";
import type { FeatureCollection } from "@/src/modules/panorama/domain/types";

/** Relative luminance (0 = black, 1 = white) of an `rgba(r,g,b,a)` string. */
function luminanceOf(rgba: string): number {
  const m = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) throw new Error(`unparseable color: ${rgba}`);
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])].map((c) => c / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe("hatch stroke color (light-skin regression guard)", () => {
  it("is dark enough to read on the near-white light canvas", () => {
    // The retired slate-300 sat at ~0.68 luminance (invisible on #eef1f4 land).
    // A readable hatch must be clearly darker than the land it overlays.
    expect(luminanceOf(HATCH_STROKE_RGBA)).toBeLessThan(0.45);
  });

  it("is not the retired slate-300 that caused the invisible-hatch bug", () => {
    expect(HATCH_STROKE_RGBA).not.toContain("203,213,225");
  });

  it("shares its exact color between the canvas tile and the legend swatch", () => {
    // MapLegends renders HATCH_SWATCH_CSS; it must embed the SAME stroke color so
    // the legend key and the on-map hatch are one system, not two constants.
    expect(HATCH_SWATCH_CSS).toContain(HATCH_STROKE_RGBA);
    expect(HATCH_SWATCH_CSS).toContain("repeating-linear-gradient(45deg");
  });
});

// T4.1 (2026-08-01): a genuinely reported ZERO had no legend representation —
// it lands in the lowest color class (province) or the floor radius (graduated),
// indistinguishable at a glance from "no data" or "protected". `layerPaintsZero`
// is the gate the Referencias tab's new caption reads, for both carriers.
describe("layerPaintsZero — a confirmed zero is a mark, not an absence", () => {
  function fc(props: Array<Record<string, unknown>>): FeatureCollection {
    return {
      type: "FeatureCollection",
      features: props.map((properties) => ({ type: "Feature", geometry: null, properties })),
    };
  }

  it("reads a province layer's `value` key", () => {
    expect(layerPaintsZero(fc([{ provinceCode: "AR-Z", value: 0 }]), "value")).toBe(true);
  });

  it("reads a graduated layer's `count` key", () => {
    expect(layerPaintsZero(fc([{ place: "Lanús", count: 0 }]), "count")).toBe(true);
  });

  it("does not count a suppressed cell as a zero, even if its field were 0", () => {
    // Defensive: production data never carries this combination (a suppressed
    // cell's numeric field is null), but the predicate must not rely on that.
    expect(
      layerPaintsZero(fc([{ provinceCode: "AR-Z", value: 0, suppressed: true }]), "value"),
    ).toBe(false);
  });

  it("answers false when no feature carries a zero", () => {
    expect(layerPaintsZero(fc([{ provinceCode: "AR-B", value: 61 }]), "value")).toBe(false);
    expect(layerPaintsZero(fc([{ place: "Lanús", count: null }]), "count")).toBe(false);
  });

  it("answers false on an empty feature list", () => {
    expect(layerPaintsZero(fc([]), "value")).toBe(false);
  });
});
