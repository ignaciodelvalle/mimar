// Cube-backed layer reader (road-to-10 infra #1, migration 0139) — behind CUBE_READS.
//
// Serves the 5 CHOROPLETH layers for ADMIN actors (national + a whole-province drill)
// from the precomputed panorama_cube, producing the SAME LayerFeaturesResult envelope
// the live path returns — by reconstructing the loaders' cell shapes and reusing the
// EXACT `buildChoroplethFeatures` / `buildProvinceChoroplethFeatures` transforms. So a
// cube-served response is a set-equal (order-independent) FeatureCollection to the live
// one — same features, envelope, and flags regardless of row order, NOT literal byte
// order (pinned by the parity test's order-independent normalization).
//
// The cube COMPOSES IN FRONT of the live Data Cache: an eligible request reads the
// cube; everything else keeps the current cached-live path untouched. Flag default ON
// since the cube-ON decision (Metrics review K4 + Scale S3, 2026-07-24): national
// admin surfaces must not silently truncate, so they read the cube WHEN FRESH and
// fall back to live (with the live path's honest `truncated` flag) otherwise.
// CUBE_READS === '0' is the kill switch (→ this returns null → live, the pre-ON
// behavior).
//
// ELIGIBILITY (all must hold, else null → live):
//   - CUBE_READS !== '0' (default ON; '0' = kill switch).
//   - layer ∈ {cobertura, esterilizacion, microchip, ppp, mortalidad}.
//   - actor is ADMIN.
//   - NOT a locality drill (adminLocality unset). A locality drill counts ONE
//     locality, but a cube department cell aggregates ALL localities in the
//     department — filtering can't recover the single-locality count, so locality
//     drills stay live. (This narrows the design's Decision 4, which listed locality
//     drills as eligible; verified against the fold — they are not.)
//   - national DEPARTMENT (locality-axis) view is served as a deliberate cube
//     SUPERSET. The live national locality rollup is capped at PER_LAYER_CAP (2000)
//     and the seed exceeds it, so the live national+department view is TRUNCATED and
//     non-deterministic — that truncation was the DEFECT, not the contract. The cube
//     is built PER PROVINCE (each province complete within its own budget); the
//     national union is therefore a superset of the truncated live set (it only adds
//     the departments truncation dropped) with matching values on the overlap. This
//     envelope declares `truncated: false`: it is not subject to the global live cap,
//     so it never claims a completeness it does not have. The cube thus serves
//     national+PROVINCE, national+DEPARTMENT (superset), and BOTH grains for a
//     whole-province drill (complete; a province whose own build hit the cap still
//     reports `truncated` via its den flag, preserving live parity for that drill).
//   - verifiedOnly === false (the cube stores the default numerator; the "solo
//     firmado" narrowing is not precomputed).
//   - cube fresh: status === 'ok' AND now − built_at ≤ STALE_MAX.
//
// WHY admin-only + complete slices: the cube is stored UNSCOPED and decomposed to
// department with suppression baked over the NATIONAL set. That is exactly correct for
// any reader who sees a COMPLETE geographic slice (national; or a whole province, since
// complementarySuppress is province-grouped). A partial slice (a govt scoped to a
// subset of a province's departments) could differ, so govt stays live in v1.

import type { PanoramaCubeRow } from "@/db/schema";
import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";
import { seesSyntheticRows } from "@/lib/metrics/scope";

import { readCubeMeta, readCubeRows } from "@/src/modules/panorama/infrastructure/repository";
import type { ChoroplethMetric } from "@/src/modules/panorama/infrastructure/repository";

import type { LayerId } from "@/src/modules/panorama/domain/types";
import type { AggregationLevel } from "@/src/modules/panorama/domain/types";
import {
  type ChoroplethCell,
  type ProvinceChoroplethCell,
  buildChoroplethFeatures,
  buildProvinceChoroplethFeatures,
  provinceCellPreDecided,
} from "./build-features";
import type { LayerFeaturesResult, LayerPeriod } from "./get-layer-features";
import {
  type LayerCacheStatus,
  loadLayerFeaturesCached,
  loadLayerFeaturesCachedWithMeta,
} from "./load-layer-features-cached";

