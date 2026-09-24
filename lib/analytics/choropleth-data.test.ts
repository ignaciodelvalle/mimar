// Pure unit tests for the shared province-choropleth data shaping (task #31c
// dedup). One describe block per extracted function, each covering the two
// call sites it replaces.

import { describe, expect, it } from "vitest";
import {
  aggregateChoroplethData,
  scopedChoroplethProps,
  sinUbicacionNote,
  toChoroplethData,
} from "./choropleth-data";
import { PROVINCE_ISO_MAP } from "./govt-dashboards";
import type { SubregionCaseCount } from "./subregion-redaction";

describe("toChoroplethData", () => {
  it("maps one row per province like /gob/poblacion (ratePct value)", () => {
    const byProvince = [
      { province: "Buenos Aires", ratePct: 62, sterilized: 100 },
      { province: "Córdoba", ratePct: 48, sterilized: 40 },
    ];

    expect(toChoroplethData(byProvince, (r) => r.ratePct)).toEqual([
      { code: "AR-B", value: 62, label: "Buenos Aires" },
      { code: "AR-X", value: 48, label: "Córdoba" },
    ]);
  });

  it("maps one row per province like /gob/censo (count value)", () => {
    const provinceRows = [
      { province: "Santa Fe", count: 12 },
      { province: "Mendoza", count: 5 },
    ];

    expect(toChoroplethData(provinceRows, (r) => r.count)).toEqual([
      { code: "AR-S", value: 12, label: "Santa Fe" },
      { code: "AR-M", value: 5, label: "Mendoza" },
    ]);
  });

  it("falls back to the raw province name as the code when unmapped — row is never dropped", () => {
    const rows = [{ province: "Atlántida", count: 3 }];

    expect(toChoroplethData(rows, (r) => r.count)).toEqual([
      { code: "Atlántida", value: 3, label: "Atlántida" },
    ]);
  });

  it("returns an empty array for an empty input", () => {
    expect(toChoroplethData([], (r: { province: string; count: number }) => r.count)).toEqual([]);
  });

  it("a NULL value marks the cell suppressed and STILL emits it (k-anon, #40c)", () => {
    // The fetchers hand back `count: number | null` so a withheld cell survives
    // the mapping. Dropping it would stipple the province "sin datos" — false,
    // and a tell that this province is different from its neighbours.
    const rows: { province: string; count: number | null }[] = [
      { province: "Santa Fe", count: 12 },
      { province: "Tierra del Fuego", count: null },
    ];

    expect(toChoroplethData(rows, (r) => r.count)).toEqual([
      { code: "AR-S", value: 12, label: "Santa Fe" },
      { code: "AR-V", value: 0, suppressed: true, label: "Tierra del Fuego" },
    ]);
  });

  it("a suppressed cell's value is a placeholder the renderer never reads", () => {
    // MapChoropleth branches on `suppressed` before every path that could paint
    // a number, so 0 here is inert — but it must never be reported as data.
    const [cell] = toChoroplethData([{ province: "Santa Cruz", count: null }], (r) => r.count);
    expect(cell.suppressed).toBe(true);
  });
});

