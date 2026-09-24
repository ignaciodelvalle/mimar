// Cross-request (Vercel Data Cache) layer for Panorama's per-layer GeoJSON.
//
// WHY (perf plan commit 1.1): the layer APIs — /api/panorama/[layer] plus the
// default layer on the two server pages — are `force-dynamic` and recomputed the
// whole k-anon aggregation fan-out on EVERY request (measured 3.6–10s each) with
// zero server-side caching. This wraps the existing PURE `getLayerFeatures`
// use-case in Next's `unstable_cache`, so a second request for the SAME
// scope+period within the revalidate window is served from the shared Data Cache
// instead of re-running the fan-out.
//
// TWO INVARIANTS THIS MODULE PRESERVES:
//   1. The cache key IS the authorization boundary (mirrors kpis-cache). Two
//      operators with different scopes (role, jurisdiction set, admin drill-down,
//      layer, level, window, basis, verifiedOnly) MUST map to different keys, or
//      one would read the other's map. `layerCacheKey` composes EVERY argument
//      that changes the result; the scope-isolation unit test pins it.
//   2. Only the post-k-anon envelope is cached. `withDbBudget` stays OUTSIDE at
//      the call sites, so a degraded/empty fallback (budget timeout) is never
//      stored — one slow load can't freeze an empty map for the whole window.
//
// POINTS-MODE BYPASS: near-zoom points requests plot REAL, volatile, narrowly
// scoped coordinates (a single viewport). They skip the cache entirely (call
// `getLayerFeatures` directly) — caching them would spend Data Cache entries on
// single-viewport payloads with near-zero reuse.
//
// KEY STABILITY: preset periods resolve `until`/`asOf` to `Date.now()`, so a raw
// timestamp key would miss on every request. `bucket()` floors the window
// endpoints to the 300s TTL — stable within a bucket, staleness bounded by it.
// CRITICAL: Next's `unstable_cache` folds the wrapped fn's ARGUMENTS into the
// cache key (invocationKey = fixedKey + JSON.stringify(args)). So the varying
// scope is carried ENTIRELY by `keyParts` (the bucketed key string) and the
// wrapped fn is invoked with NO arguments — passing the raw timestamps as args
// would fold them into the key UN-bucketed and defeat the bucket (miss every
// request). The compute args are closed over as normalized JSON-serializable
// values (ISO strings + plain actor/jurisdictions/flags); Dates are reconstructed
// inside the pure fn, which never touches headers()/cookies().

import { unstable_cache } from "next/cache";

import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";

import type { TimeBasis } from "@/src/modules/panorama/domain/time-scrub";
import type { AggregationLevel, LayerId } from "@/src/modules/panorama/domain/types";

import { withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { isIncrementalCacheMissing, warnIncrementalCacheMissingOnce } from "./data-cache";
import { type LayerFeaturesResult, type LayerPeriod, getLayerFeatures } from "./get-layer-features";

/**
 * Time budget for the COMPUTE INSIDE the Data Cache boundary (task #39, incident
 * `panorama/layer-cache-revalidation-crash`). The budget stays OUTSIDE the cache
 * at the request call sites so a degraded envelope is never stored — but that left
 * Next's stale-while-revalidate BACKGROUND re-invocation running the raw loader
 * UNBUDGETED (a >300s Postgres 57014 escaped as an unhandledRejection and killed a
 * process). Wrapping the cached body with `withDbBudgetOrThrow` bounds that
 * background work and THROWS on timeout — so `unstable_cache` keeps the stale entry
 * instead of caching a degraded one (invariant #2 preserved). Generous enough that
 * a healthy fan-out (measured 3.6–10s) still completes and warms the cache, but far
 * below the transaction-pooler pathology (>180s) so node never bounds the work at
 * 300s again.
 */
export const LAYER_CACHE_COMPUTE_BUDGET_MS = 30_000;

/**
 * Key-bucket width: 300s, ALIGNED WITH `LAYER_CACHE_REVALIDATE_S`. Preset
 * periods advance `until`/`asOf` to now on every request; flooring the window
 * endpoints to this bucket keeps the key stable while bounding staleness.
 *
 * MEASURED ON STAGING (2026-07-09): the original 60s bucket made the rolling
 * `until=now` produce a NEW key every minute, so the 300s-TTL entries could
 * only ever hit within the same minute — repeat loads minutes apart always
 * recomputed (layer APIs stayed at 3-11s). Bucket == TTL means a key stays
 * live for exactly one revalidate window; worst-case data staleness is
 * bucket + TTL ≈ 10 min, fine for day-granularity synthetic aggregates.
 */
export const LAYER_KEY_BUCKET_MS = 300_000;

/**
 * How long a cached layer envelope lives in the Data Cache before it goes stale
 * and is revalidated. Aligned with the key bucket (`LAYER_KEY_BUCKET_MS`): the
 * 300s bucket controls key stability; this 5-minute revalidate controls entry
 * lifetime — a key stays live for exactly one revalidate window.
 */
export const LAYER_CACHE_REVALIDATE_S = 300;

/**
 * Floor a timestamp to the key bucket (replica of kpis-cache's `bucket` — the
 * modules stay decoupled). Flooring both window endpoints makes a moving preset
 * `until`/`asOf` produce a STABLE key within a bucket; layer windows are
 * day-granularity, so sub-minute jitter changes no rendered cell.
 */
function bucket(ms: number, bucketMs: number = LAYER_KEY_BUCKET_MS): number {
  return Math.floor(ms / bucketMs) * bucketMs;
}

/** The full authorization + query scope that uniquely determines a layer result. */
export type LayerCacheScope = {
  role: DashboardActor["role"];
  /** The ALREADY-NARROWED jurisdictions (govt); empty for admin. */
  jurisdictions: DashboardJurisdiction[];
  layer: LayerId;
  level: AggregationLevel;
  /** Lower bound of the window. */
  since: Date;
  /** Effective upper bound (asOf scrub, or the period's `until`); undefined = live edge. */
  asOf?: Date;
  /** Replay basis: "valid" (occurred_at, default) or "transaction" (recorded_at). */
  basis?: TimeBasis;
  /** Admin drill-down province/locality (undefined for govt). */
  adminProvince?: string;
  adminLocality?: string;
  /** cobertura "solo firmado por matrícula" numerator narrowing. */
  verifiedOnly?: boolean;
};

/**
 * Compose the cache key from the FULL scope. Jurisdictions are normalized to a
 * SORTED, order-independent list so `[BA/La Plata, SF/Rosario]` and
 * `[SF/Rosario, BA/La Plata]` share an entry, while any difference in the set (or
 * in role / layer / level / admin drill-down / window bucket / basis / verified)
 * yields a distinct key. The ` ` field separator can't appear in a
 * province/locality name, so two distinct pairs never alias into one token.
 */
export function layerCacheKey(
  scope: LayerCacheScope,
  bucketMs: number = LAYER_KEY_BUCKET_MS,
): string {
  const jurisdictions = scope.jurisdictions
    .map((j) => `${j.province} ${j.locality}`)
    .sort()
    .join(";");
  return [
    `role=${scope.role}`,
    `juris=${jurisdictions}`,
    `layer=${scope.layer}`,
    `level=${scope.level}`,
    `since=${bucket(scope.since.getTime(), bucketMs)}`,
    `asOf=${scope.asOf ? bucket(scope.asOf.getTime(), bucketMs) : ""}`,
    `basis=${scope.basis ?? "valid"}`,
    `adminP=${scope.adminProvince ?? ""}`,
    `adminL=${scope.adminLocality ?? ""}`,
    `verified=${scope.verifiedOnly ? "1" : "0"}`,
  ].join("|");
}

/** Whether a layer result came from the Data Cache, was recomputed, or bypassed it. */
export type LayerCacheStatus = "hit" | "miss" | "bypass";

/** A layer result paired with how it was served (for the `x-layer-cache` header). */
export type LayerFeaturesWithMeta = {
  result: LayerFeaturesResult;
  status: LayerCacheStatus;
};

/**
 * Cross-request cached variant of `getLayerFeatures` that ALSO reports how the
 * result was served (`hit` | `miss` | `bypass`) so a route handler can surface an
 * `x-layer-cache` response header (mirrors the KPI route's `x-kpi-cache`).
 *
 * `unstable_cache` has no hit/miss signal, so we detect it structurally: the
 * wrapped fn only runs on a MISS, so a closure flag it flips distinguishes the
 * two deterministically (a hit resolves from the Data Cache without invoking it).
 *
 * Caches the post-k-anon envelope for `LAYER_CACHE_REVALIDATE_S`, keyed by the
 * bucketed `layerCacheKey`. Bypasses the cache for points-mode requests.
 */
export function loadLayerFeaturesCachedWithMeta(
  layer: LayerId,
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  period: LayerPeriod,
  level: AggregationLevel = "locality",
  adminProvince?: string,
  adminLocality?: string,
  pointsMode = false,
  verifiedOnly = false,
): Promise<LayerFeaturesWithMeta> {
  // Direct (uncached) compute — the source of truth. Used for the points-mode
  // bypass, as the cached fn's body, and as the fallback when no Data Cache is
  // available (non-render contexts). `directPointsMode` lets the cached path
  // force points off while the bypass keeps the caller's value.
  const directLoad = (directPointsMode: boolean) =>
    getLayerFeatures(
      layer,
      actor,
      jurisdictions,
      period,
      level,
      adminProvince,
      adminLocality,
      directPointsMode,
      verifiedOnly,
    );

  // Points mode bypasses the cache: real, volatile, single-viewport coordinates.
  if (pointsMode) return directLoad(true).then((result) => ({ result, status: "bypass" }));

  const key = layerCacheKey({
    role: actor.role,
    jurisdictions,
    layer,
    level,
    since: period.since,
    asOf: period.asOf,
    basis: period.basis,
    adminProvince,
    adminLocality,
    verifiedOnly,
  });

  // The wrapped fn runs ONLY on a cache miss; the closure flag it flips lets us
  // report hit vs miss (a hit resolves from the Data Cache without calling it).
  let computed = false;
  const cached = unstable_cache(
    () => {
      computed = true;
      // Bound the compute INSIDE the cache so Next's background stale-revalidation
      // can never run this loader unbudgeted (the crash). On timeout it THROWS, so
      // unstable_cache keeps the stale entry rather than caching a degraded one.
      return withDbBudgetOrThrow(
        directLoad(false),
        LAYER_CACHE_COMPUTE_BUDGET_MS,
        `layer-cache revalidate '${layer}'`,
      );
    },
    [key],
    { revalidate: LAYER_CACHE_REVALIDATE_S },
  );

  return cached()
    .then<LayerFeaturesWithMeta>((result) => ({ result, status: computed ? "miss" : "hit" }))
    .catch((err) => {
      // No Data Cache in this context (unit test / script; or a prod outage) →
      // compute uncached. Warn once so a production outage is visible in logs.
      if (isIncrementalCacheMissing(err)) {
        warnIncrementalCacheMissingOnce(`layer '${layer}'`);
        return directLoad(false).then((result) => ({ result, status: "miss" as const }));
      }
      throw err;
    });
}

/**
 * Cross-request cached variant of `getLayerFeatures`. A DROP-IN replacement with
 * the same signature — wire it INSIDE the existing `withDbBudget` at the call
 * sites so the budget/degraded boundary stays outside the cache.
 *
 * Thin wrapper over `loadLayerFeaturesCachedWithMeta` for callers (the SSR pages)
 * that don't need the cache-status meta.
 */
export function loadLayerFeaturesCached(
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
  return loadLayerFeaturesCachedWithMeta(
    layer,
    actor,
    jurisdictions,
    period,
    level,
    adminProvince,
    adminLocality,
    pointsMode,
    verifiedOnly,
  ).then((r) => r.result);
}
