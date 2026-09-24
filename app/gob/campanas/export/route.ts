// GET /gob/campanas/export — CSV download for the Campañas dashboard
// (Wave C, gob-audit-inventory item 2). See app/gob/poblacion/export/route.ts
// for the shared rationale (aggregate-only export, no Storage round-trip).

import { type NextRequest, NextResponse } from "next/server";

import { fetchCampaignDashboard } from "@/lib/analytics/campaign-metrics";
import {
  buildSectionedCsv,
  csvDownloadResponse,
  logGobDashboardExport,
} from "@/lib/analytics/govt-dashboard-export";
import { resolveJurisdictionScope } from "@/lib/analytics/jurisdiction-scope";
import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import { buildProjectionContext, resolveAnalyticsPeriod, windows } from "@/lib/metrics";
import { findServiceKind } from "@/lib/reference/service-kinds";

export async function GET(request: NextRequest): Promise<Response> {
  let profile: Awaited<ReturnType<typeof requireAdminOrGovtOrRedirect>>["profile"];
  let jurisdictions: Awaited<ReturnType<typeof requireAdminOrGovtOrRedirect>>["jurisdictions"];
  let user: Awaited<ReturnType<typeof requireAdminOrGovtOrRedirect>>["user"];

  try {
    ({ profile, jurisdictions, user } = await requireAdminOrGovtOrRedirect());
  } catch {
    return NextResponse.redirect(new URL("/iniciar-sesion", request.url));
  }

  const hasAccess =
    profile.role === "admin" || (profile.role === "govt" && jurisdictions.length > 0);
  if (!hasAccess) {
    return new NextResponse("Acceso denegado", { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const sp = {
    period: searchParams.get("period") ?? undefined,
    from: searchParams.get("from") ?? undefined,
    to: searchParams.get("to") ?? undefined,
  };
  // Service-kind domain axis — validated against the closed SERVICE_KINDS
  // catalog so an invalid URL value never drives the query, identical
  // discipline to app/gob/campanas/page.tsx.
  const kindParam = searchParams.get("kind");
  const serviceKind = kindParam && findServiceKind(kindParam) ? kindParam : undefined;

  // Jurisdiction filter — identical logic to app/gob/campanas/page.tsx.
  const { filteredJurisdictions, adminSelectedProvince, adminSelectedLocality } =
    await resolveJurisdictionScope({
      role: profile.role,
      jurisdictions,
      params: { province: searchParams.get("province"), locality: searchParams.get("locality") },
    });
  // Both undefined unless role === "admin" — same pattern as the page.
  const adminProvince = adminSelectedProvince ?? undefined;
  const adminLocality = adminSelectedLocality ?? undefined;

  // Same default-window quirk as the page: campañas defaults to trailing 30d
  // (not the 12m dashboard default) when no period/from param is present.
  const period = sp.period || sp.from ? resolveAnalyticsPeriod(sp) : windows.trailing30d();
  const actor = { role: profile.role };
  const ctx = buildProjectionContext(actor, filteredJurisdictions, period, {
    adminProvince,
    adminLocality,
  });

  // serviceKind narrows resolveOfferingIds' offering list identically to the
  // page (domain-axes export parity fix) — cascades to every downstream
  // sub-fetch so the exported summary/per-offering/geo-reach sections match
  // the on-screen dashboard exactly under the same filter.
  const dashboard = await fetchCampaignDashboard(ctx, { serviceKind });

  const summaryRows = [
    {
      inscripciones: dashboard.totals.enrollment,
      completitud_pct: dashboard.totals.completionRate ?? "",
      asistencias: dashboard.totals.completion,
      ausencias: dashboard.totals.noShow,
    },
  ];

  const offeringRows = dashboard.offerings.map((o) => ({
    servicio: o.displayName,
    tipo: findServiceKind(o.serviceKind)?.label ?? o.serviceKind,
    provincia: o.jurisdictionProvince ?? "",
    localidad: o.jurisdictionLocality ?? "",
    inscripciones: o.enrollment,
    completitud_pct: o.completionRate ?? "",
    ausencias: o.noShow,
  }));

  // k-anonymity: dashboard.geoReach.rows comes out of
  // lib/analytics/campaign-metrics.ts (fetchGeoReach → suppressGeoReach), the
  // same suppressed data the on-screen table renders — there is no separate
  // unsuppressed query here.
  //
  // This used to end "so the CSV cannot leak a sub-threshold locality count".
  // That was false until 2026-08-22 (closing report M5): the per-province fold
  // was built unconditionally, so a province with exactly ONE hidden locality
  // printed that locality's protected count under the label "Otras localidades
  // (privacidad)" — and, because both surfaces read the same rows, on screen
  // too. The claim is true now because suppressGeoReach drops a fold that stays
  // under k, not because reading suppressed rows makes a leak impossible.
  const geoReachRows = dashboard.geoReach.rows.map((r) => ({
    localidad: r.locality,
    provincia: r.province ?? "",
    asistencias: r.attendedCount,
  }));

  const csvContent = buildSectionedCsv([
    { title: "resumen", rows: summaryRows },
    { title: "performance_por_servicio", rows: offeringRows },
    { title: "alcance_geografico", rows: geoReachRows },
  ]);

  await logGobDashboardExport(user.id, "campanas", {
    resumen: summaryRows.length,
    performance_por_servicio: offeringRows.length,
    alcance_geografico: geoReachRows.length,
  });

  const filename = `campanas-${new Date().toISOString().slice(0, 10)}.csv`;
  return csvDownloadResponse(csvContent, filename);
}
