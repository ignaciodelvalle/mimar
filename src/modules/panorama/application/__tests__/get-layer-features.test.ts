// Unit tests for getLayerFeatures (F1 Panorama v2 contract).
//
// The infrastructure repository is mocked entirely — no DB, no network. All
// tests verify the use-case orchestration: correct loader is called with the
// right arguments, return value matches the envelope contract.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/src/modules/panorama/infrastructure/repository", () => ({
  loadPerdidasByUnit: vi.fn(),
  loadPerdidasEvents: vi.fn(),
  loadMordedurassByUnit: vi.fn(),
  loadBiteEvents: vi.fn(),
  loadDenunciasByUnit: vi.fn(),
  loadDenunciaCentroids: vi.fn(),
  loadZoonosisByUnit: vi.fn(),
  loadSintomasByUnit: vi.fn(),
  loadReunificacionByUnit: vi.fn(),
  loadShelters: vi.fn(),
  loadClinics: vi.fn(),
  loadDecomisos: vi.fn(),
  loadChoroplethByLevel: vi.fn(),
  loadTerritorialIndexByProvince: vi.fn(),
  loadCensusLookup: vi.fn(),
}));

import type {
  AggregatedPointRows,
  ChoroplethRows,
  PointEventsRows,
  ProvinceChoroplethRows,
} from "@/src/modules/panorama/infrastructure/repository";
import {
  loadBiteEvents,
  loadCensusLookup,
  loadChoroplethByLevel,
  loadClinics,
  loadDecomisos,
  loadDenunciaCentroids,
  loadDenunciasByUnit,
  loadMordedurassByUnit,
  loadPerdidasByUnit,
  loadPerdidasEvents,
  loadReunificacionByUnit,
  loadShelters,
  loadSintomasByUnit,
  loadTerritorialIndexByProvince,
  loadZoonosisByUnit,
} from "@/src/modules/panorama/infrastructure/repository";

import { getLayerFeatures, resolvePointsMode } from "../get-layer-features";

// ---------------------------------------------------------------------------
// Shared mock factories
// ---------------------------------------------------------------------------

/** A minimal AggregatedPointRows envelope for the per-unit loaders. */
function aggRows(over: Partial<AggregatedPointRows> = {}): AggregatedPointRows {
  return {
    cells: [
      {
        key: "Buenos Aires",
        province: "Buenos Aires",
        locality: null,
        centroidLat: "-34.6037000",
        centroidLng: "-58.3816000",
        count: 12,
        suppressed: false,
      },
    ],
    suppressedCount: 0,
    noLocalityCount: 0,
    truncated: false,
    ...over,
  };
}

const mockLoadPerdidas = vi.mocked(loadPerdidasByUnit);
const mockLoadPerdidasEvents = vi.mocked(loadPerdidasEvents);
const mockLoadMordeduras = vi.mocked(loadMordedurassByUnit);
const mockLoadBiteEvents = vi.mocked(loadBiteEvents);
const mockLoadDenuncias = vi.mocked(loadDenunciasByUnit);
const mockLoadDenunciaCentroids = vi.mocked(loadDenunciaCentroids);
const mockLoadZoonosis = vi.mocked(loadZoonosisByUnit);
const mockLoadSintomas = vi.mocked(loadSintomasByUnit);
const mockLoadReunificacion = vi.mocked(loadReunificacionByUnit);
const mockLoadShelters = vi.mocked(loadShelters);
const mockLoadClinics = vi.mocked(loadClinics);
const mockLoadDecomisos = vi.mocked(loadDecomisos);
const mockLoadChoropleth = vi.mocked(loadChoroplethByLevel);
const mockLoadTerritorialIndex = vi.mocked(loadTerritorialIndexByProvince);
const mockLoadCensusLookup = vi.mocked(loadCensusLookup);

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// F1 density+signal loaders — aggregated point contract
// ---------------------------------------------------------------------------

