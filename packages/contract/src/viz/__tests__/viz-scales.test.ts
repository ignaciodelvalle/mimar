import { describe, expect, it } from "vitest";

import {
  MAP_FILL_DISTINCT_FLOOR,
  contrastRatio,
  deltaE00,
  relLuminance,
} from "../color-distance.ts";
import {
  COLOR_DIVERGENT_ABOVE,
  COLOR_DIVERGENT_BELOW,
  COLOR_DIVERGENT_NEUTRAL,
  COLOR_NO_DATA,
  COLOR_SUPPRESSED,
  RAMP_BLUE,
  SCALE_BLUE_SEQ,
  divergentStops,
  lerpHex,
  sampleStops,
} from "../viz-scales.ts";

describe("lerpHex", () => {
  it("returns the endpoints at t=0 and t=1", () => {
    expect(lerpHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(lerpHex("#000000", "#ffffff", 1)).toBe("#ffffff");
  });

  it("interpolates channels at the midpoint", () => {
    expect(lerpHex("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  it("clamps t outside [0,1]", () => {
    expect(lerpHex("#000000", "#ffffff", 2)).toBe("#ffffff");
    expect(lerpHex("#000000", "#ffffff", -1)).toBe("#000000");
  });
});

describe("sampleStops", () => {
  it("clamps to endpoints outside the range", () => {
    const stops: Array<[number, string]> = [
      [0, RAMP_BLUE[0]],
      [100, RAMP_BLUE[1]],
    ];
    expect(sampleStops(stops, -10)).toBe(RAMP_BLUE[0]);
    expect(sampleStops(stops, 200)).toBe(RAMP_BLUE[1]);
  });

  it("evaluates a divergent ramp: below-meta reads warm, above-meta reads cool", () => {
    // CABA-style single-value fill for the inset (#9): a value below the meta must
    // sample the below (amber) side; above the meta, the teal side.
    const stops = divergentStops(80, 0, 100);
    // At the meta it is exactly the neutral midpoint.
    expect(sampleStops(stops, 80)).toBe(COLOR_DIVERGENT_NEUTRAL);
    // Real coverage ~50 sits between below-pole and neutral → not the above pole.
    const below = sampleStops(stops, 50);
    expect(below).not.toBe(COLOR_DIVERGENT_ABOVE);
    // Near the top it trends to the above pole.
    const above = sampleStops(stops, 100);
    expect(above).toBe(COLOR_DIVERGENT_ABOVE);
    expect(COLOR_DIVERGENT_BELOW).toBeTruthy();
  });

  it("returns COLOR_NO_DATA for empty stops", () => {
    expect(sampleStops([], 5)).toBe(COLOR_NO_DATA);
  });
});

describe("COLOR_DIVERGENT_ABOVE (CVD margin fix)", () => {
  // Night-1 dataviz audit: teal-600 (#0d9488) measured ΔE 10.7 vs the neutral
  // slate under deuteranopia simulation — inside the marginal 8-12 band. The
  // fix (validated with dataviz's validate_palette.js) clears ΔE 18.3 while
  // holding contrast against the navy map canvas. This test locks the navy
  // contrast half of that guarantee so a future edit can't silently regress
  // it back below WCAG's 3:1 non-text floor; re-run validate_palette.js for
  // the CVD half whenever this constant changes.
  const NAVY_MAP_CANVAS = "#0b1020";

  it("holds at least 3:1 contrast against the navy map canvas", () => {
    expect(contrastRatio(COLOR_DIVERGENT_ABOVE, NAVY_MAP_CANVAS)).toBeGreaterThanOrEqual(3);
  });

  it("is not the pre-fix teal-600 that measured ΔE 10.7 (marginal CVD band)", () => {
    expect(COLOR_DIVERGENT_ABOVE.toLowerCase()).not.toBe("#0d9488");
  });
});

describe("RAMP_BLUE (white-paper light-surface ramp)", () => {
  it("goes bright→dark (low value = near-white, high value = dark navy)", () => {
    // The light-surface rule: low signal is near-white, high signal is dark.
    // v2C's light console uses SCALE_BLUE_SEQ (same orientation); the retired
    // dark skin's inverted blue→cyan ramp is gone.
    expect(relLuminance(RAMP_BLUE[0])).toBeGreaterThan(relLuminance(RAMP_BLUE[1]));
  });
});

describe("COLOR_NO_DATA (light-canvas no-data neutral)", () => {
  // v2C flipped the operator map to the LIGHT canvas (dark skin retired). The
  // active choropleth ramp is now SCALE_BLUE_SEQ (bright→dark). No-data must not
  // be confusable with a real value.
  it("is PERCEPTUALLY distinct from the palest data class (empty ≠ low signal)", () => {
    // REGRESSION GUARD (D.5, 2026-07-29). This assertion used to read
    // `expect(COLOR_NO_DATA).not.toBe(SCALE_BLUE_SEQ[0])` — string inequality.
    // It passed green for a year while the two fills measured ΔE00 4.62, i.e.
    // a reader could not tell "no data" from "lowest data" anywhere on the map.
    // A test that pins hex strings does not pin the promise the legend makes.
    expect(deltaE00(COLOR_NO_DATA, SCALE_BLUE_SEQ[0])).toBeGreaterThanOrEqual(
      MAP_FILL_DISTINCT_FLOOR,
    );
  });

  it("separates from the suppressed fill by TEXTURE, not by color alone", () => {
    // Measured: ΔE00 4.93 — BELOW MAP_FILL_DISTINCT_FLOOR. This pair is held
    // apart by the 45° hatch (hatch-pattern.ts), not by its fill color, and
    // that is a deliberate design: "protegido" is encoded by texture + legend
    // text, never color alone.
    //
    // THE EXPOSURE THIS PINS: when no canvas is available, buildHatchImageData()
    // returns null and SituationalMap falls back to a SOLID COLOR_SUPPRESSED
    // fill (SituationalMap.tsx ~1827). In that fallback the texture is gone and
    // 4.93 is the ONLY thing separating "protected" from "empty" — weak. The
    // bound below stops that gap from quietly shrinking further; raising it to
    // MAP_FILL_DISTINCT_FLOOR requires re-spacing the greys (plan D.5 option
    // (a)), which the PO deferred on 2026-07-29.
    const measured = deltaE00(COLOR_NO_DATA, COLOR_SUPPRESSED);
    expect(measured).toBeGreaterThan(4.5);
    expect(measured).toBeLessThan(MAP_FILL_DISTINCT_FLOOR);
  });

  it("stays lighter than the mid class so empty never reads as high signal", () => {
    // On a light choropleth the confusion inverts vs the old navy canvas: a DARK
    // no-data fill would read as a HIGH value. Keep no-data lighter than the
    // ramp's mid class; the neutral (achromatic) hue separates it from the pale
    // low class.
    expect(relLuminance(COLOR_NO_DATA)).toBeGreaterThan(relLuminance(SCALE_BLUE_SEQ[2]));
  });
});

describe("SCALE_BLUE_SEQ perceptual floors (plan D.5)", () => {
  // The land canvas the operator choropleth is painted on. Mirrors
  // components/panorama/situational-map-config.ts COLOR_LAND — copied here for
  // the same reason NAVY_MAP_CANVAS above is: importing that module pulls in
  // MapLibre and DetailDrawer, which a lib-level unit test has no business
  // loading. If COLOR_LAND ever moves, this copy must move with it.
  const COLOR_LAND = "#eef1f4";

  it("keeps the LOWEST data class distinguishable from bare land", () => {
    // THE BUG THIS UNIT EXISTS FOR: at #eff3ff this measured 4.21, so a province
    // reporting a real (low) value looked identical to unpainted map. The map
    // under-reported coverage that actually existed.
    expect(deltaE00(SCALE_BLUE_SEQ[0], COLOR_LAND)).toBeGreaterThanOrEqual(MAP_FILL_DISTINCT_FLOOR);
  });

  it("keeps every adjacent class pair distinguishable", () => {
    for (let i = 0; i < SCALE_BLUE_SEQ.length - 1; i++) {
      expect(deltaE00(SCALE_BLUE_SEQ[i], SCALE_BLUE_SEQ[i + 1])).toBeGreaterThanOrEqual(
        MAP_FILL_DISTINCT_FLOOR,
      );
    }
  });

  it("steps evenly — equal steps of data look like equal steps", () => {
    // A sequential scale whose steps jump 10.77 → 21.21 (the pre-D.5 ramp) makes
    // the top of the range look like a cliff and the bottom like a plateau. Cap
    // the spread so no single class transition dominates the reading.
    const steps: number[] = [];
    for (let i = 0; i < SCALE_BLUE_SEQ.length - 1; i++) {
      steps.push(deltaE00(SCALE_BLUE_SEQ[i], SCALE_BLUE_SEQ[i + 1]));
    }
    expect(Math.max(...steps) / Math.min(...steps)).toBeLessThan(2);
  });

  it("descends in luminance so a higher value is always a darker fill", () => {
    for (let i = 0; i < SCALE_BLUE_SEQ.length - 1; i++) {
      expect(relLuminance(SCALE_BLUE_SEQ[i])).toBeGreaterThan(relLuminance(SCALE_BLUE_SEQ[i + 1]));
    }
  });
});
