// resolvePlace — the one resolver (localidades-por-id B3).
//
// Its order is the design's, and each step is pinned on a real catalogue row:
//   1. an explicit id (INDEC id from a client, or the catalogue uuid inside the
//      server), which must lie in the province it came with;
//   2. the exact catalogue name, when it names ONE row of the province;
//   3. an accent/case variant of it, under the same condition;
//   4. a pin, through its reverse-geocoded name, accepted only when the pin
//      corroborates it;
//   5. otherwise UNRESOLVED — with the candidate rows a person could pick
//      (the "¿Es acá?" of the design addendum), never one chosen for them.
//
// And the three answers every writer and the geocoding door pass on:
// RESOLVED (exactly one row), AMBIGUOUS (a name two rows share — the
// homonyms, labelled with their departments) and UNRESOLVED.
//
// Real local catalogue; the reverse geocoder is the only thing faked.

import { inArray } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const geo = vi.hoisted(() => ({ reverse: vi.fn() }));

vi.mock("@/lib/infra/geocoding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/geocoding")>();
  return { ...actual, reverseGeocode: geo.reverse };
});

import { arLocalities, db } from "@/db";
import { resolvePlace } from "@/lib/place/resolve-place";

const VILLA_MARIA_CORDOBA = "14042170";
const VILLA_MARIA_BA = "06021060";
const MECHITA_BRAGADO = "06112080";

type Row = { id: string; lat: number; lng: number; department: string | null };
const rows = new Map<string, Row>();

