// /admin/poblacion — Control poblacional (vista admin universal, Paquete G).
//
// Universal view: no JurisdictionSwitcher, admin sees all pets regardless of province.
// Adds a cross-province sterilization-coverage ranked table on top of the gob/poblacion panels.
//
// Layout:
//   KPI row      — cobertura esterilización · preñeces activas · nacimientos registrados ·
//                  balance poblacional
//   Ratio sub    — ratio esterilización/natalidad
//   Trend        — TimeSeriesChart (sterilization_performed)
//   Tabla ranked — per-province sterilization coverage (<table>)
//   Freshness footer
//
// PANORAMA NOTE: The Paquete G Panorama layer/preset is deferred to a separate
// work unit. This page is the standalone admin dashboard — not the Panorama integration.
//
// F8 fusion (2026-07-22): this is the byte-identical body of the former
// /admin/poblacion page.tsx, relocated so the admin Padrón hub
// (app/admin/padron/page.tsx) can render it as its "Población" vista (the
// default). /admin/poblacion itself now only redirects here (see
// app/admin/poblacion/page.tsx) — this is a RELOCATION, not a redesign: same
// searchParams contract, same auth guard, same query logic. This screen is
// NOT shared with gob's PoblacionScreen — the admin body genuinely diverges
// (national ranked table + no jurisdiction filter), so the two hubs render
// different screens under the same tab shape.

import { ForecastChartDynamic } from "@/components/charts/ForecastChartDynamic";
import { TimeSeriesChartDynamic } from "@/components/charts/TimeSeriesChartDynamic";
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
import { DEFAULT_DASHBOARD_PRESET } from "@/lib/analytics/analytics-period";
import { formatDelta } from "@/lib/analytics/campaign-metrics";
import { adminProvinceHref } from "@/lib/infra/admin-province-link";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import {
  SUPPRESSED_CELL_TEXT,
  TARGETS,
  buildProjectionContext,
  fetchActivePregnancies,
  fetchNetGrowth,
  fetchPrevRegisteredBirths,
  fetchReproductiveOutcomes,
  fetchSterilizationCoverage,
  fetchSterilizationNatalidadRatio,
  fetchSterilizationTrend,
  futureBucketLabel,
  projectSeries,
  provinceSuppressionNotice,
  scopeTotalSuppressionNotice,
  toneForTarget,
} from "@/lib/metrics";
import type { ProvinceSterlizationRow } from "@/lib/metrics";
import { KPI_CATALOG, getKpiInfo } from "@/lib/metrics/kpi-catalog";
import { windows } from "@/lib/metrics/period";
import { describeNarrowedView } from "@/lib/ui/view-scope-caption";
import { formatPercent, formatRate, pluralizeEs, speciesOptions } from "@/lib/utils/format";

/**
 * A cell whose value the D.10 disclosure rule withheld. An em dash for sighted
 * users, the full reason for assistive tech and on hover — never a 0 (a false
 * zero asserts) and never blank (blank reads as "no aplica").
 */
function SuppressedCellText() {
  return (
    <span className="text-ln-op-mute" title={SUPPRESSED_CELL_TEXT}>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{SUPPRESSED_CELL_TEXT}</span>
    </span>
  );
}

/**
 * Ranking order for the per-province table. Withheld rows have no rate to rank
 * on, so they sort to the BOTTOM as an alphabetical block — never dropped: a row
 * that vanishes at k makes absence the disclosure channel.
 */
function sortForRanking(rows: ProvinceSterlizationRow[]): ProvinceSterlizationRow[] {
  return [...rows].sort((a, b) => {
    if (a.suppressed && b.suppressed) return a.province.localeCompare(b.province);
    if (a.suppressed) return 1;
    if (b.suppressed) return -1;
    return b.ratePct - a.ratePct;
  });
}

/** Tailwind text color for a coverage rate against its target; muted when the
 *  cell is withheld (there is no performance to signal). */
