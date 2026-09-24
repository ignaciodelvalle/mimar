// GET /gob/censo/export — CSV download for the Censo poblacional dashboard
// (Wave C, gob-audit-inventory item 2). See app/gob/poblacion/export/route.ts
// for the shared rationale (aggregate-only export, no Storage round-trip).

import { type NextRequest, NextResponse } from "next/server";

import {
  buildSectionedCsv,
  csvDownloadResponse,
  logGobDashboardExport,
} from "@/lib/analytics/govt-dashboard-export";
import { resolveJurisdictionScope } from "@/lib/analytics/jurisdiction-scope";
import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import {
  DORMANT_MONTHS_DEFAULT,
  SUPPRESSED_CELL_TEXT,
  buildProjectionContext,
  identificationFunnel,
  provinceSuppressionNotice,
  registryByProvince,
  registryCounts,
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
  // as app/gob/censo/page.tsx (pets.species is free text, honored as-is).
  const species = searchParams.get("species") ?? undefined;

  // Jurisdiction filter — identical logic to app/gob/censo/page.tsx.
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

  // species narrows all three sub-queries identically to the page (domain-axes
  // export parity fix) so the exported summary + province breakdown match the
  // on-screen KPI row/funnel/map exactly under the same filter.
  const [counts, funnel, registry] = await Promise.all([
    registryCounts(ctx, DORMANT_MONTHS_DEFAULT, { species }),
    identificationFunnel(ctx, { species }),
    registryByProvince(ctx, { species }),
  ]);

  // RA-3 C1 / RA-1 C1c — THE RESUMEN OBEYS THE SAME VERDICT AS THE ROWS. This
  // file used to print `total_registradas,3` a few lines above
  // `Tierra del Fuego,suprimido por privacidad`: the same CSV publishing the
  // protected number and claiming to protect it. Every column here is counted
  // over the SAME scope, so when that scope is one withheld jurisdiction they
  // are all that jurisdiction's cell — withheld together, with the SAME marker
  // the province rows use, never a 0 and never an omitted column (a dropped
  // column is a disclosure channel that outlives the screen).
  const scopeNotice = scopeTotalSuppressionNotice(registry.scopeTotalPublishable);
  const summaryRows = [
    scopeSummaryRow(registry.scopeTotalPublishable, {
      total_registradas: counts.total,
      activas: counts.active,
      dormant: counts.dormant,
      perfiles_incompletos: counts.incomplete,
      con_chip: funnel.chipped,
      iso_valido: funnel.isoValid,
      escaneada_en_periodo: funnel.scanned,
    }),
  ];

  // D.10 — THE EXPORT MATCHES THE SCREEN BECAUSE IT CANNOT DO OTHERWISE.
  // `registryByProvince(ctx)` already applied the disclosure rule from the same
  // ctx /gob/censo and /admin/censo build, so this route never holds a raw count
  // to leak. The only thing left here is FORMATTING the verdict; there is no
  // second decision to keep in sync, which is the whole point (an export that
  // differs from the screen becomes the documented way around the protection).
  const provinceRowsOut = registry.rows.map((r) => ({
    provincia: r.province,
    mascotas_registradas: r.suppressed ? SUPPRESSED_CELL_TEXT : r.count,
  }));

  // The suppression is DECLARED in the file, not just performed. A CSV that
  // silently omits cells is the "hid the data, told nobody" failure in its most
  // durable form — the file outlives the screen that would have explained it.
  const privacyNotice = provinceSuppressionNotice(registry.suppressedCount);
  const privacyRows = [privacyNotice, scopeNotice]
    .filter((aviso): aviso is string => aviso !== null)
    .map((aviso) => ({ aviso }));

  const csvContent = buildSectionedCsv([
    { title: "resumen", rows: summaryRows },
    { title: "registro_por_provincia", rows: provinceRowsOut },
    { title: "privacidad", rows: privacyRows },
  ]);

  await logGobDashboardExport(user.id, "censo", {
    resumen: summaryRows.length,
    registro_por_provincia: provinceRowsOut.length,
    provincias_suprimidas: registry.suppressedCount,
  });

  const filename = `censo-${new Date().toISOString().slice(0, 10)}.csv`;
  return csvDownloadResponse(csvContent, filename);
}