/** The choropleth layers the cube covers, mapped to their metric (mirrors the
 * layer→metric switch in get-layer-features.ts). A layer absent here is not cubeable. */
const CUBE_LAYER_METRIC: Partial<Record<LayerId, ChoroplethMetric>> = {
  cobertura: "rabies-coverage",
  esterilizacion: "sterilization-coverage",
  microchip: "microchip-penetration",
  ppp: "ppp-compliance",
  mortalidad: "mortality",
};

/** Max age of the cube before a read falls back to live. Current-state choropleth
 * tolerates staleness well (day-granularity data). The window matches the build
 * CADENCE: refresh_cube runs once daily (vercel.json `0 3 * * *` — Vercel Hobby
 * allows daily schedules only), so the ceiling is daily + slack = 26h, mirroring
 * the fleet's DAILY_STALENESS_MS (lib/infra/cron-registry.ts). A tighter window
 * (the original 6h, with a sub-daily every-15-min refresh) and an always-on national
 * cube need Vercel Pro — fase 3; until then a >26h-old cube reads as stale and
 * the request degrades to live with its honest truncation disclosure. */
export const CUBE_STALE_MAX_MS = 26 * 60 * 60 * 1000;

/** Whether cube reads are enabled. Default ON (cube-ON decision 2026-07-24);
 * CUBE_READS='0' is the explicit kill switch — any other value (unset, '1', …)
 * keeps reads enabled. Freshness still gates every read (CUBE_STALE_MAX_MS). */
export function cubeReadsEnabled(): boolean {
  return process.env.CUBE_READS !== "0";
}

/** A cube-served layer result plus the cube's build timestamp (surfaced as the
 * data-freshness "Datos al" for cube-served layers — the cube's age is declared). */
export type CubeLayerResult = {
  result: LayerFeaturesResult;
  builtAt: Date;
};

/**
 * Try to serve a choropleth layer from the cube. Returns null when the request is
 * not cube-eligible OR the cube is stale/absent — the caller then uses the live path
 * (identical outcome to CUBE_READS off, per request).
 */
export async function loadLayerFeaturesFromCube(
  layer: LayerId,
  actor: DashboardActor,
  level: AggregationLevel,
  adminProvince?: string,
  adminLocality?: string,
  verifiedOnly = false,
): Promise<CubeLayerResult | null> {
  // --- eligibility + staleness gate (shared with resolveCubeFreshness) ---
  const builtAt = await resolveCubeFreshness(
    layer,
    actor,
    adminProvince,
    adminLocality,
    verifiedOnly,
  );
  if (!builtAt) return null;
  const metric = CUBE_LAYER_METRIC[layer];
  if (!metric) return null; // narrowing only — resolveCubeFreshness already checked.

  // --- read + rebuild the envelope ---
  const rows = await readCubeRows(metric, adminProvince);
  return { builtAt, result: assembleCubeLayerResult(rows, level, adminProvince) };
}

/**
 * The cube-vs-live decision, WITHOUT reading or assembling any layer rows: returns
 * the cube's `built_at` when a choropleth request for (layer, scope) WOULD be served
 * from the cube (eligible AND fresh), else null. This is the exact eligibility +
 * staleness gate `loadLayerFeaturesFromCube` applies — extracted so a caller can
 * ANNOTATE a view with the cube's freshness (the "Datos precalculados al …"
 * caption) without triggering a second cube assembly. Read-only: it never touches
 * the layer data path.
 *
 * Mirrors the eligibility in `loadLayerFeaturesFromCube`'s header: CUBE_READS on,
 * admin actor, not a locality drill, default numerator (verifiedOnly === false), a
 * cubeable choropleth layer, and meta status 'ok' within CUBE_STALE_MAX_MS.
 */
