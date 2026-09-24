// Read-only GET /api/panorama/scope — the embedded-drill scope bundle.
//
// The situational-map console commits a province/locality drill CLIENT-SIDE
// (shallow History pushState, no reload — immune to the Next 15.5 router-drop
// defect, engram #621/#622). A shallow commit does NOT re-run the server page,
// so the scope-derived state the page computes (the selected province's
// localities list + their centroids) is missing on the client. This endpoint
// returns exactly that bundle for a `?province=` so the console can:
//   - repopulate the JurisdictionSwitcher's locality dropdown, and
//   - feed the map the centroids it needs to autozoom on a locality pick.
//
// It carries the SAME institutional auth gate as the sibling panorama routes
// (resolveInstitutionalPanoramaActor: active institutional admin/govt only —
// 401/403 otherwise). The payload is reference data (the ar_localities padrón,
// same source the server page reads via listLocalitiesByProvince /
// listLocalityCentroids), NOT scoped PII: the DATA rollups (layers + KPIs) stay
// scoped by their own routes' narrowGovtScope. A govt operator can only drill
// into provinces the console already offers them (allowedProvinces / the
// implicit single-province scope), so this never widens what they can see.

import { NextResponse } from "next/server";

import { narrowGovtScope } from "@/lib/domain/jurisdiction-canonical";
import { listLocalitiesByProvince, listLocalityCentroids } from "@/lib/infra/ar-localidades";
import { withDbBudget } from "@/lib/infra/db-budget";
import type { ProvinceCode } from "@/lib/reference/ar-provincias";
import { provinceByCode } from "@/lib/reference/ar-provincias";

import { resolveInstitutionalPanoramaActor } from "../_guard";

export const dynamic = "force-dynamic";

// Same budget as the sibling panorama routes ([layer], unit-history). On expiry
// the budget resolves the `null` sentinel and we answer 503 — the console's
// designed degradation (fall back to a full document navigation) — instead of
// silently returning an EMPTY locality list for a province that has localities.
const SCOPE_BUDGET_MS = 8000;

export async function GET(request: Request) {
  // Non-redirect auth: ACTIVE INSTITUTIONAL admin or govt only (same full
  // invariant set as the page guard — role + account_type + deactivation +
  // erasure). See _guard.ts.
  const auth = await resolveInstitutionalPanoramaActor();
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const provinceIso = url.searchParams.get("province");
  const provinceObj = provinceIso ? provinceByCode(provinceIso) : null;

  // Defense-in-depth (QA fix, 2026-07-11 §1): narrow a govt actor's requested
  // province to their actual assignments — the SAME narrowGovtScope guard the
  // sibling [layer]/kpis routes apply. Harmless TODAY: this bundle is public
  // padrón reference data (the ar_localities list + centroids for whatever
  // province is requested), not scoped PII, and the console only ever offers
  // a govt operator their own allowedProvinces to begin with. But without this
  // guard, a crafted `?province=` outside an operator's assignments would
  // still resolve — the guard is added NOW, before any scope-derived field is
  // ever added to this route, so that day can't turn into a leak. Admin is
  // universal scope (mirrors [layer]/route.ts's admin bypass); an unknown ISO
  // code (`!provinceObj`) and an out-of-scope province both fall to the same
  // empty bundle the console already handles for "no province selected".
  const inScope =
    auth.actor.role === "admin" ||
    narrowGovtScope(auth.actor.jurisdictions, provinceObj?.name ?? null, null).length > 0;

  // No province (national scope), an unknown ISO code, or an out-of-scope
  // province → an empty bundle. The console resets the switcher's locality
  // list + the map's centroids to empty, exactly as the server page does when
  // no province is selected.
  if (!provinceObj || !inScope) {
    return NextResponse.json(
      { localities: [], localityCentroids: {} },
      { headers: { "cache-control": "no-store" } },
    );
  }

  try {
    // REUSE the exact server-page helpers (app/{admin,gob}/panorama/page.tsx) so
    // the bundle is byte-identical to a full-reload render of the same scope.
    // Budget-bounded (death-spiral guard, task #74): on expiry the sentinel
    // `null` resolves and we fall through to the 503 path below.
    const bundle = await withDbBudget(
      Promise.all([
        listLocalitiesByProvince(provinceObj.code as ProvinceCode),
        listLocalityCentroids(provinceObj.code as ProvinceCode),
      ]),
      SCOPE_BUDGET_MS,
      "GET /api/panorama/scope",
      null,
    );
    if (bundle === null) {
      return NextResponse.json(
        { error: "panorama_scope_unavailable" },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    const [localities, localityCentroids] = bundle;
    return NextResponse.json(
      { localities, localityCentroids },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    console.error("[GET /api/panorama/scope] failed:", err);
    // A failure here degrades to today's behavior: the console falls back to a
    // full document navigation (window.location.assign), which re-runs the
    // server page with the drilled scope. Answer with a 503 so the client's
    // fetch rejects and takes the fallback.
    return NextResponse.json(
      { error: "panorama_scope_unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