function rateColorFor(row: ProvinceSterlizationRow): string {
  if (row.suppressed) return "text-ln-op-mute";
  const tone = toneForTarget(row.ratePct, TARGETS.STERILIZATION_COVERAGE_PCT);
  if (tone === "ok") return "text-ln-op-ok";
  if (tone === "warn") return "text-ln-op-warn";
  return "text-ln-op-danger";
}

/**
 * One row of the per-province coverage ranking. Extracted so the table body
 * stays under the cognitive-complexity fence AND so the three numeric cells
 * share ONE withheld branch — a row that hid the rate but printed the base would
 * leak the numerator by multiplication.
 */
function ProvinceCoverageRow({ row, rank }: { row: ProvinceSterlizationRow; rank: number }) {
  const drillHref = adminProvinceHref(row.province);
  return (
    <tr
      className={[
        "border-b border-ln-op-line last:border-0",
        // Only signal interactivity when the row actually links out — an
        // unresolvable province is not clickable (C4).
        drillHref ? "hover:bg-ln-op-stripe/50 transition-colors" : "",
      ].join(" ")}
    >
      <td className="py-2 pr-4">
        <span className="text-sm tabular-nums text-ln-op-mute mr-2">{rank}.</span>
        {drillHref ? (
          <a href={drillHref} className="text-ln-op-azul underline-offset-2 hover:underline">
            {row.province}
          </a>
        ) : (
          row.province
        )}
      </td>
      <td className="py-2 pl-4 text-right tabular-nums">
        {row.suppressed ? <SuppressedCellText /> : row.sterilized.toLocaleString("es-AR")}
      </td>
      <td className="py-2 pl-4 text-right tabular-nums">
        {row.suppressed ? <SuppressedCellText /> : row.total.toLocaleString("es-AR")}
      </td>
      <td className={`py-2 pl-4 text-right tabular-nums font-semibold ${rateColorFor(row)}`}>
        {row.suppressed ? <SuppressedCellText /> : formatPercent(row.ratePct)}
      </td>
    </tr>
  );
}

// Species domain axis — mirrors /gob/poblacion's SPECIES_OPTIONS exactly
// (twin port, Fase B "regalos olvidados"). pets.species is free text ('dog' |
// 'cat' | 'other' in practice); "other" is the exact stored value the
// fetchers honor as-is (no query change).
// Valores: decisión de esta pantalla. Ortografía: speciesLabel, fuente única.
const SPECIES_OPTIONS = speciesOptions(["dog", "cat", "other"]);

export type AdminPoblacionScreenProps = {
  searchParams: { period?: string; from?: string; to?: string; species?: string };
  /**
   * True when rendered as the admin Padrón hub's "Población" tab
   * (app/admin/padron/page.tsx) — see components/ui/dashboard/ScreenHeader.tsx.
   */
  underHub?: boolean;
};