export async function resolveCubeFreshness(
  layer: LayerId,
  actor: DashboardActor,
  adminProvince?: string,
  adminLocality?: string,
  verifiedOnly = false,
): Promise<Date | null> {
  // --- eligibility (cheap checks first, no DB) ---
  if (!cubeReadsEnabled()) return null;
  if (!hasNationalReadScope(actor.role)) return null;
  // T1-P1: the cube is built as ADMIN and so it counts the synthetic seed. Only a
  // viewer who sees synthetic rows may be served from it; a `national` viewer
  // reads live, where the scope clause excludes them (lib/metrics/scope.ts).
  if (!seesSyntheticRows(actor.role)) return null;
  if (adminLocality) return null; // locality drill → live (see header)
  if (verifiedOnly) return null;
  // National + department IS cube-eligible (superset over the truncated live view);
  // the only locality-axis exclusion is the locality drill above.
  if (!CUBE_LAYER_METRIC[layer]) return null;

  // --- staleness gate ---
  // Defensive try/catch: SSR pages call this annotation helper OUTSIDE the
  // cube-or-live readers' own catch, and with the flag default ON a transient
  // meta-read failure must degrade to "no stamp" (live), never 500 the page.
  try {
    const meta = await readCubeMeta();
    if (!meta || meta.status !== "ok" || !meta.builtAt) return null;
    if (Date.now() - meta.builtAt.getTime() > CUBE_STALE_MAX_MS) return null;
    return meta.builtAt;
  } catch {
    return null;
  }
}

/**
 * Rebuild the loader's LayerFeaturesResult envelope from stored cube rows. Pure
 * (no DB) — exported so the truncation threading is testable without a build.
 *
 * TRUNCATION (CB1): the builder captures each province's department-grain
 * `truncated` flag (its LOCALITY rollup hitting PER_LAYER_CAP — reachable at
 * Buenos Aires scale, ~2000 INDEC localities) in the province row's `den` column
 * (0/1 — reserved-column reuse, see buildProvinceCubeRows). The department grain
 * threads it through here so a cube-served drill can never claim false
 * completeness (live parity: the live loader would say truncated too). The
 * province grain is structurally never truncated (≤24 rows from the loader).
 *
 * `adminProvince` distinguishes the two department-grain shapes: a whole-province
 * drill (defined) threads the province's own build-time `den` truncation flag for
 * live parity; the NATIONAL department view (undefined) is a deliberate cube
 * SUPERSET over the truncated live set and declares `truncated: false` — it is not
 * subject to the live global cap, so it never claims false completeness.
 */
export function assembleCubeLayerResult(
  rows: PanoramaCubeRow[],
  level: AggregationLevel,
  adminProvince?: string,
): LayerFeaturesResult {
  if (level === "province") {
    const cells: ProvinceChoroplethCell[] = rows
      .filter((r) => r.unitLevel === "province")
      // #40: read the cube's `suppressed` flag — do NOT infer suppression from a
      // null value. `Number(r.value ?? 0)` used to turn a protected province into
      // a published 0, the exact false-zero the k-anon rule forbids. The flag is
      // the carrier; the value is nulled from it.
      .map((r) =>
        provinceCellPreDecided(
          r.unitCode,
          r.label ?? r.province,
          r.value === null ? null : Number(r.value),
          r.suppressed === true,
        ),
      );
    return {
      features: buildProvinceChoroplethFeatures(cells),
      truncated: false,
      // Counted from the SAME flags the cells were built from — this used to be
      // hardcoded 0 under the retired "provinces are never suppressed" premise,
      // which (a) broke parity with the live province loaders and (b) left a
      // fully-hatched cube-served map with no privacy disclosure at all.
      suppressedCount: cells.reduce((n, c) => n + (c.suppressed ? 1 : 0), 0),
      noLocalityCount: 0,
      level: "province",
    };
  }

  // Department (locality-axis) grain.
  const deptRows = rows.filter((r) => r.unitLevel === "department");
  const cells: ChoroplethCell[] = deptRows.map((r) => cellFromRow(r));
  const suppressedCount = deptRows.reduce((n, r) => n + (r.suppressed ? 1 : 0), 0);
  const provinceRows = rows.filter((r) => r.unitLevel === "province");
  // noLocalityCount: sum the province-grain residual over the in-scope provinces
  // (national = all rows; a province drill already filtered to that province).
  const noLocalityCount = provinceRows.reduce((n, r) => n + (r.noLocality ?? 0), 0);
  // Truncated flag: honest in BOTH scopes. The cube is built per province, and a
  // single province's own LOCALITY rollup can hit PER_LAYER_CAP at scale (Buenos
  // Aires ~2000 INDEC localities) — captured as den=1 on that province's row,
  // meaning ITS department cells are undercounts (localities dropped before the
  // fold). That incompleteness is real regardless of scope, so national must
  // union the per-province den flags too — reporting false here would hide a
  // silently-incomplete BA department view (the cube being a superset OVER the
  // live cap does not make an internally-capped province complete).
  const truncated = provinceRows.some((r) => (r.den ?? 0) !== 0);

  return {
    features: buildChoroplethFeatures(cells),
    truncated,
    suppressedCount,
    noLocalityCount,
    level: "locality",
  };
}

