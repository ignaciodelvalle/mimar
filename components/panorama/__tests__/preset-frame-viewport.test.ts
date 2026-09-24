// Unit tests for computePresetFrameViewport (panorama-redesign Fase 1).
//
// Pure helper mirroring computeJurisdictionViewport: given a preset's optional
// framing, the captured national bbox (from the map's first fit) and the AR
// fallback bbox, it resolves the fitBounds descriptor the SituationalMap frame
// effect applies — or null when the preset carries no framing (camera untouched).

import { describe, expect, it } from "vitest";

import { computePresetFrameViewport } from "@/components/panorama/situational-map-utils";

const NATIONAL_BBOX: [[number, number], [number, number]] = [
  [-73.58, -55.05],
  [-53.64, -21.78],
];

const AR_FALLBACK_BBOX: [[number, number], [number, number]] = [
  [-73.6, -55.1],
  [-53.6, -21.7],
];

const CUSTOM_BOUNDS: [[number, number], [number, number]] = [
  [-65.77, -35.0],
  [-61.44, -29.3],
];

describe("computePresetFrameViewport", () => {
  // This test used to read "→ fitBounds to the CAPTURED national bbox" and
  // asserted exactly that. It was pinning the defect (plan unit C.3).
  //
  // The captured bbox is the DATA-EXTENT snapshot taken at map load. On a
  // camera-restored session it equals the restored REGIONAL view, so a preset
  // promising the national picture re-framed to the region the operator was
  // already looking at — a visible no-op. v2C had already fixed exactly this on
  // the «← Volver a Nacional» path and wrote the rule down there: "The reset
  // promises the national picture; only the static extent delivers it." The
  // preset path never followed.
  it("national framing → the STATIC extent, never the captured one", () => {
    const out = computePresetFrameViewport({ kind: "national" }, NATIONAL_BBOX, AR_FALLBACK_BBOX);
    expect(out).toEqual({ kind: "fitBounds", bbox: AR_FALLBACK_BBOX });
  });

  it("ignores the captured bbox even when it is a NARROW regional view", () => {
    // The case that made this visible, stated as data: a session restored over
    // one province. "National" must escape it, not honour it.
    const restoredRegional: [[number, number], [number, number]] = [
      [-59.2, -35.1],
      [-57.8, -34.4],
    ];
    const out = computePresetFrameViewport(
      { kind: "national" },
      restoredRegional,
      AR_FALLBACK_BBOX,
    );
    expect(out).toEqual({ kind: "fitBounds", bbox: AR_FALLBACK_BBOX });
  });

  it("national framing with no captured bbox → still the static extent", () => {
    const out = computePresetFrameViewport({ kind: "national" }, null, AR_FALLBACK_BBOX);
    expect(out).toEqual({ kind: "fitBounds", bbox: AR_FALLBACK_BBOX });
  });

  it("bbox framing → fitBounds to the explicit bounds (national bbox ignored)", () => {
    const out = computePresetFrameViewport(
      { kind: "bbox", bounds: CUSTOM_BOUNDS },
      NATIONAL_BBOX,
      AR_FALLBACK_BBOX,
    );
    expect(out).toEqual({ kind: "fitBounds", bbox: CUSTOM_BOUNDS });
  });

  it("absent framing (undefined) → null: the camera must not move", () => {
    expect(computePresetFrameViewport(undefined, NATIONAL_BBOX, AR_FALLBACK_BBOX)).toBeNull();
  });

  it("absent framing (null) → null: the camera must not move", () => {
    expect(computePresetFrameViewport(null, NATIONAL_BBOX, AR_FALLBACK_BBOX)).toBeNull();
  });
});