describe("aggregateChoroplethData", () => {
  it("counts occurrences per resolved province like /gob/perdidas (aggregateLostByProvince)", () => {
    // Every province is at/above the k floor so this test measures the FOLD,
    // not the k-anon rule (which has its own block below).
    const lostPets = [
      ...Array.from({ length: 6 }, () => ({ province: "Buenos Aires" as string | null })),
      ...Array.from({ length: 5 }, () => ({ province: "Córdoba" as string | null })),
      { province: null }, // dropped: no province
      { province: "Atlántida" }, // dropped: not in PROVINCE_ISO_MAP
    ];

    const result = aggregateChoroplethData(
      lostPets,
      (p) => (p.province ? PROVINCE_ISO_MAP[p.province] : undefined),
      () => 1,
    );

    expect(result).toEqual([
      { code: "AR-B", value: 6, label: "Buenos Aires" },
      { code: "AR-X", value: 5, label: "Córdoba" },
    ]);
  });

  it("sums an already-resolved code field like /gob/vigilancia (provinceChoroplethData)", () => {
    const mapData = [
      { code: "AR-B", count: 3 },
      { code: "AR-B", count: 4 },
      { code: "AR-X", count: 5 },
      { code: "", count: 9 }, // dropped: falsy code
    ];

    const result = aggregateChoroplethData(
      mapData,
      (row) => row.code,
      (row) => row.count,
    );

    expect(result).toEqual([
      { code: "AR-B", value: 7, label: "Buenos Aires" },
      { code: "AR-X", value: 5, label: "Córdoba" },
    ]);
  });

  it("EVERY cell is labelled with its province name, never its count (demo review 2026-08-01 #2)", () => {
    // THE FINDING: `label` is the one field a choropleth cell has for saying
    // WHERE, and MapChoropleth spends it on the popup's place line and on the
    // "Región" column of the "Ver datos" a11y table — the only way to read
    // exact values off a WebGL canvas, and the whole path for an operator who
    // cannot see the map. This fold used to fill it with the caller's
    // `labelFor(value)`, so /gob/vigilancia nacional listed 24 rows reading
    // "18 casos abiertos", "78 casos abiertos", "32 casos abiertos" — with no
    // province named anywhere, "which province has 78?" was unanswerable.
    const rows = [
      { code: "AR-B", count: 78 },
      { code: "AR-X", count: 32 },
      { code: "AR-S", count: 18 },
      { code: "AR-V", count: 1 }, // suppressed — already named, must stay named
    ];

    const result = aggregateChoroplethData(
      rows,
      (r) => r.code,
      (r) => r.count,
    );

    expect(result.map((c) => c.label)).toEqual([
      "Buenos Aires",
      "Córdoba",
      "Santa Fe",
      "Tierra del Fuego",
    ]);
    // Not one label anywhere may carry a digit: a place name has none, and a
    // count in this field is either a redundant restatement (visible cell) or
    // a disclosure (suppressed cell).
    for (const cell of result) expect(cell.label).not.toMatch(/\d/);
  });

  it("an unmapped code falls back to the code itself, never to a count", () => {
    const result = aggregateChoroplethData(
      [{ code: "AR-ZZ", count: 40 }],
      (r) => r.code,
      (r) => r.count,
    );

    expect(result).toEqual([{ code: "AR-ZZ", value: 40, label: "AR-ZZ" }]);
  });

  it("returns an empty array when every row is dropped", () => {
    const rows = [{ code: null }, { code: undefined }, { code: "" }];

    const result = aggregateChoroplethData(
      rows,
      (r) => r.code,
      () => 1,
    );

    expect(result).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // RA-3 C5 — the province tier is k-anonymised inside the shared fold.
  // -------------------------------------------------------------------------

  it("k-anon: a sub-k province paints a hatch, not a polygon with a number", () => {
    // THE finding: one open case used to render a coloured province, a
    // "1 caso abierto" tooltip and a bare 1 in the "Ver datos" a11y table.
    const rows = [
      { code: "AR-B", count: 30 },
      { code: "AR-S", count: 20 },
      { code: "AR-V", count: 1 },
    ];

    const result = aggregateChoroplethData(
      rows,
      (r) => r.code,
      (r) => r.count,
    );
    const tdf = result.find((c) => c.code === "AR-V");

    expect(tdf?.suppressed).toBe(true);
    // The LABEL is the disclosure channel nobody looks at: MapChoropleth renders
    // it as the popup's place line. This fold used to spell the count out there
    // via `labelFor(value)`; now every cell carries its province NAME, so the
    // suppressed one no longer needs (or has) a special case to stay silent.
    expect(tdf?.label).toBe("Tierra del Fuego");
    expect(tdf?.label).not.toMatch(/\d/);
  });

  it("k-anon: the cell is EMITTED, never dropped — absence would be the tell", () => {
    const rows = [
      { code: "AR-B", count: 30 },
      { code: "AR-S", count: 20 },
      { code: "AR-V", count: 2 },
    ];

    const result = aggregateChoroplethData(
      rows,
      (r) => r.code,
      (r) => r.count,
    );

    // A province that vanishes at k gets stippled "sin datos" by the map — false,
    // and it makes absence the disclosure channel.
    expect(result.map((c) => c.code).sort()).toEqual(["AR-B", "AR-S", "AR-V"]);
  });

  it("k-anon: a lone suppressed province also suppresses its smallest sibling (differencing)", () => {
    // /gob/perdidas publishes the scope total in the list header and in the
    // map's scopeAggregate notice, so ONE hidden province is recoverable by
    // `total − Σ(visible)`. complementarySuppress (national group) closes it.
    const rows = [
      { code: "AR-B", count: 30 },
      { code: "AR-S", count: 20 },
      { code: "AR-V", count: 1 },
    ];

    const result = aggregateChoroplethData(
      rows,
      (r) => r.code,
      (r) => r.count,
    );
    const suppressed = result.filter((c) => c.suppressed).map((c) => c.code);

    // AR-V primary + AR-S (smallest visible sibling) complementary.
    expect(suppressed.sort()).toEqual(["AR-S", "AR-V"]);
    expect(result.find((c) => c.code === "AR-B")?.suppressed).toBeUndefined();
  });

  it("k-anon: a province exactly AT k is published (k is a floor, not a ceiling)", () => {
    const rows = [
      { code: "AR-B", count: 30 },
      { code: "AR-X", count: 5 },
    ];

    const result = aggregateChoroplethData(
      rows,
      (r) => r.code,
      (r) => r.count,
    );

    expect(result).toEqual([
      { code: "AR-B", value: 30, label: "Buenos Aires" },
      { code: "AR-X", value: 5, label: "Córdoba" },
    ]);
  });

  it("k-anon: a suppressed cell's value is an inert 0 placeholder, never reported as data", () => {
    const rows = [{ code: "AR-C", count: 1 }];

    const [cell] = aggregateChoroplethData(
      rows,
      (r) => r.code,
      (r) => r.count,
    );

    expect(cell.suppressed).toBe(true);
    expect(cell.value).toBe(0);
    expect(cell.label).toBe("CABA");
  });
});

describe("scopedChoroplethProps", () => {
  const provinceCells = [
    { code: "AR-B", value: 5, label: "Buenos Aires" },
    { code: "AR-X", value: 2, label: "Córdoba" },
  ];

  it("stays at province grain when no province is selected", () => {
    expect(scopedChoroplethProps(provinceCells, null, null)).toEqual({
      level: "province",
      data: provinceCells,
    });
  });

  it("stays at province grain when subregionCells hasn't been fetched yet, even with a selection", () => {
    expect(scopedChoroplethProps(provinceCells, "AR-B", null)).toEqual({
      level: "province",
      data: provinceCells,
    });
  });

  it("drills to department grain for a non-CABA province, dropping zero-count non-suppressed cells", () => {
    const subregionCells: SubregionCaseCount[] = [
      { code: "06007", name: "Adolfo Alsina", count: 7 },
      { code: "06014", name: "Adolfo Gonzales Chaves", count: 0 },
      { code: "06021", name: "Alberti", count: 0, suppressed: true },
    ];

    const result = scopedChoroplethProps(provinceCells, "AR-B", subregionCells);

    expect(result.level).toBe("department");
    expect(result.geojsonUrl).toBe("/geo/ar-departments.geojson");
    // visibleCodes carries the FULL sub-region set (zooms + filters the geojson).
    expect(result.visibleCodes).toEqual(["06007", "06014", "06021"]);
    // data drops the honest zero (Adolfo Gonzales Chaves) but keeps the
    // suppressed cell — count redacted to 0, never a raw 1..4 number.
    expect(result.data).toEqual([
      { code: "06007", value: 7, label: "Adolfo Alsina" },
      { code: "06021", value: 0, suppressed: true, label: "Alberti" },
    ]);
  });

  it("drills to barrio grain for CABA (AR-C)", () => {
    const subregionCells: SubregionCaseCount[] = [{ code: "palermo", name: "Palermo", count: 8 }];

    const result = scopedChoroplethProps(provinceCells, "AR-C", subregionCells);

    expect(result.level).toBe("barrio");
    expect(result.geojsonUrl).toBe("/geo/caba-barrios.geojson");
    expect(result.data).toEqual([{ code: "palermo", value: 8, label: "Palermo" }]);
  });
});

describe("sinUbicacionNote (L1·1 — the drill's residual under the map)", () => {
  const casos = { singular: "caso", plural: "casos" };

  it("says how many rows the map could not place", () => {
    expect(sinUbicacionNote({ count: 12, suppressed: false }, casos)).toBe(
      "12 casos sin ubicar: no tienen una localidad del catálogo y no aparecen en el mapa.",
    );
  });

  it("uses the singular for one", () => {
    expect(sinUbicacionNote({ count: 1, suppressed: false }, casos)).toMatch(/^1 caso sin ubicar/);
  });

  it("confesses a suppressed residual WITHOUT a number", () => {
    const note = sinUbicacionNote({ count: 0, suppressed: true }, casos);
    expect(note).toBe(
      "Hay casos sin ubicar que no aparecen en el mapa (cantidad protegida por privacidad).",
    );
    expect(note).not.toMatch(/\d/);
  });

  it("says nothing when there is nothing to say", () => {
    expect(sinUbicacionNote({ count: 0, suppressed: false }, casos)).toBeNull();
    expect(sinUbicacionNote(null, casos)).toBeNull();
    expect(sinUbicacionNote(undefined, casos)).toBeNull();
  });
});
