// P3.1 — geocoder outage must not swallow a denuncia (PO decision D.11).
//
// THE DEFECT. A denuncia's (province, locality) is produced client-side by
// LocationFields from a geocoder result. When nominatim.openstreetmap.org is
// unreachable — a shared GitHub-Actions egress IP getting 403/429'd is the
// documented case — those hidden inputs arrive EMPTY and the row is written
// with jurisdiction_province NULL. Every branch of the jurisdiction scope model
// tests province equality, so a NULL-province row is in NOBODY's scope: the
// citizen files a maltrato report and no government operator ever sees it.
//
// WHAT IS ASSERTED HERE, AND WHAT IS NOT. The four groups below deliberately
// avoid the "mock the geocoder, assert the mock" shape that proves nothing:
//
//   1. Endpoint + timeout — `fetch` is stubbed at the NETWORK boundary (the one
//      thing a unit test may not perform) and the assertions are about the URL
//      we would contact and about the call NOT hanging.
//   2. addressSegments — pure, no doubles at all.
//   3. Inference — the ar_localities catalog is replaced by a small FAKE
//      CATALOG (a data fixture, not a spy); every assertion is about which
//      jurisdiction the module picks out of it, using the real provinceByName.
//   4. Visibility — the recovered jurisdiction is fed into the REAL scope
//      predicate `jurisdictionScopeContains` (the in-memory counterpart of the
//      SQL clause the queues compile) and into the REAL
//      `buildMaltratoListConditions`. No doubles in this group. This is the
//      group that proves the report stops being invisible; the rest is plumbing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Network boundary
// ---------------------------------------------------------------------------

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// ---------------------------------------------------------------------------
// Fake INDEC catalog — a fixture standing in for the ar_localities table.
// Two provinces, plus one deliberately ambiguous name shared by two provinces.
// ---------------------------------------------------------------------------

type CatalogRow = {
  id: string;
  provinceCode: string;
  provinceName: string;
  localityName: string;
  /** Centroid, for the coordinate-corroboration arm (A11-G1). */
  lat: number;
  lng: number;
};

const CATALOG: CatalogRow[] = [
  {
    id: "loc-quilmes",
    provinceCode: "AR-B",
    provinceName: "Buenos Aires",
    localityName: "Quilmes",
    lat: -34.7206,
    lng: -58.2546,
  },
  {
    id: "loc-lanus",
    provinceCode: "AR-B",
    provinceName: "Buenos Aires",
    localityName: "Lanús",
    lat: -34.7009,
    lng: -58.3918,
  },
  {
    id: "loc-palermo",
    provinceCode: "AR-C",
    provinceName: "CABA",
    localityName: "Palermo",
    lat: -34.5889,
    lng: -58.4306,
  },
  // Same name in two provinces — the inference must refuse to pick one.
  {
    id: "loc-belgrano-c",
    provinceCode: "AR-C",
    provinceName: "CABA",
    localityName: "Belgrano",
    lat: -34.5627,
    lng: -58.4583,
  },
  {
    id: "loc-belgrano-b",
    provinceCode: "AR-B",
    provinceName: "Buenos Aires",
    localityName: "Belgrano",
    lat: -35.0,
    lng: -58.9,
  },
  // La Plata and three neighbours, so a pin there has closer settlements than
  // Quilmes (~35 km away) — the locality arm of the corroboration check.
  {
    id: "loc-la-plata",
    provinceCode: "AR-B",
    provinceName: "Buenos Aires",
    localityName: "La Plata",
    lat: -34.9214,
    lng: -57.9544,
  },
  {
    id: "loc-berisso",
    provinceCode: "AR-B",
    provinceName: "Buenos Aires",
    localityName: "Berisso",
    lat: -34.8733,
    lng: -57.8866,
  },
  {
    id: "loc-ensenada",
    provinceCode: "AR-B",
    provinceName: "Buenos Aires",
    localityName: "Ensenada",
    lat: -34.8646,
    lng: -57.9111,
  },
  {
    id: "loc-city-bell",
    provinceCode: "AR-B",
    provinceName: "Buenos Aires",
    localityName: "City Bell",
    lat: -34.8667,
    lng: -58.05,
  },
  // Ten settlements around Salta city, so a pin there has ten nearer catalog
  // rows than any in CABA — the province arm of the corroboration check.
  ...Array.from({ length: 10 }, (_, i) => ({
    id: `loc-salta-${i}`,
    provinceCode: "AR-A",
    provinceName: "Salta",
    localityName: `Paraje Salteño ${i}`,
    lat: -24.78 + i * 0.05,
    lng: -65.41,
  })),
];

