// Where a bite happened, when the phone sent a map pin (M17 security review).
//
// PO rule: a bite counts WHERE IT HAPPENED. Pinned here, over the real
// `resolveBiteJurisdiction` with the catalogue and geocoder faked:
//   · a pin in Córdoba next to codes for Buenos Aires is REFUSED — never filed
//     under Buenos Aires, never silently "corrected";
//   · a pin with no codes DERIVES the jurisdiction from the pin — never the
//     pet's home — via reverse geocoding when it corroborates, else the nearest
//     catalogued locality;
//   · no pin keeps the old behaviour (the trio, or the home fallback).

import { beforeEach, describe, expect, it, vi } from "vitest";

const CORDOBA = { lat: -31.4201, lng: -64.1888 };

const control = vi.hoisted(() => ({
  /** Which provinces the pin's neighbourhood holds, by display name. */
  pinProvince: "Córdoba",
  reverse: null as null | { display_name: string; province: string; locality: string },
  nearest: [] as Array<{ id: string; provinceCode: string; localityName: string }>,
  corroborateCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/domain/location-normalize", () => ({
  normalizeLocationForWrite: async (loc: {
    provinceCode: string;
    locality: string | null;
  }) => {
    const names: Record<string, string> = { "AR-B": "Buenos Aires", "AR-X": "Córdoba" };
    const province = names[loc.provinceCode];
    if (!province) throw new Error("INVALID_PROVINCE");
    return {
      province,
      locality: loc.locality,
      localityCanonical: true,
      localityId: `id-${loc.locality}`,
      lat: null,
      lng: null,
      address: null,
    };
  },
}));

vi.mock("@/lib/infra/jurisdiction-from-text", () => ({
  coordinatesCorroborateJurisdiction: async (input: { province: string }) => {
    control.corroborateCalls.push(input);
    return input.province === control.pinProvince;
  },
}));

vi.mock("@/lib/infra/geocoding", () => ({
  reverseGeocode: async () => control.reverse,
}));

vi.mock("@/lib/infra/ar-localidades", () => ({
  nearestLocalities: async () => control.nearest,
}));

import { resolveBiteJurisdiction } from "@/app/api/v1/pets/[publicToken]/events/bite-jurisdiction";

beforeEach(() => {
  control.pinProvince = "Córdoba";
  control.reverse = null;
  control.nearest = [];
  control.corroborateCalls = [];
});

describe("a pin AND a locality trio", () => {
  it("refuses a Córdoba pin filed with Buenos Aires codes — the bite counts where it happened", async () => {
    const result = await resolveBiteJurisdiction({
      provinceCode: "AR-B",
      localityName: "La Plata",
      localityIndecId: "06441030",
      locationLat: CORDOBA.lat,
      locationLng: CORDOBA.lng,
    });
    expect(result).toEqual({ ok: false, code: "bite_location_mismatch" });
    expect(control.corroborateCalls[0]).toMatchObject({ province: "Buenos Aires", ...CORDOBA });
  });

  it("keeps a trio the pin corroborates", async () => {
    const result = await resolveBiteJurisdiction({
      provinceCode: "AR-X",
      localityName: "Córdoba",
      localityIndecId: "14014010",
      locationLat: CORDOBA.lat,
      locationLng: CORDOBA.lng,
    });
    expect(result).toEqual({ ok: true, province: "Córdoba", locality: "Córdoba" });
  });

  it("still refuses a pair the catalogue does not hold", async () => {
    const result = await resolveBiteJurisdiction({
      provinceCode: "AR-Z9",
      localityName: "Nowhere",
      localityIndecId: null,
      locationLat: CORDOBA.lat,
      locationLng: CORDOBA.lng,
    });
    expect(result).toEqual({ ok: false, code: "invalid_request" });
  });
});

describe("a pin and NO trio — derived from the pin, never the pet's home", () => {
  it("uses the reverse-geocoded pair when the pin corroborates it", async () => {
    control.reverse = { display_name: "Córdoba", province: "Córdoba", locality: "Córdoba" };
    const result = await resolveBiteJurisdiction({
      provinceCode: null,
      localityName: null,
      localityIndecId: null,
      locationLat: CORDOBA.lat,
      locationLng: CORDOBA.lng,
    });
    expect(result).toEqual({ ok: true, province: "Córdoba", locality: "Córdoba" });
  });

  it("falls back to the nearest catalogued locality when the geocoder has nothing", async () => {
    control.nearest = [{ id: "n1", provinceCode: "AR-X", localityName: "Villa Allende" }];
    const result = await resolveBiteJurisdiction({
      provinceCode: null,
      localityName: null,
      localityIndecId: null,
      locationLat: CORDOBA.lat,
      locationLng: CORDOBA.lng,
    });
    expect(result).toEqual({ ok: true, province: "Córdoba", locality: "Villa Allende" });
  });
});

describe("no pin — unchanged", () => {
  it("answers nulls so the writer falls back to the animal's home, as before", async () => {
    const result = await resolveBiteJurisdiction({
      provinceCode: null,
      localityName: null,
      localityIndecId: null,
      locationLat: null,
      locationLng: null,
    });
    expect(result).toEqual({ ok: true, province: null, locality: null });
    expect(control.corroborateCalls).toEqual([]);
  });

  it("takes a trio without checking it against a pin that is not there", async () => {
    const result = await resolveBiteJurisdiction({
      provinceCode: "AR-B",
      localityName: "La Plata",
      localityIndecId: "06441030",
      locationLat: null,
      locationLng: null,
    });
    expect(result).toEqual({ ok: true, province: "Buenos Aires", locality: "La Plata" });
    expect(control.corroborateCalls).toEqual([]);
  });
});
