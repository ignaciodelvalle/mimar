// GET /gob/outreach/export?pipeline=<id> — CSV download for outreach pipeline lists.
//
// Query param: pipeline = "overdue_rabies" | "stray_density" | "sterilization_ranking"
//
// PII contract: every export request writes a pii_queried audit row (same as
// the page view, but with export=true in the payload). This is a MANDATORY
// requirement per Item 21 spec — no export without an audit row.
//
// Anonymization: overdue_rabies exports include petId (internal), name, species,
// locality. No owner name, no owner contact. The export is for campaign planning
// (outreach team contacts via the city's existing channels), not for external
// distribution. Operators handle PII under their institutional mandate.

import { type NextRequest, NextResponse } from "next/server";

import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import {
  fetchOverdueRabiesVaccine,
  fetchSterilizationVetRanking,
  fetchStrayDensityAreas,
  logOutreachPiiQuery,
} from "@/lib/infra/outreach-pipelines";
import { buildProjectionContext } from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";
import { neutralizeCsvFormula } from "@/lib/utils/csv-formula";

type Pipeline = "overdue_rabies" | "stray_density" | "sterilization_ranking";

function escapeCell(value: string | number | null | undefined): string {
  // Free-text petName / vetLabel / clinic reach this and land in a
  // funcionario's spreadsheet. Neutralise before the RFC 4180 decision.
  const s = neutralizeCsvFormula(value, String(value ?? ""));
  // RFC 4180: fields containing commas, double-quotes, or newlines must be quoted.
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [
    headers.map(escapeCell).join(","),
    ...rows.map((r) => r.map(escapeCell).join(",")),
  ];
  return `﻿${lines.join("\r\n")}\r\n`; // UTF-8 BOM for Excel compatibility
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Auth guard — same as /gob/* pages.
  let user: Awaited<ReturnType<typeof requireAdminOrGovtOrRedirect>>["user"];
  let profile: Awaited<ReturnType<typeof requireAdminOrGovtOrRedirect>>["profile"];
  let jurisdictions: Awaited<ReturnType<typeof requireAdminOrGovtOrRedirect>>["jurisdictions"];

  try {
    ({ user, profile, jurisdictions } = await requireAdminOrGovtOrRedirect());
  } catch {
    return NextResponse.redirect("/iniciar-sesion");
  }

  const hasAccess =
    profile.role === "admin" || (profile.role === "govt" && jurisdictions.length > 0);
  if (!hasAccess) {
    return new NextResponse("Acceso denegado", { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const rawPipeline = searchParams.get("pipeline");
  const validPipelines: Pipeline[] = ["overdue_rabies", "stray_density", "sterilization_ranking"];
  if (!rawPipeline || !validPipelines.includes(rawPipeline as Pipeline)) {
    return new NextResponse("Pipeline inválido", { status: 400 });
  }
  const pipeline = rawPipeline as Pipeline;

  const period12m = windows.trailing12m();
  const period30d = windows.trailing30d();
  const ctx12m = buildProjectionContext({ role: profile.role }, jurisdictions, period12m);
  const ctx30d = buildProjectionContext({ role: profile.role }, jurisdictions, period30d);

  let csvContent: string;
  let filename: string;

  if (pipeline === "overdue_rabies") {
    const result = await fetchOverdueRabiesVaccine(ctx12m);
    // Zone scoping (PO decision 3, geo-first, 2026-07-23): the Alcance
    // screen's CSV link now lives INSIDE an expanded zone
    // (AlcanceScreen.tsx), so it only ever passes province/locality for the
    // SAME zone the operator just confirmed — filtered here in-memory from
    // the SAME single query, no new DB round-trip. Absent params (a direct
    // API hit) fall back to the whole in-scope list, unchanged.
    const zoneProvinceRaw = searchParams.get("province");
    const zoneLocalityRaw = searchParams.get("locality");
    const ZONE_NONE = "__sin-dato__";
    const zoneProvince =
      zoneProvinceRaw === null ? null : zoneProvinceRaw === ZONE_NONE ? null : zoneProvinceRaw;
    const zoneLocality =
      zoneLocalityRaw === null ? null : zoneLocalityRaw === ZONE_NONE ? null : zoneLocalityRaw;
    const hasZoneFilter = zoneProvinceRaw !== null || zoneLocalityRaw !== null;
    const pets = hasZoneFilter
      ? result.pets.filter(
          (p) =>
            (p.jurisdictionProvince ?? null) === zoneProvince &&
            (p.jurisdictionLocality ?? null) === zoneLocality,
        )
      : result.pets;
    // Mandatory PII export audit log — carries the zone when one was applied.
    void logOutreachPiiQuery(
      user.id,
      "overdue_rabies",
      pets.length,
      hasZoneFilter ? { province: zoneProvince, locality: zoneLocality } : undefined,
    );
    filename = `outreach-antirrabica-vencida-${new Date().toISOString().slice(0, 10)}.csv`;
    csvContent = buildCsv(
      ["pet_id", "nombre", "especie", "provincia", "localidad", "ultima_vacuna_antirrabica"],
      pets.map((p) => [
        p.petId,
        p.petName,
        p.species,
        p.jurisdictionProvince,
        p.jurisdictionLocality,
        p.lastVaccineAt.getTime() === 0 ? "" : p.lastVaccineAt.toISOString().slice(0, 10),
      ]),
    );
  } else if (pipeline === "stray_density") {
    const result = await fetchStrayDensityAreas(ctx30d);
    void logOutreachPiiQuery(user.id, "stray_density", result.areas.length);
    filename = `outreach-densidad-callejeros-${new Date().toISOString().slice(0, 10)}.csv`;
    csvContent = buildCsv(
      ["localidad", "provincia", "escaneos_30d"],
      result.areas.map((a) => [a.locality, a.province, a.scanCount]),
    );
  } else {
    const result = await fetchSterilizationVetRanking(ctx30d);
    void logOutreachPiiQuery(user.id, "sterilization_ranking", result.vets.length);
    filename = `outreach-ranking-esterilizacion-${new Date().toISOString().slice(0, 10)}.csv`;
    csvContent = buildCsv(
      ["veterinario_a", "clinica", "esterilizaciones_30d"],
      result.vets.map((v) => [v.vetLabel, v.clinic, v.count]),
    );
  }

  return new NextResponse(csvContent, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // No-cache: PII responses must not be cached by intermediaries.
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