/** Same equirectangular approximation as the real catalog query. */
function fakeDistanceKm(row: CatalogRow, p: { lat: number; lng: number }): number {
  const dLng = (row.lng - p.lng) * Math.cos((p.lat * Math.PI) / 180);
  return 111.195 * Math.sqrt((row.lat - p.lat) ** 2 + dLng ** 2);
}

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

vi.mock("@/lib/infra/ar-localidades", () => ({
  localityByName: vi.fn(async (provinceCode: string, name: string | null | undefined) => {
    if (!name) return null;
    const row = CATALOG.find(
      (r) => r.provinceCode === provinceCode && fold(r.localityName) === fold(name),
    );
    return row ? { ...row, indecId: row.id, localitySlug: fold(row.localityName) } : null;
  }),
  searchLocalities: vi.fn(async (input: { query: string }) => {
    const q = fold(input.query);
    return CATALOG.filter((r) => fold(r.localityName).includes(q)).map((r) => ({
      ...r,
      indecId: r.id,
      localitySlug: fold(r.localityName),
      matchKind: "exact" as const,
    }));
  }),
  nearestLocalities: vi.fn(async (p: { lat: number; lng: number; limit: number }) =>
    CATALOG.map((r) => ({
      id: r.id,
      provinceCode: r.provinceCode,
      localityName: r.localityName,
      distanceKm: fakeDistanceKm(r, p),
    }))
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, p.limit),
  ),
  localityDistanceKm: vi.fn(async (id: string, p: { lat: number; lng: number }) => {
    const row = CATALOG.find((r) => r.id === id);
    return row ? fakeDistanceKm(row, p) : null;
  }),
}));

// ---------------------------------------------------------------------------
// Imports after the mocks
// ---------------------------------------------------------------------------

import { db, welfareReports } from "@/db";
import {
  type MaltratoListFilters,
  buildMaltratoListConditions,
} from "@/lib/analytics/govt-dashboards";
import { jurisdictionScopeContains } from "@/lib/domain/jurisdiction-canonical";
import {
  __resetRateLimitForTests,
  geocodeAddress,
  geocodingBaseUrl,
  geocodingTimeoutMs,
} from "@/lib/infra/geocoding";
import {
  addressSegments,
  inferJurisdictionFromText,
  resolveRoutableJurisdiction,
} from "@/lib/infra/jurisdiction-from-text";

beforeEach(() => {
  fetchMock.mockReset();
  __resetRateLimitForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// ===========================================================================
// 1. The fetch itself — endpoint override, timeout, failure semantics
// ===========================================================================

describe("geocoding provider endpoint is configurable", () => {
  it("defaults to the public Nominatim host when no override is set", () => {
    vi.stubEnv("GEOCODING_BASE_URL", "");
    expect(geocodingBaseUrl()).toBe("https://nominatim.openstreetmap.org");
  });

  it("sends the forward query to GEOCODING_BASE_URL when one is configured", async () => {
    vi.stubEnv("GEOCODING_BASE_URL", "https://geocoder.interno.gob.ar/nominatim/");
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] });

    await geocodeAddress("Plaza Italia");

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin).toBe("https://geocoder.interno.gob.ar");
    // The trailing slash on the override must not produce "//search".
    expect(url.pathname).toBe("/nominatim/search");
  });

  it("treats a whitespace-only override as unset instead of building an invalid URL", () => {
    vi.stubEnv("GEOCODING_BASE_URL", "   ");
    expect(geocodingBaseUrl()).toBe("https://nominatim.openstreetmap.org");
  });
});

