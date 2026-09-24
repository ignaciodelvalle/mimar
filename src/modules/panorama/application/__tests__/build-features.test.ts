// Unit tests for the pure feature transforms (no DB) — one per layer.

import { describe, expect, it } from "vitest";

import {
  type BiteRow,
  type ChoroplethCell,
  type DecomisoRow,
  type DenunciaCentroidRow,
  type LostPointRow,
  type OutbreakRow,
  PROVINCE_K,
  type ProvinceChoroplethCell,
  type ShelterRow,
  buildChoroplethFeatures,
  buildDecomisosFeatures,
  buildDenunciasFeatures,
  buildMordedurasFeatures,
  buildPerdidasFeatures,
  buildProvinceChoroplethFeatures,
  buildRefugiosFeatures,
  buildZoonosisFeatures,
  provinceCell,
  provinceCellPreDecided,
} from "../build-features";

const row = (over: Partial<LostPointRow> = {}): LostPointRow => ({
  publicToken: "DIM-AAAA-1111",
  name: "Firulai",
  species: "dog",
  status: "lost",
  locationLat: "-34.6037000",
  locationLng: "-58.3816000",
  lastSeenAt: "2026-06-19T12:00:00.000Z",
  locationSource: null,
  ...over,
});

describe("buildPerdidasFeatures", () => {
  it("wraps rows into a typed FeatureCollection with [lng, lat] points", () => {
    const fc = buildPerdidasFeatures([row()]);
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry?.coordinates).toEqual([-58.3816, -34.6037]);
  });

  it("carries the public properties (token/name/species/status/lastSeenAt/locationSource)", () => {
    const fc = buildPerdidasFeatures([
      row({ publicToken: "DIM-BBBB-2222", name: "Mishi", locationSource: "pin_manual" }),
    ]);
    expect(fc.features[0].properties).toEqual({
      token: "DIM-BBBB-2222",
      name: "Mishi",
      species: "dog",
      status: "lost",
      lastSeenAt: "2026-06-19T12:00:00.000Z",
      locationSource: "pin_manual",
    });
  });

  it("drops non-located rows (missing coordinate pair) from the point layer", () => {
    const fc = buildPerdidasFeatures([
      row({ publicToken: "ok" }),
      row({ publicToken: "no-lat", locationLat: null }),
      row({ publicToken: "no-lng", locationLng: null }),
    ]);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties.token).toBe("ok");
  });

  it("returns an empty collection for no rows", () => {
    expect(buildPerdidasFeatures([])).toEqual({ type: "FeatureCollection", features: [] });
  });
});

// --- mordeduras --------------------------------------------------------------

describe("buildMordedurasFeatures", () => {
  const biteRow = (over: Partial<BiteRow> = {}): BiteRow => ({
    id: "evt-1",
    locationLat: "-34.6",
    locationLng: "-58.4",
    incidentType: "bite_inflicted",
    severity: "moderate",
    occurredAt: "2026-06-10T00:00:00.000Z",
    ...over,
  });

  it("emits [lng,lat] points carrying incidentType/severity", () => {
    const fc = buildMordedurasFeatures([biteRow()]);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry?.coordinates).toEqual([-58.4, -34.6]);
    expect(fc.features[0].properties).toMatchObject({
      incidentType: "bite_inflicted",
      severity: "moderate",
    });
  });

  it("drops non-located bite rows", () => {
    const fc = buildMordedurasFeatures([biteRow({ locationLat: null })]);
    expect(fc.features).toHaveLength(0);
  });
});

// --- denuncias (coarse centroid) --------------------------------------------

describe("buildDenunciasFeatures", () => {
  const denRow = (over: Partial<DenunciaCentroidRow> = {}): DenunciaCentroidRow => ({
    centroidLat: "-31.4",
    centroidLng: "-64.2",
    province: "Córdoba",
    locality: "Córdoba",
    severity: "high",
    kind: "abandono",
    createdAt: "2026-06-01T00:00:00.000Z",
    ...over,
  });

  it("plots the locality centroid and flags the feature as coarse (no exact coord)", () => {
    const fc = buildDenunciasFeatures([denRow()]);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry?.coordinates).toEqual([-64.2, -31.4]);
    // The coarse marker MUST be set; the props carry no exact lat/lng field.
    expect(fc.features[0].properties.coarse).toBe(true);
    expect(fc.features[0].properties).not.toHaveProperty("locationLat");
    expect(fc.features[0].properties).not.toHaveProperty("centroidLat");
  });

  it("drops reports whose locality has no resolvable centroid", () => {
    const fc = buildDenunciasFeatures([denRow({ centroidLat: null, centroidLng: null })]);
    expect(fc.features).toHaveLength(0);
  });
});

// --- zoonosis ----------------------------------------------------------------

