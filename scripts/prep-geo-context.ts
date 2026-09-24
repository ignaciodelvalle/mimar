// Regenerate the Panorama "regional context" geo assets from a single
// Natural Earth source, and fold the Malvinas archipelago into Argentina's
// own polygons (Ley 26.651 — the Malvinas are Argentine territory and MUST
// appear on every Argentine map).
//
// WHY THIS EXISTS
// ----------------
// 1. The national map showed Argentina floating alone on the dark canvas with
//    no neighbouring landmass for spatial reference. This script emits
//    `public/geo/sudamerica-context.geojson` — six neighbours (Chile, Uruguay,
//    Brazil, Paraguay, Bolivia, Peru), heavily simplified — that
//    SituationalMap.tsx draws as a NON-interactive, muted basemap BELOW the
//    Argentine provinces.
// 2. The Malvinas literally did not exist at province level: the AR-V (Tierra
//    del Fuego) feature in `public/geo/ar-provinces.geojson` stopped at lon
//    −63.8, while the archipelago spans lon −61.1…−57.8. We MERGE the Natural
//    Earth Malvinas polygons into the AR-V MultiPolygon so the islands render
//    as part of the province (properties {code:"AR-V", name} untouched).
// 3. Department `94021` ("Islas del Atlántico Sur") in
//    `public/geo/ar-departments.geojson` carried 222 garbled sub-polygons
//    (fragments nowhere near the islands) that rendered garbage when Tierra del
//    Fuego was scoped. We REPLACE its geometry with the clean Malvinas polygons
//    so the islands department renders correctly at department zoom.
//
// SOURCE (public domain)
// ----------------------
// Natural Earth 1:50m Admin 0 – Countries (public domain, no attribution
// required). The canonical GeoJSON mirror:
//
//   https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson
//
// Country identity is read from the `ADMIN` property. Natural Earth models the
// Malvinas as ADMIN="Falkland Islands"; we relabel them into Argentine geometry
// (no separate feature is ever emitted — the islands appear ONLY as Argentina).
//
// PIPELINE (deterministic, dependency-free)
// -----------------------------------------
// Pure-JS: Ramer–Douglas–Peucker ring simplification + fixed-precision
// coordinate rounding. No mapshaper / no network tool needed (the only network
// call is the Natural Earth download, skippable with --source). Same source +
// same flags → identical output.
//
//   - Neighbours: RDP tol 0.05° (~5.5 km), rounded to 2 decimals. Ample for a
//     muted wide-zoom backdrop; keeps the file tiny.
//   - Malvinas:   RDP tol 0.005°, rounded to 4 decimals (department precision),
//     re-rounded to 3 decimals for the provinces merge (matches that file).
//
// IDEMPOTENCY
// -----------
// Re-runs converge:
//   - provinces: any AR-V sub-polygon lying entirely east of lon −63 (i.e. a
//     previously-merged Malvinas polygon) is dropped before the fresh merge —
//     genuine Tierra del Fuego polygons all end at lon ≤ −63.8.
//   - departments: 94021's geometry is REPLACED wholesale each run.
//
// USAGE
//   pnpm tsx scripts/prep-geo-context.ts                 # download NE + build all
//   pnpm tsx scripts/prep-geo-context.ts --source <path> # reuse a local NE geojson

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson";

const GEO_DIR = join(process.cwd(), "public", "geo");
const PROVINCES_PATH = join(GEO_DIR, "ar-provinces.geojson");
const DEPARTMENTS_PATH = join(GEO_DIR, "ar-departments.geojson");
const CONTEXT_OUT = join(GEO_DIR, "sudamerica-context.geojson");

const NEIGHBOURS = ["Chile", "Uruguay", "Brazil", "Paraguay", "Bolivia", "Peru"] as const;
const FALKLANDS_ADMIN = "Falkland Islands";

const AR_V_CODE = "AR-V";
const ISLANDS_DEPT_CODE = "94021";
const ISLANDS_DEPT_NAME = "Islas del Atlántico Sur";
// Any AR-V sub-polygon east of this longitude is a merged Malvinas polygon
// (genuine Tierra del Fuego geometry ends at lon ≤ −63.8). Used for idempotency.
const MALVINAS_LON_THRESHOLD = -63;