describe("geocoding timeout", () => {
  it("clamps a nonsense GEOCODING_TIMEOUT_MS instead of disabling the abort guard", () => {
    vi.stubEnv("GEOCODING_TIMEOUT_MS", "0");
    expect(geocodingTimeoutMs()).toBe(1000);
    vi.stubEnv("GEOCODING_TIMEOUT_MS", "9999999");
    expect(geocodingTimeoutMs()).toBe(30_000);
    vi.stubEnv("GEOCODING_TIMEOUT_MS", "not-a-number");
    expect(geocodingTimeoutMs()).toBe(8000);
  });

  it("a provider that never answers FAILS at the deadline — it does not hang", async () => {
    vi.stubEnv("GEOCODING_TIMEOUT_MS", "1000");
    vi.useFakeTimers();
    __resetRateLimitForTests();

    // A provider socket that only settles when the AbortController fires — the
    // real shape of a hung upstream, not an immediate rejection.
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );

    const pending = geocodeAddress("Plaza Italia");
    // Attach the rejection handler before advancing so the rejection is never
    // unhandled; the assertion is that it SETTLES, and settles as a failure.
    const settled = pending.then(
      () => "resolved",
      (e: Error) => e.message,
    );
    await vi.advanceTimersByTimeAsync(1500);

    expect(await settled).toBe("fetch_failed");
  });

  it("the corner-syntax retries share ONE wall-clock budget with the first query", async () => {
    // "Gorriti y Serrano" produces two intersection candidates, so the naive
    // implementation issues three sequential requests, each with its own full
    // timeout. With a shared budget, a provider that is merely SLOW (each call
    // answering just under the deadline, with zero results) gets abandoned
    // after the budget is spent instead of costing 3x the timeout.
    vi.stubEnv("GEOCODING_TIMEOUT_MS", "1000");
    vi.useFakeTimers();
    __resetRateLimitForTests();

    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true, json: async () => [] }), 900);
        }),
    );

    const pending = geocodeAddress("Gorriti y Serrano");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual([]);

    // Original + exactly one retry: the second retry starts after 1800ms of
    // elapsed time, past the 1000ms budget, and is skipped.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// 2. Address segmentation — pure
// ===========================================================================

describe("addressSegments", () => {
  it("splits on the comma grammar and drops the country tail", () => {
    expect(addressSegments("Av. Rivadavia 1234, Quilmes, Buenos Aires, Argentina")).toEqual([
      "Av. Rivadavia 1234",
      "Quilmes",
      "Buenos Aires",
    ]);
  });

  it("drops bare postal codes and house numbers, which are never jurisdictions", () => {
    expect(addressSegments("Serrano 500, B1878, Quilmes")).toEqual(["Serrano 500", "Quilmes"]);
    expect(addressSegments("Callao 100, C1425DKE, CABA")).toEqual(["Callao 100", "CABA"]);
  });

  it("returns nothing for text with no comma structure worth reading", () => {
    expect(addressSegments("")).toEqual([]);
    expect(addressSegments(null)).toEqual([]);
    expect(addressSegments("ay")).toEqual([]);
  });

  it("keeps the TAIL when a paste has more segments than the lookup budget", () => {
    const many = Array.from({ length: 12 }, (_, i) => `seg${i}xx`).join(", ");
    const out = addressSegments(many);
    expect(out).toHaveLength(8);
    expect(out.at(-1)).toBe("seg11xx");
  });
});

// ===========================================================================
// 3. Inference from the form text
// ===========================================================================

