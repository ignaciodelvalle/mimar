// Unit tests for chipImplantSiteFromLocation — moved from
// src/modules/pets/domain/__tests__/pet-rules.test.ts when the helper
// relocated here (2026-07-18 dependency-direction cleanup).

import { describe, expect, it } from "vitest";

import { chipImplantSiteFromLocation } from "./microchip-implant-site";

describe("chipImplantSiteFromLocation", () => {
  it("passes through the canonical value interescapular unchanged", () => {
    expect(chipImplantSiteFromLocation("interescapular")).toBe("interescapular");
  });

  it("passes through the canonical value lateral_cuello_izq unchanged", () => {
    expect(chipImplantSiteFromLocation("lateral_cuello_izq")).toBe("lateral_cuello_izq");
  });

  it("passes through the canonical value lateral_cuello_der unchanged", () => {
    expect(chipImplantSiteFromLocation("lateral_cuello_der")).toBe("lateral_cuello_der");
  });

  it("maps interscapular_left to interescapular", () => {
    expect(chipImplantSiteFromLocation("interscapular_left")).toBe("interescapular");
  });

  it("maps interscapular_right to interescapular", () => {
    expect(chipImplantSiteFromLocation("interscapular_right")).toBe("interescapular");
  });

  it("maps interscapular to interescapular", () => {
    expect(chipImplantSiteFromLocation("interscapular")).toBe("interescapular");
  });

  it("maps neck_left to lateral_cuello_izq", () => {
    expect(chipImplantSiteFromLocation("neck_left")).toBe("lateral_cuello_izq");
  });

  it("maps neck_right to lateral_cuello_der", () => {
    expect(chipImplantSiteFromLocation("neck_right")).toBe("lateral_cuello_der");
  });

  it("maps any other non-null value to otro", () => {
    expect(chipImplantSiteFromLocation("shoulder")).toBe("otro");
  });

  it("returns null when location is null", () => {
    expect(chipImplantSiteFromLocation(null)).toBeNull();
  });
});