type Position = [number, number];
type Ring = Position[];
type PolygonCoords = Ring[];
type MultiPolygonCoords = PolygonCoords[];

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// --- Geometry helpers -------------------------------------------------------

/** Min longitude across every position in a polygon's rings. */
function minLon(poly: PolygonCoords): number {
  let mn = Number.POSITIVE_INFINITY;
  for (const ring of poly) for (const [x] of ring) if (x < mn) mn = x;
  return mn;
}

/** Perpendicular distance from point p to the segment a→b (in degrees). */
function perpDistance(p: Position, a: Position, b: Position): number {
  const [px, py] = p;
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Ramer–Douglas–Peucker on an open point list. */
function rdp(points: Position[], tol: number): Position[] {
  if (points.length <= 2) return points;
  let maxD = 0;
  let idx = 0;
  const end = points.length - 1;
  for (let i = 1; i < end; i++) {
    const d = perpDistance(points[i], points[0], points[end]);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD > tol) {
    const left = rdp(points.slice(0, idx + 1), tol);
    const right = rdp(points.slice(idx), tol);
    return [...left.slice(0, -1), ...right];
  }
  return [points[0], points[end]];
}

const round = (n: number, dp: number): number => Number(n.toFixed(dp));

/** Simplify + round one closed ring. Returns null if it collapses (< 4 pts). */
function processRing(ring: Ring, tol: number, dp: number): Ring | null {
  const simplified = rdp(ring, tol).map(([x, y]) => [round(x, dp), round(y, dp)] as Position);
  // Drop consecutive duplicates introduced by rounding.
  const deduped: Ring = [];
  for (const pt of simplified) {
    const prev = deduped[deduped.length - 1];
    if (!prev || prev[0] !== pt[0] || prev[1] !== pt[1]) deduped.push(pt);
  }
  // A valid closed ring needs at least 4 positions (first === last).
  if (deduped.length < 4) return null;
  const first = deduped[0];
  const last = deduped[deduped.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) deduped.push([first[0], first[1]]);
  return deduped.length >= 4 ? deduped : null;
}

/** Simplify + round an entire (Multi)Polygon geometry. */
function processGeometry(
  geom: { type: string; coordinates: unknown },
  tol: number,
  dp: number,
): { type: "MultiPolygon"; coordinates: MultiPolygonCoords } {
  const polys: MultiPolygonCoords =
    geom.type === "Polygon"
      ? [geom.coordinates as PolygonCoords]
      : (geom.coordinates as MultiPolygonCoords);
  const out: MultiPolygonCoords = [];
  for (const poly of polys) {
    const rings: PolygonCoords = [];
    for (const ring of poly) {
      const processed = processRing(ring, tol, dp);
      if (processed) rings.push(processed);
    }
    if (rings.length > 0) out.push(rings);
  }
  return { type: "MultiPolygon", coordinates: out };
}

/** Re-round an already-simplified MultiPolygon to fewer decimals. */
function reround(coords: MultiPolygonCoords, dp: number): MultiPolygonCoords {
  return coords
    .map((poly) =>
      poly
        .map((ring) => {
          const r = processRing(
            ring.map(([x, y]) => [round(x, dp), round(y, dp)] as Position),
            0,
            dp,
          );
          return r;
        })
        .filter((r): r is Ring => r !== null),
    )
    .filter((poly) => poly.length > 0);
}

// --- Source loading ---------------------------------------------------------

type NeFeature = {
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown };
};

async function loadSource(): Promise<NeFeature[]> {
  const local = arg("--source");
  if (local) {
    console.log(`Reading Natural Earth source from ${local}`);
    return JSON.parse(readFileSync(local, "utf8")).features as NeFeature[];
  }
  console.log(`Downloading Natural Earth 50m: ${SOURCE_URL}`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`Source download failed: HTTP ${res.status}`);
  return ((await res.json()) as { features: NeFeature[] }).features;
}

function findByAdmin(features: NeFeature[], admin: string): NeFeature {
  const f = features.find((x) => x.properties.ADMIN === admin);
  if (!f) throw new Error(`Natural Earth feature not found: ADMIN=${admin}`);
  return f;
}

