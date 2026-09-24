import { describe, expect, it } from "vitest";

import { cameraViolationKind } from "./qa-panorama-chaos";

// PURE predicate extracted from the panorama chaos harness (hardening review
// H1): every storm round asserts this against a LIVE camera reading (via the
// window.__PANORAMA_MAP__ seam), never only the URL. This test pins the bounds
// math itself so a future edit to the clamp tolerance can't silently regress
// without a runnable browser.
//
// AR_BBOX padded by ±31° lng / ±2° lat (mirrors SituationalMap.AR_MAX_BOUNDS):
//   minLng -104.6, maxLng -22.6, minLat -57.1, maxLat -19.8

describe("cameraViolationKind", () => {
  it("returns null for a camera well within AR_MAX_BOUNDS", () => {
    expect(cameraViolationKind({ z: 5, lat: -34.6, lng: -58.4 })).toBeNull();
  });

  it("returns null for a camera exactly on the padded boundary", () => {
    expect(cameraViolationKind({ z: 3, lat: -57.1, lng: -104.6 })).toBeNull();
    expect(cameraViolationKind({ z: 3, lat: -19.8, lng: -22.6 })).toBeNull();
  });

  it("flags NaN lat/lng/z before checking bounds", () => {
    expect(cameraViolationKind({ z: Number.NaN, lat: -34.6, lng: -58.4 })).toBe("nan");
    expect(cameraViolationKind({ z: 5, lat: Number.NaN, lng: -58.4 })).toBe("nan");
    expect(cameraViolationKind({ z: 5, lat: -34.6, lng: Number.NaN })).toBe("nan");
  });

  it("flags +/-Infinity as nan (non-finite), not out-of-bounds", () => {
    expect(cameraViolationKind({ z: 5, lat: Number.POSITIVE_INFINITY, lng: -58.4 })).toBe("nan");
    expect(cameraViolationKind({ z: 5, lat: -34.6, lng: Number.NEGATIVE_INFINITY })).toBe("nan");
  });

  it("flags a camera east of the padded bounds (e.g. South Atlantic drift)", () => {
    expect(cameraViolationKind({ z: 4, lat: -35, lng: 0 })).toBe("out-of-bounds");
  });

  it("flags a camera west of the padded bounds", () => {
    expect(cameraViolationKind({ z: 4, lat: -35, lng: -150 })).toBe("out-of-bounds");
  });

  it("flags a camera north of the padded bounds", () => {
    expect(cameraViolationKind({ z: 4, lat: 10, lng: -58 })).toBe("out-of-bounds");
  });

  it("flags a camera south of the padded bounds", () => {
    expect(cameraViolationKind({ z: 4, lat: -80, lng: -58 })).toBe("out-of-bounds");
  });
});
