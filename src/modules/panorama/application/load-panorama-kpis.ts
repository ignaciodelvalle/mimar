// Shared, cached + budgeted loader for the Panorama KPI strip.
//
// WHY THIS EXISTS (staging QA 2026-07-08, finding #1 — "indicators load
// intermittently"): the KPI fan-out had TWO entry points with DIFFERENT
// resilience:
//   - the /api/panorama/kpis route (client refetch on a filter change) wrapped
//     the fan-out in a 20s budget AND a 60s short-TTL cache;
//   - the SERVER page render (app/{admin,gob}/panorama/page.tsx) — the path a
//     browser RELOAD actually re-runs — was UNCACHED with a tighter 9s budget.
// So a funcionario reloading the console re-ran the full ~12-query fan-out under
// the tight budget every time; under concurrent load it tripped the budget and
// the strip fell into the honest "No pudimos cargar los indicadores" degraded
// state — the indicators appeared to VANISH on reload.
//
// This module gives BOTH entry points ONE loader: kpiCacheKey → getCachedPanoramaKpis
// (the same module-level per-lambda cache) wrapping withDbBudget(getPanoramaKpis).
// A reload within the 60s TTL now collapses onto the warm cache instead of
// re-running the fan-out, so the indicators cannot vanish on reload. Degraded
// (budget-exhausted) results are still never cached, so one bad load never
// poisons the next window.

import { unstable_cache } from "next/cache";

import { reportError } from "@/lib/infra/report-error";
import type { AnalyticsPeriod, DashboardActor, DashboardJurisdiction } from "@/lib/metrics";

import { withDbBudget } from "@/lib/infra/db-budget";
import { isIncrementalCacheMissing, warnIncrementalCacheMissingOnce } from "./data-cache";
import { type PanoramaKpis, degradedPanoramaKpis, getPanoramaKpis } from "./get-panorama-kpis";
import { type CachedKpisResult, getCachedPanoramaKpis, kpiCacheKey } from "./kpis-cache";
import { loadPanoramaKpisFromCube } from "./load-panorama-kpis-cube";

// Time budget for the KPI fan-out. The fan-out runs on the ANALYTICS pool
// (session pooler — measured ~1.7s worst case: universal scope, 3y window), so
// 20s is generous headroom ABOVE the 15s DB statement_timeout: a genuinely
// stuck query is cancelled server-side first (SQLSTATE 57014 → rejection →
// degraded fallback) and only a pathology the DB can't cancel falls through to
// the budget's degraded result. Shared by the API route AND the server pages so
// a reload gets the same headroom the client refetch already had (previously the
// pages used a tighter 9s budget, which tripped under load — staging QA #1).
export const KPIS_BUDGET_MS = 20_000;

/**
 * L2 (cross-request Vercel Data Cache) revalidate window for the KPI fan-out.
 * Matches the L1 per-lambda TTL (60s) so both cache layers agree on freshness.
 */
export const KPIS_CACHE_REVALIDATE_S = 60;

/** A real (non-degraded) strip carries at least one tile; a degraded strip has none. */
const isRealKpiStrip = (value: PanoramaKpis): boolean => value.kpis.length > 0;

/**
 * Thrown INSIDE the L2 cached fan-out when the result is a degraded (empty)
 * strip, so Next's `unstable_cache` never PERSISTS it (a thrown result is not
 * stored). Caught immediately OUTSIDE the cache and converted back to a plain
 * degraded strip returned UNCACHED. `getPanoramaKpis` normally THROWS on a
 * fetcher failure (never returns an empty strip), so this is a defensive
 * belt-and-suspenders guard mirroring the L1 `shouldCache` predicate.
 */
class DegradedKpiStripError extends Error {
  constructor() {
    super("panorama KPI fan-out produced a degraded strip — not cacheable");
    this.name = "DegradedKpiStripError";
  }
}

/**
 * L2: wrap the underlying KPI fan-out in the shared Vercel Data Cache, keyed by
 * the SAME bucketed `kpiCacheKey` string as the L1 Map, so a browser reload that
 * lands on a COLD lambda still skips the ~17-query fan-out when a warm entry
 * exists cross-request.
 *
 * KEY STABILITY: the wrapped fn takes NO arguments; the varying scope rides
 * entirely in `keyParts` (the bucketed key). Compute args are closed over as
 * normalized ISO strings and reconstructed inside the pure fn (no headers()/
 * cookies()) — passing the raw timestamps as args would fold them into Next's
 * cache key un-bucketed and defeat the 60s bucket.
 *
 * DEGRADED NEVER CACHED: `withDbBudget` stays OUTSIDE this call (in
 * `loadCachedPanoramaKpis`), and the sentinel-throw guard ensures the Data Cache
 * only ever holds a real strip. A real fetcher failure propagates as
 * `PanoramaKpisUnavailableError` (unstable_cache never stores a throw) so the
 * caller degrades exactly as before.
 */