describe("buildZoonosisFeatures", () => {
  it("emits located outbreak signals with disease metadata", () => {
    const row: OutbreakRow = {
      id: "sig-1",
      locationLat: "-24.8",
      locationLng: "-65.4",
      diseaseCode: "rabia",
      diseaseLabel: "Rabia",
      occurredAt: "2026-06-05T00:00:00.000Z",
    };
    const fc = buildZoonosisFeatures([row]);
    expect(fc.features[0].geometry?.coordinates).toEqual([-65.4, -24.8]);
    expect(fc.features[0].properties.diseaseCode).toBe("rabia");
  });
});

// --- refugios ----------------------------------------------------------------

describe("buildRefugiosFeatures", () => {
  it("emits shelter points with token/name/verified, dropping non-located", () => {
    const rows: ShelterRow[] = [
      {
        id: "o1",
        publicToken: "ORG-1",
        displayName: "Refugio Norte",
        locationLat: "-34.5",
        locationLng: "-58.5",
        verified: true,
      },
      {
        id: "o2",
        publicToken: "ORG-2",
        displayName: "Sin ubicación",
        locationLat: null,
        locationLng: null,
        verified: false,
      },
    ];
    const fc = buildRefugiosFeatures(rows);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties).toEqual({
      token: "ORG-1",
      name: "Refugio Norte",
      verified: true,
    });
  });
});

// --- decomisos ---------------------------------------------------------------

describe("buildDecomisosFeatures", () => {
  it("emits case points with code/status", () => {
    const row: DecomisoRow = {
      id: "c1",
      publicCode: "CASE-9",
      status: "open",
      centroidLat: "-32.9",
      centroidLng: "-60.7",
      openedAt: "2026-06-02T00:00:00.000Z",
    };
    const fc = buildDecomisosFeatures([row]);
    expect(fc.features[0].properties).toMatchObject({
      code: "CASE-9",
      status: "open",
      coarse: true,
    });
  });
});

// --- choropleth (graduated symbol, suppressed handling) ---------------------

describe("buildChoroplethFeatures", () => {
  const cell = (over: Partial<ChoroplethCell> = {}): ChoroplethCell => ({
    key: "Buenos Aires|La Plata",
    province: "Buenos Aires",
    locality: "La Plata",
    centroidLat: "-34.92",
    centroidLng: "-57.95",
    departmentCode: "06441",
    departmentName: "La Plata",
    value: 12,
    suppressed: false,
    ...over,
  });

  it("plots visible cells carrying the real value + department roll-up key", () => {
    const fc = buildChoroplethFeatures([cell()]);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry?.coordinates).toEqual([-57.95, -34.92]);
    expect(fc.features[0].properties).toEqual({
      province: "Buenos Aires",
      locality: "La Plata",
      departmentCode: "06441",
      departmentName: "La Plata",
      value: 12,
      suppressed: false,
    });
  });

  it("renders suppressed cells with value=null (the real count never leaks) but keeps the department key", () => {
    const fc = buildChoroplethFeatures([
      cell({
        key: "Salta|Cafayate",
        departmentCode: "66028",
        departmentName: "Cafayate",
        value: 3,
        suppressed: true,
      }),
    ]);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties.suppressed).toBe(true);
    expect(fc.features[0].properties.value).toBeNull();
    // The department code survives so the map can still outline the departamento.
    expect(fc.features[0].properties.departmentCode).toBe("66028");
  });

  it("passes a null department code through for a cell with no ar_localities match", () => {
    const fc = buildChoroplethFeatures([cell({ departmentCode: null, departmentName: null })]);
    expect(fc.features[0].properties.departmentCode).toBeNull();
  });

  it("drops cells with no resolvable centroid", () => {
    const fc = buildChoroplethFeatures([cell({ centroidLat: null, centroidLng: null })]);
    expect(fc.features).toHaveLength(0);
  });
});

// --- province choropleth (U5: filled polygons, no geometry/centroid) --------

