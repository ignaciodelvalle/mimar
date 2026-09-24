// Unit tests for the CABA/AMBA inset visibility predicate (task #36 fix 1 +
// PBA addendum). Pure — the intersection + scope logic lives in
// situational-map-utils so it is testable without a maplibre runtime; the
// component wiring (moveend → updateCabaInView → cabaInsetVisible) is a thin
// apply step over these helpers.

import { describe, expect, it } from "vitest";

import { type Bbox, cabaInView, cabaInsetVisible } from "../situational-map-utils";

// A bbox that clearly contains CABA (national overview) and one that clearly
// does not (Patagonia / far south-west).
const NATIONAL_BBOX: Bbox = [
  [-73, -55],
  [-53, -21],
];
const PATAGONIA_BBOX: Bbox = [
  [-73, -55],
  [-64, -40],
];

describe("cabaInView", () => {
  it("is true when the viewport contains CABA (national overview)", () => {
    expect(cabaInView(NATIONAL_BBOX)).toBe(true);
  });

  it("is false when CABA is off-screen (panned/zoomed away)", () => {
    expect(cabaInView(PATAGONIA_BBOX)).toBe(false);
  });

  it("is false for a null camera bbox", () => {
    expect(cabaInView(null)).toBe(false);
  });
});

describe("cabaInsetVisible", () => {
  const base = {
    hasInsetLayer: true,
    scopeProvince: null as string | null,
    scopeIsCaba: false,
    scopeIsPba: false,
    cabaInView: true,
  };

  it("never shows without an inset layer", () => {
    expect(cabaInsetVisible({ ...base, hasInsetLayer: false })).toBe(false);
  });

  it("shows at national scope when CABA is in the viewport (AMBA magnifier)", () => {
    expect(cabaInsetVisible({ ...base, scopeProvince: null, cabaInView: true })).toBe(true);
  });

  it("hides at national scope once CABA is panned off-screen", () => {
    // The pre-fix bug: the inset lingered when the operator panned away at
    // regional zoom. Now it hides.
    expect(cabaInsetVisible({ ...base, scopeProvince: null, cabaInView: false })).toBe(false);
  });

  it("hides the inset when drilled into CABA itself (no double CABA — #49 item 6)", () => {
    // The main map now shows CABA at barrio scale, so the magnifier is redundant.
    expect(
      cabaInsetVisible({
        ...base,
        scopeProvince: "AR-C",
        scopeIsCaba: true,
        cabaInView: true,
      }),
    ).toBe(false);
  });

  it("keeps the inset when drilled into Provincia de Buenos Aires (addendum)", () => {
    expect(
      cabaInsetVisible({
        ...base,
        scopeProvince: "AR-B",
        scopeIsPba: true,
        cabaInView: true,
      }),
    ).toBe(true);
  });

  it("hides the inset when drilled into any OTHER province, even if CABA is in view", () => {
    // Córdoba: scope decision beats the geometry test.
    expect(
      cabaInsetVisible({
        ...base,
        scopeProvince: "AR-X",
        scopeIsCaba: false,
        scopeIsPba: false,
        cabaInView: true,
      }),
    ).toBe(false);
  });
});
