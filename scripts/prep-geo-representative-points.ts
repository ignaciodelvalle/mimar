// Precompute REPRESENTATIVE POINTS (point-on-surface) for every province and
// department polygon — the fix for "centroid dots in the water" (task #20
// Part 2, item 1 / dim-interno:docs/plans/panorama-v2-polish.md Part B #6).
//
// WHY THIS EXISTS
// ----------------
// The aggregated province/department markers on the situational map used to
// plot at the ARITHMETIC MEAN of the member localities' lat/lng (an unweighted
// "locality centroid", see repository.ts / build-features.ts). For a concave
// or multi-part geography that mean can fall outside the polygon entirely —
// Tierra del Fuego (AR-V) is the confirmed case: its province geometry is a
// MultiPolygon (Isla Grande + the Malvinas/Georgias claim + minor islands),
// and averaging locality coordinates across those parts drags the point into
// the South Atlantic between the mainland island and the outlying claims.
//
// FIX: precompute, at build time, ONE representative point per province and
// per department that is GUARANTEED to land on that unit's own landmass —
// specifically, on its LARGEST polygon part (by planar shoelace area), using
// polylabel (Mapbox's "pole of inaccessibility" algorithm: the point deepest
// inside the polygon, i.e. farthest from any edge — ideal for a marker/label
// anchor, unlike a plain centroid which has no such guarantee for concave
// shapes). This is placement-only: it does not change which units get a
// marker, does not touch k-anon/suppression, and adds no jitter — the
// opposite of jitter, actually (a single deterministic point per unit).
//
// SOURCE GEOMETRY
// ----------------
// public/geo/ar-provinces.geojson  → { code: "AR-X", name }
// public/geo/ar-departments.geojson → { code: <INDEC 5-digit>, name }
// (Both already checked in — this script re-derives points from them, it
// does not regenerate the polygons themselves. See prep-geo-departments.ts
// for THAT pipeline.)
//
// OUTPUT
// ------
// src/modules/panorama/domain/geo-representative-points.ts — a plain,
// dependency-free TS data module (domain layer: no infra/app imports, so
// both infrastructure/repository.ts and application/build-features.ts can
// import it without crossing a layering boundary). Committed, not generated
// at request time — polylabel only runs here, never in the request path.
//
// USAGE
//   pnpm tsx scripts/prep-geo-representative-points.ts
//
// Deterministic: same source geojson + same polylabel precision → same output.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import polylabel from "polylabel";

const PROVINCES_PATH = join(process.cwd(), "public", "geo", "ar-provinces.geojson");
const DEPARTMENTS_PATH = join(process.cwd(), "public", "geo", "ar-departments.geojson");
const OUT_PATH = join(
  process.cwd(),
  "src",
  "modules",
  "panorama",
  "domain",
  "geo-representative-points.ts",
);

// 0.01 degree ≈ 1 km at these latitudes — ample precision for a map marker
// (the same order of magnitude as the department geometry's own simplify
// precision, ~11 m, is overkill for a label anchor; 1 km keeps polylabel fast
// across 513 departments).
const PRECISION = 0.01;

type Ring = number[][];
type PolygonRings = Ring[]; // [exterior, ...holes]

/** Planar shoelace area of a single ring (unsigned). Good enough to compare
 *  parts of the SAME feature at country scale — no need for a geodesic area. */
function ringArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** The LARGEST polygon's rings (exterior + holes) for a Polygon or
 *  MultiPolygon geometry — the part polylabel should search. For a Polygon
 *  this is just its own rings; for a MultiPolygon it's the biggest part by
 *  exterior-ring area (this is what keeps the TdF marker on Isla Grande
 *  instead of drifting toward a smaller outlying part). */
function largestPolygonRings(geometry: GeoJSON.Geometry): PolygonRings | null {
  if (geometry.type === "Polygon") {
    return geometry.coordinates as PolygonRings;
  }
  if (geometry.type === "MultiPolygon") {
    const polys = geometry.coordinates as PolygonRings[];
    let best: PolygonRings | null = null;
    let bestArea = -1;
    for (const rings of polys) {
      const area = ringArea(rings[0]);
      if (area > bestArea) {
        bestArea = area;
        best = rings;
      }
    }
    return best;
  }
  return null;
}

