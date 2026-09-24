// /gob/poblacion — Control poblacional (Paquete G).
//
// Jurisdiction-scoped, period-aware gobierno screen answering:
// "¿Estamos conteniendo la población?"
//
// Layout (Op* design system):
//   KPI row      — cobertura esterilización (con meta 70%) · preñeces activas ·
//                  nacimientos registrados (caveat) · tasa neta de crecimiento (caveat)
//                  · ratio esterilización/natalidad (sub o tile 5)
//   Trend        — TimeSeriesChart (sterilization_performed trend)
//   Coropleta    — <PanoramaEmbed> (esterilización por provincia, capa panorama · #51)
//   Tabla brecha — provinces below the 70% target, worst-first, linking to
//                  the Alcance comunitario pipelines (IA audit 2026-08: the
//                  campaign decision spanned Padrón ↔ Operativos with no
//                  cross-link, and "which area is below target" degraded to
//                  reading the choropleth instead of a ranked list)
//   Freshness footer
//
// PANORAMA NOTE: The Paquete G Panorama layer/preset (population-control map layer
// and preset in /gob/panorama) is deferred to a separate work unit. This page is
// the standalone jurisdiction dashboard — not the Panorama integration.
//
// F8 fusion (2026-07-22): this is the byte-identical body of the former
// /gob/poblacion page.tsx, relocated so the Padrón hub (app/gob/padron/
// page.tsx) can render it as its "Población" vista (the default). /gob/
// poblacion itself now only redirects here via the hub (see app/gob/
// poblacion/page.tsx) — this is a RELOCATION, not a redesign: same
// searchParams contract, same auth guard, same query logic. The exportHref
// still targets /gob/poblacion/export — that API route is UNCHANGED.

import Link from "next/link";

import { TimeSeriesChartDynamic } from "@/components/charts/TimeSeriesChartDynamic";
import { PanoramaEmbed } from "@/components/panorama/PanoramaEmbed";
import { LnEmptyState } from "@/components/ui/EmptyState";
import {
  OpCard,
  OpCardBody,
  OpCardHead,
  type OpFilterAxis,
  OpFilterBar,
  OpKpi,
  ViewScopeCaption,
} from "@/components/ui/dashboard";
import { AnalyticsLoadFallback } from "@/components/ui/dashboard/AnalyticsLoadFallback";
import { DashboardFreshnessFooter } from "@/components/ui/dashboard/DashboardFreshnessFooter";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { analyticsRetryHref, loadWithTimeout } from "@/lib/analytics/analytics-load";
import { formatDelta } from "@/lib/analytics/campaign-metrics";
import { resolveJurisdictionScope } from "@/lib/analytics/jurisdiction-scope";
import {
  JURISDICTION_ADJUSTED_TARGET_NOTE,
  resolveJurisdictionTargetsForScope,
} from "@/lib/analytics/jurisdiction-targets";
import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import { requireGobReadAccessOrRedirect } from "@/lib/infra/auth-guards";
import {
  TARGETS,
  buildProjectionContext,
  fetchActivePregnancies,
  fetchDewormingCoverage,
  fetchNetGrowth,
  fetchPrevRegisteredBirths,
  fetchReproductiveOutcomes,
  fetchSterilizationCoverage,
  fetchSterilizationNatalidadRatio,
  fetchSterilizationTrend,
  provinceSuppressionNotice,
  scopeTotalSuppressionNotice,
  toneForTarget,
} from "@/lib/metrics";
import type { ProvinceSterlizationRow } from "@/lib/metrics";
import { KPI_CATALOG, getKpiInfo } from "@/lib/metrics/kpi-catalog";
import { resolveAnalyticsPeriod } from "@/lib/metrics/period";
import { GOB_MAP_HEIGHT } from "@/lib/ui/map-bounds";
import { describeNarrowedView } from "@/lib/ui/view-scope-caption";
import {
  formatPercent,
  formatRate,
  formatDelta as formatSignedDelta,
  speciesOptions,
} from "@/lib/utils/format";
import { gobEmbedView } from "@/src/modules/panorama/domain/embed-view";