describe("inferJurisdictionFromText", () => {
  it("reads province and locality out of a normal Argentine address line", async () => {
    const r = await inferJurisdictionFromText("Av. Rivadavia 1234, Quilmes, Buenos Aires");
    expect(r).toEqual({
      province: "Buenos Aires",
      locality: "Quilmes",
      localityId: "loc-quilmes",
    });
  });

  it("scans back-to-front, so a STREET named after a province does not win", async () => {
    // "Córdoba 1234" is a CABA street. A front-to-back scan would route this
    // denuncia to the province of Córdoba, ~700km away.
    const r = await inferJurisdictionFromText("Córdoba 1234, Palermo, CABA");
    expect(r?.province).toBe("CABA");
    expect(r?.locality).toBe("Palermo");
  });

  it("returns the province alone when no catalog locality is named", async () => {
    // Province-only still routes: the whole-province branch of the scope model
    // matches rows whose locality is NULL.
    const r = await inferJurisdictionFromText("Ruta 2 km 40, Buenos Aires");
    expect(r).toEqual({ province: "Buenos Aires", locality: null, localityId: null });
  });

  it("recovers the province from a bare locality name typed alone", async () => {
    const r = await inferJurisdictionFromText("Quilmes");
    expect(r).toEqual({
      province: "Buenos Aires",
      locality: "Quilmes",
      localityId: "loc-quilmes",
    });
  });

  it("REFUSES to guess when a bare locality name exists in more than one province", async () => {
    // "Belgrano" is both a CABA barrio and a Buenos Aires locality. Picking one
    // by relevance ranking would route a denuncia to a municipality on a coin
    // flip and still print a jurisdiction that looks authoritative.
    expect(await inferJurisdictionFromText("Belgrano")).toBeNull();
  });

  it("returns null for text that names no jurisdiction at all", async () => {
    expect(await inferJurisdictionFromText("atrás del galpón, cerca de las vías")).toBeNull();
    expect(await inferJurisdictionFromText(null)).toBeNull();
  });
});

// ===========================================================================
// 4. The gate, and the thing that actually matters: is the report VISIBLE?
// ===========================================================================