/** Which path served a layer request: the cube, or the live (cached) path. */
export type LayerSource = "cube" | "live";

/** A layer result plus which path served it (for the `x-layer-source` header) and,
 * for a cube hit, the cube's build timestamp; for a live hit, the Data Cache status. */
export type LayerFeaturesSourced = {
  result: LayerFeaturesResult;
  source: LayerSource;
  /** Present when source === 'cube' — the cube's freshness timestamp. */
  builtAt?: Date;
  /** Present when source === 'live' — the Data Cache hit/miss/bypass status. */
  cacheStatus?: LayerCacheStatus;
};

/**
 * Pick cube-vs-live per request, reporting which path served (the API route echoes
 * it as `x-layer-source`). Eligible + fresh → cube; otherwise the existing cached-live
 * path, UNTOUCHED. A cube read error degrades to live (never throws out the door).
 */
export async function loadLayerFeaturesCubeOrCachedWithMeta(
  layer: LayerId,
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  period: LayerPeriod,
  level: AggregationLevel = "locality",
  adminProvince?: string,
  adminLocality?: string,
  pointsMode = false,
  verifiedOnly = false,
): Promise<LayerFeaturesSourced> {
  if (!pointsMode) {
    try {
      const cube = await loadLayerFeaturesFromCube(
        layer,
        actor,
        level,
        adminProvince,
        adminLocality,
        verifiedOnly,
      );
      if (cube) return { result: cube.result, source: "cube", builtAt: cube.builtAt };
    } catch {
      // Cube read failed → fall through to live (identical to CUBE_READS off).
    }
  }
  const live = await loadLayerFeaturesCachedWithMeta(
    layer,
    actor,
    jurisdictions,
    period,
    level,
    adminProvince,
    adminLocality,
    pointsMode,
    verifiedOnly,
  );
  return { result: live.result, source: "live", cacheStatus: live.status };
}

/**
 * Thin cube-or-live variant for callers that don't need the source meta (the SSR
 * pages). Same eligibility; a cube read error degrades to the live cached path.
 */
export async function loadLayerFeaturesCubeOrCached(
  layer: LayerId,
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  period: LayerPeriod,
  level: AggregationLevel = "locality",
  adminProvince?: string,
  adminLocality?: string,
  pointsMode = false,
  verifiedOnly = false,
): Promise<LayerFeaturesResult> {
  if (!pointsMode) {
    try {
      const cube = await loadLayerFeaturesFromCube(
        layer,
        actor,
        level,
        adminProvince,
        adminLocality,
        verifiedOnly,
      );
      if (cube) return cube.result;
    } catch {
      // fall through to live
    }
  }
  return loadLayerFeaturesCached(
    layer,
    actor,
    jurisdictions,
    period,
    level,
    adminProvince,
    adminLocality,
    pointsMode,
    verifiedOnly,
  );
}

/** Reconstruct the loader's ChoroplethCell from a stored department row. Mirrors
 * `toChoroplethCells` output exactly so build-features emits identical features. */
function cellFromRow(r: PanoramaCubeRow): ChoroplethCell {
  return {
    key: r.unitCode,
    province: r.province,
    locality: r.label ?? "",
    centroidLat: r.centroidLat,
    centroidLng: r.centroidLng,
    departmentCode: r.departmentCode,
    departmentName: r.departmentName,
    value: r.suppressed ? null : r.value == null ? null : Number(r.value),
    suppressed: r.suppressed,
  };
}
