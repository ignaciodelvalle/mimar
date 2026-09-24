// Panorama ViewState P3 — the first-class ChoroplethEncoding value object.
//
// These are the two STRUCTURAL guarantees P3 buys, pinned as tests (design §3):
//   1. scale-matches-paint — the fill expression, the legend swatches, and the
//      inset flat-fill are ALL derived from the ONE `scale` object the encoding
//      carries, so they cannot drift (was: an inline isMeta branch ×4 + a legend
//      recompute).
//   2. inset-encoding === main-encoding — the CABA-inset flat fill samples the
//      SAME scale the main province fill paints, so CABA reads the same color as
//      its (tiny) main-map polygon by construction.
//
// Plus a byte-identity guard: the consolidated fill is IDENTICAL to the standalone
// provinceColorExpr / provinceMetaColorExpr output (this pass is a refactor — the
// only intended pixel change is the deliberate CABA-inset one, which lives in the
// SituationalMap integration, not this pure module).

import { describe, expect, it } from "vitest";

import type { FeatureCollection } from "@/src/modules/panorama/domain/types";
import { SCALE_BLUE_SEQ } from "@dim/contract/viz";

import { classSwatches, colorForValue } from "../class-scale";
import { resolveChoroplethEncoding } from "../encoding";
import { provinceColorExpr, provinceMetaColorExpr } from "../province-choropleth-style";

/** Decode a MapLibre `["step", input, c0, t1, c1, t2, …]` into breaks + colors. */
function decodeStep(step: unknown[]): { breaks: number[]; colors: string[] } {
  const colors: string[] = [step[2] as string];
  const breaks: number[] = [];
  for (let i = 3; i < step.length; i += 2) {
    breaks.push(step[i] as number);
    colors.push(step[i + 1] as string);
  }
  return { breaks, colors };
}

/** The class color the fill's step expression paints for a scalar value — the
 *  JS mirror of MapLibre `step` semantics (value < breaks[0] → colors[0]; …). */
function stepColorAt(breaks: number[], colors: string[], value: number): string {
  let idx = 0;
  for (let i = 0; i < breaks.length; i++) if (value >= breaks[i]) idx = i + 1;
  return colors[idx];
}

/** Build a province FeatureCollection (null geometry — the polygon is the basemap). */
function provinceFC(cells: Array<{ provinceCode: string; value: number }>): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: cells.map((c) => ({
      type: "Feature",
      geometry: null,
      properties: { provinceCode: c.provinceCode, province: c.provinceCode, value: c.value },
    })),
  };
}

const SEQ_FC = provinceFC([
  { provinceCode: "AR-B", value: 61 },
  { provinceCode: "AR-X", value: 9 },
  { provinceCode: "AR-S", value: 22 },
  { provinceCode: "AR-C", value: 40 },
  { provinceCode: "AR-M", value: 77 },
]);

const META_FC = provinceFC([
  { provinceCode: "AR-B", value: 34 },
  { provinceCode: "AR-X", value: 55 },
  { provinceCode: "AR-S", value: 72 },
  { provinceCode: "AR-C", value: 40 },
  { provinceCode: "AR-M", value: 88 },
]);

describe("resolveChoroplethEncoding — kind resolution", () => {
  it("resolves a plain choropleth as choropleth-seq (no compliance target)", () => {
    const enc = resolveChoroplethEncoding({ features: SEQ_FC });
    expect(enc?.kind).toBe("choropleth-seq");
    expect(enc?.meta).toBe(false);
    expect(enc?.unit).toBeUndefined();
  });

  it("resolves a rate layer with a compliance target as choropleth-meta", () => {
    const enc = resolveChoroplethEncoding({
      features: META_FC,
      dataType: "rate",
      complianceTarget: 80,
    });
    expect(enc?.kind).toBe("choropleth-meta");
    expect(enc?.meta).toBe(true);
    expect(enc?.unit).toBe("%");
    // META breaks are target-anchored [0.5T, 0.75T, T].
    expect(enc?.scale.breaks).toEqual([40, 60, 80]);
    expect(enc?.scale.method).toBe("meta");
  });

  it("returns null when the layer carries no numeric values (caller paints neutral)", () => {
    expect(resolveChoroplethEncoding({ features: provinceFC([]) })).toBeNull();
    expect(
      resolveChoroplethEncoding({
        features: provinceFC([]),
        dataType: "rate",
        complianceTarget: 80,
      }),
    ).toBeNull();
  });
});