// Species domain axis — mirrors /gob/perdidas' SPECIES_OPTIONS exactly.
// pets.species is free text ('dog' | 'cat' | 'other' in practice); "other" is
// the exact stored value the fetchers honor as-is (no query change).
// Valores: decisión de esta pantalla. Ortografía: speciesLabel, fuente única.
const SPECIES_OPTIONS = speciesOptions(["dog", "cat", "other"]);

/** One below-target province of the sterilization-coverage ranking. */
export type ProvinceGapRow = {
  province: string;
  /** Publishable coverage rate (0–100). */
  ratePct: number;
  /** Percentage points BELOW the target — positive, larger = worse. */
  gapPp: number;
};

/**
 * The below-target slice of `coverage.byProvince`, ranked worst-first (largest
 * gap on top; ties alphabetical for a stable order).
 *
 * Withheld provinces are EXCLUDED, never fabricated: a suppressed row carries
 * no publishable rate, so it cannot be ranked — its existence is announced via
 * `provinceSuppressionNotice` beside the table instead (same discipline as the
 * admin ranking, where withheld rows at least have a name to alphabetize; a
 * gap ranking has nothing honest to print for them at all).
 *
 * Pure and exported so the ranking rule is unit-testable without Postgres.
 */
export function rankProvincesBelowTarget(
  byProvince: readonly ProvinceSterlizationRow[],
  targetPct: number = TARGETS.STERILIZATION_COVERAGE_PCT,
): ProvinceGapRow[] {
  const rows: ProvinceGapRow[] = [];
  for (const row of byProvince) {
    if (row.suppressed) continue;
    if (row.ratePct >= targetPct) continue;
    rows.push({
      province: row.province,
      ratePct: row.ratePct,
      // One decimal, matching the display precision of the rate itself.
      gapPp: Math.round((targetPct - row.ratePct) * 10) / 10,
    });
  }
  return rows.sort((a, b) => b.gapPp - a.gapPp || a.province.localeCompare(b.province, "es"));
}

/** Rate color for a below-target row — warn near the target, danger far below
 *  (same `toneForTarget` verdict the KPI tile uses; "ok" is unreachable here
 *  because every ranked row is below target by construction). */
function gapRateColor(
  ratePct: number,
  targetPct: number = TARGETS.STERILIZATION_COVERAGE_PCT,
): string {
  const tone = toneForTarget(ratePct, targetPct);
  return tone === "warn" ? "text-ln-op-warn" : "text-ln-op-danger";
}

/** Where a below-target province becomes an intervention: the Operativos hub's
 *  Alcance comunitario pipelines. AlcanceScreen's searchParams contract only
 *  scopes the overdue-rabies ZONE drill-down (`?zona=`+`?provincia=`, both
 *  locality-grain) — there is no province-only scoping param yet, so this link
 *  is deliberately unscoped and the copy beside it says so. */
const ALCANCE_HREF = "/gob/operativos?vista=alcance";

/**
 * Ranked "provincias bajo la meta" table + cross-link to the outreach hub —
 * the connective tissue the IA audit found missing: the choropleth above shows
 * WHERE coverage is low, this answers "which provinces, how far below, in what
 * order" as a list, and hands off to Operativos/Alcance to act on it.
 *
 * Reads the SAME `coverage.byProvince` rows the PanoramaEmbed choropleth is
 * fed from (fetchSterilizationCoverage, one fetch) — no second query.
 * Synchronous and exported so the render contract is testable without the
 * screen's auth/DB dependencies.
 */
