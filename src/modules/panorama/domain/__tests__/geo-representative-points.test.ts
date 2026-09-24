// Regression guard for the "centroid dots in the water" fix (task #20 Part 2,
// item 1 / dim-interno:docs/plans/panorama-v2-polish.md Part B #6).
//
// Aggregated province/department markers used to plot at the ARITHMETIC MEAN
// of member-locality coordinates, which has no guarantee of landing inside the
// unit's polygon for a concave/multi-part geography. Tierra del Fuego (AR-V) is
// the confirmed failure: its province geometry is a MultiPolygon spanning Isla
// Grande (the mainland island) PLUS the Malvinas/Georgias claim (Ley 26.651
// requires they render as Argentina, see geo-context-geojson.test.ts) plus
// minor islands — averaging coordinates across those parts drifts the marker
// into the South Atlantic, between Isla Grande and the Malvinas.
//
// PROVINCE_REPRESENTATIVE_POINTS / DEPARTMENT_REPRESENTATIVE_POINTS
// (regenerate via `pnpm tsx scripts/prep-geo-representative-points.ts`) fix
// this by precomputing, per unit, the pole of inaccessibility (polylabel) of
// the unit's LARGEST polygon part — guaranteed to sit on that unit's own
// landmass. This test pins:
//   1. AR-V's representative point falls within Isla Grande's own bounding box
//      (the largest part of the MultiPolygon), not the province's overall bbox
//      (which spans all the way to the Malvinas).
//   2. It differs materially from the naive "average every vertex across every
//      part" computation — the exact shape of the original bug.
//   3. The department-level fold (Ushuaia, INDEC 94015) is independently
//      correct too.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEPARTMENT_REPRESENTATIVE_POINTS,
  PROVINCE_REPRESENTATIVE_POINTS,
} from "@/src/modules/panorama/domain/geo-representative-points";

type Feature = {
  properties: { code?: string; name?: string };
  geometry: GeoJSON.Geometry;
};

function loadGeo(name: string): { features: Feature[] } {
  return JSON.parse(readFileSync(join(process.cwd(), "public", "geo", name), "utf8"));
}

function ringArea(ring: number[][]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** bbox + naive vertex-average across EVERY part of a (Multi)Polygon — the
 *  unweighted "locality centroid" shape the old runtime AVG bug produced. */
function analyzeGeometry(geometry: GeoJSON.Geometry): {
  largestPartBbox: { minLng: number; maxLng: number; minLat: number; maxLat: number };
  naiveVertexAverage: { lng: number; lat: number };
} {
  const parts: number[][][] =
    geometry.type === "MultiPolygon"
      ? (geometry.coordinates as number[][][][]).map((rings) => rings[0])
      : geometry.type === "Polygon"
        ? [(geometry.coordinates as number[][][])[0]]
        : [];

  let bestArea = -1;
  let largestPartBbox = {
    minLng: Number.POSITIVE_INFINITY,
    maxLng: Number.NEGATIVE_INFINITY,
    minLat: Number.POSITIVE_INFINITY,
    maxLat: Number.NEGATIVE_INFINITY,
  };
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const ring of parts) {
    const area = ringArea(ring);
    if (area > bestArea) {
      bestArea = area;
      let minLng = Number.POSITIVE_INFINITY;
      let maxLng = Number.NEGATIVE_INFINITY;
      let minLat = Number.POSITIVE_INFINITY;
      let maxLat = Number.NEGATIVE_INFINITY;
      for (const [lng, lat] of ring) {
        minLng = Math.min(minLng, lng);
        maxLng = Math.max(maxLng, lng);
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
      }
      largestPartBbox = { minLng, maxLng, minLat, maxLat };
    }
    for (const [lng, lat] of ring) {
      sx += lng;
      sy += lat;
      n += 1;
    }
  }
  return { largestPartBbox, naiveVertexAverage: { lng: sx / n, lat: sy / n } };
}

describe("PROVINCE_REPRESENTATIVE_POINTS — AR-V (Tierra del Fuego) point-on-surface fix", () => {
  it("lands inside Isla Grande's own bbox (the largest MultiPolygon part), not drifted toward the Malvinas", () => {
    const provinces = loadGeo("ar-provinces.geojson");
    const arV = provinces.features.find((f) => f.properties.code === "AR-V");
    expect(arV).toBeDefined();
    expect(arV?.geometry.type).toBe("MultiPolygon");

    const { largestPartBbox, naiveVertexAverage } = analyzeGeometry(
      arV?.geometry as GeoJSON.Geometry,
    );
    const rep = PROVINCE_REPRESENTATIVE_POINTS["AR-V"];
    expect(rep).toBeDefined();

    // 1. On Isla Grande's own landmass (its bbox), not the whole-province bbox.
    expect(rep.lng).toBeGreaterThanOrEqual(largestPartBbox.minLng);
    expect(rep.lng).toBeLessThanOrEqual(largestPartBbox.maxLng);
    expect(rep.lat).toBeGreaterThanOrEqual(largestPartBbox.minLat);
    expect(rep.lat).toBeLessThanOrEqual(largestPartBbox.maxLat);

    // 2. Differs materially from the naive vertex-average across ALL parts
    //    (the Malvinas/Georgias-drifted point the old AVG-of-localities bug
    //    would produce) — several degrees apart, not a rounding difference.
    const drift = Math.hypot(rep.lng - naiveVertexAverage.lng, rep.lat - naiveVertexAverage.lat);
    expect(drift).toBeGreaterThan(1);
  });

  it("matches the checked-in precomputed value exactly (regenerate via prep-geo-representative-points.ts if this ever legitimately changes)", () => {
    expect(PROVINCE_REPRESENTATIVE_POINTS["AR-V"]).toEqual({ lat: -54.25511, lng: -68.02355 });
  });
});

describe("DEPARTMENT_REPRESENTATIVE_POINTS — Ushuaia (INDEC 94015)", () => {
  it("lands inside its own department polygon bbox", () => {
    const departments = loadGeo("ar-departments.geojson");
    const ushuaia = departments.features.find((f) => f.properties.code === "94015");
    expect(ushuaia).toBeDefined();

    const { largestPartBbox } = analyzeGeometry(ushuaia?.geometry as GeoJSON.Geometry);
    const rep = DEPARTMENT_REPRESENTATIVE_POINTS["94015"];
    expect(rep).toBeDefined();
    expect(rep.lng).toBeGreaterThanOrEqual(largestPartBbox.minLng);
    expect(rep.lng).toBeLessThanOrEqual(largestPartBbox.maxLng);
    expect(rep.lat).toBeGreaterThanOrEqual(largestPartBbox.minLat);
    expect(rep.lat).toBeLessThanOrEqual(largestPartBbox.maxLat);
  });

  it("every department code has a representative point (513-feature parity)", () => {
    expect(Object.keys(DEPARTMENT_REPRESENTATIVE_POINTS).length).toBe(513);
  });

  it("every province code has a representative point (24-feature parity)", () => {
    expect(Object.keys(PROVINCE_REPRESENTATIVE_POINTS).length).toBe(24);
  });
});