describe("buildProvinceChoroplethFeatures", () => {
  const pCell = (over: Partial<ProvinceChoroplethCell> = {}): ProvinceChoroplethCell => ({
    provinceCode: "AR-B",
    label: "Buenos Aires",
    value: 61,
    suppressed: false,
    ...over,
  });

  it("emits ONE null-geometry feature per province (the polygon comes from the basemap)", () => {
    const fc = buildProvinceChoroplethFeatures([pCell()]);
    expect(fc.features).toHaveLength(1);
    // No point geometry — the map data-joins this to the ar-provinces polygon.
    expect(fc.features[0].geometry).toBeNull();
    expect(fc.features[0].properties).toEqual({
      provinceCode: "AR-B",
      province: "Buenos Aires",
      value: 61,
      suppressed: false,
    });
  });

  // ⚠️ THIS TEST USED TO PIN THE DEFECT. It read:
  //     it("carries the value verbatim — province cells are NEVER suppressed
  //         (no k-anon)", ...) → expect(value).toBe(2)
  // i.e. it asserted that a province cell publishes a raw sub-k count, and it
  // was GREEN for exactly as long as the leak existed. The premise it encoded —
  // "provinces are large" — is about a province's POPULATION, while k-anonymity
  // is about its DENOMINATOR, and on a rate layer those are different numbers.
  // Any test that ratifies a small published count is now the prime suspect.
  it("publishes a suppressed cell as null — never the raw value, never a zero", () => {
    const fc = buildProvinceChoroplethFeatures([
      pCell({ provinceCode: "AR-V", value: 2, suppressed: true }),
    ]);
    expect(fc.features[0].properties.value).toBeNull();
    expect(fc.features[0].properties.suppressed).toBe(true);
  });

  it("EMITS the suppressed cell rather than dropping it (absence is a disclosure channel)", () => {
    // A cell that vanishes when it crosses k tells the reader it crossed k, and
    // the map then stipples the province as "sin datos" — false AND a tell.
    const fc = buildProvinceChoroplethFeatures([
      pCell({ provinceCode: "AR-V", value: null, suppressed: true }),
      pCell({ provinceCode: "AR-B", value: 61 }),
    ]);
    expect(fc.features).toHaveLength(2);
    expect(fc.features.map((f) => f.properties.provinceCode)).toEqual(["AR-V", "AR-B"]);
  });

  it("nulls the value even if a caller hand-built the cell with a stale value + the flag", () => {
    const fc = buildProvinceChoroplethFeatures([
      pCell({ provinceCode: "AR-V", value: 2, suppressed: true }),
    ]);
    expect(fc.features[0].properties.value).not.toBe(2);
  });

  it("drops cells with an unmappable (empty) province code", () => {
    const fc = buildProvinceChoroplethFeatures([pCell({ provinceCode: "" })]);
    expect(fc.features).toHaveLength(0);
  });

  it("never emits `suppressed: undefined` — the flag survives JSON serialization", () => {
    // A JS caller (a test mock, a cube row read back) can hand over a cell with
    // no flag. `undefined` is DROPPED by JSON.stringify, so the property would
    // vanish from the serialized feature and a reader could not tell the layer
    // even HAS a suppression dimension. It must always be a boolean.
    const loose = { provinceCode: "AR-B", label: "Buenos Aires", value: 61 };
    const fc = buildProvinceChoroplethFeatures([loose as ProvinceChoroplethCell]);
    expect(fc.features[0].properties.suppressed).toBe(false);
    expect(JSON.parse(JSON.stringify(fc.features[0].properties))).toHaveProperty(
      "suppressed",
      false,
    );
  });
});

// --- province k-anon: the provinceCell helper (#40) --------------------------

describe("provinceCell — k-anon on the DENOMINATOR, not the value", () => {
  it("suppresses a cell whose denominator is below k, even when the VALUE is large", () => {
    // The trap, verbatim: Santa Cruz publishing 100% coverage over 11 dogs. Here
    // 100% over 3 dogs — a threshold read off `value` sees 100 and publishes.
    const cell = provinceCell("AR-Z", "Santa Cruz", 100, 3);
    expect(cell.suppressed).toBe(true);
    expect(cell.value).toBeNull();
  });

  it("does NOT suppress at exactly k (the boundary is >= k, not > k)", () => {
    const cell = provinceCell("AR-Z", "Santa Cruz", 100, PROVINCE_K);
    expect(PROVINCE_K).toBe(5);
    expect(cell.suppressed).toBe(false);
    expect(cell.value).toBe(100);
  });

  it("suppresses at k-1 — the other side of the same boundary", () => {
    expect(provinceCell("AR-Z", "Santa Cruz", 100, PROVINCE_K - 1).suppressed).toBe(true);
  });

  it("a suppressed cell publishes null — never a zero", () => {
    const cell = provinceCell("AR-Z", "Santa Cruz", 42, 1);
    expect(cell.value).toBeNull();
    expect(cell.value).not.toBe(0);
  });

  it("does NOT suppress a denominator of exactly 0 — an empty group protects nobody", () => {
    // Labelling this "protegido por privacidad" would dress a genuine data gap
    // as a deliberate withholding. Same zero nuance as suppressDelta.
    expect(provinceCell("AR-Z", "Santa Cruz", 0, 0).suppressed).toBe(false);
  });

  it("keeps the code and label on a suppressed cell — only the VALUE is withheld", () => {
    const cell = provinceCell("AR-Z", "Santa Cruz", 100, 2);
    expect(cell.provinceCode).toBe("AR-Z");
    expect(cell.label).toBe("Santa Cruz");
  });
});

describe("provinceCellPreDecided — upstream-decided suppression", () => {
  it("emits a present-but-suppressed cell (the tendencia case)", () => {
    const cell = provinceCellPreDecided("AR-Z", "Santa Cruz", null, true);
    expect(cell).toEqual({
      provinceCode: "AR-Z",
      label: "Santa Cruz",
      value: null,
      suppressed: true,
    });
  });

  it("nulls a value handed in alongside a true flag", () => {
    expect(provinceCellPreDecided("AR-Z", "Santa Cruz", 7, true).value).toBeNull();
  });

  it("passes an unsuppressed value through untouched", () => {
    expect(provinceCellPreDecided("AR-Z", "Santa Cruz", 7, false).value).toBe(7);
  });
});