describe("getLayerFeatures — perdidas (F1 aggregated point)", () => {
  it("calls loadPerdidasByUnit with (level, actor, jurisdictions, since, asOf) and returns aggregated envelope", async () => {
    const rows = aggRows();
    mockLoadPerdidas.mockResolvedValue(rows);

    const actor = { role: "govt" as const };
    const jur = [{ province: "Buenos Aires", locality: "La Plata" }];
    const since = new Date("2026-06-01T00:00:00.000Z");
    const asOf = new Date("2026-06-15T00:00:00.000Z");

    const result = await getLayerFeatures("perdidas", actor, jur, { since, asOf }, "province");

    expect(mockLoadPerdidas).toHaveBeenCalledOnce();
    expect(mockLoadPerdidas).toHaveBeenCalledWith(
      "province",
      actor,
      jur,
      since,
      asOf,
      undefined,
      undefined,
      undefined,
    );

    // Return shape: aggregated features + envelope.
    expect(result.level).toBe("province");
    expect(result.truncated).toBe(false);
    expect(result.suppressedCount).toBe(0);
    // One feature per cell.
    expect(result.features.features).toHaveLength(1);
  });

  it("threads asOf into the loader — asOf is NOT a post-fetch filter", async () => {
    mockLoadPerdidas.mockResolvedValue(aggRows());

    const asOf = new Date("2026-06-08T00:00:00.000Z");
    await getLayerFeatures(
      "perdidas",
      { role: "admin" },
      [],
      { since: new Date("2026-06-01T00:00:00.000Z"), asOf },
      "locality",
    );

    expect(mockLoadPerdidas).toHaveBeenCalledWith(
      "locality",
      { role: "admin" },
      [],
      expect.any(Date),
      asOf,
      undefined,
      undefined,
      undefined,
    );
  });

  it("passes actor+jurisdictions through without widening scope", async () => {
    mockLoadPerdidas.mockResolvedValue(aggRows());
    const jur = [{ province: "Salta", locality: "Salta" }];

    await getLayerFeatures("perdidas", { role: "govt" }, jur, {
      since: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(mockLoadPerdidas).toHaveBeenCalledWith(
      expect.any(String),
      { role: "govt" },
      jur,
      expect.any(Date),
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it("returns buildAggregatedPointFeatures output with correct level in envelope", async () => {
    mockLoadPerdidas.mockResolvedValue(aggRows({ truncated: true, suppressedCount: 2 }));

    const result = await getLayerFeatures(
      "perdidas",
      { role: "admin" },
      [],
      { since: new Date("2026-06-01T00:00:00.000Z") },
      "locality",
    );

    expect(result.level).toBe("locality");
    expect(result.truncated).toBe(true);
    expect(result.suppressedCount).toBe(2);
    expect(result.features.type).toBe("FeatureCollection");
  });
});

// ---------------------------------------------------------------------------
// panorama-event-points Slice 1 — near-zoom REAL sighting dots + server gate.
// ---------------------------------------------------------------------------

function eventRows(over: Partial<PointEventsRows> = {}): PointEventsRows {
  return {
    rows: [
      {
        publicToken: "DIM-AAAA-1111",
        name: "Firulai",
        species: "dog",
        status: "lost",
        locationLat: "-34.6037000",
        locationLng: "-58.3816000",
        lastSeenAt: "2026-06-19T12:00:00.000Z",
        locationSource: "gps",
      },
    ],
    truncated: false,
    noCoordCount: 0,
    ...over,
  };
}

describe("resolvePointsMode (server-authoritative gate — A1)", () => {
  it("is false when mode is not 'points' regardless of province", () => {
    expect(resolvePointsMode(null, true)).toBe(false);
    expect(resolvePointsMode("aggregated", true)).toBe(false);
  });

  it("is false when mode=points but NO province is resolved (no national dot-dump)", () => {
    // admin session with mode=points and no province → aggregated, never dots.
    expect(resolvePointsMode("points", false)).toBe(false);
  });

  it("is true only when mode=points AND a province is resolved", () => {
    expect(resolvePointsMode("points", true)).toBe(true);
  });
});

describe("getLayerFeatures — perdidas points mode (Slice 1)", () => {
  it("routes to loadPerdidasEvents (NOT the aggregated loader) and returns a points envelope", async () => {
    mockLoadPerdidasEvents.mockResolvedValue(eventRows({ truncated: true, noCoordCount: 3 }));

    const actor = { role: "govt" as const };
    const jur = [{ province: "Córdoba", locality: "Córdoba" }];
    const since = new Date("2026-06-01T00:00:00.000Z");
    const asOf = new Date("2026-06-15T00:00:00.000Z");

    const result = await getLayerFeatures(
      "perdidas",
      actor,
      jur,
      { since, asOf },
      "locality",
      "Córdoba",
      "Córdoba",
      /* pointsMode */ true,
    );

    // The aggregated loader is NOT called; the per-event dot loader is.
    expect(mockLoadPerdidas).not.toHaveBeenCalled();
    expect(mockLoadPerdidasEvents).toHaveBeenCalledWith(
      actor,
      jur,
      since,
      asOf,
      "Córdoba",
      "Córdoba",
      undefined,
    );
    expect(result.mode).toBe("points");
    expect(result.truncated).toBe(true);
    // Distinct residual field (A6) — NOT noLocalityCount.
    expect(result.sinUbicacionCount).toBe(3);
    expect(result.features.features).toHaveLength(1);
    // The dot carries the public-by-consent props, no province (A3/D7).
    expect(result.features.features[0].properties).toMatchObject({
      token: "DIM-AAAA-1111",
      locationSource: "gps",
    });
    expect(
      (result.features.features[0].properties as Record<string, unknown>).province,
    ).toBeUndefined();
  });

  it("falls back to the aggregated loader when pointsMode is false (default)", async () => {
    mockLoadPerdidas.mockResolvedValue(aggRows());

    const result = await getLayerFeatures(
      "perdidas",
      { role: "admin" },
      [],
      { since: new Date("2026-06-01T00:00:00.000Z") },
      "locality",
    );

    expect(mockLoadPerdidasEvents).not.toHaveBeenCalled();
    expect(mockLoadPerdidas).toHaveBeenCalledOnce();
    expect(result.mode).toBeUndefined();
  });
});

describe("getLayerFeatures — mordeduras (F1 aggregated point)", () => {
  it("calls loadMordedurassByUnit with correct args and returns envelope", async () => {
    mockLoadMordeduras.mockResolvedValue(aggRows());

    const actor = { role: "admin" as const };
    const asOf = new Date("2026-06-08T00:00:00.000Z");

    const result = await getLayerFeatures(
      "mordeduras",
      actor,
      [],
      { since: new Date("2026-06-01T00:00:00.000Z"), asOf },
      "province",
    );

    expect(mockLoadMordeduras).toHaveBeenCalledWith(
      "province",
      actor,
      [],
      expect.any(Date),
      asOf,
      undefined,
      undefined,
      undefined,
    );
    expect(result.level).toBe("province");
  });
});

// ---------------------------------------------------------------------------
// panorama-event-points Slice 2 — mordeduras REAL incident dots (operator-scoped).
// ---------------------------------------------------------------------------

describe("getLayerFeatures — mordeduras points mode (Slice 2)", () => {
  it("routes to loadBiteEvents (NOT the aggregated loader), scope-bound, and returns a points envelope", async () => {
    mockLoadBiteEvents.mockResolvedValue({
      rows: [
        {
          id: "evt-1",
          locationLat: "-31.4200000",
          locationLng: "-64.1800000",
          incidentType: "bite_inflicted",
          severity: "moderate",
          occurredAt: "2026-06-19T12:00:00.000Z",
        },
      ],
      truncated: false,
      noCoordCount: 4,
    });

    const actor = { role: "govt" as const };
    const jur = [{ province: "Córdoba", locality: "Córdoba" }];
    const since = new Date("2026-06-01T00:00:00.000Z");

    const result = await getLayerFeatures(
      "mordeduras",
      actor,
      jur,
      { since },
      "locality",
      "Córdoba",
      "Córdoba",
      /* pointsMode */ true,
    );

    // The aggregated loader is NOT called; the per-event dot loader is — scope
    // (adminProvince/Locality) is threaded so a govt user stays jurisdiction-bound.
    expect(mockLoadMordeduras).not.toHaveBeenCalled();
    expect(mockLoadBiteEvents).toHaveBeenCalledWith(
      actor,
      jur,
      since,
      undefined,
      "Córdoba",
      "Córdoba",
      undefined,
    );
    expect(result.mode).toBe("points");
    // Older coord-less bites → honest residual (not a fake dot).
    expect(result.sinUbicacionCount).toBe(4);
    expect(result.features.features).toHaveLength(1);
    // Bite dot carries NO token/pet and NO province → no k-anon unit-history fetch.
    const props = result.features.features[0].properties as Record<string, unknown>;
    expect(props.incidentType).toBe("bite_inflicted");
    expect(props.province).toBeUndefined();
    expect(props.token).toBeUndefined();
  });

  it("falls back to the aggregated loader when pointsMode is false", async () => {
    mockLoadMordeduras.mockResolvedValue(aggRows());
    const result = await getLayerFeatures(
      "mordeduras",
      { role: "admin" },
      [],
      { since: new Date("2026-06-01T00:00:00.000Z") },
      "locality",
    );
    expect(mockLoadBiteEvents).not.toHaveBeenCalled();
    expect(mockLoadMordeduras).toHaveBeenCalledOnce();
    expect(result.mode).toBeUndefined();
  });
});

describe("getLayerFeatures — denuncias (F1 aggregated point)", () => {
  it("calls loadDenunciasByUnit — exact coordinate never leaves repository", async () => {
    const rows = aggRows({
      cells: [
        {
          key: "Córdoba|Córdoba",
          province: "Córdoba",
          locality: "Córdoba",
          centroidLat: "-31.4200000",
          centroidLng: "-64.1800000",
          count: 7,
          suppressed: false,
        },
      ],
    });
    mockLoadDenuncias.mockResolvedValue(rows);

    const jur = [{ province: "Córdoba", locality: "Córdoba" }];
    const result = await getLayerFeatures(
      "denuncias",
      { role: "govt" },
      jur,
      { since: new Date("2026-06-01T00:00:00.000Z") },
      "locality",
    );

    expect(mockLoadDenuncias).toHaveBeenCalledWith(
      "locality",
      { role: "govt" },
      jur,
      expect.any(Date),
      undefined,
      undefined,
      undefined,
    );
    expect(result.features.features).toHaveLength(1);
    expect(result.level).toBe("locality");
  });
});

// ---------------------------------------------------------------------------
// panorama-event-points Slice 3 — denuncias LOCALITY-CENTROID dots.
// The exact welfare_reports coordinate is NEVER selected (anonymous-reporter
// invariant); loadDenunciaCentroids snaps to the ar_localities centroid.
// ---------------------------------------------------------------------------

describe("getLayerFeatures — denuncias points mode (Slice 3)", () => {
  it("routes to loadDenunciaCentroids and emits COARSE centroid features (never exact coord)", async () => {
    mockLoadDenunciaCentroids.mockResolvedValue({
      rows: [
        {
          // ALREADY the locality centroid — the loader never returns the exact coord.
          centroidLat: "-31.4200000",
          centroidLng: "-64.1800000",
          province: "Córdoba",
          locality: "Córdoba",
          severity: "high",
          kind: "physical_abuse",
          createdAt: "2026-06-19T12:00:00.000Z",
        },
      ],
      truncated: false,
    });

    const actor = { role: "govt" as const };
    const jur = [{ province: "Córdoba", locality: "Córdoba" }];
    const since = new Date("2026-06-01T00:00:00.000Z");

    const result = await getLayerFeatures(
      "denuncias",
      actor,
      jur,
      { since },
      "locality",
      "Córdoba",
      "Córdoba",
      /* pointsMode */ true,
    );

    expect(mockLoadDenuncias).not.toHaveBeenCalled();
    expect(mockLoadDenunciaCentroids).toHaveBeenCalledWith(
      actor,
      jur,
      since,
      undefined,
      "Córdoba",
      "Córdoba",
    );
    expect(result.mode).toBe("points");
    expect(result.features.features).toHaveLength(1);
    // The dot is flagged COARSE — the popup/drawer must say "ubicación aproximada".
    const props = result.features.features[0].properties as Record<string, unknown>;
    expect(props.coarse).toBe(true);
    // Plotted at the locality centroid we handed the loader (never an exact addr).
    expect(result.features.features[0].geometry).toMatchObject({
      coordinates: [-64.18, -31.42],
    });
  });
});

describe("getLayerFeatures — zoonosis (F1 aggregated signal point)", () => {
  it("calls loadZoonosisByUnit and returns aggregated envelope", async () => {
    mockLoadZoonosis.mockResolvedValue(aggRows());

    const result = await getLayerFeatures(
      "zoonosis",
      { role: "admin" },
      [],
      { since: new Date("2026-06-01T00:00:00.000Z") },
      "province",
    );

    expect(mockLoadZoonosis).toHaveBeenCalledWith(
      "province",
      { role: "admin" },
      [],
      expect.any(Date),
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(result.level).toBe("province");
    expect(result.features.type).toBe("FeatureCollection");
  });

  // panorama-event-points Slice 3 — zoonosis TIER DECISION: stays aggregated even
  // in points mode. Both outbreak_signal writers persist NO columnar
  // location_lat/lng (only pet_jurisdiction_* snapshots), so there is nothing to
  // plot as a real dot. Rendering an aggregate/centroid is the honest choice
  // (plan §5 "if the writer sets no coords → aggregated + document the gap").
  it("stays AGGREGATED in points mode — no real dots (writer persists no coords)", async () => {
    mockLoadZoonosis.mockResolvedValue(aggRows());

    const result = await getLayerFeatures(
      "zoonosis",
      { role: "govt" },
      [{ province: "Córdoba", locality: "Córdoba" }],
      { since: new Date("2026-06-01T00:00:00.000Z") },
      "locality",
      "Córdoba",
      "Córdoba",
      /* pointsMode */ true,
    );

    // Still the per-unit aggregated loader — points mode is a no-op for zoonosis.
    expect(mockLoadZoonosis).toHaveBeenCalledOnce();
    expect(result.mode).toBeUndefined();
  });

  // task panorama-bivariate-2026-07-21: the province-grain fallback for the
  // bivariate join's signal axis. `loadZoonosisByUnit` carries it as
  // `provinceSignal` on the AggregatedPointRows envelope; getLayerFeatures must
  // surface it as `bivariateSignal` — a SEPARATE FeatureCollection from the
  // primary (still department-grain) `features` the standalone layer paints.
  it("surfaces provinceSignal as a separate bivariateSignal FeatureCollection", async () => {
    mockLoadZoonosis.mockResolvedValue(
      aggRows({
        provinceSignal: [
          {
            key: "Buenos Aires",
            province: "Buenos Aires",
            locality: null,
            centroidLat: "-36.6769000",
            centroidLng: "-60.5588000",
            count: 55,
            suppressed: false,
          },
          {
            key: "Tierra del Fuego",
            province: "Tierra del Fuego",
            locality: null,
            centroidLat: "-54.0000000",
            centroidLng: "-68.0000000",
            count: null,
            suppressed: true,
          },
        ],
      }),
    );

    const result = await getLayerFeatures(
      "zoonosis",
      { role: "admin" },
      [],
      { since: new Date("2026-06-01T00:00:00.000Z") },
      "province",
    );

    expect(result.bivariateSignal).toBeDefined();
    expect(result.bivariateSignal?.features).toHaveLength(2);
    const props = result.bivariateSignal?.features.map((f) => f.properties);
    expect(props).toContainEqual(
      expect.objectContaining({ province: "Buenos Aires", count: 55, suppressed: false }),
    );
    expect(props).toContainEqual(
      expect.objectContaining({ province: "Tierra del Fuego", count: null, suppressed: true }),
    );
    // The primary `features` (department-grain, the standalone layer's paint
    // data) stays independent of the bivariate fallback — untouched by it.
    expect(result.features).not.toBe(result.bivariateSignal);
  });

  it("leaves bivariateSignal undefined when the loader doesn't set provinceSignal (e.g. at locality level)", async () => {
    mockLoadZoonosis.mockResolvedValue(aggRows());

    const result = await getLayerFeatures(
      "zoonosis",
      { role: "admin" },
      [],
      { since: new Date("2026-06-01T00:00:00.000Z") },
      "locality",
    );

    expect(result.bivariateSignal).toBeUndefined();
  });
});

describe("getLayerFeatures — sintomas (F1 aggregated point, panorama-operator-ia port)", () => {
  it("calls loadSintomasByUnit with (level, actor, jurisdictions, since, asOf, ..., basis) and returns aggregated envelope", async () => {
    mockLoadSintomas.mockResolvedValue(aggRows());

    const actor = { role: "admin" as const };
    const since = new Date("2026-06-01T00:00:00.000Z");
    const asOf = new Date("2026-06-15T00:00:00.000Z");

    const result = await getLayerFeatures(
      "sintomas",
      actor,
      [],
      { since, asOf, basis: "transaction" },
      "province",
    );

    expect(mockLoadSintomas).toHaveBeenCalledWith(
      "province",
      actor,
      [],
      since,
      asOf,
      undefined,
      undefined,
      "transaction",
    );
    expect(result.level).toBe("province");
    expect(result.features.type).toBe("FeatureCollection");
  });
});

describe("getLayerFeatures — reunificacion (F1 aggregated signal point, D4)", () => {
  it("calls loadReunificacionByUnit WITHOUT a basis argument and returns aggregated envelope", async () => {
    mockLoadReunificacion.mockResolvedValue(aggRows());

    const actor = { role: "govt" as const };
    const jur = [{ province: "Córdoba", locality: "Córdoba" }];
    const since = new Date("2026-06-01T00:00:00.000Z");

    const result = await getLayerFeatures(
      "reunificacion",
      actor,
      jur,
      { since, basis: "transaction" },
      "locality",
    );

    // loadReunificacionByUnit has no bitemporal replay basis — the underlying
    // rollup is period-windowed only, so the call must NOT thread `basis`.
    expect(mockLoadReunificacion).toHaveBeenCalledWith(
      "locality",
      actor,
      jur,
      since,
      undefined,
      undefined,
      undefined,
    );
    expect(result.level).toBe("locality");
    expect(result.features.type).toBe("FeatureCollection");
  });
});

// ---------------------------------------------------------------------------
// Reference layers — discrete pins, unaffected by the aggregation axis.
// ---------------------------------------------------------------------------

describe("getLayerFeatures — refugios (reference layer)", () => {
  it("calls loadShelters (no period, no level) and returns point features", async () => {
    mockLoadShelters.mockResolvedValue({
      rows: [
        {
          id: "org-1",
          publicToken: "SH-001",
          displayName: "Refugio Luna",
          locationLat: "-34.92",
          locationLng: "-57.95",
          verified: true,
        },
      ],
      truncated: false,
    });

    const result = await getLayerFeatures(
      "refugios",
      { role: "govt" },
      [{ province: "Buenos Aires", locality: "La Plata" }],
      { since: new Date("2026-06-01T00:00:00.000Z") },
      // level is ignored by reference layers
      "province",
    );

    expect(mockLoadShelters).toHaveBeenCalledOnce();
    expect(result.truncated).toBe(false);
    expect(result.suppressedCount).toBe(0);
    expect(result.features.features).toHaveLength(1);
    // Reference layers return level="locality" (envelope default — not driven by toggle).
    expect(result.level).toBe("locality");
  });
});

describe("getLayerFeatures — clinicas (reference layer)", () => {
  it("calls loadClinics (not loadShelters) and returns point features", async () => {
    mockLoadClinics.mockResolvedValue({
      rows: [
        {
          id: "org-9",
          publicToken: "CL-009",
          displayName: "Clínica Veterinaria del Sur",
          locationLat: "-34.60",
          locationLng: "-58.38",
          verified: true,
        },
      ],
      truncated: false,
    });

    const result = await getLayerFeatures(
      "clinicas",
      { role: "govt" },
      [{ province: "Buenos Aires", locality: "La Plata" }],
      { since: new Date("2026-06-01T00:00:00.000Z") },
      // level is ignored by reference layers
      "province",
    );

    expect(mockLoadClinics).toHaveBeenCalledOnce();
    // Disjoint loaders — clinicas must NOT reuse the shelter loader.
    expect(mockLoadShelters).not.toHaveBeenCalled();
    expect(result.truncated).toBe(false);
    expect(result.suppressedCount).toBe(0);
    expect(result.features.features).toHaveLength(1);
    expect(result.level).toBe("locality");
  });
});

describe("getLayerFeatures — decomisos (reference layer)", () => {
  it("calls loadDecomisos and returns point features", async () => {
    mockLoadDecomisos.mockResolvedValue({
      rows: [
        {
          id: "case-1",
          publicCode: "DEC-001",
          status: "open",
          centroidLat: "-34.92",
          centroidLng: "-57.95",
          openedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
      truncated: false,
    });

    const result = await getLayerFeatures("decomisos", { role: "admin" }, [], {
      since: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(mockLoadDecomisos).toHaveBeenCalledOnce();
    expect(result.features.features).toHaveLength(1);
    expect(result.level).toBe("locality");
  });
});

// ---------------------------------------------------------------------------
// Choropleth layers — unchanged contract, both levels.
// ---------------------------------------------------------------------------

describe("getLayerFeatures — mortalidad (LOCALITY choropleth)", () => {
  it("delegates to loadChoroplethByLevel at locality level and echoes the envelope", async () => {
    mockLoadChoropleth.mockResolvedValue({
      cells: [
        {
          key: "Buenos Aires|La Plata",
          province: "Buenos Aires",
          locality: "La Plata",
          centroidLat: "-34.92",
          centroidLng: "-57.95",
          value: 12,
          suppressed: false,
        },
        {
          key: "Salta|Cafayate",
          province: "Salta",
          locality: "Cafayate",
          centroidLat: "-26.07",
          centroidLng: "-65.98",
          value: null,
          suppressed: true,
        },
      ],
      suppressedCount: 1,
      truncated: false,
    } as ChoroplethRows);

    // Default level is "locality".
    const result = await getLayerFeatures("mortalidad", { role: "admin" }, [], {
      since: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(mockLoadChoropleth).toHaveBeenCalledWith(
      "mortality",
      "locality",
      { role: "admin" },
      [],
      undefined,
      undefined,
      false,
    );
    expect(result.features.features).toHaveLength(2);
    expect(result.suppressedCount).toBe(1);
    expect(result.level).toBe("locality");
    const suppressed = result.features.features.find(
      (f) => (f.properties as { suppressed?: boolean }).suppressed === true,
    );
    expect((suppressed?.properties as { value: number | null }).value).toBeNull();
  });
});

describe("getLayerFeatures — cobertura (PROVINCE choropleth)", () => {
  it("delegates to loadChoroplethByLevel at province level (filled polygons, ratePct values)", async () => {
    mockLoadChoropleth.mockResolvedValue({
      cells: [
        // value = ratePct (true percentage, not raw count) — the rate-as-count fix.
        { provinceCode: "AR-B", label: "Buenos Aires", value: 61 },
        { provinceCode: "AR-X", label: "Córdoba", value: 9 },
      ],
      truncated: false,
      suppressedCount: 0,
    } as unknown as ChoroplethRows);

    const result = await getLayerFeatures(
      "cobertura",
      { role: "admin" },
      [],
      { since: new Date("2026-06-01T00:00:00.000Z") },
      "province",
    );

    expect(mockLoadChoropleth).toHaveBeenCalledWith(
      "rabies-coverage",
      "province",
      { role: "admin" },
      [],
      undefined,
      undefined,
      false,
    );
    expect(result.level).toBe("province");
    expect(result.features.features).toHaveLength(2);
    expect(result.features.features[0].geometry).toBeNull();
    expect(result.features.features[0].properties).toMatchObject({
      provinceCode: "AR-B",
      value: 61,
      suppressed: false,
    });
    expect(result.suppressedCount).toBe(0);
  });

  // PRE-PUSH REVIEW 2026-07-30 — the province envelope used to hardcode/default
  // `suppressedCount` to 0, so a province map where EVERY cell was k-anon
  // hatched disclosed nothing: AllSuppressedNoticeCard bails on
  // `suppressedCount === 0` and the LayerPanel footer stayed silent. The values
  // were protected; the operator was not told. Province cells ARE suppressible
  // (k protects the DENOMINATOR — see provinceCell), so the count is real data,
  // not a locality-grain-only field.
  it("reports the k-anon count when SOME province cells are suppressed", async () => {
    mockLoadChoropleth.mockResolvedValue({
      cells: [
        { provinceCode: "AR-B", label: "Buenos Aires", value: 61, suppressed: false },
        { provinceCode: "AR-Z", label: "Santa Cruz", value: null, suppressed: true },
      ],
      truncated: false,
      suppressedCount: 1,
    } as unknown as ChoroplethRows);

    const result = await getLayerFeatures(
      "cobertura",
      { role: "admin" },
      [],
      { since: new Date("2026-06-01T00:00:00.000Z") },
      "province",
    );

    expect(result.level).toBe("province");
    expect(result.suppressedCount).toBe(1);
  });

  it("reports EVERY cell when the whole province map is suppressed (the notice trigger)", async () => {
    mockLoadChoropleth.mockResolvedValue({
      cells: [
        { provinceCode: "AR-Z", label: "Santa Cruz", value: null, suppressed: true },
        { provinceCode: "AR-V", label: "Tierra del Fuego", value: null, suppressed: true },
      ],
      truncated: false,
      suppressedCount: 2,
    } as unknown as ChoroplethRows);

    const result = await getLayerFeatures(
      "cobertura",
      { role: "admin" },
      [],
      { since: new Date("2026-06-01T00:00:00.000Z") },
      "province",
    );

    // Every painted feature hatched AND a non-zero count — both halves are what
    // buildAllSuppressedNotice needs to render the card.
    expect(result.features.features.length).toBeGreaterThan(0);
    expect(
      result.features.features.every(
        (f) => (f.properties as { suppressed?: boolean }).suppressed === true,
      ),
    ).toBe(true);
    expect(result.suppressedCount).toBe(2);
  });
});

describe("getLayerFeatures — esterilizacion (North-Star PROVINCE choropleth)", () => {
  it("routes to sterilization-coverage metric (ratePct values, divergent at target 70)", async () => {
    mockLoadChoropleth.mockResolvedValue({
      cells: [
        { provinceCode: "AR-B", label: "Buenos Aires", value: 72 },
        { provinceCode: "AR-X", label: "Córdoba", value: 58 },
      ],
      truncated: false,
    } as unknown as ChoroplethRows);

    const result = await getLayerFeatures(
      "esterilizacion",
      { role: "admin" },
      [],
      { since: new Date("2026-06-01T00:00:00.000Z") },
      "province",
    );

    expect(mockLoadChoropleth).toHaveBeenCalledWith(
      "sterilization-coverage",
      "province",
      { role: "admin" },
      [],
      undefined,
      undefined,
      false,
    );
    expect(result.level).toBe("province");
    expect(result.features.features).toHaveLength(2);
    expect(result.features.features[0].properties).toMatchObject({
      provinceCode: "AR-B",
      value: 72,
    });
  });

  it("routes to sterilization-coverage at locality level (count-density, v1)", async () => {
    mockLoadChoropleth.mockResolvedValue({
      cells: [],
      suppressedCount: 0,
      noLocalityCount: 0,
      truncated: false,
    } as ChoroplethRows);

    const result = await getLayerFeatures(
      "esterilizacion",
      { role: "admin" },
      [],
      { since: new Date("2026-06-01T00:00:00.000Z") },
      "locality",
    );

    expect(mockLoadChoropleth).toHaveBeenCalledWith(
      "sterilization-coverage",
      "locality",
      { role: "admin" },
      [],
      undefined,
      undefined,
      false,
    );
    expect(result.level).toBe("locality");
  });
});

describe("getLayerFeatures — microchip (PROVINCE choropleth, C1)", () => {
  it("routes to microchip-penetration metric (ratePct values)", async () => {
    mockLoadChoropleth.mockResolvedValue({
      cells: [
        { provinceCode: "AR-B", label: "Buenos Aires", value: 61 },
        { provinceCode: "AR-X", label: "Córdoba", value: 40 },
      ],
      truncated: false,
    } as unknown as ChoroplethRows);

    const result = await getLayerFeatures(
      "microchip",
      { role: "admin" },
      [],
      { since: new Date("2026-06-01T00:00:00.000Z") },
      "province",
    );

    expect(mockLoadChoropleth).toHaveBeenCalledWith(
      "microchip-penetration",
      "province",
      { role: "admin" },
      [],
      undefined,
      undefined,
      false,
    );
    expect(result.level).toBe("province");
    expect(result.features.features).toHaveLength(2);
  });

  it("routes to microchip-penetration at locality level (count-density, v1)", async () => {
    mockLoadChoropleth.mockResolvedValue({
      cells: [],
      suppressedCount: 0,
      noLocalityCount: 0,
      truncated: false,
    } as ChoroplethRows);

    const result = await getLayerFeatures(
      "microchip",
      { role: "admin" },
      [],
      { since: new Date("2026-06-01T00:00:00.000Z") },
      "locality",
    );

    expect(mockLoadChoropleth).toHaveBeenCalledWith(
      "microchip-penetration",
      "locality",
      { role: "admin" },
      [],
      undefined,
      undefined,
      false,
    );
    expect(result.level).toBe("locality");
  });
});

describe("getLayerFeatures — ppp (PROVINCE choropleth, C7)", () => {
  it("routes to ppp-compliance metric (ratePct values)", async () => {
    mockLoadChoropleth.mockResolvedValue({
      cells: [{ provinceCode: "AR-B", label: "Buenos Aires", value: 0 }],
      truncated: false,
    } as unknown as ChoroplethRows);

    const result = await getLayerFeatures(
      "ppp",
      { role: "admin" },
      [],
      { since: new Date("2026-06-01T00:00:00.000Z") },
      "province",
    );

    expect(mockLoadChoropleth).toHaveBeenCalledWith(
      "ppp-compliance",
      "province",
      { role: "admin" },
      [],
      undefined,
      undefined,
      false,
    );
    expect(result.level).toBe("province");
    expect(result.features.features).toHaveLength(1);
  });
});

describe("getLayerFeatures — acceso-veterinario (vet-access choropleth)", () => {
  it("routes to the vet-access metric at province level (per-1.000 rate magnitude)", async () => {
    mockLoadChoropleth.mockResolvedValue({
      cells: [
        { provinceCode: "AR-B", label: "Buenos Aires", value: 320 },
        { provinceCode: "AR-C", label: "CABA", value: 540 },
      ],
      truncated: false,
    } as unknown as ChoroplethRows);

    const result = await getLayerFeatures(
      "acceso-veterinario",
      { role: "admin" },
      [],
      { since: new Date("2026-06-01T00:00:00.000Z") },
      "province",
    );

    expect(mockLoadChoropleth).toHaveBeenCalledWith(
      "vet-access",
      "province",
      { role: "admin" },
      [],
      undefined,
      undefined,
      false,
    );
    expect(result.level).toBe("province");
    expect(result.features.features).toHaveLength(2);
    expect(result.features.features[0].properties).toMatchObject({
      provinceCode: "AR-B",
      value: 320,
    });
  });

  it("routes to vet-access at locality level (count-density, v1) and echoes k-anon", async () => {
    mockLoadChoropleth.mockResolvedValue({
      cells: [
        {
          key: "Buenos Aires|La Plata",
          province: "Buenos Aires",
          locality: "La Plata",
          centroidLat: "-34.92",
          centroidLng: "-57.95",
          value: 8,
          suppressed: false,
        },
      ],
      suppressedCount: 3,
      noLocalityCount: 0,
      truncated: false,
    } as ChoroplethRows);

    const result = await getLayerFeatures(
      "acceso-veterinario",
      { role: "admin" },
      [],
      { since: new Date("2026-06-01T00:00:00.000Z") },
      "locality",
    );

    expect(mockLoadChoropleth).toHaveBeenCalledWith(
      "vet-access",
      "locality",
      { role: "admin" },
      [],
      undefined,
      undefined,
      false,
    );
    expect(result.level).toBe("locality");
    expect(result.suppressedCount).toBe(3);
  });
});

describe("getLayerFeatures — antiparasitario (deworming coverage choropleth)", () => {
  it("routes to the deworming metric at province level (ratePct, divergent at 80)", async () => {
    mockLoadChoropleth.mockResolvedValue({
      cells: [
        { provinceCode: "AR-B", label: "Buenos Aires", value: 64 },
        { provinceCode: "AR-X", label: "Córdoba", value: 51 },
      ],
      truncated: false,
    } as unknown as ChoroplethRows);

    const result = await getLayerFeatures(
      "antiparasitario",
      { role: "admin" },
      [],
      { since: new Date("2026-06-01T00:00:00.000Z") },
      "province",
    );

    expect(mockLoadChoropleth).toHaveBeenCalledWith(
      "deworming",
      "province",
      { role: "admin" },
      [],
      undefined,
      undefined,
      false,
    );
    expect(result.level).toBe("province");
    expect(result.features.features).toHaveLength(2);
    expect(result.features.features[0].properties).toMatchObject({
      provinceCode: "AR-B",
      value: 64,
    });
  });

  it("routes to deworming at locality level (count-density, v1)", async () => {
    mockLoadChoropleth.mockResolvedValue({
      cells: [],
      suppressedCount: 0,
      noLocalityCount: 0,
      truncated: false,
    } as ChoroplethRows);

    const result = await getLayerFeatures(
      "antiparasitario",
      { role: "admin" },
      [],
      { since: new Date("2026-06-01T00:00:00.000Z") },
      "locality",
    );

    expect(mockLoadChoropleth).toHaveBeenCalledWith(
      "deworming",
      "locality",
      { role: "admin" },
      [],
      undefined,
      undefined,
      false,
    );
    expect(result.level).toBe("locality");
  });
});

describe("getLayerFeatures — indice-territorial (province-only composite index)", () => {
  it("delegates to loadTerritorialIndexByProvince and returns filled province polygons", async () => {
    mockLoadTerritorialIndex.mockResolvedValue({
      cells: [
        { provinceCode: "AR-B", label: "Buenos Aires", value: 78 },
        { provinceCode: "AR-C", label: "CABA", value: 91 },
      ],
      truncated: false,
      suppressedCount: 0,
    } as ProvinceChoroplethRows);

    const result = await getLayerFeatures("indice-territorial", { role: "admin" }, [], {
      since: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(mockLoadTerritorialIndex).toHaveBeenCalledWith(
      { role: "admin" },
      [],
      undefined,
      undefined,
    );
    expect(mockLoadChoropleth).not.toHaveBeenCalled();
    expect(result.level).toBe("province");
    expect(result.suppressedCount).toBe(0);
    expect(result.features.features).toHaveLength(2);
    expect(result.features.features[0].geometry).toBeNull();
    expect(result.features.features[0].properties).toMatchObject({
      provinceCode: "AR-B",
      value: 78,
      suppressed: false,
    });
  });

  it("ignores the aggregation level — always province-grain (locality returns province cells)", async () => {
    mockLoadTerritorialIndex.mockResolvedValue({
      cells: [{ provinceCode: "AR-X", label: "Córdoba", value: 64 }],
      truncated: false,
      suppressedCount: 0,
    } as ProvinceChoroplethRows);

    const result = await getLayerFeatures(
      "indice-territorial",
      { role: "admin" },
      [],
      { since: new Date("2026-06-01T00:00:00.000Z") },
      "locality",
    );

    // level=locality is ignored — the loader always returns province cells.
    expect(mockLoadTerritorialIndex).toHaveBeenCalledOnce();
    expect(result.level).toBe("province");
    expect(result.features.features).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// task #77 bitemporal — replay basis threading (valid=occurred_at vs
// transaction=recorded_at). The pet_events-backed loaders receive `period.basis`
// as their final argument so the same fixture animates differently in each mode
// (an event with occurred_at ≠ recorded_at moves in transaction-time replay).
// ---------------------------------------------------------------------------

describe("getLayerFeatures — bitemporal replay basis (task #77)", () => {
  const since = new Date("2026-03-01T00:00:00.000Z");
  const asOf = new Date("2026-03-10T00:00:00.000Z");

  it("threads basis='transaction' to loadPerdidasByUnit (recorded_at replay)", async () => {
    mockLoadPerdidas.mockResolvedValue(aggRows());
    await getLayerFeatures(
      "perdidas",
      { role: "admin" },
      [],
      { since, asOf, basis: "transaction" },
      "province",
    );
    expect(mockLoadPerdidas).toHaveBeenCalledWith(
      "province",
      { role: "admin" },
      [],
      since,
      asOf,
      undefined,
      undefined,
      "transaction",
    );
  });

  it("threads basis='transaction' to loadZoonosisByUnit", async () => {
    mockLoadZoonosis.mockResolvedValue(aggRows());
    await getLayerFeatures(
      "zoonosis",
      { role: "admin" },
      [],
      { since, asOf, basis: "transaction" },
      "locality",
    );
    expect(mockLoadZoonosis).toHaveBeenCalledWith(
      "locality",
      { role: "admin" },
      [],
      since,
      asOf,
      undefined,
      undefined,
      "transaction",
    );
  });

  it("threads basis='transaction' to the points-mode loader (loadPerdidasEvents)", async () => {
    mockLoadPerdidasEvents.mockResolvedValue(eventRows());
    await getLayerFeatures(
      "perdidas",
      { role: "govt" },
      [{ province: "Salta", locality: "Salta" }],
      { since, asOf, basis: "transaction" },
      "locality",
      "Salta",
      "Salta",
      /* pointsMode */ true,
    );
    expect(mockLoadPerdidasEvents).toHaveBeenCalledWith(
      { role: "govt" },
      [{ province: "Salta", locality: "Salta" }],
      since,
      asOf,
      "Salta",
      "Salta",
      "transaction",
    );
  });

  it("defaults to valid-time (final arg undefined) when basis is not set", async () => {
    mockLoadMordeduras.mockResolvedValue(aggRows());
    await getLayerFeatures("mordeduras", { role: "admin" }, [], { since, asOf }, "province");
    // Final arg is undefined → the loader's own default ("valid") applies.
    const call = mockLoadMordeduras.mock.calls[0];
    expect(call[call.length - 1]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Per-cápita census enrichment (panorama-percapita v1 — province grain)
// ---------------------------------------------------------------------------

describe("getLayerFeatures — per-cápita census enrichment (province grain)", () => {
  const since = new Date("2026-06-01T00:00:00.000Z");
  const lookup = {
    populations: { "Buenos Aires": 120_000 },
    year: 2022,
    source: "INDEC Censo 2022",
  };

  it("enriches an ELIGIBLE layer's province cells with population/per10k/census meta", async () => {
    mockLoadPerdidas.mockResolvedValue(aggRows());
    mockLoadCensusLookup.mockResolvedValue(lookup);

    const result = await getLayerFeatures("perdidas", { role: "admin" }, [], { since }, "province");

    expect(mockLoadCensusLookup).toHaveBeenCalledOnce();
    const props = result.features.features[0].properties as Record<string, unknown>;
    // count 12 over 120.000 inhabitants → 1 per 10.000.
    expect(props.count).toBe(12);
    expect(props.population).toBe(120_000);
    expect(props.per10k).toBe(1);
    expect(props.censusYear).toBe(2022);
    expect(props.censusSource).toBe("INDEC Censo 2022");
  });

  it("does NOT enrich at locality level (no department/locality denominator in v1)", async () => {
    mockLoadPerdidas.mockResolvedValue(aggRows());
    mockLoadCensusLookup.mockResolvedValue(lookup);

    const result = await getLayerFeatures("perdidas", { role: "admin" }, [], { since }, "locality");

    expect(mockLoadCensusLookup).not.toHaveBeenCalled();
    const props = result.features.features[0].properties as Record<string, unknown>;
    expect(props.per10k).toBeUndefined();
  });

  it("does NOT enrich an ineligible layer (zoonosis — department grain, no denominator)", async () => {
    mockLoadZoonosis.mockResolvedValue(aggRows());
    mockLoadCensusLookup.mockResolvedValue(lookup);

    const result = await getLayerFeatures("zoonosis", { role: "admin" }, [], { since }, "province");

    expect(mockLoadCensusLookup).not.toHaveBeenCalled();
    const props = result.features.features[0].properties as Record<string, unknown>;
    expect(props.per10k).toBeUndefined();
  });

  it("serves the layer UNENRICHED when the census lookup is unavailable (never fails the fetch)", async () => {
    mockLoadPerdidas.mockResolvedValue(aggRows());
    mockLoadCensusLookup.mockResolvedValue(null);

    const result = await getLayerFeatures("perdidas", { role: "admin" }, [], { since }, "province");

    // The layer still renders (count encoding); per-cápita simply has no data.
    expect(result.features.features).toHaveLength(1);
    const props = result.features.features[0].properties as Record<string, unknown>;
    expect(props.count).toBe(12);
    expect(props.per10k).toBeUndefined();
  });

  it("does NOT enrich a points-mode result (real dots carry no per-unit counts)", async () => {
    mockLoadBiteEvents.mockResolvedValue({
      rows: [
        {
          id: "e1",
          locationLat: "-34.6",
          locationLng: "-58.4",
          incidentType: "bite_inflicted",
          severity: null,
          occurredAt: "2026-06-10T00:00:00.000Z",
        },
      ],
      truncated: false,
      noCoordCount: 0,
    });
    mockLoadCensusLookup.mockResolvedValue(lookup);

    const result = await getLayerFeatures(
      "mordeduras",
      { role: "govt" },
      [{ province: "Salta", locality: "Salta" }],
      { since },
      "province",
      undefined,
      undefined,
      true,
    );

    expect(result.mode).toBe("points");
    expect(mockLoadCensusLookup).not.toHaveBeenCalled();
  });
});
