// Read-only GET /api/panorama/[layer] — the LayerPanel fetches this on toggle.
//
// Auth: admin or govt ONLY. Unlike the page guards (which REDIRECT), an API
// route must answer with a status code, so we do a non-redirect session check
// (createClient + getProfileCached) and return 401/403 via NextResponse.
//
// Scope/period are parsed from the query string (same keys as the dashboards:
// province/locality/period/from/to) and intersected with the viewer's actual
// assignments — a govt user can NEVER widen scope by crafting params. The
// use-case enforces the per-layer cap + k-anon; we echo its envelope.

import { NextResponse } from "next/server";

import { resolveAnalyticsPeriod } from "@/lib/analytics/analytics-period";
import { withDbBudget } from "@/lib/infra/db-budget";
import type { DashboardJurisdiction } from "@/lib/metrics";
import {
  emptyLayerFeatures,
  resolvePointsMode,
} from "@/src/modules/panorama/application/get-layer-features";
import { loadLayerFeaturesCubeOrCachedWithMeta } from "@/src/modules/panorama/application/load-layer-features-cube";
import { resolvePanoramaRequestScope } from "@/src/modules/panorama/application/resolve-request-scope";
import { isLayerId } from "@/src/modules/panorama/domain/layers";
import { clampAsOf, parseAsOf, parseTimeBasis } from "@/src/modules/panorama/domain/time-scrub";
import { loadScopeDailyCounts } from "@/src/modules/panorama/infrastructure/repository";

import { resolveInstitutionalPanoramaActor } from "../_guard";

export const dynamic = "force-dynamic";

// Client-side budget for a single layer fetch — see kpis/route.ts for the
// rationale. On expiry the route returns an empty FeatureCollection (200).
const LAYER_BUDGET_MS = 8000;

