// Unit tests for the ZOOM-DRIVEN admin-division activation (PO directive
// 2026-07-07: "a partir de cierto punto SIEMPRE mostrar las localidades").
//
// Pure — the viewport→province resolution is extracted into situational-map-utils
// so it is testable WITHOUT a maplibre runtime (unavailable in Vitest), mirroring
// division-fill.test.ts. The component wiring (debounced moveend → syncDivisions →
// source rebuild) is a thin apply step over these helpers.

import { describe, expect, it } from "vitest";

import {
  type Bbox,
  type ProvinceBbox,
  Z_DIVISIONS,
  bboxesIntersect,
  computeProvinceBboxes,
  resolveDataLevel,
  resolveDivisionProvinces,
} from "../situational-map-utils";

// Synthetic province bboxes: two adjacent mainland provinces + a tiny CABA-like
// province far away, so viewport intersection is unambiguous.
const P1: ProvinceBbox = {
  code: "AR-1",
  bbox: [
    [0, 0],
    [2, 2],
  ],
};
const P2: ProvinceBbox = {
  code: "AR-2",
  bbox: [
    [3, 0],
    [5, 2],
  ],
};
const CABA: ProvinceBbox = {
  code: "AR-C",
  bbox: [
    [10, 10],
    [10.2, 10.2],
  ],
};
const PROVINCES = [P1, P2, CABA];

describe("bboxesIntersect", () => {
  it("detects overlap and disjointness", () => {
    expect(
      bboxesIntersect(
        [
          [0, 0],
          [1, 1],
        ],
        [
          [0.5, 0.5],
          [2, 2],
        ],
      ),
    ).toBe(true);
    expect(
      bboxesIntersect(
        [
          [0, 0],
          [1, 1],
        ],
        [
          [3, 3],
          [4, 4],
        ],
      ),
    ).toBe(false);
  });
  it("treats touching edges as intersecting (harmless false positives are fine)", () => {
    expect(
      bboxesIntersect(
        [
          [0, 0],
          [1, 1],
        ],
        [
          [1, 1],
          [2, 2],
        ],
      ),
    ).toBe(true);
  });
});

describe("computeProvinceBboxes", () => {
  it("derives a bbox per province from Polygon/MultiPolygon geometry", () => {
    const boxes = computeProvinceBboxes([
      {
        properties: { code: "AR-X", name: "Córdoba" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [-64, -33],
              [-62, -33],
              [-62, -31],
              [-64, -31],
              [-64, -33],
            ],
          ],
        },
      },
      // Skipped: no usable geometry.
      { properties: { code: "AR-Z", name: "Santa Cruz" }, geometry: null },
    ]);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].code).toBe("AR-X");
    expect(boxes[0].bbox).toEqual([
      [-64, -33],
      [-62, -31],
    ]);
  });
});