beforeAll(async () => {
  const found = await db
    .select({
      id: arLocalities.id,
      indecId: arLocalities.indecId,
      lat: arLocalities.latitude,
      lng: arLocalities.longitude,
      department: arLocalities.departmentName,
    })
    .from(arLocalities)
    .where(inArray(arLocalities.indecId, [VILLA_MARIA_CORDOBA, VILLA_MARIA_BA, MECHITA_BRAGADO]));
  for (const r of found) {
    if (r.indecId) {
      rows.set(r.indecId, {
        id: r.id,
        lat: Number(r.lat),
        lng: Number(r.lng),
        department: r.department,
      });
    }
  }
  expect(rows.size, "every INDEC fixture row must exist").toBe(3);
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

function pinAt(indecId: string) {
  return { lat: row(indecId).lat, lng: row(indecId).lng };
}

describe("1. an explicit id", () => {
  it("an INDEC id decides between two same-named rows", async () => {
    const place = await resolvePlace({
      province: "Buenos Aires",
      locality: "Mechita",
      indecId: MECHITA_BRAGADO,
    });
    expect(place).toMatchObject({
      status: "resolved",
      provinceCode: "AR-B",
      province: "Buenos Aires",
      locality: "Mechita",
      localityId: row(MECHITA_BRAGADO).id,
      method: "indec_id",
      candidates: [],
    });
  });

  it("the catalogue uuid (server-internal) resolves as such", async () => {
    const place = await resolvePlace({
      province: "AR-X",
      locality: null,
      localityId: row(VILLA_MARIA_CORDOBA).id,
    });
    expect(place).toMatchObject({
      status: "resolved",
      localityId: row(VILLA_MARIA_CORDOBA).id,
      method: "catalogue_id",
    });
  });

  it("a row the person PICKED from the candidates is recorded as picked", async () => {
    const place = await resolvePlace({
      province: "Buenos Aires",
      locality: "Mechita",
      indecId: MECHITA_BRAGADO,
      picked: true,
    });
    expect(place).toMatchObject({ status: "resolved", method: "user_picked" });
  });

  it("an id from another province is not a place in this one", async () => {
    const place = await resolvePlace({
      province: "Buenos Aires",
      locality: "Villa María",
      indecId: VILLA_MARIA_CORDOBA,
    });
    expect(place).toMatchObject({
      status: "unresolved",
      reason: "id_outside_province",
      province: "Buenos Aires",
      localityId: null,
      method: "unresolved",
    });
  });
});

describe("2-3. a name that names one row", () => {
  it("the exact catalogue spelling", async () => {
    const place = await resolvePlace({ province: "Córdoba", locality: "Villa María" });
    expect(place).toMatchObject({
      status: "resolved",
      localityId: row(VILLA_MARIA_CORDOBA).id,
      method: "exact_name_unique",
    });
  });

  it("an accent/case variant of it", async () => {
    const place = await resolvePlace({ province: "cordoba", locality: "villa maria" });
    expect(place).toMatchObject({
      status: "resolved",
      province: "Córdoba",
      locality: "Villa María",
      localityId: row(VILLA_MARIA_CORDOBA).id,
      method: "folded_name_unique",
    });
  });
});

describe("AMBIGUOUS: a name two rows of the province share", () => {
  it("resolves to neither, and offers both labelled with their departments", async () => {
    const place = await resolvePlace({ province: "Buenos Aires", locality: "Mechita" });
    expect(place).toMatchObject({
      status: "ambiguous",
      reason: "ambiguous",
      province: "Buenos Aires",
      locality: null,
      localityId: null,
      method: "unresolved",
    });
    expect(place.candidates).toHaveLength(2);
    expect(place.candidates.map((c) => c.localityName)).toEqual(["Mechita", "Mechita"]);
    expect(new Set(place.candidates.map((c) => c.departmentName)).size).toBe(2);
    expect(place.candidates.map((c) => c.indecId)).toContain(MECHITA_BRAGADO);
  });
});

describe("4. a pin, through its reverse-geocoded name", () => {
  it("a unique name the pin corroborates", async () => {
    geo.reverse.mockResolvedValue({
      display_name: "Villa María, Córdoba",
      province: "Córdoba",
      locality: "Villa María",
    });
    const place = await resolvePlace({
      province: null,
      locality: null,
      point: pinAt(VILLA_MARIA_CORDOBA),
    });
    expect(place).toMatchObject({
      status: "resolved",
      localityId: row(VILLA_MARIA_CORDOBA).id,
      method: "geocode_unique",
    });
  });

  it("a geocoded name two rows share is AMBIGUOUS, never the nearer one", async () => {
    geo.reverse.mockResolvedValue({
      display_name: "Mechita, Buenos Aires",
      province: "Buenos Aires",
      locality: "Mechita",
    });
    const place = await resolvePlace({
      province: null,
      locality: null,
      point: { lat: row(MECHITA_BRAGADO).lat, lng: row(MECHITA_BRAGADO).lng },
    });
    expect(place.status).toBe("ambiguous");
    expect(place.localityId).toBeNull();
    expect(place.candidates.map((c) => c.indecId)).toContain(MECHITA_BRAGADO);
    expect(place.candidates).toHaveLength(2);
  });
});

describe("5. UNRESOLVED", () => {
  it("a pin the geocoder cannot name offers the nearby rows, nearest first, and picks none", async () => {
    const place = await resolvePlace({
      province: null,
      locality: null,
      point: pinAt(VILLA_MARIA_CORDOBA),
    });
    expect(place).toMatchObject({
      status: "unresolved",
      reason: "pin_only",
      localityId: null,
      method: "unresolved",
    });
    expect(place.candidates.length).toBeGreaterThan(0);
    expect(place.candidates.length).toBeLessThanOrEqual(5);
    // The pin sits on Villa María's own centroid: it is the nearest candidate.
    expect(place.candidates[0]?.indecId).toBe(VILLA_MARIA_CORDOBA);
    expect(place.candidates[0]?.departmentName).toBe(row(VILLA_MARIA_CORDOBA).department);
  });

  it("a name the catalogue does not know", async () => {
    const place = await resolvePlace({ province: "Córdoba", locality: "Pueblo Que No Existe" });
    expect(place).toMatchObject({
      status: "unresolved",
      reason: "not_in_catalogue",
      province: "Córdoba",
      localityId: null,
      candidates: [],
    });
  });

  it("a province and nothing else", async () => {
    const place = await resolvePlace({ province: "Córdoba", locality: null });
    expect(place).toMatchObject({
      status: "unresolved",
      reason: "no_locality",
      provinceCode: "AR-X",
    });
  });

  it("nothing at all", async () => {
    const place = await resolvePlace({ province: null, locality: null });
    expect(place).toMatchObject({ status: "unresolved", reason: "none_entered", province: null });
  });
});