describe("resolveRoutableJurisdiction — D.11 gate", () => {
  it("GEOCODER SUCCEEDED and the pin agrees: passes the jurisdiction through untouched and unmarked", async () => {
    const r = await resolveRoutableJurisdiction({
      province: "CABA",
      locality: "Palermo",
      localityId: "loc-palermo",
      addressText: "Av. Santa Fe 3253, Palermo, CABA",
      lat: -34.5885,
      lng: -58.4108,
    });
    expect(r).toEqual({
      province: "CABA",
      locality: "Palermo",
      localityId: "loc-palermo",
      unverified: false,
    });
  });

  it("GEOCODER SUCCEEDED with an off-catalog locality: accepted and preserved, but MARKED", async () => {
    // The public intake normalizes locality in "soft" mode precisely so an OSM
    // spelling that is not in INDEC does not hard-block — and it still does not:
    // the pair is kept. But a locality with no catalog row has nothing the pin
    // can be measured against, so it is not verified (security review LOW-2).
    const r = await resolveRoutableJurisdiction({
      province: "Buenos Aires",
      locality: "Villa Tesei",
      localityId: null,
      addressText: "Calle 12, Villa Tesei, Buenos Aires",
      lat: -34.6167,
      lng: -58.6333,
    });
    expect(r.unverified).toBe(true);
    expect(r.locality).toBe("Villa Tesei");
    expect(r.province).toBe("Buenos Aires");
  });

  it("control: the same pin with a province-only claim (no locality) is verified", async () => {
    const r = await resolveRoutableJurisdiction({
      province: "Buenos Aires",
      locality: null,
      localityId: null,
      addressText: "Calle 12, Buenos Aires",
      lat: -34.6167,
      lng: -58.6333,
    });
    expect(r.unverified).toBe(false);
  });

  // A11-G1: the pair on this arm is the CLIENT's echo of a geocoder answer. A
  // client can put any pair next to any pin, so it is marked verified only when
  // the pin corroborates it — and it is never rewritten from the pin.
  it("an echoed province the pin contradicts keeps its pair but is MARKED", async () => {
    const r = await resolveRoutableJurisdiction({
      province: "CABA",
      locality: "Palermo",
      localityId: "loc-palermo",
      addressText: "Av. Santa Fe 3253, Palermo, CABA",
      lat: -24.7821,
      lng: -65.4232, // Salta
    });
    expect(r).toEqual({
      province: "CABA",
      locality: "Palermo",
      localityId: "loc-palermo",
      unverified: true,
    });
  });

  it("an echoed province-only pair the pin contradicts is MARKED (the province arm alone)", async () => {
    const r = await resolveRoutableJurisdiction({
      province: "CABA",
      locality: null,
      localityId: null,
      addressText: "Av. Corrientes 1234, CABA",
      lat: -24.7821,
      lng: -65.4232, // Salta
    });
    expect(r.province).toBe("CABA");
    expect(r.unverified).toBe(true);
  });

  it("an echoed locality ~35 km from the pin, with nearer settlements, is MARKED", async () => {
    const r = await resolveRoutableJurisdiction({
      province: "Buenos Aires",
      locality: "Quilmes",
      localityId: "loc-quilmes",
      addressText: "Calle 7 y 50, Quilmes, Buenos Aires",
      lat: -34.9205,
      lng: -57.9536, // La Plata
    });
    expect(r.province).toBe("Buenos Aires");
    expect(r.locality).toBe("Quilmes");
    expect(r.unverified).toBe(true);
  });

  it("control: the same pin echoing its own locality is verified", async () => {
    const r = await resolveRoutableJurisdiction({
      province: "Buenos Aires",
      locality: "La Plata",
      localityId: "loc-la-plata",
      addressText: "Calle 7 y 50, La Plata, Buenos Aires",
      lat: -34.9205,
      lng: -57.9536,
    });
    expect(r.unverified).toBe(false);
  });

  it("an echoed pair with no coordinates to check it against is MARKED", async () => {
    const r = await resolveRoutableJurisdiction({
      province: "CABA",
      locality: "Palermo",
      localityId: "loc-palermo",
      addressText: "Av. Santa Fe 3253, Palermo, CABA",
      lat: null,
      lng: null,
    });
    expect(r.province).toBe("CABA");
    expect(r.unverified).toBe(true);
  });

  it("GEOCODER DOWN: recovers the jurisdiction from the form text and MARKS it", async () => {
    const r = await resolveRoutableJurisdiction({
      province: null,
      locality: null,
      localityId: null,
      lat: null,
      lng: null,
      addressText: "Av. Rivadavia 1234, Quilmes, Buenos Aires",
    });
    expect(r).toEqual({
      province: "Buenos Aires",
      locality: "Quilmes",
      localityId: "loc-quilmes",
      unverified: true,
    });
  });

  it("GEOCODER DOWN and the text names nothing: no jurisdiction invented, still marked", async () => {
    const r = await resolveRoutableJurisdiction({
      province: null,
      locality: null,
      localityId: null,
      lat: null,
      lng: null,
      addressText: "atrás del galpón",
    });
    expect(r.province).toBeNull();
    expect(r.unverified).toBe(true);
  });
});

