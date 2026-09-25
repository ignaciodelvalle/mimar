// resolveReportedPlace / resolvePinPlace — where a REPORTED event happened.
//
// localidades-por-id A1 (lost web) and, reused, A2/A3/A4/A6. A report carries up
// to two answers to "where": the (province, locality[, INDEC id]) a picker or a
// client-side reverse geocoder produced, and the pin a person placed. The rules
// these tests hold (P1 — never confuse places):
//
//   - a pair resolves only to ONE catalogue row (the id wins; a name counts
//     only when it names exactly one row in its province);
//   - with a pin, the pair must be corroborated by it; a pair the pin
//     contradicts is flagged, and its locality is never kept;
//   - a pin alone resolves only through a reverse-geocoded name that is unique
//     AND corroborated; otherwise the place is province-level, and the
//     province itself is kept only when the coordinates vouch for it;
//   - nothing ever comes from the pet's home — this module never sees it.
//
// Real local catalogue; the reverse geocoder is the only thing faked.

import { inArray } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const geo = vi.hoisted(() => ({
  reverse: vi.fn(),
}));

vi.mock("@/lib/infra/geocoding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/geocoding")>();
  return { ...actual, reverseGeocode: geo.reverse };
});

import { arLocalities, db } from "@/db";
import type { LocationValue } from "@/lib/domain/location-value";
import { JurisdictionValidationError } from "@/lib/infra/jurisdiction-validation";
import { resolvePinPlace, resolveReportedPlace } from "@/lib/place/reported-place";

const VILLA_MARIA_CORDOBA = "14042170";
const VILLA_MARIA_BUENOS_AIRES = "06021060";
const MECHITA_ALBERTI = "06021030";
const MECHITA_BRAGADO = "06112080";

type Row = { id: string; lat: number; lng: number };
const rows = new Map<string, Row>();

beforeAll(async () => {
  const found = await db
    .select({
      id: arLocalities.id,
      indecId: arLocalities.indecId,
      lat: arLocalities.latitude,
      lng: arLocalities.longitude,
    })
    .from(arLocalities)
    .where(
      inArray(arLocalities.indecId, [
        VILLA_MARIA_CORDOBA,
        VILLA_MARIA_BUENOS_AIRES,
        MECHITA_ALBERTI,
        MECHITA_BRAGADO,
      ]),
    );
  for (const r of found) {
    if (r.indecId) rows.set(r.indecId, { id: r.id, lat: Number(r.lat), lng: Number(r.lng) });
  }
  expect(rows.size, "the four INDEC fixture rows must exist").toBe(4);
});

beforeEach(() => {
  geo.reverse.mockReset();
  geo.reverse.mockResolvedValue(null);
});

function row(indecId: string): Row {
  const r = rows.get(indecId);
  if (!r) throw new Error(`fixture ${indecId} missing`);
  return r;
}

function loc(overrides: Partial<LocationValue>): LocationValue {
  return {
    province: null,
    provinceCode: null,
    locality: null,
    localityIndecId: null,
    lat: null,
    lng: null,
    address: null,
    ...overrides,
  };
}

function at(indecId: string): Pick<LocationValue, "lat" | "lng"> {
  const r = row(indecId);
  return { lat: r.lat, lng: r.lng };
}

describe("resolveReportedPlace — a pair, with or without a pin", () => {
  it("a unique name the pin corroborates resolves to its one row", async () => {
    const place = await resolveReportedPlace(
      loc({ provinceCode: "AR-X", locality: "Villa María", ...at(VILLA_MARIA_CORDOBA) }),
      { pair: "soft" },
    );
    expect(place).toMatchObject({
      province: "Córdoba",
      locality: "Villa María",
      localityId: row(VILLA_MARIA_CORDOBA).id,
      method: "exact_name_unique",
      mismatch: false,
    });
  });

  it("the INDEC id decides the row and is named as the method", async () => {
    const place = await resolveReportedPlace(
      loc({
        provinceCode: "AR-X",
        locality: "Villa María",
        localityIndecId: VILLA_MARIA_CORDOBA,
        ...at(VILLA_MARIA_CORDOBA),
      }),
      { pair: "strict" },
    );
    expect(place).toMatchObject({
      localityId: row(VILLA_MARIA_CORDOBA).id,
      method: "indec_id",
    });
  });

  it("an ambiguous name is a province-level place even under strict — never a homonym, never a refusal", async () => {
    const place = await resolveReportedPlace(loc({ provinceCode: "AR-B", locality: "Mechita" }), {
      pair: "strict",
    });
    expect(place).toMatchObject({
      province: "Buenos Aires",
      locality: null,
      localityId: null,
      method: "unresolved",
      unresolvedReason: "ambiguous",
    });
  });

  it("strict still refuses a locality the catalogue does not have", async () => {
    await expect(
      resolveReportedPlace(loc({ provinceCode: "AR-B", locality: "Narnia" }), { pair: "strict" }),
    ).rejects.toBeInstanceOf(JurisdictionValidationError);
  });

  it("a pair the pin contradicts is flagged and keeps no locality", async () => {
    // Codes say Córdoba's Villa María; the pin sits on Buenos Aires' Villa María.
    const place = await resolveReportedPlace(
      loc({
        provinceCode: "AR-X",
        locality: "Villa María",
        localityIndecId: VILLA_MARIA_CORDOBA,
        ...at(VILLA_MARIA_BUENOS_AIRES),
      }),
      { pair: "strict" },
    );
    expect(place).toMatchObject({
      locality: null,
      localityId: null,
      method: "unresolved",
      mismatch: true,
      unresolvedReason: "pin_disagrees",
    });
    // Never the other province's homonym either.
    expect(place.province).not.toBe("Buenos Aires");
  });

  it("keeps what was entered, whatever it resolved to", async () => {
    const place = await resolveReportedPlace(loc({ provinceCode: "AR-B", locality: "mechita" }), {
      pair: "soft",
    });
    expect(place.entered).toEqual({ province: "AR-B", locality: "mechita", indecId: null });
  });
});

