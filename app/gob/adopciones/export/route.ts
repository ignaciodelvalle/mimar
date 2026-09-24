// GET /gob/adopciones/export — CSV download for the Adopciones dashboard
// (Wave C, gob-audit-inventory item 2). See app/gob/poblacion/export/route.ts
// for the shared rationale (aggregate-only export, no Storage round-trip).

import { type NextRequest, NextResponse } from "next/server";

import { loadWithTimeout } from "@/lib/analytics/analytics-load";
import {
  buildSectionedCsv,
  csvDownloadResponse,
  logGobDashboardExport,
} from "@/lib/analytics/govt-dashboard-export";
import { resolveJurisdictionScope } from "@/lib/analytics/jurisdiction-scope";
import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import {
  buildProjectionContext,
  fetchCustodyFunnel,
  fetchFosterPoolUtilization,
  fetchReturnRate,
  fetchShelterOccupancyNational,
  fetchTimeInState,
} from "@/lib/metrics";
import { resolveAnalyticsPeriod } from "@/lib/metrics/period";

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
  // Species domain axis — identical param + no-validation-needed pass-through
  // as app/gob/adopciones/page.tsx (pets.species is free text, honored as-is).
  const species = searchParams.get("species") ?? undefined;

  // Jurisdiction filter — identical logic to app/gob/adopciones/page.tsx.
  const { filteredJurisdictions, adminSelectedProvince, adminSelectedLocality } =
    await resolveJurisdictionScope({
      role: profile.role,
      jurisdictions,
      params: { province: searchParams.get("province"), locality: searchParams.get("locality") },
    });
  // Both undefined unless role === "admin" — same pattern as the page.
  const adminProvince = adminSelectedProvince ?? undefined;
  const adminLocality = adminSelectedLocality ?? undefined;

  const period = resolveAnalyticsPeriod(sp);
  const actor = { role: profile.role } as const;
  const ctx = buildProjectionContext(actor, filteredJurisdictions, period, {
    adminProvince,
    adminLocality,
  });

  // species narrows funnel/timeInState/returnRate identically to the page
  // (domain-axes export parity fix). fosterPool and shelterOccupancy
  // deliberately do NOT take species — same honest skip as the page (foster
  // pool is volunteer-level with no species dimension; shelter occupancy's
  // capacity denominator is org-level and can't be split by species).
  //
  // BOUNDED (2026-08-09, discovery scan). Same five population-scale aggregates
  // the page runs, and the page has been bounded since the outage pass while
  // this route — reachable by the same click, from the same bar — was not. An
  // export that hangs holds a connection with no UI to show for it; 503 tells
  // the operator to retry instead of leaving the download spinning.
  const load = await loadWithTimeout(
    Promise.all([
      fetchCustodyFunnel(ctx, { species }),
      fetchTimeInState(ctx, { species }),
      fetchReturnRate(ctx, { species }),
      fetchFosterPoolUtilization(ctx),
      fetchShelterOccupancyNational(ctx),
    ]),
  );
  if (!load.ok) {
    return new Response(
      "No pudimos generar el export en este momento. Reintentá en unos minutos.",
      {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "60" },
      },
    );
  }
  const [funnel, timeInState, returnRateValue, fosterPool, shelterOccupancy] = load.value;

  const returnRatePct = returnRateValue != null ? Math.round(returnRateValue * 1000) / 10 : "";

  const summaryRows = [
    {
      en_custodia_refugio: shelterOccupancy.occupied,
      en_transito_foster: fosterPool.activeFosterPlacements,
      adopciones_periodo: funnel.adoption,
      tasa_retorno_pct: returnRatePct,
      voluntarios_foster_activos: fosterPool.activeVolunteers,
      voluntarios_con_cupo: fosterPool.withCapacity,
    },
  ];

  const funnelRows = [
    { etapa: "Ingresos al refugio", cantidad: funnel.intake },
    { etapa: "Asignados a tránsito", cantidad: funnel.foster },
    { etapa: "Adopciones finalizadas", cantidad: funnel.adoption },
    { etapa: "Devoluciones", cantidad: funnel.reversed },
  ];

  const timeInStateRows = timeInState.map((r) => ({
    rol: r.role,
    mediana_dias: r.medianDays ?? "",
    p75_dias: r.p75Days ?? "",
    registros: r.n,
  }));

  const csvContent = buildSectionedCsv([
    { title: "resumen", rows: summaryRows },
    { title: "embudo_colocacion", rows: funnelRows },
    { title: "tiempo_en_estado", rows: timeInStateRows },
  ]);

  await logGobDashboardExport(user.id, "adopciones", {
    resumen: summaryRows.length,
    embudo_colocacion: funnelRows.length,
    tiempo_en_estado: timeInStateRows.length,
  });

  const filename = `adopciones-${new Date().toISOString().slice(0, 10)}.csv`;
  return csvDownloadResponse(csvContent, filename);
}
