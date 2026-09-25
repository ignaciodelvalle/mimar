// resolveDenunciaJurisdiction — where a denuncia is routed, and whether the
// triage queue shows it as verified.
//
// localidades-por-id A6. Both denuncia doors (the public/org web intakes and
// POST /api/v1/welfare-reports) used to canonicalise the pair with the soft
// gate and hand it to the D.11 gate (`resolveRoutableJurisdiction`). Two
// defects rode along: a homonym NAME settled on the alphabetically first
// department (in the gate and in the form-text fallback), and a pin could
// never outrank ambiguous text when the geocoder had nothing. The rules held
// here (spec: "Denuncia — public web", "Denuncia — org/API"):
//
//   - the pair resolves to ONE row or to none; a pin that contradicts it is
//     re-read (the web's pair is the geocode of that same pin);
//   - with no pair, the PIN decides before the form text does;
//   - the form text is the last resort (D.11), and it never picks a homonym;
//   - a place that was named and could not be resolved is MARKED unverified.
//
// Real local catalogue; the reverse geocoder is the only thing faked.

import { readFileSync } from "node:fs";

import { inArray } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const geo = vi.hoisted(() => ({ reverse: vi.fn() }));

vi.mock("@/lib/infra/geocoding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/geocoding")>();
  return { ...actual, reverseGeocode: geo.reverse };
});

import { arLocalities, db } from "@/db";
import type { LocationValue } from "@/lib/domain/location-value";
import { resolveDenunciaJurisdiction } from "@/lib/place/denuncia-place";

const VILLA_MARIA_CORDOBA = "14042170";
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
    .where(inArray(arLocalities.indecId, [VILLA_MARIA_CORDOBA, MECHITA_BRAGADO]));
  for (const r of found) {
    if (r.indecId) rows.set(r.indecId, { id: r.id, lat: Number(r.lat), lng: Number(r.lng) });
  }
  expect(rows.size, "both INDEC fixture rows must exist").toBe(2);
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

function pinAt(indecId: string) {
  return { lat: row(indecId).lat, lng: row(indecId).lng };
}

describe("resolveDenunciaJurisdiction", () => {
  it("a pair its pin corroborates is routed there, verified", async () => {
    const out = await resolveDenunciaJurisdiction(
      loc({ provinceCode: "AR-X", locality: "Villa María", ...pinAt(VILLA_MARIA_CORDOBA) }),
    );
    expect(out).toEqual({
      province: "Córdoba",
      locality: "Villa María",
      localityId: row(VILLA_MARIA_CORDOBA).id,
      unverified: false,
    });
  });

  it("the INDEC id an org client resolved is kept", async () => {
    const out = await resolveDenunciaJurisdiction(
      loc({
        provinceCode: "AR-X",
        locality: "Villa María",
        localityIndecId: VILLA_MARIA_CORDOBA,
        ...pinAt(VILLA_MARIA_CORDOBA),
      }),
    );
    expect(out.localityId).toBe(row(VILLA_MARIA_CORDOBA).id);
    expect(out.unverified).toBe(false);
  });

  it("a homonym name is province-level and MARKED — never filed under Alberti", async () => {
    const out = await resolveDenunciaJurisdiction(
      loc({ provinceCode: "AR-B", locality: "Mechita", ...pinAt(MECHITA_BRAGADO) }),
    );
    expect(out).toEqual({
      province: "Buenos Aires",
      locality: null,
      localityId: null,
      unverified: true,
    });
  });

  it("with no pair, the pin decides before the form text does", async () => {
    geo.reverse.mockResolvedValue({
      display_name: "Villa María, Córdoba",
      province: "Córdoba",
      locality: "Villa María",
    });
    const out = await resolveDenunciaJurisdiction(
      loc({ address: "Villa María", ...pinAt(VILLA_MARIA_CORDOBA) }),
    );
    expect(out).toEqual({
      province: "Córdoba",
      locality: "Villa María",
      localityId: row(VILLA_MARIA_CORDOBA).id,
      unverified: false,
    });
  });

  it("with no pair and no geocoder, the pin still names its province over ambiguous text", async () => {
    // "Villa María" alone names a locality in two provinces; the text path
    // would refuse and leave the report in nobody's queue. The pin says Córdoba.
    const out = await resolveDenunciaJurisdiction(
      loc({ address: "Villa María", ...pinAt(VILLA_MARIA_CORDOBA) }),
    );
    expect(out).toEqual({
      province: "Córdoba",
      locality: null,
      localityId: null,
      unverified: true,
    });
  });

  it("with nothing but form text, the text is read — and never picks a homonym", async () => {
    const out = await resolveDenunciaJurisdiction(
      loc({ address: "Calle 10, Mechita, Buenos Aires" }),
    );
    expect(out).toEqual({
      province: "Buenos Aires",
      locality: null,
      localityId: null,
      unverified: true,
    });
  });
});

describe("the long-form province a geocoder echoes", () => {
  it("is filed under its catalogue name, with the row it names", async () => {
    // Nominatim spells every point inside CABA "Ciudad Autónoma de Buenos
    // Aires"; the catalogue and the CHECK on welfare_reports hold "CABA".
    const out = await resolveDenunciaJurisdiction(
      loc({ province: "Ciudad Autónoma de Buenos Aires", locality: "Palermo" }),
    );
    expect(out.province).toBe("CABA");
    expect(out.locality).toBe("Palermo");
    expect(out.localityId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// A source pin, because the doors need a session (web) or a bearer (API) to
// run: every denuncia intake resolves its place through this ONE composition,
// and none of them reaches the name gate or the D.11 gate on its own again.
describe("every denuncia door uses this composition", () => {
  it("the web's public and org intakes", () => {
    const source = readFileSync("src/modules/welfare/actions.ts", "utf8");
    expect(source.match(/await resolveDenunciaJurisdiction\(loc\)/g)).toHaveLength(2);
    expect(source).not.toMatch(/resolveRoutableJurisdiction\(/);
    expect(source).not.toMatch(/normalizeLocationForWrite\(loc, \{\s*locality: "soft"/);
  });

  it("POST /api/v1/welfare-reports", () => {
    const source = readFileSync("app/api/v1/welfare-reports/commands.ts", "utf8");
    expect(source.match(/await resolveDenunciaJurisdiction\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/resolveRoutableJurisdiction\(/);
    expect(source).toMatch(/localityIndecId: input\.locationLocalityIndecId/);
  });
});
