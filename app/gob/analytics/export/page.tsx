// ---------------------------------------------------------------------------
// Reachable via the "Exportar datos" CTA in /gob/analytics' filter-bar
// `actions` slot (rewired 2026-07-21 -- orphan flagged by
// dim-interno:docs/reviews/results/2026-07-21-audit-4-decision-ciclos.md).
//
// STALE CLAIM CORRECTED 2026-09-23: this comment used to say the route had
// "no dedicated nav-presets.ts entry" because it was "a child of
// /gob/analytics, which already has its own GOB_NAV_SECTIONS entry" — true
// when written (dec0f58f), false since the F9 fusion (2026-08-01) removed
// /gob/analytics from GOB_NAV_SECTIONS entirely (absorbed into
// /gob/programa's "Analítica" vista). That left this export three clicks deep
// with no direct menu path. It now has its own entry, "Exportar a SENASA",
// in the Programa section (components/layout/nav-presets.ts) — the label
// names SENASA because that is what a funcionario searches the menu for.
// ---------------------------------------------------------------------------

import Link from "next/link";
import { Suspense } from "react";

import { LnEmptyState } from "@/components/ui/EmptyState";
import { OpCallout, OpCard, OpCardBody, OpCardHead } from "@/components/ui/dashboard";
import { resolveJurisdictionScope } from "@/lib/analytics/jurisdiction-scope";
import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import { ExportFormClient } from "./ExportFormClient";
import { SenasaExportLink } from "./SenasaExportLink";
import { canExportPadronSanitario } from "./export-access";
import { EXPORT_DEFAULT_PRESET } from "./export-period";
import { EXPORT_PRIVACY_NOTICE } from "./privacy-notice";

export const dynamic = "force-dynamic";

export default async function GobAnalyticsExportPage({
  searchParams,
}: {
  searchParams: Promise<{
    period?: string;
    from?: string;
    to?: string;
    province?: string;
    locality?: string;
  }>;
}) {
  const { profile, jurisdictions } = await requireAdminOrGovtOrRedirect();

  // Capability guard: export = admin OR (govt AND has assignments). The same
  // predicate hides the /gob rail entry (./export-access.ts).
  const hasAccess = canExportPadronSanitario(profile.role, jurisdictions);

  if (!hasAccess) {
    return (
      <div className="space-y-6">
        <LnEmptyState
          icon="lock"
          title="Sin acceso"
          description="Tu rol no tiene acceso a la exportación de datos. Pedile al admin que te asigne una jurisdicción."
        />
      </div>
    );
  }

  const params = await searchParams;
  // Single-sourced with the picker's defaultPreset and the action's resolver
  // (RA-2 F11) — three independent "30d" literals is how the vocabularies
  // drifted apart in the first place.
  const period = params.period ?? EXPORT_DEFAULT_PRESET;
  const from = params.from ?? "";
  const to = params.to ?? "";
  const province = params.province ?? "";
  const locality = params.locality ?? "";

  // Resolve selected province → localities list + switcher options.
  const { localities, allowedProvinces } = await resolveJurisdictionScope({
    role: profile.role,
    jurisdictions,
    params: { province: params.province, locality: params.locality },
  });

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="text-sm text-ln-op-mute">
        {/* F9 (2026-08-01): the breadcrumb parent is the Programa hub's
            Analítica vista — /gob/analytics is a redirect now, and a
            breadcrumb that bounces is a breadcrumb that lies about depth. */}
        <Link href="/gob/programa?vista=analitica" className="hover:underline text-ln-op-azul">
          Analítica
        </Link>
        <span aria-hidden="true" className="mx-1">
          /
        </span>
        <span aria-current="page">Exportar datos</span>
      </nav>

      {/* Page header */}
      <header className="space-y-1">
        <h1 className="text-title font-semibold text-ln-op-ink">Exportar datos</h1>
        <p className="text-md text-ln-op-mute">
          {profile.role === "admin"
            ? "Vista universal — todas las jurisdicciones."
            : "Genera el padrón fila por fila de los datos de tu cobertura."}
        </p>
      </header>

      {/* Privacy notice -- Ley 25.326.
          Copy lives in ./privacy-notice.ts so it can be asserted by a test: it
          is a factual claim about what leaves the database, and the previous
          version of it ("Los datos exportados están anonimizados") was not
          true of a row-level padrón. See that module's header for the D2
          decision and the two properties the claim rests on. */}
      <OpCallout
        icon="i"
        title="Aviso sobre proteccion de datos personales (Ley 25.326)."
        body={EXPORT_PRIVACY_NOTICE}
      />

      <OpCard>
        <OpCardHead title="Configurar exportación" />
        <OpCardBody>
          <Suspense fallback={null}>
            <ExportFormClient
              allowedProvinces={allowedProvinces}
              localities={localities}
              period={period}
              from={from}
              to={to}
              province={province}
              locality={locality}
            />
          </Suspense>
        </OpCardBody>
      </OpCard>

      {/* Pilot T1-P7: the SENASA padrón route had no entry point. Same access
          rule as this page (checked above), same period + jurisdiction. */}
      <OpCard>
        <OpCardHead title="Padrón sanitario para SENASA" />
        <OpCardBody>
          <div className="space-y-3">
            <p className="text-md text-ln-op-ink-2">
              Eventos sanitarios de tu cobertura (vacunas, desparasitaciones y demás) para el
              período y la jurisdicción elegidos arriba. Sale en CSV con nuestras columnas: el
              formato oficial de SENASA todavía no está homologado.
            </p>
            <Suspense fallback={null}>
              <SenasaExportLink
                period={period}
                from={from}
                to={to}
                province={province}
                locality={locality}
              />
            </Suspense>
          </div>
        </OpCardBody>
      </OpCard>
    </div>
  );
}
