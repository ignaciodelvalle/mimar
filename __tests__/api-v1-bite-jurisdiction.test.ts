// Where a bite happened, when the phone sent a map pin (M17 security review).
//
// PO rule: a bite counts WHERE IT HAPPENED. Pinned here, over the real
// `resolveBiteJurisdiction` with the catalogue and geocoder faked:
//   · a pin in Córdoba next to codes for Buenos Aires is REFUSED — never filed
//     under Buenos Aires, never silently "corrected";
//   · a pin with no codes DERIVES the jurisdiction from the pin — never the
//     pet's home — via reverse geocoding when it corroborates; otherwise the
//     place is PROVINCE-level: the nearest catalogued centroid is never taken
//     for the locality (localidades-por-id A4 — the catalogue has centroids,
//     not boundaries, and a border pin sits nearer the neighbour's centre);
//   · a name two localities of one province share, with no id, is a
//     province-level bite — never either homonym (A4);
//   · no pin keeps the old behaviour (the trio, or the home fallback).

import { beforeEach, describe, expect, it, vi } from "vitest";

const CORDOBA = { lat: -31.4201, lng: -64.1888 };

const control = vi.hoisted(() => ({
  /** Which provinces the pin's neighbourhood holds, by display name. */
  pinProvince: "Córdoba",
  reverse: null as null | { display_name: string; province: string; locality: string },
  nearest: [] as Array<{ id: string; provinceCode: string; localityName: string }>,
  corroborateCalls: [] as Array<Record<string, unknown>>,
  gateInputs: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/domain/location-normalize", () => {
  class JurisdictionValidationError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    JurisdictionValidationError,
    normalizeLocationForWrite: async (loc: {
      provinceCode: string;
      locality: string | null;
    }) => {
      control.gateInputs.push(loc);
      const names: Record<string, string> = { "AR-B": "Buenos Aires", "AR-X": "Córdoba" };
      const province = names[loc.provinceCode];
      if (!province) throw new JurisdictionValidationError("INVALID_PROVINCE", "no such province");
      if (loc.locality === "Mechita") {
        throw new JurisdictionValidationError("AMBIGUOUS_LOCALITY", "two Mechitas");
      }
      return {
        province,
        locality: loc.locality,
        localityCanonical: true,
        localityId: `id-${loc.locality}`,
        placeMethod: "indec_id",
        lat: null,
        lng: null,
        address: null,
      };
    },
  };
});

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
    expect(result).toEqual({
      ok: true,
      province: "Córdoba",
      locality: "Córdoba",
      localityId: "id-Córdoba",
      place: {
        entered: { province: "AR-X", locality: "Córdoba", indec_id: "14014010" },
        resolved: { locality_id: "id-Córdoba", province_code: "AR-X", method: "indec_id" },
      },
    });
  });

  it("files an ambiguous name with no id at PROVINCE level, never either homonym", async () => {
    control.pinProvince = "Buenos Aires";
    const result = await resolveBiteJurisdiction({
      provinceCode: "AR-B",
      localityName: "Mechita",
      localityIndecId: null,
      locationLat: CORDOBA.lat,
      locationLng: CORDOBA.lng,
    });
    expect(result).toEqual({
      ok: true,
      province: "Buenos Aires",
      locality: null,
      localityId: null,
      place: { entered: { province: "AR-B", locality: "Mechita", indec_id: null }, resolved: null },
    });
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
    expect(result).toEqual({
      ok: true,
      province: "Córdoba",
      locality: "Córdoba",
      localityId: "id-Córdoba",
      place: {
        entered: { province: null, locality: null, indec_id: null },
        resolved: { locality_id: "id-Córdoba", province_code: "AR-X", method: "geocode_unique" },
      },
    });
  });

  it("with no geocoder answer the bite is PROVINCE-level — the nearest centroid is not a locality", async () => {
    control.nearest = [{ id: "n1", provinceCode: "AR-X", localityName: "Villa Allende" }];
    const result = await resolveBiteJurisdiction({
      provinceCode: null,
      localityName: null,
      localityIndecId: null,
      locationLat: CORDOBA.lat,
      locationLng: CORDOBA.lng,
    });
    expect(result).toEqual({
      ok: true,
      province: "Córdoba",
      locality: null,
      localityId: null,
      // The point's nearby rows are kept as candidates, never chosen (review BLOCKER 2).
      place: {
        entered: { province: null, locality: null, indec_id: null },
        resolved: null,
        candidates: ["n1"],
      },
    });
  });

  it("near a border, with no geocoder answer, not even the province is guessed", async () => {
    control.nearest = [
      { id: "n1", provinceCode: "AR-X", localityName: "Villa María" },
      { id: "n2", provinceCode: "AR-B", localityName: "Villa María" },
    ];
    const result = await resolveBiteJurisdiction({
      provinceCode: null,
      localityName: null,
      localityIndecId: null,
      locationLat: CORDOBA.lat,
      locationLng: CORDOBA.lng,
    });
    expect(result).toEqual({
      ok: true,
      province: null,
      locality: null,
      localityId: null,
      place: {
        entered: { province: null, locality: null, indec_id: null },
        resolved: null,
        candidates: ["n1", "n2"],
      },
    });
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
    expect(result).toEqual({
      ok: true,
      province: null,
      locality: null,
      localityId: null,
      place: null,
    });
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
    expect(result).toEqual({
      ok: true,
      province: "Buenos Aires",
      locality: "La Plata",
      localityId: "id-La Plata",
      place: {
        entered: { province: "AR-B", locality: "La Plata", indec_id: "06441030" },
        resolved: { locality_id: "id-La Plata", province_code: "AR-B", method: "indec_id" },
      },
    });
    expect(control.corroborateCalls).toEqual([]);
  });
});

// Security review of stage B: the app's "¿Es acá?" pick reaches the write
// gate marked, which records it as `user_picked`.
describe("a locality the person picked", () => {
  it("reaches the write gate marked as picked", async () => {
    control.gateInputs.length = 0;
    await resolveBiteJurisdiction({
      provinceCode: "AR-X",
      localityName: "Villa María",
      localityIndecId: "14042170",
      localityPicked: true,
      locationLat: null,
      locationLng: null,
    });
    expect(control.gateInputs[0]).toMatchObject({ localityPicked: true });
  });
});