describe("resolvePinPlace — a pin and nothing else", () => {
  it("a reverse-geocoded unique name the pin corroborates resolves (geocode_unique)", async () => {
    geo.reverse.mockResolvedValue({
      display_name: "Villa María, Córdoba",
      province: "Córdoba",
      locality: "Villa María",
    });
    const place = await resolvePinPlace(at(VILLA_MARIA_CORDOBA) as { lat: number; lng: number });
    expect(place).toMatchObject({
      province: "Córdoba",
      locality: "Villa María",
      localityId: row(VILLA_MARIA_CORDOBA).id,
      method: "geocode_unique",
    });
  });

  it("a reverse-geocoded homonym stays province-level, never the first department", async () => {
    geo.reverse.mockResolvedValue({
      display_name: "Mechita, Buenos Aires",
      province: "Buenos Aires",
      locality: "Mechita",
    });
    const place = await resolvePinPlace(at(MECHITA_BRAGADO) as { lat: number; lng: number });
    expect(place).toMatchObject({
      province: "Buenos Aires",
      locality: null,
      localityId: null,
      method: "unresolved",
    });
  });

  it("with the geocoder down, the nearest centroid is NOT a locality — the place is province-level", async () => {
    geo.reverse.mockResolvedValue(null);
    const place = await resolvePinPlace(at(VILLA_MARIA_CORDOBA) as { lat: number; lng: number });
    expect(place).toMatchObject({
      province: "Córdoba",
      locality: null,
      localityId: null,
      method: "unresolved",
      unresolvedReason: "pin_only",
    });
  });

  it("nothing entered at all is nothing resolved", async () => {
    const place = await resolveReportedPlace(loc({}), { pair: "soft" });
    expect(place).toMatchObject({
      province: null,
      locality: null,
      localityId: null,
      method: "unresolved",
      unresolvedReason: "none_entered",
    });
    expect(geo.reverse).not.toHaveBeenCalled();
  });
});

describe("the pin alone, through resolveReportedPlace", () => {
  it("derives from the pin when no pair was entered", async () => {
    geo.reverse.mockResolvedValue({
      display_name: "Villa María, Córdoba",
      province: "Córdoba",
      locality: "Villa María",
    });
    const place = await resolveReportedPlace(loc(at(VILLA_MARIA_CORDOBA)), { pair: "soft" });
    expect(place).toMatchObject({ province: "Córdoba", locality: "Villa María" });
  });
});

// A pin between Neuquén (AR-Q) and Cipolletti (AR-R): its nearby catalogued
// localities span two provinces, so without a geocoder nothing honest names a
// province. Midpoint of the two centroids in the local catalogue.
const NEUQUEN_CIPOLLETTI_BORDER = { lat: -38.9366557, lng: -68.0399008 };

// Stage A review, BLOCKER 2: a pin that names no province is UNRESOLVED — never
// a reason to reach for anybody's home — and it keeps the point-derived
// candidates so the unresolved queue can offer them.
describe("a border pin with no geocoder answer", () => {
  it("names no province, stays unresolved and keeps the nearby candidates", async () => {
    const place = await resolvePinPlace(NEUQUEN_CIPOLLETTI_BORDER);
    expect(place).toMatchObject({
      province: null,
      locality: null,
      localityId: null,
      method: "unresolved",
      unresolvedReason: "pin_only",
    });
    const provinces = await db
      .select({ code: arLocalities.provinceCode })
      .from(arLocalities)
      .where(inArray(arLocalities.id, place.candidateIds));
    expect(new Set(provinces.map((r) => r.code))).toEqual(new Set(["AR-Q", "AR-R"]));
  });

  it("a resolved place carries no candidates", async () => {
    geo.reverse.mockResolvedValue({
      display_name: "Villa María, Córdoba",
      province: "Córdoba",
      locality: "Villa María",
    });
    const place = await resolvePinPlace(at(VILLA_MARIA_CORDOBA) as { lat: number; lng: number });
    expect(place.candidateIds).toEqual([]);
  });
});

// localidades-por-id B6 (design addendum #1). A pin that named no row with
// certainty offered the person the candidate rows ("¿Es acá?"); the one they
// PICKED travels back as its INDEC id marked as picked, and is what the report
// keeps — by id, recorded as `user_picked`, still corroborated by the pin.
describe("a locality the person picked from the candidates", () => {
  it("is kept by id and recorded as picked", async () => {
    const place = await resolveReportedPlace(
      loc({
        provinceCode: "AR-B",
        locality: "Mechita",
        localityIndecId: MECHITA_BRAGADO,
        localityPicked: true,
        lat: row(MECHITA_BRAGADO).lat,
        lng: row(MECHITA_BRAGADO).lng,
      }),
      { pair: "soft" },
    );
    expect(place).toMatchObject({
      localityId: row(MECHITA_BRAGADO).id,
      method: "user_picked",
      mismatch: false,
    });
  });

  it("the same id NOT marked as picked is an INDEC id a client sent", async () => {
    const place = await resolveReportedPlace(
      loc({ provinceCode: "AR-B", locality: "Mechita", localityIndecId: MECHITA_BRAGADO }),
      { pair: "soft" },
    );
    expect(place).toMatchObject({ localityId: row(MECHITA_BRAGADO).id, method: "indec_id" });
  });
});
