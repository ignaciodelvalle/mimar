// GET /gob/poblacion/export — CSV download for the Control poblacional
// dashboard (Wave C, gob-audit-inventory item 2).
//
// Mirrors /gob/outreach/export's direct-download pattern: this exports
// AGGREGATE rows (per-province sterilization coverage + a KPI summary), not
// raw pet-level PII, so no Storage upload / signed URL / email round-trip is
// needed — see lib/analytics/govt-dashboard-export.ts for the shared
// rationale. Respects the same province/locality/period query params the
// page itself reads, so "Exportar CSV" always matches what the operator is
// looking at.

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
  SUPPRESSED_CELL_TEXT,
  buildProjectionContext,
  fetchActivePregnancies,
  fetchNetGrowth,
  fetchReproductiveOutcomes,
  fetchSterilizationCoverage,
  fetchSterilizationNatalidadRatio,
  provinceSuppressionNotice,
  scopeSummaryRow,
  scopeTotalSuppressionNotice,
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
  // as app/gob/poblacion/page.tsx (pets.species is free text, honored as-is).
  const species = searchParams.get("species") ?? undefined;

  // Jurisdiction filter — identical logic to app/gob/poblacion/page.tsx so
  // the export always matches the active province/locality selection.
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

  // species narrows every fetcher identically to the page (domain-axes export
  // parity fix) so the exported summary + per-province coverage match the
  // on-screen KPI row/ratio/trend/map exactly under the same filter.
  //
  // BOUNDED (2026-08-09, discovery scan). PoblacionScreen has been bounded
  // since the outage pass; this route runs the same five aggregates from the
  // same screen's export button and was not. An export that hangs holds a
  // connection with no UI to show for it.
  const load = await loadWithTimeout(
    Promise.all([
      fetchSterilizationCoverage(ctx, { species }),
      fetchActivePregnancies(ctx, { species }),
      fetchReproductiveOutcomes(ctx, { species }),
      fetchNetGrowth(ctx, { species }),
      fetchSterilizationNatalidadRatio(ctx, { species }),
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
  const [coverage, activePregnancies, outcomes, netGrowth, sterilNatalidadRatio] = load.value;

  // RA-3 C1 / RA-1 C1c — THE RESUMEN OBEYS THE SAME VERDICT AS THE ROWS. This
  // file used to print `cobertura_esterilizacion_pct` and `mascotas_total`
  // above a `cobertura_por_provincia` section that withheld the very same
  // numbers. Every column is counted over the SAME scope, so a one-jurisdiction
  // scope makes all of them that jurisdiction's cell — and a rate published
  // beside its base gives up the numerator by multiplication, which is why they
  // are withheld together rather than column by column.
  const scopeNotice = scopeTotalSuppressionNotice(coverage.scopeTotalPublishable);
  const summaryRows = [
    scopeSummaryRow(coverage.scopeTotalPublishable, {
      cobertura_esterilizacion_pct: coverage.rate,
      mascotas_esterilizadas: coverage.sterilized,
      mascotas_total: coverage.total,
      preneces_activas: activePregnancies,
      nacimientos_registrados: outcomes.registeredBirths,
      balance_poblacional: netGrowth.net,
      ratio_esterilizacion_natalidad: sterilNatalidadRatio ?? "",
    }),
  ];

  // D.10 — THE EXPORT MATCHES THE SCREEN BECAUSE IT CANNOT DO OTHERWISE.
  // `fetchSterilizationCoverage(ctx)` already applied the disclosure rule from
  // the same ctx /gob/poblacion and /admin/poblacion build, so this route never
  // holds a raw per-province number. Only formatting happens here — there is no
  // second decision that could drift out of sync with the screen.
  //
  // All three numeric columns are withheld together: a rate published beside its
  // base leaks the numerator by multiplication, so hiding one and keeping the
  // others would be no protection at all.
  const provinceRows = coverage.byProvince.map((r) =>
    r.suppressed
      ? {
          provincia: r.province,
          mascotas_total: SUPPRESSED_CELL_TEXT,
          esterilizadas: SUPPRESSED_CELL_TEXT,
          cobertura_pct: SUPPRESSED_CELL_TEXT,
        }
      : {
          provincia: r.province,
          mascotas_total: r.total,
          esterilizadas: r.sterilized,
          cobertura_pct: r.ratePct,
        },
  );

  // The suppression is DECLARED in the file, not just performed — a CSV outlives
  // the screen that would have explained it.
  const privacyNotice = provinceSuppressionNotice(coverage.byProvinceSuppressedCount);
  const privacyRows = [privacyNotice, scopeNotice]
    .filter((aviso): aviso is string => aviso !== null)
    .map((aviso) => ({ aviso }));

  const csvContent = buildSectionedCsv([
    { title: "resumen", rows: summaryRows },
    { title: "cobertura_por_provincia", rows: provinceRows },
    { title: "privacidad", rows: privacyRows },
  ]);

  await logGobDashboardExport(user.id, "poblacion", {
    resumen: summaryRows.length,
    cobertura_por_provincia: provinceRows.length,
    provincias_suprimidas: coverage.byProvinceSuppressedCount,
  });

  const filename = `poblacion-${new Date().toISOString().slice(0, 10)}.csv`;
  return csvDownloadResponse(csvContent, filename);
}