describe("a geocoder outage no longer makes a denuncia invisible", () => {
  // The REAL scope predicate. lib/metrics/scope.ts documents it as the
  // in-memory counterpart of the SQL clause every govt queue compiles, with the
  // same subsumption rules — so "true here" is "selected by the queue's WHERE".
  const QUILMES_OPERATOR = [{ province: "Buenos Aires", locality: "Quilmes" }];
  const WHOLE_CABA_OPERATOR = [{ province: "CABA", locality: "Ciudad Autónoma de Buenos Aires" }];
  const PALERMO_OPERATOR = [{ province: "CABA", locality: "Palermo" }];

  it("THE DEFECT: a null-jurisdiction report is in nobody's queue", () => {
    for (const operator of [QUILMES_OPERATOR, WHOLE_CABA_OPERATOR, PALERMO_OPERATOR]) {
      expect(jurisdictionScopeContains(operator, null, null)).toBe(false);
    }
  });

  it("THE FIX: the text-recovered pair lands in the queue of the jurisdiction it names", async () => {
    const r = await resolveRoutableJurisdiction({
      province: null,
      locality: null,
      localityId: null,
      lat: null,
      lng: null,
      addressText: "Av. Rivadavia 1234, Quilmes, Buenos Aires",
    });
    expect(jurisdictionScopeContains(QUILMES_OPERATOR, r.province, r.locality)).toBe(true);
    // And nowhere else — the fallback must not broadcast a denuncia to every
    // municipality in the country to be safe.
    expect(jurisdictionScopeContains(WHOLE_CABA_OPERATOR, r.province, r.locality)).toBe(false);
  });

  it("a province-only recovery reaches the whole-province operator", async () => {
    const r = await resolveRoutableJurisdiction({
      province: null,
      locality: null,
      localityId: null,
      lat: null,
      lng: null,
      addressText: "Av. 9 de Julio y Corrientes, CABA",
    });
    expect(r.province).toBe("CABA");
    expect(r.locality).toBeNull();
    expect(jurisdictionScopeContains(WHOLE_CABA_OPERATOR, r.province, r.locality)).toBe(true);
    // A barrio-grain operator is NOT widened by a locality-less row — that is
    // the pre-existing rule (jurisdictionPairClause), left alone on purpose.
    expect(jurisdictionScopeContains(PALERMO_OPERATOR, r.province, r.locality)).toBe(false);
  });
});

describe("the 'Sin verificar' lens is a lens, not a hiding place", () => {
  const BASE: MaltratoListFilters = {
    actor: { role: "govt" },
    filteredJurisdictions: [{ province: "Buenos Aires", locality: "Quilmes" }],
    queue: "all",
    currentUserId: "00000000-0000-0000-0000-000000000001",
  };

  /**
   * Serialize the predicate to real SQL text. Walking the Drizzle condition
   * object instead would be useless here: the tree holds a reference to the
   * whole PgTable, so EVERY column name of welfare_reports appears in it
   * whether the predicate mentions it or not — a negative assertion built that
   * way can never fail. `.toSQL()` renders only what the WHERE actually says
   * and issues no query.
   */
  function whereSql(filters: MaltratoListFilters): string {
    const full = db
      .select({ id: welfareReports.id })
      .from(welfareReports)
      .where(buildMaltratoListConditions(filters))
      .toSQL().sql;
    const idx = full.indexOf(" where ");
    // A predicate that vanished entirely would silently pass every assertion
    // below, so refuse to return an empty string.
    expect(idx).toBeGreaterThan(-1);
    return full.slice(idx);
  }

  it("queue=unverified filters ON the flag", () => {
    expect(whereSql({ ...BASE, queue: "unverified" })).toContain('"jurisdiction_unverified"');
  });

  it("the DEFAULT queues do not filter unverified rows out — they stay in the workload", () => {
    // This is the half of the "which queue" decision that is easy to get wrong
    // in the other direction: shunting the guesses into their own tab would
    // reproduce the invisibility defect under a tidier name.
    for (const queue of ["unassigned", "urgent", "mine", "overdue", "all"] as const) {
      expect(whereSql({ ...BASE, queue })).not.toContain("jurisdiction_unverified");
    }
  });

  it("the lens does NOT widen scope — a govt operator still only sees their own jurisdiction", () => {
    // A "show me all the guesses" tab that quietly dropped the jurisdiction
    // fence would be a cross-tenant leak wearing an audit tool's clothes.
    const sqlText = whereSql({ ...BASE, queue: "unverified" });
    expect(sqlText).toContain('"jurisdiction_province"');
    expect(sqlText).toContain('"jurisdiction_locality"');
  });
});