export function SterilizationGapCard({
  byProvince,
  suppressedCount,
  // ADR-8: the RSC may thread a jurisdiction-resolved target; the flat
  // TARGETS default keeps every legacy caller/test byte-identical (JT4 —
  // `targetAdjusted` drives the disclosure line, never a silent swap).
  targetPct = TARGETS.STERILIZATION_COVERAGE_PCT,
  targetAdjusted = false,
}: {
  byProvince: readonly ProvinceSterlizationRow[];
  suppressedCount: number;
  targetPct?: number;
  targetAdjusted?: boolean;
}) {
  const rows = rankProvincesBelowTarget(byProvince, targetPct);
  const suppressionNote = provinceSuppressionNotice(suppressedCount);
  const panelId = "panel-brecha-esterilizacion-titulo";
  return (
    <OpCard aria-labelledby={panelId}>
      <OpCardHead
        title={<span id={panelId}>Provincias por debajo de la meta de esterilización</span>}
        actions={
          <Link href={ALCANCE_HREF} className="text-sm text-ln-op-azul hover:underline">
            Planificar alcance →
          </Link>
        }
      />
      <OpCardBody>
        {rows.length === 0 ? (
          <p className="text-sm text-ln-op-mute">
            Ninguna provincia publicable está por debajo de la meta del {targetPct}%.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <caption className="pb-2 text-left text-sm text-ln-op-mute">
                Provincias por debajo de la meta de esterilización ({targetPct}%), mayor brecha
                primero. Cobertura calculada a nivel provincia.
                {targetAdjusted ? ` ${JURISDICTION_ADJUSTED_TARGET_NOTE}.` : ""}
              </caption>
              <thead>
                <tr className="border-b border-ln-op-line">
                  <th scope="col" className="py-1.5 pr-4 text-left font-semibold text-ln-op-mute">
                    Provincia
                  </th>
                  <th scope="col" className="py-1.5 pl-4 text-right font-semibold text-ln-op-mute">
                    Cobertura
                  </th>
                  <th scope="col" className="py-1.5 pl-4 text-right font-semibold text-ln-op-mute">
                    Brecha vs meta
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.province} className="border-b border-ln-op-line/50 last:border-0">
                    <td className="py-1.5 pr-4 text-ln-op-ink">{row.province}</td>
                    <td
                      className={`py-1.5 pl-4 text-right tabular-nums font-medium ${gapRateColor(row.ratePct, targetPct)}`}
                    >
                      {formatPercent(row.ratePct)}
                    </td>
                    <td className="py-1.5 pl-4 text-right tabular-nums text-ln-op-ink">
                      {formatSignedDelta(-row.gapPp, { unit: " pp" })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {suppressionNote && <p className="mt-2 text-xs text-ln-op-mute">{suppressionNote}</p>}
        <p className="mt-3 text-sm text-ln-op-mute">
          Armá la campaña en{" "}
          <Link href={ALCANCE_HREF} className="underline underline-offset-2 hover:text-ln-op-ink">
            Operativos · Alcance comunitario →
          </Link>{" "}
          — esa vista todavía no filtra por provincia.
        </p>
      </OpCardBody>
    </OpCard>
  );
}

export type PoblacionScreenProps = {
  searchParams: {
    period?: string;
    from?: string;
    to?: string;
    province?: string;
    locality?: string;
    species?: string;
  };
  /**
   * True when rendered as the Padrón hub's "Población" tab (app/gob/padron/
   * page.tsx) — see components/ui/dashboard/ScreenHeader.tsx.
   */
  underHub?: boolean;
};

export async function PoblacionScreen({
  searchParams: sp,
  underHub = false,
}: PoblacionScreenProps) {
  const { profile, jurisdictions } = await requireGobReadAccessOrRedirect();
  const actor = { role: profile.role } as const;

  const hasAnalyticsRead =
    hasNationalReadScope(profile.role) || (profile.role === "govt" && jurisdictions.length > 0);

  if (!hasAnalyticsRead) {
    return (
      <div className="space-y-6">
        <LnEmptyState
          icon="lock"
          title="Sin acceso"
          description="Tu rol no tiene acceso al control poblacional. Pedile al admin que te asigne capabilities."
        />
      </div>
    );
  }

  // "Exportar CSV" always mirrors the active period + jurisdiction filters —
  // the export route re-derives filteredJurisdictions from the same params.
  const exportParams = new URLSearchParams();
  if (sp.period) exportParams.set("period", sp.period);
  if (sp.from) exportParams.set("from", sp.from);
  if (sp.to) exportParams.set("to", sp.to);
  if (sp.province) exportParams.set("province", sp.province);
  if (sp.locality) exportParams.set("locality", sp.locality);
  if (sp.species) exportParams.set("species", sp.species);
  const exportHref = `/gob/poblacion/export${exportParams.size > 0 ? `?${exportParams}` : ""}`;

  const {
    filteredJurisdictions,
    localities,
    allowedProvinces,
    adminSelectedProvince,
    adminSelectedLocality,
  } = await resolveJurisdictionScope({
    role: profile.role,
    jurisdictions,
    params: { province: sp.province, locality: sp.locality },
  });
  // Both undefined unless role === "admin" (resolveJurisdictionScope's guarantee) —
  // hoisted once so every fetcher below shares the identical admin-scope value
  // (same pattern as /gob/perdidas).
  const adminProvince = adminSelectedProvince ?? undefined;
  const adminLocality = adminSelectedLocality ?? undefined;
  const species = sp.species || undefined;

  // C3 disclosure: caption when this page's filters narrow below the mandate.
  const narrowedView = describeNarrowedView({
    role: profile.role,
    mandateJurisdictions: jurisdictions,
    effectiveJurisdictions: filteredJurisdictions,
    adminProvince,
    adminLocality,
  });

  const period = resolveAnalyticsPeriod(sp);
  const ctx = buildProjectionContext(actor, filteredJurisdictions, period, {
    adminProvince,
    adminLocality,
  });

  // ADR-8 (jurisdiction-compliance WU4b): jurisdiction-resolved sterilization
  // target for this screen's tone/sub/gap-table. Fail-safe (flat TARGETS on
  // any read failure) AND bounded inside the module by
  // JURISDICTION_TARGETS_TIMEOUT_MS (T6 review M1 — this await precedes the
  // page's loadWithTimeout group, so it needs its own deadline); admin
  // national/cross-province views stay flat (JT5).
  const jurisdictionTargets = await resolveJurisdictionTargetsForScope(
    hasNationalReadScope(profile.role)
      ? adminProvince
        ? [{ province: adminProvince, locality: adminLocality ?? "" }]
        : []
      : filteredJurisdictions,
  );
  const sterilTargetPct = jurisdictionTargets.values.STERILIZATION_COVERAGE_PCT;
  const sterilTargetAdjusted = jurisdictionTargets.adjusted.STERILIZATION_COVERAGE_PCT;

  // Header + filters render in both the data and degraded (timeout) branches.
  const header = (
    <ScreenHeader
      underHub={underHub}
      className="space-y-2"
      eyebrow="Registro"
      title="Control poblacional"
      subtitle={
        <>
          {/* The universal claim yields to the narrowed-view caption (never both). */}
          {hasNationalReadScope(profile.role) ? (
            narrowedView ? null : (
              <p className="text-md text-ln-op-mute">Vista universal — todas las jurisdicciones.</p>
            )
          ) : (
            <p className="text-md text-ln-op-mute">
              Cobertura de esterilización, reproducción activa y balance poblacional en tu
              cobertura.
            </p>
          )}
          <ViewScopeCaption scope={narrowedView} />
        </>
      }
    />
  );
  // Unified filter bar — jurisdiction + period, with "Exportar CSV" rendered
  // via the bar's `actions` slot (header row) instead of floating beside it.
  const filtersRow = (
    <OpFilterBar
      period={{ defaultPreset: "trailing12m" }}
      jurisdiction={{ allowedProvinces, localities }}
      axes={
        [
          {
            id: "species",
            label: "Especie",
            paramKey: "species",
            options: SPECIES_OPTIONS,
            current: sp.species ?? null,
          },
        ] satisfies OpFilterAxis[]
      }
      actions={
        <a href={exportHref} className="text-md text-ln-op-azul hover:underline">
          Exportar CSV →
        </a>
      }
    />
  );

  // Bound the fetcher set with a deadline so a degraded DB yields an honest
  // "reintentar" state instead of an unbounded hang (parity with /admin/poblacion).
  // fetchPrevRegisteredBirths adds ONE new query (same scope, shifted one
  // period back) purely to power the Nacimientos registrados deltaV2 chip —
  // mirrors campaign-metrics.ts' fetchPrevTotals pattern.
  // species narrows every fetcher below identically so the KPI row, ratio
  // tile, net-growth breakdown, trend, and choropleth all agree (domain-axes work).
  const load = await loadWithTimeout(
    Promise.all([
      fetchSterilizationCoverage(ctx, { species }),
      fetchActivePregnancies(ctx, { species }),
      fetchReproductiveOutcomes(ctx, { species }),
      fetchNetGrowth(ctx, { species }),
      fetchSterilizationNatalidadRatio(ctx, { species }),
      fetchSterilizationTrend(ctx, { species }),
      fetchDewormingCoverage(ctx, { species }),
      fetchPrevRegisteredBirths(ctx, { species }),
    ]),
  );

  if (!load.ok) {
    return (
      <div className="space-y-6">
        {header}
        {filtersRow}
        <AnalyticsLoadFallback
          reason={load.reason}
          correlationId={load.id}
          retryHref={analyticsRetryHref("/gob/padron", { ...sp, vista: "poblacion" })}
        />
      </div>
    );
  }

  const [
    coverage,
    activePregnancies,
    outcomes,
    netGrowth,
    sterilNatalidadRatio,
    sterilTrend,
    deworming,
    prevRegisteredBirths,
  ] = load.value;

  // THE HEADLINE OBEYS THE SAME VERDICT AS THE ROWS (RA-3 finding C1).
  // `?province=AR-V` narrows the whole scope to one province, and then
  // "meta programática 70% · 1 de 3" IS that province's withheld cell — a rate
  // beside its base gives up the numerator by multiplication. Every KPI on this
  // page counts over that same scope, so the page withholds them together
  // rather than tile by tile. The verdict came from the same
  // `planProvinceDisclosure` call that decided `byProvince`, which is what stops
  // /gob/poblacion/export from publishing what this screen hides.
  const scopeNotice = scopeTotalSuppressionNotice(coverage.scopeTotalPublishable);
  if (scopeNotice) {
    return (
      <div className="space-y-6">
        {header}
        {filtersRow}
        <LnEmptyState
          icon="lock"
          title="Datos insuficientes (privacidad)"
          description={scopeNotice}
        />
      </div>
    );
  }

  const registeredBirthsDelta = formatDelta(
    outcomes.registeredBirths,
    prevRegisteredBirths,
    "vs período anterior",
  );

  const hasData = coverage.total > 0;
  // Deworming has no jurisdiction-varying legal target (JT1 whitelist) — it
  // borrows the FLAT sterilization benchmark as its proxy, deliberately NOT
  // the jurisdiction-adjusted value (a local sterilization mandate says
  // nothing about deworming).
  const dewormingTone = toneForTarget(deworming.rate, TARGETS.STERILIZATION_COVERAGE_PCT);
  const hasTrend = sterilTrend.points.length > 0;

  const coverageTone = toneForTarget(coverage.rate, sterilTargetPct);

  // Net growth: directional only. Tone is neutral — sign alone is meaningful
  // but exact value is not because registeredBirths under-counts natalidad.
  const netTone = "neutral" as const;

  const panelTrendId = "panel-esterilizacion-titulo";
  const panelMapId = "panel-mapa-titulo";

  const natalidadCaveatText = "Solo partos en seguimiento — subestima la natalidad real";
  // metric-honesty 2026-07-09: the ratio's denominator (partos registrados)
  // under-counts real natalidad, so the ratio OVER-states population control.
  // Spell that out — the old sub-line only said the natalidad was under-counted,
  // never that the ratio itself therefore reads too optimistically.
  const ratioOverstatementCaveat =
    "Contexto, no indicador de decisión: el denominador (partos en seguimiento) subestima la natalidad real, por lo que este ratio SOBRESTIMA la contención poblacional.";

  return (
    <div className="space-y-6">
      {/* Page header */}
      {header}

      {/* Filters row */}
      {filtersRow}

      {/* KPI row */}
      <section
        aria-label="Indicadores de control poblacional"
        className="grid grid-cols-2 md:grid-cols-5 gap-3"
      >
        {/* KPI 1: Sterilization coverage — with target bar + tone */}
        <OpKpi
          label="Cobertura de esterilización"
          value={hasData ? formatPercent(coverage.rate) : "—"}
          bar={hasData ? coverage.rate : undefined}
          tone={hasData ? coverageTone : "neutral"}
          sub={
            hasData
              ? `meta ${sterilTargetAdjusted ? "" : "programática "}${sterilTargetPct}% · ${coverage.sterilized.toLocaleString("es-AR")} de ${coverage.total.toLocaleString("es-AR")}${sterilTargetAdjusted ? ` · ${JURISDICTION_ADJUSTED_TARGET_NOTE}` : ""}`
              : "Sin datos en la cobertura"
          }
          sparkline={hasTrend ? sterilTrend.points : undefined}
          info={getKpiInfo("sterilization_coverage_population")}
          descriptorId="sterilization_coverage_population"
        />

        {/* KPI 1b: Deworming coverage — sanitary sibling of esterilización, 12m window */}
        <OpKpi
          label="Cobertura antiparasitaria"
          value={deworming.total > 0 ? formatPercent(deworming.rate) : "—"}
          bar={deworming.total > 0 ? deworming.rate : undefined}
          tone={deworming.total > 0 ? dewormingTone : "neutral"}
          sub={
            deworming.total > 0
              ? `últimos 12 meses · ${deworming.dewormed.toLocaleString("es-AR")} de ${deworming.total.toLocaleString("es-AR")}`
              : "Sin datos en la cobertura"
          }
          info={getKpiInfo("deworming_coverage_population")}
          descriptorId="deworming_coverage_population"
        />

        {/* KPI 2: Active pregnancies */}
        <OpKpi
          label={KPI_CATALOG.active_pregnancies.label}
          value={activePregnancies.toLocaleString("es-AR")}
          sub="preñez registrada y aún no cerrada"
          tone={activePregnancies > 0 ? "warn" : "neutral"}
          info={getKpiInfo("active_pregnancies")}
          descriptorId="active_pregnancies"
        />

        {/* KPI 3: Registered births — with natalidad caveat */}
        <OpKpi
          label={KPI_CATALOG.registered_births.label}
          value={outcomes.registeredBirths.toLocaleString("es-AR")}
          sub={natalidadCaveatText}
          tone="neutral"
          deltaV2={
            // Neutral valence: more registered births is neither win nor loss
            // (population growth vs registration uptake ambiguity).
            registeredBirthsDelta
              ? { ...registeredBirthsDelta, valence: "neutral" as const }
              : undefined
          }
          info={{
            definition:
              "Eventos clinical_info_logged con sub_kind='pregnancy', pregnancy_phase='ended' y outcome='live_birth' en el período seleccionado, en el scope de jurisdicción.",
            formula:
              "COUNT(clinical_info_logged WHERE sub_kind='pregnancy' AND pregnancy_phase='ended' AND outcome='live_birth' AND period AND scope)",
            caveat:
              "Solo cuenta partos de preñeces registradas en el sistema. Partos callejeros y camadas sin seguimiento son invisibles. Este número subestima la natalidad real — tratarlo como indicador direccional, no como dato exacto.",
          }}
          descriptorId="registered_births"
          guardInput={{ priorBase: prevRegisteredBirths }}
        />

        {/* KPI 4: Net registry inflow — directional, neutral tone.
            demo-review M2: this read "Balance poblacional +3.619", which a
            funcionario reads as "the population grew by 3,619" — but "altas"
            is pets.created_at (new REGISTRATIONS in miMAR, including
            pre-existing animals just now onboarded), not new animals born.
            Relabeled to name what's actually summed; the caveat now says so
            explicitly instead of only warning about the natality undercount. */}
        <OpKpi
          label={KPI_CATALOG.net_registry_inflow.label}
          value={
            netGrowth.net > 0
              ? `+${netGrowth.net.toLocaleString("es-AR")}`
              : netGrowth.net.toLocaleString("es-AR")
          }
          // Screenshot review finding #10: this tile is a composite (altas +
          // nacimientos − muertes), not a births-only metric — the natalidad
          // undercount caveat belongs on the Nacimientos-registrados tile (above),
          // not here. This sub names what actually limits THIS metric's
          // read (full detail in info.caveat below).
          sub="Indicador direccional — no es crecimiento poblacional real"
          tone={netTone}
          info={{
            definition:
              "Altas nuevas en el período + nacimientos registrados − muertes registradas.",
            formula: "COUNT(altas) + COUNT(live_birth events) − COUNT(death_recorded events)",
            caveat:
              "INDICADOR DIRECCIONAL, NO EXACTO — no es crecimiento poblacional real. 'Altas nuevas' son mascotas RECIÉN REGISTRADAS en miMAR (pets.created_at), que en su mayoría ya existían y no representan nacimientos. Los nacimientos registrados solo cubren partos en seguimiento — callejero y camadas sin registro son invisibles. Un valor positivo refleja sobre todo ritmo de adopción del sistema, no necesariamente más mascotas vivas.",
          }}
          descriptorId="net_registry_inflow"
        />
      </section>

      {/* Ratio esterilización/natalidad — CONTEXT tile (metric-honesty
          2026-07-09). Demoted out of the headline: it OVER-states population
          control because its denominator (partos en seguimiento) under-counts
          real natalidad. Smaller value + explicit "sobrestima" caveat so it
          never reads as a decision headline. */}
      {sterilNatalidadRatio !== null && (
        <section aria-label={KPI_CATALOG.sterilization_natalidad_ratio.label}>
          <div className="rounded-xl border border-ln-op-line bg-white px-5 py-4">
            <p className="text-sm font-semibold uppercase tracking-[0.1em] text-ln-op-mute">
              Contexto · Ratio esterilización / natalidad registrada
            </p>
            <p className="mt-1 text-lg font-semibold tabular-nums text-ln-op-ink">
              {formatRate(sterilNatalidadRatio, { decimals: 2 })}
            </p>
            <p className="mt-1 text-sm text-ln-op-mute">
              esterilizaciones del período por parto en seguimiento
            </p>
            <p className="mt-1 text-sm italic text-ln-op-mute">{ratioOverstatementCaveat}</p>
          </div>
        </section>
      )}

      {/* Net growth breakdown sub-section */}
      {/* Background unified to OpCard's canonical bg-ln-op-card (design-consistency
          sweep) — this hand-built panel doesn't use OpCardHead's bordered-divider
          header, so it stays a plain div rather than a full OpCard conversion. */}
      {hasData && (
        <div className="rounded-xl border border-ln-op-line bg-ln-op-card px-5 py-4">
          <p className="text-sm font-semibold uppercase tracking-[0.1em] text-ln-op-mute mb-3">
            Componentes del balance
          </p>
          {/* Stacked below sm (mobile-polish 2026-07): 3-across crushed the
              stat captions at 390px. */}
          <div className="grid grid-cols-1 gap-4 text-center sm:grid-cols-3">
            <div>
              <p className="text-sm text-ln-op-mute">Altas nuevas</p>
              <p className="text-lg font-semibold tabular-nums text-ln-op-ink">
                +{netGrowth.altas.toLocaleString("es-AR")}
              </p>
            </div>
            <div>
              <p className="text-sm text-ln-op-mute">Nacimientos registrados</p>
              <p className="text-lg font-semibold tabular-nums text-ln-op-ink">
                +{netGrowth.registeredBirths.toLocaleString("es-AR")}
              </p>
            </div>
            <div>
              <p className="text-sm text-ln-op-mute">Muertes registradas</p>
              <p className="text-lg font-semibold tabular-nums text-ln-op-ink">
                −{netGrowth.deaths.toLocaleString("es-AR")}
              </p>
            </div>
          </div>
          {/* Scoped to the Nacimientos-registrados column only (screenshot review
              finding #10) — the natalidad-undercount caveat does not apply
              to "Altas nuevas" (new registrations, not births) or "Muertes
              registradas" in this same breakdown, so it must not read as a
              blanket caveat for all three columns. */}
          <p className="mt-3 text-xs text-ln-op-mute text-center italic">
            Nacimientos registrados: {natalidadCaveatText.toLowerCase()}.
          </p>
        </div>
      )}

      {/* Sterilization trend */}
      <OpCard aria-labelledby={panelTrendId}>
        <OpCardHead
          title={<span id={panelTrendId}>Tendencia de esterilizaciones</span>}
          actions={
            sterilTrend.suppressedCount > 0 ? (
              <span className="text-sm font-normal text-ln-op-mute">
                {sterilTrend.suppressedCount}{" "}
                {sterilTrend.suppressedCount === 1 ? "período oculto" : "períodos ocultos"}{" "}
                (privacidad)
              </span>
            ) : null
          }
        />
        <OpCardBody>
          {!hasTrend ? (
            <LnEmptyState
              icon="chart-line"
              title="Sin esterilizaciones en el período"
              description="No hay esterilizaciones registradas en el rango y la cobertura seleccionados."
            />
          ) : (
            <TimeSeriesChartDynamic
              data={sterilTrend.points}
              seriesLabel="Esterilizaciones"
              yLabel="Eventos registrados"
              variant="area"
              fallbackTableLabel={`Esterilizaciones por ${sterilTrend.granularity === "month" ? "mes" : "semana"}`}
              // A fully masked series must say "Datos ocultos por privacidad
              // (k<5)" inside the plot; without this it falls back to "Sin
              // datos para el período seleccionado", which claims a measured
              // absence the data never established.
              suppressedCount={sterilTrend.suppressedCount}
            />
          )}
        </OpCardBody>
      </OpCard>

      {/* Panorama embed (#51) — the SAME per-province sterilization ratePct
          choropleth, now rendered through the shared panorama surface. Data is
          byte-identical: the esterilizacion layer's province loader delegates to
          fetchSterilizationCoverage(...).byProvince — the very coverage value the
          KPI tile above already uses. A national frozen view keeps the province
          aggregation axis; /api/panorama/[layer] fences govt scope server-side. */}
      {coverage.byProvince.length > 0 && (
        <OpCard aria-labelledby={panelMapId}>
          <OpCardHead
            title={<span id={panelMapId}>Cobertura de esterilización por provincia</span>}
          />
          <OpCardBody>
            {!hasNationalReadScope(profile.role) && (sp.province || sp.locality) && (
              <p className="mb-2 text-sm text-ln-op-mute">
                El mapa muestra tu asignación completa; el filtro de jurisdicción no se aplica en
                esta vista.
              </p>
            )}
            <PanoramaEmbed
              viewState={gobEmbedView("esterilizacion", "trailing12m")}
              height={GOB_MAP_HEIGHT}
            />
          </OpCardBody>
        </OpCard>
      )}

      {/* Ranked below-target table (IA audit 2026-08) — the same byProvince
          rows the choropleth above paints (ONE fetchSterilizationCoverage
          call), now readable as a worst-first list with the cross-link to
          Operativos/Alcance that closes the Padrón ↔ Operativos gap. */}
      {coverage.byProvince.length > 0 && (
        <SterilizationGapCard
          byProvince={coverage.byProvince}
          suppressedCount={coverage.byProvinceSuppressedCount}
          targetPct={sterilTargetPct}
          targetAdjusted={sterilTargetAdjusted}
        />
      )}

      <DashboardFreshnessFooter ctx={ctx} />
    </div>
  );
}