// --- Main -------------------------------------------------------------------

async function main(): Promise<void> {
  const features = await loadSource();

  // 1. Regional-context basemap (neighbours only — NEVER the Malvinas).
  const contextFeatures = NEIGHBOURS.map((admin) => {
    const src = findByAdmin(features, admin);
    return {
      type: "Feature" as const,
      properties: { ADMIN: admin },
      geometry: processGeometry(src.geometry, 0.05, 2),
    };
  });
  const contextFc = { type: "FeatureCollection" as const, features: contextFeatures };
  // Sanity: the context layer must not smuggle in a Malvinas/Falkland feature.
  if (contextFeatures.some((f) => /falkland|malvina/i.test(String(f.properties.ADMIN)))) {
    throw new Error("Context basemap unexpectedly contains a Malvinas/Falkland feature");
  }
  writeFileSync(CONTEXT_OUT, JSON.stringify(contextFc));
  console.log(
    `Wrote ${CONTEXT_OUT}  features: ${contextFeatures.length}  size: ${(Buffer.byteLength(JSON.stringify(contextFc)) / 1e3).toFixed(1)} KB`,
  );

  // 2. Malvinas geometry (department precision = 4 dp).
  const falklands = findByAdmin(features, FALKLANDS_ADMIN);
  const malvinas4 = processGeometry(falklands.geometry, 0.005, 4);
  const malvinas3 = {
    type: "MultiPolygon" as const,
    coordinates: reround(malvinas4.coordinates, 3),
  };

  // 3. Merge Malvinas into the AR-V (Tierra del Fuego) province polygon.
  const provinces = JSON.parse(readFileSync(PROVINCES_PATH, "utf8")) as {
    features: Array<{
      properties: { code: string };
      geometry: { type: string; coordinates: unknown };
    }>;
  };
  const arv = provinces.features.find((f) => f.properties.code === AR_V_CODE);
  if (!arv) throw new Error(`AR-V feature not found in ${PROVINCES_PATH}`);
  const arvPolys = (
    arv.geometry.type === "Polygon"
      ? [arv.geometry.coordinates as PolygonCoords]
      : (arv.geometry.coordinates as MultiPolygonCoords)
  ).filter((poly) => minLon(poly) <= MALVINAS_LON_THRESHOLD); // drop prior Malvinas merges
  const mergedPolys = [...arvPolys, ...malvinas3.coordinates];
  arv.geometry = { type: "MultiPolygon", coordinates: mergedPolys };
  writeFileSync(PROVINCES_PATH, JSON.stringify(provinces));
  console.log(
    `Merged ${malvinas3.coordinates.length} Malvinas polygon(s) into AR-V (now ${mergedPolys.length} polygons total)`,
  );

  // 4. Replace department 94021's geometry with the clean Malvinas polygons.
  // Surgical, single-line replacement to preserve the one-feature-per-line
  // format of ar-departments.geojson (mapshaper output from prep-geo-departments).
  const deptLines = readFileSync(DEPARTMENTS_PATH, "utf8").split("\n");
  const idx = deptLines.findIndex((l) => l.includes(`"${ISLANDS_DEPT_CODE}"`));
  if (idx < 0) throw new Error(`Department ${ISLANDS_DEPT_CODE} not found in ${DEPARTMENTS_PATH}`);
  const hadTrailingComma = deptLines[idx].trimEnd().endsWith(",");
  const newFeature = {
    type: "Feature",
    geometry: malvinas4,
    properties: { code: ISLANDS_DEPT_CODE, name: ISLANDS_DEPT_NAME },
  };
  deptLines[idx] = JSON.stringify(newFeature) + (hadTrailingComma ? "," : "");
  writeFileSync(DEPARTMENTS_PATH, deptLines.join("\n"));
  console.log(
    `Replaced department ${ISLANDS_DEPT_CODE} geometry with ${malvinas4.coordinates.length} clean Malvinas polygon(s)`,
  );
}

const calledDirectly = process.argv[1]?.endsWith("prep-geo-context.ts");
if (calledDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