function computeCachedKpiFanOut(
  cacheKey: string,
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  period: AnalyticsPeriod,
  adminProvince: string | undefined,
  adminLocality: string | undefined,
  asOf: Date | null | undefined,
): Promise<PanoramaKpis> {
  // Direct (uncached) fan-out — the source of truth, shared by the cached fn's
  // body and the no-Data-Cache fallback so both paths compute identically. `asOf`
  // rides through the closure (and folds into `cacheKey` via `keyParts`) so a
  // scrubbed frame never aliases the live entry (coherence hybrid H1).
  const fanOut = () =>
    getPanoramaKpis(actor, jurisdictions, period, adminProvince, adminLocality, asOf);

  const cached = unstable_cache(
    async () => {
      const result = await fanOut();
      // Never let unstable_cache persist a degraded (empty) strip.
      if (!isRealKpiStrip(result)) throw new DegradedKpiStripError();
      return result;
    },
    [cacheKey],
    { revalidate: KPIS_CACHE_REVALIDATE_S },
  );

  return cached().catch((err) => {
    // The sentinel means "degraded" → return it UNCACHED.
    if (err instanceof DegradedKpiStripError) return degradedPanoramaKpis();
    // No Data Cache in this context (unit test / script; or a prod outage) → run
    // the fan-out uncached (getPanoramaKpis throws on a real failure → propagates
    // as before). Warn once so a production outage is visible in the logs.
    if (isIncrementalCacheMissing(err)) {
      warnIncrementalCacheMissingOnce("KPI fan-out");
      return fanOut();
    }
    // Any other rejection (a real fetcher failure) propagates so the caller degrades.
    throw err;
  });
}

export type LoadCachedPanoramaKpisParams = {
  actor: DashboardActor;
  /** The ALREADY-NARROWED jurisdictions (govt scope enforced upstream). */
  jurisdictions: DashboardJurisdiction[];
  period: AnalyticsPeriod;
  /** Admin drill-down province/locality (undefined for govt). */
  adminProvince?: string;
  adminLocality?: string;
  /** Temporal-scrub cutoff (coherence hybrid H1). Null/undefined = live. */
  asOf?: Date | null;
  /** Time budget in ms. Defaults to KPIS_BUDGET_MS. */
  budgetMs?: number;
  /** Short log label, e.g. "GET /api/panorama/kpis" or "gob/panorama kpis". */
  label: string;
};

/** Which path served the strip (echoed by the API as `x-kpi-source`, mirroring
 * the layer route's `x-layer-source`). */
export type KpiSource = "cube" | "live";

/** CachedKpisResult plus the serving path and, for a cube hit, the cube's
 * build timestamp. Additive over CachedKpisResult so pre-existing callers
 * destructuring { value, cacheHit } are untouched. */
export type LoadedKpisResult = CachedKpisResult & {
  source: KpiSource;
  /** Present when source === 'cube' — the cube's freshness timestamp. */
  cubeBuiltAt?: Date;
};

/**
 * Resolve the headline KPIs for a scope. The CUBE COMPOSES IN FRONT (migration
 * 0151, behind CUBE_READS): an eligible admin-national request with the default
 * period is served from the precomputed strip; everything else — and any cube
 * read error — takes the existing cached-live path UNTOUCHED (L1 per-lambda
 * cache → budget → L2 Data Cache → fan-out), identical to CUBE_READS off.
 *
 * The cache key is derived from the FULL authorization scope — two operators
 * with different scopes can NEVER share an entry (kpis-cache scope-isolation
 * test). On a budget-exhausted (degraded) result the value is returned but NOT
 * cached, so one bad load never freezes the honest error for the next 60s.
 *
 * NEVER-CRASH: a fetcher rejection propagates out of `compute` (before the
 * budget) so an API caller can answer 503; a page caller adds its own `.catch`
 * to degrade instead. A budget timeout resolves the degraded strip.
 */
export async function loadCachedPanoramaKpis(
  params: LoadCachedPanoramaKpisParams,
): Promise<LoadedKpisResult> {
  try {
    const cube = await loadPanoramaKpisFromCube({
      actor: params.actor,
      jurisdictions: params.jurisdictions,
      period: params.period,
      adminProvince: params.adminProvince,
      adminLocality: params.adminLocality,
      asOf: params.asOf,
    });
    if (cube) {
      return { value: cube.value, cacheHit: false, source: "cube", cubeBuiltAt: cube.builtAt };
    }
  } catch (err) {
    // Cube read failed → fall through to live (identical to CUBE_READS off).
    // Logged so a persistently broken cube degrades VISIBLY, not silently.
    reportError("panorama/kpi-cube-read", err);
  }
  const live = await loadLivePanoramaKpis(params);
  return { ...live, source: "live" };
}

/** The pre-cube live path, verbatim (L1 → budget → L2 → fan-out). */
function loadLivePanoramaKpis(params: LoadCachedPanoramaKpisParams): Promise<CachedKpisResult> {
  const cacheKey = kpiCacheKey({
    role: params.actor.role,
    jurisdictions: params.jurisdictions,
    since: params.period.since,
    until: params.period.until,
    adminProvince: params.adminProvince,
    adminLocality: params.adminLocality,
    asOf: params.asOf,
  });
  return getCachedPanoramaKpis(
    cacheKey,
    // L1 (per-lambda Map) → withDbBudget → L2 (cross-request Data Cache) →
    // getPanoramaKpis. The budget stays OUTSIDE L2 so a budget-timeout degraded
    // is never stored; L2 lets a reload on a COLD lambda still skip the fan-out.
    () =>
      withDbBudget(
        computeCachedKpiFanOut(
          cacheKey,
          params.actor,
          params.jurisdictions,
          params.period,
          params.adminProvince,
          params.adminLocality,
          params.asOf,
        ),
        params.budgetMs ?? KPIS_BUDGET_MS,
        params.label,
        degradedPanoramaKpis(),
      ),
    // Only a real strip (tiles present) is cached — degraded strips carry no
    // tiles (kpis: []), so caching one would freeze the honest error for 60s.
    { shouldCache: isRealKpiStrip },
  );
}