export async function AdminPoblacionScreen({
  searchParams: sp,
  underHub = false,
}: AdminPoblacionScreenProps) {
  await requireAdminOrRedirect();

  // Admin context: global scope (no jurisdiction restriction), trailing 12m window.
  const { resolveAnalyticsPeriod } = await import("@/lib/metrics/period");
  const period = sp.period || sp.from ? resolveAnalyticsPeriod(sp) : windows.trailing12m();
  const species = sp.species || undefined;

  const ctx = buildProjectionContext({ role: "admin" }, [], period);

  // C3 disclosure: caption when this page's filters narrow below the mandate.
  // This screen has no province/locality drill-down (fully national, universal
  // admin scope) — always null, kept for parity with the other admin screens.
  const narrowedView = describeNarrowedView({
    role: "admin",
    mandateJurisdictions: [],
  });

  // Page header — rendered in both the data and degraded (D2) branches.
  const header = (
    <ScreenHeader
      underHub={underHub}
      className="space-y-2"
      eyebrow="Admin · Control poblacional nacional"
      title="Control poblacional"
      subtitle={
        <>
          <p className="text-md text-ln-op-mute">
            Vista nacional: cobertura de esterilización, reproducción y balance, con ranking por
            provincia.
          </p>
          <ViewScopeCaption scope={narrowedView} />
        </>
      }
    />
  );

  // Hoisted with the header so the degraded branch keeps it: every axis here is
  // built from `sp` and from module constants, resolved before the load. The
  // filter bar is exactly what an operator would reach for to narrow the query
  // that just timed out, so it is the worst thing to drop on that render.
  // Same shape as app/gob/censo/CensoScreen.tsx.
  const filtersRow = (
    <OpFilterBar
      period={{ defaultPreset: DEFAULT_DASHBOARD_PRESET }}
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
    />
  );

  // D2: bound the fetcher set with a deadline (see /admin/censo).
  // fetchPrevRegisteredBirths adds ONE new query (same scope, shifted one
  // period back) purely to power the Nacimientos registrados deltaV2 chip —
  // mirrors campaign-metrics.ts' fetchPrevTotals pattern (same as /gob/poblacion).
  // species narrows every fetcher below identically (twin of /gob/poblacion's
  // domain-axes work) so the KPI row, ratio tile, net-growth breakdown, trend,
  // and ranked table all agree.
  const load = await loadWithTimeout(
    Promise.all([
      fetchSterilizationCoverage(ctx, { species }),
      fetchActivePregnancies(ctx, { species }),
      fetchReproductiveOutcomes(ctx, { species }),
      fetchNetGrowth(ctx, { species }),
      fetchSterilizationNatalidadRatio(ctx, { species }),
      fetchSterilizationTrend(ctx, { species }),
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
          retryHref={analyticsRetryHref("/admin/padron", { ...sp, vista: "poblacion" })}
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
    prevRegisteredBirths,
  ] = load.value;

  // D.10: the verdict was made ONCE inside fetchSterilizationCoverage, so this
  // screen never holds a withheld number and cannot disagree with
  // /gob/poblacion/export for the same viewer. Announcing it is mandatory —
  // hiding cells without saying so is the failure #40's follow-up shipped.
  const coverageNotice = provinceSuppressionNotice(coverage.byProvinceSuppressedCount);

  // Same single verdict as /gob/poblacion (RA-3 finding C1). No province drill
  // here, so it only trips when the whole national grouping is one withheld
  // province — a sparse pilot where the national coverage rate would be that
  // province's protected base wearing a national label.
  const scopeNotice = scopeTotalSuppressionNotice(coverage.scopeTotalPublishable);
  if (scopeNotice) {
    return (
      <div className="space-y-6">
        {header}
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
  const hasTrend = sterilTrend.points.length > 0;

  // Paquete J — forward projection over the sterilization FLOW series (event
  // counts/bucket). Reuses the already-fetched trend points (no extra DB call).
  // §J-D3: the legal/programmatic target is COVERAGE % (a stock); we do NOT pass
  // a %-meta ReferenceLine onto this counts axis — the volume band stands alone.
  // Projection ticks carry REAL calendar labels ("ago 26"), not "+1/+2/+3"
  // (axis-format unification, visual review 2026-07-23 #13).
  const sterilForecast = projectSeries(sterilTrend.points, {
    horizon: 3,
    labelForecast: (h) =>
      futureBucketLabel(period, sterilTrend.granularity, sterilTrend.points.length, h),
  });

  const coverageTone = toneForTarget(coverage.rate, TARGETS.STERILIZATION_COVERAGE_PCT);

  const natalidadCaveatText = "Solo partos en seguimiento — subestima la natalidad real";
  // metric-honesty 2026-07-09: the ratio's denominator (partos registrados)
  // under-counts real natalidad, so the ratio OVER-states population control.
  const ratioOverstatementCaveat =
    "Contexto, no indicador de decisión: el denominador (partos en seguimiento) subestima la natalidad real, por lo que este ratio SOBRESTIMA la contención poblacional.";

  const panelTrendId = "admin-panel-esterilizacion-titulo";
  const panelForecastId = "admin-panel-esterilizacion-proyeccion-titulo";
  const panelTableId = "admin-panel-tabla-titulo";

  return (
    <div className="space-y-6">
      {/* Page header */}
      {header}

      {/* Unified filter bar — period + species (no jurisdiction for admin —
          universal scope). Twin of /gob/poblacion's rail. */}
      {filtersRow}

      {/* KPI row */}
      <section
        aria-label="Indicadores de control poblacional nacional"
        className="grid grid-cols-2 md:grid-cols-4 gap-3"
      >
        {/* KPI 1: Sterilization coverage */}
        <OpKpi
          label="Cobertura de esterilización"
          value={hasData ? formatPercent(coverage.rate) : "—"}
          bar={hasData ? coverage.rate : undefined}
          tone={hasData ? coverageTone : "neutral"}
          sub={
            hasData
              ? `meta programática 70% · ${coverage.sterilized.toLocaleString("es-AR")} de ${coverage.total.toLocaleString("es-AR")}`
              : "Sin datos"
          }
          info={getKpiInfo("sterilization_coverage_population")}
          descriptorId="sterilization_coverage_population"
        />

        {/* KPI 2: Active pregnancies */}
        <OpKpi
          label={KPI_CATALOG.active_pregnancies.label}
          value={activePregnancies.toLocaleString("es-AR")}
          // Bug fix (qa-triage-2026-07-23, finding #9): raw enum + column name
          // leaked into operator-facing copy. Localized to match the gob
          // twin's wording (app/gob/poblacion/PoblacionScreen.tsx), scoped
          // "nacional" for this admin (universal-scope) screen.
          sub="preñez registrada y aún no cerrada (nacional)"
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
              "Eventos clinical_info_logged con sub_kind='pregnancy', pregnancy_phase='ended' y outcome='live_birth' en el período seleccionado, a nivel nacional.",
            formula:
              "COUNT(clinical_info_logged WHERE sub_kind='pregnancy' AND pregnancy_phase='ended' AND outcome='live_birth' AND period)",
            caveat:
              "Solo cuenta partos de preñeces registradas en el sistema. Partos callejeros y camadas sin seguimiento son invisibles. Indicador direccional, no exacto.",
          }}
          descriptorId="registered_births"
          guardInput={{ priorBase: prevRegisteredBirths }}
        />

        {/* KPI 4: Net registry inflow — directional, neutral tone.
            demo-review M2 (mirrored from /gob/poblacion): "Balance
            poblacional" read as real population growth, but "altas" is
            pets.created_at (new registrations, including pre-existing
            animals just onboarded), not new animals born. Relabeled to keep
            this surface consistent with the govt dashboard's honest wording. */}
        <OpKpi
          label={KPI_CATALOG.net_registry_inflow.label}
          value={
            netGrowth.net > 0
              ? `+${netGrowth.net.toLocaleString("es-AR")}`
              : netGrowth.net.toLocaleString("es-AR")
          }
          sub="Indicador direccional — no es crecimiento poblacional real"
          tone="neutral"
          info={{
            definition:
              "Altas nuevas en el período + nacimientos registrados − muertes registradas (nacional).",
            formula: "COUNT(altas) + COUNT(live_birth events) − COUNT(death_recorded events)",
            caveat:
              "INDICADOR DIRECCIONAL, NO EXACTO — no es crecimiento poblacional real. 'Altas nuevas' son mascotas RECIÉN REGISTRADAS en miMAR (pets.created_at), que en su mayoría ya existían y no representan nacimientos. Los nacimientos registrados solo cubren partos en seguimiento — callejero e ilegítimos son invisibles.",
          }}
          descriptorId="net_registry_inflow"
        />
      </section>
      {/* mirrors gob twin (visual review 2026-07-23 #10): the natalidad caveat
          belongs to the births tile only — this tile's own honest sub above. */}

      {/* Ratio esterilización/natalidad — CONTEXT tile (metric-honesty
          2026-07-09). Demoted out of the headline: it OVER-states population
          control because its denominator (partos en seguimiento) under-counts
          real natalidad. */}
      {sterilNatalidadRatio !== null && (
        <section aria-label={KPI_CATALOG.sterilization_natalidad_ratio.label}>
          {/* Background unified to OpCard's canonical bg-ln-op-card (design-
              consistency sweep) — no bordered-divider header here, so it stays a
              plain div rather than a full OpCard conversion. */}
          <div className="rounded-xl border border-ln-op-line bg-ln-op-card px-5 py-4">
            <p className="text-sm font-semibold uppercase tracking-[0.1em] text-ln-op-mute">
              Contexto · Ratio esterilización / natalidad registrada (nacional)
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
              description="No hay eventos sterilization_performed en el rango seleccionado."
            />
          ) : (
            <TimeSeriesChartDynamic
              data={sterilTrend.points}
              seriesLabel="Esterilizaciones"
              yLabel="Eventos registrados"
              variant="area"
              fallbackTableLabel={`Esterilizaciones por ${sterilTrend.granularity === "month" ? "mes" : "semana"}`}
            />
          )}
        </OpCardBody>
      </OpCard>

      {/* Sterilization forecast — Paquete J (additive; trend card stays intact) */}
      <OpCard aria-labelledby={panelForecastId}>
        <OpCardHead title={<span id={panelForecastId}>Proyección de esterilizaciones</span>} />
        <OpCardBody>
          {!hasTrend ? (
            <LnEmptyState
              icon="chart-line"
              title="Sin datos para proyectar"
              description="No hay eventos sterilization_performed en el rango seleccionado."
            />
          ) : (
            <ForecastChartDynamic
              result={sterilForecast}
              seriesLabel="Esterilizaciones"
              unit="esterilizaciones"
            />
          )}
        </OpCardBody>
      </OpCard>

      {/* Cross-province sterilization coverage ranked table */}
      <OpCard aria-labelledby={panelTableId}>
        <OpCardHead
          title={<span id={panelTableId}>Cobertura de esterilización por provincia</span>}
        />
        <OpCardBody>
          {coverage.byProvince.length === 0 ? (
            <p className="text-md text-ln-op-mute">Sin datos provinciales disponibles.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-md text-ln-op-ink border-collapse">
                <caption className="sr-only">
                  Ranking de cobertura de esterilización por provincia, ordenado de mayor a menor.
                </caption>
                <thead>
                  <tr className="border-b border-ln-op-line">
                    <th scope="col" className="text-left py-2 pr-4 font-semibold text-ln-op-mute">
                      Provincia
                    </th>
                    <th scope="col" className="text-right py-2 pl-4 font-semibold text-ln-op-mute">
                      Esterilizadas
                    </th>
                    <th scope="col" className="text-right py-2 pl-4 font-semibold text-ln-op-mute">
                      Total activas
                    </th>
                    <th scope="col" className="text-right py-2 pl-4 font-semibold text-ln-op-mute">
                      Cobertura
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortForRanking(coverage.byProvince).map((row, i) => (
                    <ProvinceCoverageRow key={row.province} row={row} rank={i + 1} />
                  ))}
                </tbody>
              </table>
              {coverageNotice && <p className="mt-2 text-xs text-ln-op-mute">{coverageNotice}</p>}
              {(() => {
                // byProvinceAssignedTotal sums ALL provinces, withheld included —
                // recomputing from the visible rows would overstate the residual
                // AND make this footnote the subtraction channel that recovers a
                // hidden cell. It is null exactly when publishing it would isolate
                // one, and then this says nothing at all.
                const assignedTotal = coverage.byProvinceAssignedTotal;
                if (assignedTotal === null) return null;
                const unassigned = coverage.total - assignedTotal;
                if (unassigned <= 0) return null;
                return (
                  <p className="mt-2 text-xs text-ln-op-mute">
                    * {unassigned.toLocaleString("es-AR")} {pluralizeEs(unassigned, "mascota")} sin
                    provincia asignada no {unassigned === 1 ? "aparece" : "aparecen"} en la tabla —
                    la suma de las filas no equivale al total nacional.
                  </p>
                );
              })()}
            </div>
          )}
        </OpCardBody>
      </OpCard>

      <DashboardFreshnessFooter ctx={ctx} />
    </div>
  );
}
