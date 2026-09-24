import { parseLocationFromFormData, parseLocationFromObject } from "@/lib/domain/location-value";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fd(entries: Record<string, string>): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    form.append(k, v);
  }
  return form;
}

// ---------------------------------------------------------------------------
// parseLocationFromFormData
// ---------------------------------------------------------------------------

describe("parseLocationFromFormData", () => {
  it("returns all nulls for an empty FormData", () => {
    const loc = parseLocationFromFormData(new FormData());
    expect(loc).toEqual({
      province: null,
      provinceCode: null,
      locality: null,
      localityIndecId: null,
      lat: null,
      lng: null,
      address: null,
    });
  });

  it("trims strings and returns null for whitespace-only values", () => {
    const loc = parseLocationFromFormData(
      fd({
        provinceName: "  Buenos Aires  ",
        provinceCode: "  AR-B  ",
        localityName: "   ",
        localityNameIndecId: "  06270  ",
        locationAddress: "",
      }),
    );
    expect(loc.province).toBe("Buenos Aires");
    expect(loc.provinceCode).toBe("AR-B");
    expect(loc.locality).toBeNull();
    expect(loc.localityIndecId).toBe("06270");
    expect(loc.address).toBeNull();
  });

  it("parses valid lat/lng to numbers", () => {
    const loc = parseLocationFromFormData(
      fd({
        locationLat: "-34.6083",
        locationLng: "-58.3712",
      }),
    );
    expect(loc.lat).toBeCloseTo(-34.6083);
    expect(loc.lng).toBeCloseTo(-58.3712);
  });

  it("returns null for empty lat/lng strings", () => {
    const loc = parseLocationFromFormData(fd({ locationLat: "", locationLng: "" }));
    expect(loc.lat).toBeNull();
    expect(loc.lng).toBeNull();
  });

  it("returns null for whitespace-only lat/lng", () => {
    const loc = parseLocationFromFormData(fd({ locationLat: "   ", locationLng: "  " }));
    expect(loc.lat).toBeNull();
    expect(loc.lng).toBeNull();
  });

  it("returns null for non-numeric lat/lng", () => {
    const loc = parseLocationFromFormData(fd({ locationLat: "abc", locationLng: "xyz" }));
    expect(loc.lat).toBeNull();
    expect(loc.lng).toBeNull();
  });

  it("reads all standard wire names in one call", () => {
    const loc = parseLocationFromFormData(
      fd({
        provinceCode: "AR-C",
        provinceName: "CABA",
        localityName: "Palermo",
        localityNameIndecId: "02007",
        locationLat: "-34.5833",
        locationLng: "-58.4167",
        locationAddress: "Av. Santa Fe 1234",
      }),
    );
    expect(loc).toEqual({
      province: "CABA",
      provinceCode: "AR-C",
      locality: "Palermo",
      localityIndecId: "02007",
      lat: -34.5833,
      lng: -58.4167,
      address: "Av. Santa Fe 1234",
    });
  });
});

// ---------------------------------------------------------------------------
// parseLocationFromObject
// ---------------------------------------------------------------------------

describe("parseLocationFromObject", () => {
  it("accepts standard wire-name keys", () => {
    const loc = parseLocationFromObject({
      provinceName: "Córdoba",
      provinceCode: "AR-X",
      localityName: "Córdoba Capital",
      localityNameIndecId: "14014",
      locationLat: -31.4135,
      locationLng: -64.181,
      locationAddress: "Bv. San Juan 780",
    });
    expect(loc.province).toBe("Córdoba");
    expect(loc.provinceCode).toBe("AR-X");
    expect(loc.locality).toBe("Córdoba Capital");
    expect(loc.localityIndecId).toBe("14014");
    expect(loc.lat).toBeCloseTo(-31.4135);
    expect(loc.lng).toBeCloseTo(-64.181);
    expect(loc.address).toBe("Bv. San Juan 780");
  });

  it("accepts AssignLocalityForm vocabulary (province/locality keys)", () => {
    const loc = parseLocationFromObject({
      province: "Santa Fe",
      locality: "Rosario",
    });
    expect(loc.province).toBe("Santa Fe");
    expect(loc.locality).toBe("Rosario");
    expect(loc.provinceCode).toBeNull();
  });

  it("prefers provinceName over province when both present", () => {
    const loc = parseLocationFromObject({
      provinceName: "Buenos Aires",
      province: "BA (legacy)",
    });
    expect(loc.province).toBe("Buenos Aires");
  });

  it("prefers localityName over locality when both present", () => {
    const loc = parseLocationFromObject({
      localityName: "La Plata",
      locality: "lp (legacy)",
    });
    expect(loc.locality).toBe("La Plata");
  });

  it("trims strings and returns null for empty values", () => {
    const loc = parseLocationFromObject({
      province: "   ",
      locality: "",
    });
    expect(loc.province).toBeNull();
    expect(loc.locality).toBeNull();
  });

  it("parses numeric lat/lng values directly", () => {
    const loc = parseLocationFromObject({ locationLat: -34.9, locationLng: -57.95 });
    expect(loc.lat).toBeCloseTo(-34.9);
    expect(loc.lng).toBeCloseTo(-57.95);
  });

  it("parses string lat/lng values", () => {
    const loc = parseLocationFromObject({ locationLat: "-34.9", locationLng: "-57.95" });
    expect(loc.lat).toBeCloseTo(-34.9);
    expect(loc.lng).toBeCloseTo(-57.95);
  });

  it("returns null for null/undefined coordinates", () => {
    const loc = parseLocationFromObject({ locationLat: null, locationLng: undefined });
    expect(loc.lat).toBeNull();
    expect(loc.lng).toBeNull();
  });
});