describe("scale-matches-paint (STRUCTURAL) — fill, legend, and scale read ONE object", () => {
  for (const [name, layer] of [
    ["sequential", { features: SEQ_FC }] as const,
    ["META", { features: META_FC, dataType: "rate", complianceTarget: 80 }] as const,
  ]) {
    it(`${name}: the fill step, the legend swatches, and enc.scale share the exact breaks + colors`, () => {
      const enc = resolveChoroplethEncoding(layer);
      expect(enc).not.toBeNull();
      const painted = decodeStep((enc?.fillColorExpr as unknown as unknown[])[3] as unknown[]);

      // The fill's painted classes ARE enc.scale (no re-derivation).
      expect(painted.breaks).toEqual(enc?.scale.breaks);
      expect(painted.colors).toEqual(enc?.scale.colors);

      // The legend swatches are built from the SAME scale — interior boundaries
      // and colors line up class-for-class with the paint.
      const swatchBreaks = classSwatches(enc?.scale as NonNullable<typeof enc>["scale"])
        .map((s) => s.hi)
        .filter((h): h is number => h !== null);
      const swatchColors = (enc?.legend ?? []).map((s) => s.color);
      expect(swatchBreaks).toEqual(painted.breaks);
      expect(swatchColors).toEqual(painted.colors);

      // Sanity: the ramp poles anchor the class colors.
      expect(painted.colors[0]).toBe(SCALE_BLUE_SEQ[0]);
      expect(painted.colors[painted.colors.length - 1]).toBe(
        SCALE_BLUE_SEQ[SCALE_BLUE_SEQ.length - 1],
      );
    });
  }
});

describe("inset-encoding === main-encoding (STRUCTURAL) — CABA samples the same scale", () => {
  it("sequential: the inset flat fill equals the class color the main fill paints for CABA", () => {
    const enc = resolveChoroplethEncoding({ features: SEQ_FC });
    expect(enc).not.toBeNull();
    const painted = decodeStep((enc?.fillColorExpr as unknown as unknown[])[3] as unknown[]);
    // CABA's value is 40 in SEQ_FC — the inset paints colorForValue(enc.scale, 40)
    // and the main map paints the step class for 40. They MUST match.
    const cabaValue = 40;
    const insetColor = colorForValue(enc?.scale as NonNullable<typeof enc>["scale"], cabaValue);
    expect(insetColor).toBe(stepColorAt(painted.breaks, painted.colors, cabaValue));
  });

  it("META: the inset flat fill equals the class color the main fill paints for CABA", () => {
    const enc = resolveChoroplethEncoding({
      features: META_FC,
      dataType: "rate",
      complianceTarget: 80,
    });
    expect(enc).not.toBeNull();
    const painted = decodeStep((enc?.fillColorExpr as unknown as unknown[])[3] as unknown[]);
    // CABA's value is 40 → lands exactly on the 0.5T break (half-open: belongs to
    // the UPPER class). The inset color must equal the painted class for 40.
    const cabaValue = 40;
    const insetColor = colorForValue(enc?.scale as NonNullable<typeof enc>["scale"], cabaValue);
    expect(insetColor).toBe(stepColorAt(painted.breaks, painted.colors, cabaValue));
  });
});

describe("byte-identity — the consolidated fill matches the standalone expr functions", () => {
  it("sequential fill deep-equals provinceColorExpr (no pixel change)", () => {
    const enc = resolveChoroplethEncoding({ features: SEQ_FC });
    expect(enc?.fillColorExpr).toEqual(provinceColorExpr(SEQ_FC));
  });

  it("sequential fill under locked breaks deep-equals provinceColorExpr(frozen)", () => {
    const frozen = [12, 24, 48, 96];
    const enc = resolveChoroplethEncoding({ features: SEQ_FC }, { lockedSeqBreaks: frozen });
    expect(enc?.scale.breaks).toEqual(frozen);
    expect(enc?.fillColorExpr).toEqual(provinceColorExpr(SEQ_FC, frozen));
  });

  it("META fill deep-equals provinceMetaColorExpr", () => {
    const enc = resolveChoroplethEncoding({
      features: META_FC,
      dataType: "rate",
      complianceTarget: 80,
    });
    expect(enc?.fillColorExpr).toEqual(provinceMetaColorExpr(META_FC, 80));
  });
});