describe("resolveDivisionProvinces", () => {
  it("below the threshold with no selection → [] (clean national provinces view)", () => {
    const view: Bbox = [
      [0, 0],
      [1, 1],
    ];
    expect(
      resolveDivisionProvinces({
        selectedProvince: null,
        zoom: Z_DIVISIONS - 0.5,
        cameraBbox: view,
        provinceBboxes: PROVINCES,
      }),
    ).toEqual([]);
  });

  it("at/above the threshold → every province whose bbox is in view (multi-province departments)", () => {
    const view: Bbox = [
      [0, 0],
      [6, 6],
    ]; // spans P1 + P2, not CABA
    expect(
      resolveDivisionProvinces({
        selectedProvince: null,
        zoom: Z_DIVISIONS,
        cameraBbox: view,
        provinceBboxes: PROVINCES,
      }),
    ).toEqual(["AR-1", "AR-2"]);
  });

  it("crossing the threshold with CABA in view → CABA is activated (→ its barrios)", () => {
    const view: Bbox = [
      [9, 9],
      [11, 11],
    ]; // only CABA
    expect(
      resolveDivisionProvinces({
        selectedProvince: null,
        zoom: 8,
        cameraBbox: view,
        provinceBboxes: PROVINCES,
      }),
    ).toEqual(["AR-C"]);
  });

  it("an explicit selection WINS at any zoom, even below the threshold or with no camera", () => {
    expect(
      resolveDivisionProvinces({
        selectedProvince: "AR-2",
        zoom: 3,
        cameraBbox: null,
        provinceBboxes: PROVINCES,
      }),
    ).toEqual(["AR-2"]);
  });

  it("honors a custom threshold", () => {
    const view: Bbox = [
      [0, 0],
      [1, 1],
    ];
    const base = { selectedProvince: null, cameraBbox: view, provinceBboxes: PROVINCES };
    expect(resolveDivisionProvinces({ ...base, zoom: 5, threshold: 6 })).toEqual([]);
    expect(resolveDivisionProvinces({ ...base, zoom: 6, threshold: 6 })).toEqual(["AR-1"]);
  });

  it("produces a STABLE sorted set so identical viewports dedupe (debounce/cache essence)", () => {
    // Two different-order pans that see the same provinces must yield the same
    // set — the component keys its rebuild on the sorted signature, so a rapid
    // gesture that keeps the same provinces in view triggers no refetch.
    const a = resolveDivisionProvinces({
      selectedProvince: null,
      zoom: Z_DIVISIONS,
      cameraBbox: [
        [0, 0],
        [6, 6],
      ],
      provinceBboxes: PROVINCES,
    });
    const b = resolveDivisionProvinces({
      selectedProvince: null,
      zoom: Z_DIVISIONS + 1,
      cameraBbox: [
        [0.1, 0.1],
        [5.9, 1.9],
      ],
      provinceBboxes: PROVINCES,
    });
    expect([...a].sort().join(",")).toBe([...b].sort().join(","));
  });
});

describe("resolveDataLevel — automatic department-grain LOD (A2)", () => {
  const NATIONAL = { hasProvinceScope: false, hasLocalityScope: false };

  it("a committed province scope reads the locality axis at ANY zoom", () => {
    expect(
      resolveDataLevel({
        hasProvinceScope: true,
        hasLocalityScope: false,
        zoom: 3,
        hasActiveChoropleth: true,
      }),
    ).toBe("locality");
    // Even below the division threshold and with no choropleth active — the drill wins.
    expect(
      resolveDataLevel({
        hasProvinceScope: true,
        hasLocalityScope: false,
        zoom: 0,
        hasActiveChoropleth: false,
      }),
    ).toBe("locality");
  });

  it("a committed locality scope reads the locality axis at any zoom", () => {
    expect(
      resolveDataLevel({
        hasProvinceScope: false,
        hasLocalityScope: true,
        zoom: 2,
        hasActiveChoropleth: false,
      }),
    ).toBe("locality");
  });

  it("national + choropleth active + zoom past Z_DIVISIONS → LOCALITY (departments fill)", () => {
    expect(resolveDataLevel({ ...NATIONAL, zoom: Z_DIVISIONS, hasActiveChoropleth: true })).toBe(
      "locality",
    );
    expect(
      resolveDataLevel({ ...NATIONAL, zoom: Z_DIVISIONS + 2, hasActiveChoropleth: true }),
    ).toBe("locality");
  });

  it("national + choropleth active + BELOW the threshold → province (clean overview stays)", () => {
    expect(
      resolveDataLevel({ ...NATIONAL, zoom: Z_DIVISIONS - 0.5, hasActiveChoropleth: true }),
    ).toBe("province");
  });

  it("national past the threshold but NO choropleth active → province (nothing to fill)", () => {
    // The camera flip is gated on an active choropleth (the metric that colors the
    // polygons) — a signal-only national view stays on the province axis and never
    // resurrects an uncubed national+locality fetch.
    expect(
      resolveDataLevel({ ...NATIONAL, zoom: Z_DIVISIONS + 3, hasActiveChoropleth: false }),
    ).toBe("province");
  });

  it("honors a custom threshold", () => {
    expect(
      resolveDataLevel({ ...NATIONAL, zoom: 6, hasActiveChoropleth: true, threshold: 7 }),
    ).toBe("province");
    expect(
      resolveDataLevel({ ...NATIONAL, zoom: 7, hasActiveChoropleth: true, threshold: 7 }),
    ).toBe("locality");
  });
});
