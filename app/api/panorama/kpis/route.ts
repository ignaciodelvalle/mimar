// Read-only GET /api/panorama/kpis — the console's headline KPI strip.
//
// Used when the KPIs refetch on a client-side filter change (the page can also
// server-render the initial KPIs). Auth + scope intersection MIRROR the sibling
// /api/panorama/[layer]/route.ts EXACTLY:
//   - non-redirect session check (an API route answers with a status code, not
//     a redirect): 401 when unauthenticated, 403 when not admin/govt,
//   - scope is parsed from the query string (province/locality/period/from/to,
//     same keys as the dashboards) and INTERSECTED with the viewer's actual
//     assignments — a govt user can NEVER widen scope by crafting params.
//
// The KPI numbers come from getPanoramaKpis, which reuses the tested dashboard
// fetchers — the console can never desync from the detail dashboards.

import { NextResponse } from "next/server";

import { resolveAnalyticsPeriod } from "@/lib/analytics/analytics-period";
import type { DashboardJurisdiction } from "@/lib/metrics";
import { degradedPanoramaKpis } from "@/src/modules/panorama/application/get-panorama-kpis";
import { loadCachedPanoramaKpis } from "@/src/modules/panorama/application/load-panorama-kpis";
import { resolvePanoramaRequestScope } from "@/src/modules/panorama/application/resolve-request-scope";

import { resolveInstitutionalPanoramaActor } from "../_guard";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // 1. Non-redirect auth: ACTIVE INSTITUTIONAL admin or govt only (same full
  //    invariant set as the page guard — role + account_type + deactivation +
  //    erasure). Personal-account 'admin', deactivated, and erased operators get
  //    401/403, never data. See _guard.ts.
  const auth = await resolveInstitutionalPanoramaActor();
  if (!auth.ok) return auth.response;
  const { role } = auth.actor;

  const actor = { role };
  const jurisdictions: DashboardJurisdiction[] = auth.actor.jurisdictions;

  // 2. Parse period + scope from the query string (same keys as the dashboards).
  const url = new URL(request.url);
  const period = resolveAnalyticsPeriod({
    period: url.searchParams.get("period") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  });

  const provinceIso = url.searchParams.get("province");
  const localitySlug = url.searchParams.get("locality");

  // Coherence hybrid (H1): the temporal-scrub cutoff. When present, the temporal
  // KPIs (mordeduras/zoonosis/denuncias-in-period) compute as-of this instant so
  // the big numbers track the map + Registros the scrubber already moves. An
  // unparseable value is ignored (treated as live) — never trusted blindly.
  const asOfParam = url.searchParams.get("asOf");
  const asOfDate = asOfParam ? new Date(asOfParam) : null;
  const asOf = asOfDate && !Number.isNaN(asOfDate.getTime()) ? asOfDate : null;

  // 3. Resolve the effective scope via the SHARED resolver (same block as the
  //    layer route and both panorama pages): govt narrowing with whole-province
  //    subsumption + the admin drill-down names. The admin drill matters here so
  //    a client KPI refetch on a filter change scopes to the selected
  //    province/locality — without it the route ignored the admin filter and a
  //    refetch silently returned NATIONAL KPIs (critique of PR #762, finding 1).
  const { scoped, adminProvince, adminLocality } = await resolvePanoramaRequestScope({
    role,
    jurisdictions,
    province: provinceIso,
    locality: localitySlug,
  });

  // 5. Delegate to the shared cached loader (src/.../load-panorama-kpis.ts).
  //    Short-TTL server cache (60s) keyed by the FULL authorization scope, so a
  //    burst of reloads on the warm-cold micro DB collapses onto ONE fan-out per
  //    scope instead of tripping the 20s budget on ~1 of 3 reloads (overnight QA).
  //    Degraded results (empty strip from budget exhaustion) are NOT cached, so
  //    one bad load never poisons the next 60s. The SAME loader now backs the
  //    SERVER page render (app/{admin,gob}/panorama/page.tsx), so a browser
  //    RELOAD hits this warm per-lambda cache too instead of re-running the
  //    fan-out under a tight budget (staging QA 2026-07-08 finding #1).
  //
  //    It NEVER throws to the runtime (task #74):
  //    - budget elapses (DB degraded / queries hang) → 200 with a degraded strip.
  //    - fetcher rejected (getPanoramaKpis throws) → 503 JSON error envelope.
  //    Either way the lambda answers cleanly instead of crashing mid-response.
  try {
    const {
      value: result,
      cacheHit,
      source,
      cubeBuiltAt,
    } = await loadCachedPanoramaKpis({
      actor,
      jurisdictions: scoped,
      period,
      adminProvince,
      adminLocality,
      asOf,
      label: "GET /api/panorama/kpis",
    });
    // `x-kpi-source` mirrors the layer route's `x-layer-source` (cube | live);
    // a cube hit also declares its build timestamp so a client can surface the
    // same freshness stamp the layer path threads via resolveCubeFreshness.
    return NextResponse.json(result, {
      headers: {
        "cache-control": "no-store",
        "x-kpi-cache": cacheHit ? "hit" : "miss",
        "x-kpi-source": source,
        ...(cubeBuiltAt ? { "x-kpi-cube-built-at": cubeBuiltAt.toISOString() } : {}),
      },
    });
  } catch (err) {
    console.error("[GET /api/panorama/kpis] failed:", err);
    return NextResponse.json(
      { error: "panorama_kpis_unavailable", ...degradedPanoramaKpis() },
      { status: 503, headers: { "cache-control": "no-store", "x-kpi-cache": "miss" } },
    );
  }
}