export async function GET(request: Request, ctx: { params: Promise<{ layer: string }> }) {
  const { layer } = await ctx.params;

  // 1. Validate the layer id (registry type guard).
  if (!isLayerId(layer)) {
    return NextResponse.json({ error: "unknown_layer" }, { status: 404 });
  }

  // 2. Non-redirect auth: ACTIVE INSTITUTIONAL admin or govt only. This routes
  //    through the same full invariant set as the page guard (role +
  //    account_type + deactivation + erasure) — a personal-account 'admin', a
  //    deactivated or an erased operator gets 401/403, never data. See _guard.ts.
  const auth = await resolveInstitutionalPanoramaActor();
  if (!auth.ok) return auth.response;
  const { role } = auth.actor;

  const actor = { role };
  const jurisdictions: DashboardJurisdiction[] = auth.actor.jurisdictions;

  // 3. Parse period + scope from the query string.
  const url = new URL(request.url);
  const sp = {
    period: url.searchParams.get("period") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  };
  const { since, until } = resolveAnalyticsPeriod(sp);

  // F4 temporal reproduction: parse an optional `asOf` ISO upper bound and clamp
  // it into [since, until] (until = "now" for presets) so a crafted param can
  // never widen the window below `since` or above the live edge. null = live.
  const asOf = clampAsOf(parseAsOf(url.searchParams.get("asOf")), since, until) ?? undefined;

  // task #77 bitemporal: replay basis. "valid" (occurred_at, default) reproduces
  // "what happened when"; "transaction" (recorded_at) reproduces "what the State
  // KNEW when". Honored by the pet_events-backed layers; a crafted value can only
  // pick between the two safe modes — it never widens scope, k-anon or auth.
  const basis = parseTimeBasis(url.searchParams.get("basis"));

  const provinceIso = url.searchParams.get("province");
  const localitySlug = url.searchParams.get("locality");

  // U5 aggregation axis (distinct from the province/locality SCOPE filter above):
  // `level=province` aggregates the choropleth layers by province (filled
  // polygons); anything else defaults to locality (centroid symbols). A crafted
  // value can only choose between the two safe levels — never widen scope.
  const level = url.searchParams.get("level") === "province" ? "province" : "locality";

  // task #78 Part 3: the "solo firmado por matrícula" toggle. A crafted `?verified=1`
  // can ONLY narrow the rabies-coverage numerator to vet-signed doses — it never
  // widens scope, k-anon or auth (all enforced below/inside the loader). Honored by
  // the `cobertura` layer only; every other layer ignores it.
  const verifiedOnly = url.searchParams.get("verified") === "1";

  // 4. Resolve the effective scope via the SHARED resolver (same block as the
  //    KPI route and both panorama pages): govt narrowing with whole-province
  //    subsumption + the admin drill-down names. The admin drill matters here so
  //    toggled layers scope to the selected province/locality exactly like the
  //    server-rendered default layer + KPIs — without it the API ignored the
  //    filter for admins and every toggled layer returned national data while
  //    the default layer showed the selected province. `provinceObj` is kept for
  //    the points-mode gate below.
  const { provinceObj, scoped, adminProvince, adminLocality } = await resolvePanoramaRequestScope({
    role,
    jurisdictions,
    province: provinceIso,
    locality: localitySlug,
  });

  // panorama-event-points Slice 1 — SERVER-AUTHORITATIVE points-mode gate (A1).
  // The client sends `mode=points` when zoomed into a jurisdiction, but the
  // server independently requires a province to be RESOLVED (provinceObj != null,
  // for admin AND govt alike). Govt stays additionally bound by petsScope inside
  // the loader. A crafted `?mode=points` with no province → false → aggregated
  // bubbles, never a national dump of every lost-pet coordinate.
  const pointsMode = resolvePointsMode(url.searchParams.get("mode"), provinceObj != null);

  // 5. Delegate to the use-case (cap + k-anon enforced inside). The level only
  // affects the two choropleth layers; point layers ignore it. Bounded + never
  // throws to the runtime (task #74): budget expiry → empty features (200);
  // fetcher rejection → 503 JSON envelope. Never crashes the lambda.
  // The layer window's upper bound: an explicit `asOf` scrub if present, else the
  // period's own `until`. Passing only `asOf` (undefined when not scrubbing) let
  // a CUSTOM period's upper bound leak — events after `to` were plotted (critique
  // of PR #762, finding 3). getLayerFeatures already treats `asOf` as the upper
  // bound of the event-windowed layers and ignores it for current-state layers,
  // so `asOf ?? until` bounds custom periods without touching the loader signature.
  const windowUntil = asOf ?? until;

  // TimeScrubber histogram (aggregate views): return per-day scope-total event
  // counts instead of features, over the SAME scope/period/drill resolved above.
  //
  // k-anon IS applied inside loadScopeDailyCounts (closing report M3, 2026-08-22).
  // The old note here — "scope-total counts carry no per-unit disclosure, so no
  // k-anon" — was the same wrong premise as the loader's header: at a
  // single-unit drill the scope total IS the unit count, and this endpoint also
  // carried each event's date. `suppressed` is passed through VERBATIM rather
  // than collapsed into an empty `histogram`: a caller must be able to tell
  // "protegido por privacidad" from "no pasó nada acá".
  //
  // Bounded + never throws to the runtime like the feature path: budget expiry →
  // empty histogram (200); rejection → 503 JSON envelope.
  if (url.searchParams.get("histogram") === "1") {
    try {
      const result = await withDbBudget(
        loadScopeDailyCounts({
          layer,
          actor,
          jurisdictions: scoped,
          since,
          until: windowUntil,
          basis,
          adminProvince,
          adminLocality,
        }),
        LAYER_BUDGET_MS,
        `GET /api/panorama/${layer}?histogram`,
        // Budget expiry is "we could not measure", not "we are hiding
        // something" — the degraded fallback must not claim suppression.
        { suppressed: false, counts: [] },
      );
      return NextResponse.json(
        { histogram: result.counts, suppressed: result.suppressed },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (err) {
      console.error(`[GET /api/panorama/${layer}?histogram] failed:`, err);
      return NextResponse.json(
        { error: "panorama_histogram_unavailable" },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
  }

  try {
    const sourced = await withDbBudget(
      // The cube composes IN FRONT of the Data Cache: an eligible admin choropleth
      // request (flag on, fresh) is served from panorama_cube; everything else keeps
      // the current cached-live path. The whole thing stays INSIDE the budget so a
      // degraded/empty fallback is never cached; points mode bypasses the cube+cache
      // internally. `source` says cube|live; `cacheStatus` echoes hit|miss|bypass on
      // the live path (mirrors the KPI route's `x-kpi-cache`).
      loadLayerFeaturesCubeOrCachedWithMeta(
        layer,
        actor,
        scoped,
        { since, asOf: windowUntil, basis },
        level,
        adminProvince,
        adminLocality,
        pointsMode,
        verifiedOnly,
      ),
      LAYER_BUDGET_MS,
      `GET /api/panorama/${layer}`,
      {
        result: emptyLayerFeatures(),
        source: "live" as const,
        cacheStatus: pointsMode ? ("bypass" as const) : ("miss" as const),
      },
    );
    const { result, source } = sourced;

    const headers: Record<string, string> = {
      "cache-control": "no-store",
      "x-layer-source": source,
      // Live path keeps the Data Cache hit/miss/bypass signal; cube path bypasses it.
      "x-layer-cache": sourced.cacheStatus ?? "bypass",
    };
    // Freshness honesty: for a cube-served layer, declare the cube's age (not hide it).
    if (source === "cube" && sourced.builtAt) {
      headers["x-cube-built-at"] = sourced.builtAt.toISOString();
    }

    // Honesty (panorama QA 2026-07-14): a budget/failure fallback must never
    // read as an empty dataset — declare it so the console can say "no pudimos
    // calcular esta capa a tiempo" instead of painting a silent blank map.
    if (result.degraded) headers["x-layer-degraded"] = "1";

    return NextResponse.json(
      {
        features: result.features,
        truncated: result.truncated,
        suppressedCount: result.suppressedCount,
        noLocalityCount: result.noLocalityCount ?? 0,
        level: result.level,
        // panorama-event-points Slice 1: points-mode envelope (undefined for the
        // aggregated path — the console falls back to its aggregated disclosure).
        mode: result.mode,
        sinUbicacionCount: result.sinUbicacionCount ?? 0,
        degraded: result.degraded ?? false,
        // task panorama-bivariate-2026-07-21: province-grain fallback for the
        // bivariate join's signal axis — set only for zoonosis at level=province
        // (see LayerFeaturesResult.bivariateSignal jsdoc). Undefined elsewhere.
        bivariateSignal: result.bivariateSignal,
      },
      { headers },
    );
  } catch (err) {
    console.error(`[GET /api/panorama/${layer}] failed:`, err);
    return NextResponse.json(
      { error: "panorama_layer_unavailable" },
      {
        status: 503,
        headers: { "cache-control": "no-store", "x-layer-source": "live", "x-layer-cache": "miss" },
      },
    );
  }
}