/** Representative point [lat, lng] for one feature's geometry, or null if the
 *  geometry is missing/unsupported (never happens for our province/department
 *  sources, but keeps the function total). */
function representativePoint(geometry: GeoJSON.Geometry | null): [number, number] | null {
  if (!geometry) return null;
  const rings = largestPolygonRings(geometry);
  if (!rings || rings.length === 0 || rings[0].length === 0) return null;
  // GeoJSON coordinate rings are plain number[][] (no tuple guarantee); every
  // ring here is a validated [lng, lat] pair (real GeoJSON source), so the cast
  // to polylabel's [number, number][][] expectation is safe.
  const [lng, lat] = polylabel(rings as [number, number][][], PRECISION);
  return [lat, lng];
}

function buildLookup(
  path: string,
  label: string,
): { entries: Array<{ code: string; name: string; lat: number; lng: number }>; skipped: number } {
  const fc = JSON.parse(readFileSync(path, "utf8")) as GeoJSON.FeatureCollection;
  const entries: Array<{ code: string; name: string; lat: number; lng: number }> = [];
  let skipped = 0;
  for (const f of fc.features) {
    const props = f.properties as { code?: string; name?: string } | null;
    const code = props?.code;
    if (!code) {
      skipped += 1;
      continue;
    }
    const point = representativePoint(f.geometry);
    if (!point) {
      skipped += 1;
      continue;
    }
    entries.push({ code, name: props?.name ?? "", lat: point[0], lng: point[1] });
  }
  console.log(`${label}: ${entries.length} representative points (${skipped} skipped)`);
  return { entries, skipped };
}

function formatLookup(
  entries: Array<{ code: string; name: string; lat: number; lng: number }>,
): string {
  const lines = entries
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code))
    .map(
      (e) => `  "${e.code}": { lat: ${e.lat.toFixed(5)}, lng: ${e.lng.toFixed(5)} }, // ${e.name}`,
    );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const provinces = buildLookup(PROVINCES_PATH, "Provinces");
  const departments = buildLookup(DEPARTMENTS_PATH, "Departments");

  const banner = `// AUTO-GENERATED by scripts/prep-geo-representative-points.ts — do not hand-edit.
// Regenerate: pnpm tsx scripts/prep-geo-representative-points.ts
//
// Representative point (pole of inaccessibility, via polylabel) for every
// province and department polygon in public/geo/{ar-provinces,ar-departments}
// .geojson. Guarantees the point lands on the unit's own (largest) landmass —
// unlike an arithmetic mean of member-locality coordinates, which can fall in
// open water for a concave/multi-part geography (Tierra del Fuego / AR-V:
// its province polygon spans Isla Grande + the Malvinas/Georgias claim +
// minor islands — averaging locality coords across those parts drifts into
// the South Atlantic). Consumed by:
//   - src/modules/panorama/infrastructure/repository.ts (province-level
//     aggregated point cells — replaces the runtime AVG(ar_localities.lat/lng))
//   - src/modules/panorama/application/build-features.ts (department fold —
//     replaces the unweighted average of locality centroids)
//
// Placement-only: does not affect k-anon/suppression or which units get a
// marker, and is NOT jitter (one deterministic point per unit, not noise).

export type RepresentativePoint = { lat: number; lng: number };

/** ISO 3166-2:AR province code (e.g. "AR-V") → representative point. */
export const PROVINCE_REPRESENTATIVE_POINTS: Record<string, RepresentativePoint> = {
${formatLookup(provinces.entries)}
};

/** INDEC 5-digit department code (e.g. "94015") → representative point. */
export const DEPARTMENT_REPRESENTATIVE_POINTS: Record<string, RepresentativePoint> = {
${formatLookup(departments.entries)}
};
`;

  writeFileSync(OUT_PATH, banner);
  console.log(`Wrote ${OUT_PATH}`);
}

const calledDirectly = process.argv[1]?.endsWith("prep-geo-representative-points.ts");
if (calledDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
