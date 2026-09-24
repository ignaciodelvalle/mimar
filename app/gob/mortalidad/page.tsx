// /gob/mortalidad — Mortality & disposal dashboard (Item 2).
//
// Standalone, jurisdiction-scoped, period-aware govt screen surfacing the
// disposal-traceability signal already captured by death_recorded (Ley CABA
// 5470). Pure projection: all data comes from fetchMortalityDisposition over the
// event log — no schema, no new event type (umbrella D1).
//
// Layout (Op* design system):
//   KPI row     — total deaths · B3 traceable rate · B4 unknown rate · B9 reportable share
//   OpBreach    — conditional, shown when B4 > 25% (low disposal traceability)
//   Disposición — B2 bucket bars
//   Contexto    — B7 splits (vet-confirmed / at-clinic / private crematorium)
//   Causas      — B1 cause-by-week
//   Distribución— B8 deaths by locality (k-anonymity suppressed)
//
// ProjectionContext is built once at this page boundary (like app/gob/page.tsx)
// and passed to the single fetcher.

import { StackedTimeSeriesChartDynamic } from "@/components/charts/StackedTimeSeriesChartDynamic";
import { LnEmptyState } from "@/components/ui/EmptyState";
import {
  OpBreach,
  OpCard,
  OpCardBody,
  OpCardHead,
  type OpFilterAxis,
  OpFilterBar,
  OpKpi,
  OpKpiSm,
  ViewScopeCaption,
} from "@/components/ui/dashboard";
import { AnalyticsLoadFallback } from "@/components/ui/dashboard/AnalyticsLoadFallback";
import { DashboardFreshnessFooter } from "@/components/ui/dashboard/DashboardFreshnessFooter";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { analyticsRetryHref, loadWithTimeout } from "@/lib/analytics/analytics-load";
import { formatDelta } from "@/lib/analytics/campaign-metrics";
import { resolveJurisdictionScope } from "@/lib/analytics/jurisdiction-scope";
import {
  fetchMortalityDisposition,
  fetchPrevMortalityTotal,
  sortLocalityCellsRollupLast,
} from "@/lib/analytics/mortality-metrics";
import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import { requireGobReadAccessOrRedirect } from "@/lib/infra/auth-guards";
import {
  TARGETS,
  buildProjectionContext,
  fetchDeathCausesTrend,
  fetchKpiTrend,
  toneForBreachCeiling,
  toneForTarget,
} from "@/lib/metrics";
import { KPI_CATALOG, getKpiInfo } from "@/lib/metrics/kpi-catalog";
import { formatMetricLegalBasis, resolveMetricLegalBasis } from "@/lib/metrics/metric-legal-basis";
import { resolveAnalyticsPeriod } from "@/lib/metrics/period";
import { describeNarrowedView } from "@/lib/ui/view-scope-caption";
import { deathCauseLabel, formatPercent, pluralizeEs, speciesOptions } from "@/lib/utils/format";

export const dynamic = "force-dynamic";

const BUCKET_LABELS: Record<string, string> = {
  cremation: "Cremación",
  authorized_burial: "Cementerio autorizado",
  home_burial: "Entierro en domicilio",
  rendering: "Reciclaje sanitario",
  other: "Otro / sin especificar",
};

// Species domain axis — mirrors /gob/perdidas' SPECIES_OPTIONS exactly.
// pets.species is free text ('dog' | 'cat' | 'other' in practice); "other" is
// the exact stored value the fetchers honor as-is (no query change).
// Valores: decisión de esta pantalla. Ortografía: speciesLabel, fuente única.
const SPECIES_OPTIONS = speciesOptions(["dog", "cat", "other"]);

// Death-cause domain axis — the deathRecorded event schema's `cause` enum
// (lib/events/event-schemas.ts) is a closed set; fetchMortalityDisposition
// already COALESCEs a missing cause to 'unknown', so that value is included
// here as a selectable option rather than only appearing unbidden in the chart.
const DEATH_CAUSE_VALUES = [
  "known",
  "unknown",
  "natural",
  "disease",
  "accident",
  "euthanasia",
  "sudden",
  "violent",
  "other",
] as const;
const CAUSE_OPTIONS = DEATH_CAUSE_VALUES.map((value) => ({
  value,
  label: deathCauseLabel(value),
}));

export default async function GobMortalidadPage({
  searchParams,
}: {
  searchParams: Promise<{
    period?: string;
    from?: string;
    to?: string;
    province?: string;
    locality?: string;
    species?: string;
    cause?: string;
  }>;
}) {
  const { profile, jurisdictions } = await requireGobReadAccessOrRedirect();
  const actor = { role: profile.role } as const;

  // Capability guard: analytics.read = admin OR (govt AND has assignments).
  const hasAnalyticsRead =
    hasNationalReadScope(profile.role) || (profile.role === "govt" && jurisdictions.length > 0);

  if (!hasAnalyticsRead) {
    return (
      <div className="space-y-6">
        <LnEmptyState
          icon="lock"
          title="Sin acceso"
          description="Tu rol no tiene acceso a mortalidad. Pedile al admin que te asigne capabilities."
        />
      </div>
    );
  }

  const sp = await searchParams;

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

  // C3 disclosure: caption when this page's filters narrow below the mandate.
  const narrowedView = describeNarrowedView({
    role: profile.role,
    mandateJurisdictions: jurisdictions,
    effectiveJurisdictions: filteredJurisdictions,
    adminProvince,
    adminLocality,
  });
  // Mandate-scoped legal citation (red-team CRITICAL): "Ley 5470" is a CABA
  // law — it is only cited to an operator whose MANDATE (raw assignments, not
  // the page's narrowed filter) includes CABA. Admin has universal scope and
  // keeps the full citation.
  const mandateProvinces = hasNationalReadScope(profile.role)
    ? ("all" as const)
    : [...new Set(jurisdictions.map((j) => j.province))];
  const traceabilityLegalBasis = formatMetricLegalBasis(
    "mortality_disposal_traceability",
    mandateProvinces,
  );
  const traceabilityLegalGap = resolveMetricLegalBasis(
    "mortality_disposal_traceability",
    mandateProvinces,
  ).hasProvincialGap;

  const species = sp.species || undefined;
  // Validate against the closed cause enum so an invalid URL value never
  // drives the query (same discipline as /gob/perdidas' parseStatusFilter).
  const cause =
    sp.cause && (DEATH_CAUSE_VALUES as readonly string[]).includes(sp.cause) ? sp.cause : undefined;

  const period = resolveAnalyticsPeriod(sp);
  const ctx = buildProjectionContext(actor, filteredJurisdictions, period, {
    adminProvince,
    adminLocality,
  });
  // Header + filter bar render in BOTH the data and the degraded branch (same
  // shape as app/gob/censo/CensoScreen.tsx). Neither depends on the fetchers
  // below — the bar is built from allowedProvinces/localities, already resolved
  // by resolveJurisdictionScope — and dropping them on timeout removed the very
  // controls (province, period) that would have narrowed the query that timed
  // out, while "Reintentar" re-issues the identical one.
  const shell = (
    <>
      {/* Page header */}
      <ScreenHeader
        className="space-y-2"
        eyebrow="Vigilancia sanitaria"
        title="Mortalidad y disposición"
        subtitle={
          <>
            {/* The universal claim yields to the narrowed-view caption (never both). */}
            {hasNationalReadScope(profile.role) ? (
              narrowedView ? null : (
                <p className="text-md text-ln-op-mute">
                  Vista universal — todas las jurisdicciones.
                </p>
              )
            ) : (
              <p className="text-md text-ln-op-mute">
                {!traceabilityLegalGap && traceabilityLegalBasis
                  ? `Trazabilidad de la disposición final de fallecimientos (${traceabilityLegalBasis}) en tu cobertura.`
                  : // Provincial gap: the mandate has no province with a
                    // registered disposal law — neutral framing, never a
                    // foreign province's law.
                    `Trazabilidad de la disposición final de fallecimientos en tu cobertura.${traceabilityLegalBasis ? ` ${traceabilityLegalBasis}.` : ""}`}
              </p>
            )}
            <ViewScopeCaption scope={narrowedView} />
          </>
        }
      />

      {/* Unified filter bar — jurisdiction + period + species/cause axes +
          active-filter chips. */}
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
              current: species ?? null,
            },
            {
              id: "cause",
              label: "Causa",
              paramKey: "cause",
              options: CAUSE_OPTIONS,
              current: cause ?? null,
            },
          ] satisfies OpFilterAxis[]
        }
      />
    </>
  );

  // Snapshot projection + the D1 cause-by-period trend + death sparkline run in
  // parallel over the same scoped death_recorded population. fetchPrevMortalityTotal
  // adds ONE new query (same scope, shifted one period back) purely to power the
  // "Muertes (período)" deltaV2 chip — mirrors campaign-metrics.ts' fetchPrevTotals.
  //
  // species + cause narrow every fetcher below identically (fetchMortalityDisposition
  // shares ONE `where` across all its sub-queries) so the KPI row, disposition bars,
  // context splits, causes-by-week chart, and locality breakdown all agree. The
  // death sparkline (fetchKpiTrend) only takes species — "cause" is a
  // death_recorded-payload-specific field, not something the generic
  // event-type trend helper models; the sparkline is a decorative secondary
  // signal, not the headline tile, so this is an accepted minor inconsistency
  // when a cause filter is active.
  // BOUNDED (outage pass 2026-08-09).
  const load = await loadWithTimeout(
    Promise.all([
      fetchMortalityDisposition(ctx, { species, cause }),
      fetchDeathCausesTrend(ctx, { species, cause }),
      fetchKpiTrend("death_recorded", ctx, { species }),
      fetchPrevMortalityTotal(ctx, { species, cause }),
    ]),
  );
  if (!load.ok) {
    return (
      <div className="space-y-6">
        {shell}
        <AnalyticsLoadFallback
          reason={load.reason}
          correlationId={load.id}
          retryHref={analyticsRetryHref("/gob/mortalidad", sp)}
        />
      </div>
    );
  }
  const [m, causesTrend, deathSparkline, prevTotal] = load.value;

  const deathsDelta = formatDelta(m.total, prevTotal, "vs período anterior");

  const maxBucket = m.byBucket.reduce((acc, b) => Math.max(acc, b.count), 0);
  // Segregate the k-anon rollup bucket(s) (qa-triage-2026-07-23, finding #14):
  // sort them LAST regardless of count so a large aggregate (many small
  // localities folded together — "Santiago del Estero (otras localidades)"
  // hit 1.965 in live seed data) never visually reads as "the #1 locality" —
  // it isn't one. Real, individually-identified localities keep their
  // original (DB-returned) order among themselves.
  const localityCells = sortLocalityCellsRollupLast(m.byLocality.value);
  const maxLocality = localityCells.reduce((acc, c) => Math.max(acc, c.count), 0);
  const showBreach = m.unknownRate > TARGETS.DISPOSAL_UNKNOWN_BREACH_PCT;
  const hasDeaths = m.total > 0;

  const panelDispId = "panel-disposicion-titulo";
  const panelCtxId = "panel-contexto-titulo";
  const panelCauseId = "panel-causas-titulo";
  const panelLocId = "panel-localidad-titulo";

  // D1 — "Causas por semana" is now a stacked time-series. The bucket unit
  // follows the selected period (week for short windows, month for long ones).
  const causeBucketWord = causesTrend.granularity === "month" ? "mes" : "semana";
  const causesCardTitle = `Causas por ${causeBucketWord}`;
  const hasCausesTrend = causesTrend.series.points.length > 0;

  return (
    <div className="space-y-6">
      {/* Header + filter bar — hoisted above the load so the degraded branch
          keeps them (see the `shell` definition). */}
      {shell}

      {/* Conditional breach banner — low disposal traceability */}
      {showBreach && (
        <OpBreach
          title="Baja trazabilidad de disposición"
          detail={`${formatPercent(m.unknownRate)} de los fallecimientos no tienen método de disposición registrado (umbral ${TARGETS.DISPOSAL_UNKNOWN_BREACH_PCT}%).`}
        />
      )}

      {/* KPI row */}
      <section
        aria-label="Indicadores de mortalidad"
        className="grid grid-cols-2 md:grid-cols-4 gap-3"
      >
        <OpKpi
          label="Muertes (período)"
          value={hasDeaths ? m.total.toLocaleString("es-AR") : "—"}
          sub={hasDeaths ? "fallecimientos registrados" : "Sin datos en el período"}
          tone={!hasDeaths ? "neutral" : undefined}
          deltaV2={
            // Neutral valence: a deaths rise can be real deterioration OR
            // better registration — no green/red verdict either way (same
            // posture as PanoramaKpiTile's never-valence delta).
            hasDeaths && deathsDelta ? { ...deathsDelta, valence: "neutral" as const } : undefined
          }
          sparkline={deathSparkline.points}
          info={{
            definition:
              "Total de eventos death_recorded registrados en el período y jurisdicción seleccionados.",
            formula: "COUNT(death_recorded) en scope + período",
          }}
          descriptorId="mortality_deaths_period"
          guardInput={{ n: m.total, priorBase: prevTotal }}
        />
        <OpKpi
          label="Trazabilidad de disposición"
          // Honesty (backlog H1): with no deaths in scope every rate is 0/0 → 0%,
          // which toneForTarget paints RED (false alarm) / GREEN (false success).
          // Gate the rate tiles on hasDeaths → "—" neutral, like the count tile.
          value={hasDeaths ? formatPercent(m.traceableRate) : "—"}
          tone={
            hasDeaths
              ? toneForTarget(m.traceableRate, TARGETS.DISPOSAL_TRACEABILITY_PCT)
              : "neutral"
          }
          bar={hasDeaths ? m.traceableRate : undefined}
          sub={`meta ${TARGETS.DISPOSAL_TRACEABILITY_PCT}% · método + instalación${
            !traceabilityLegalGap && traceabilityLegalBasis
              ? ` (B3 · ${traceabilityLegalBasis})`
              : // Provincial gap (or no registered basis): keep the metric
                // code, never cite a province outside the mandate.
                " (B3)"
          }`}
          info={getKpiInfo("mortality_disposal_traceability")}
          descriptorId="mortality_disposal_traceability"
          guardInput={{ n: m.total }}
        />
        <OpKpi
          label={KPI_CATALOG.mortality_unknown_disposal_rate.label}
          value={hasDeaths ? formatPercent(m.unknownRate) : "—"}
          // toneForBreachCeiling, not toneForTarget (screenshot review finding
          // #12): the catalog's own caveat calls this threshold "umbral de
          // incumplimiento (no meta a alcanzar)" — a breach ceiling, not a
          // target worth painting green as you approach it. 16,7% unknown
          // disposition is a real data/compliance gap even though it's under
          // the 25% breach line; toneForTarget's "ok" band read it as a win.
          tone={
            hasDeaths
              ? toneForBreachCeiling(m.unknownRate, TARGETS.DISPOSAL_UNKNOWN_BREACH_PCT)
              : "neutral"
          }
          sub="sin método registrado (B4)"
          info={{
            definition:
              "Porcentaje de fallecimientos sin método de disposición registrado (campo disposition_method ausente o con valor 'unknown'). Es el complemento negativo de la trazabilidad (B4).",
            formula: "deaths con (disposition_method IS NULL OR = 'unknown') / total",
            caveat: `Se activa alerta visual cuando supera el ${TARGETS.DISPOSAL_UNKNOWN_BREACH_PCT}%.`,
          }}
          descriptorId="mortality_unknown_disposal_rate"
          guardInput={{ n: m.total }}
        />
        <OpKpi
          label={KPI_CATALOG.mortality_reportable_share.label}
          value={hasDeaths ? formatPercent(m.reportableShare) : "—"}
          tone={hasDeaths && m.reportableShare > 0 ? "warn" : undefined}
          sub="del total (B9)"
          info={{
            definition:
              "Porcentaje de fallecimientos que corresponden a enfermedades de notificación obligatoria (campo is_reportable = true). Un valor > 0 requiere notificación a la autoridad sanitaria (B9).",
            formula: "deaths con (is_reportable = true) / total",
            caveat:
              "Cualquier valor > 0% activa una indicación de atención: esos fallecimientos requieren notificación ENO.",
          }}
          descriptorId="mortality_reportable_share"
          guardInput={{ n: m.total }}
        />
      </section>

      {/* Disposición — B2 bucket bars + Contexto — B7 splits */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <OpCard aria-labelledby={panelDispId}>
          <OpCardHead title={<span id={panelDispId}>Disposición</span>} />
          <OpCardBody>
            {m.byBucket.length === 0 ? (
              // C4 (2026-07-22, §S4): death_recorded only exists in miMAR if
              // an owner/vet logs it — a physical death that's never logged
              // reads identically to "no deaths". no-signal, not "all clear".
              <LnEmptyState
                icon="eye-off"
                nature="no-signal"
                title="Sin fallecimientos registrados en miMAR"
                description="La ausencia de registro no implica ausencia de mortalidad en tu cobertura — depende de que un dueño o profesional lo registre."
              />
            ) : (
              // Q2: role="img" used to sit here, which flattens the ENTIRE
              // subtree to a single opaque image for assistive tech — the
              // figcaption AND every <li>'s per-bar aria-label below became
              // unreachable. Dropping the role restores <figure>'s normal
              // (non-flattening) semantics; the figure's own aria-label still
              // gives an overview, and the list stays independently readable
              // (same fix already shipped for StaticFirstMap's static-map role).
              <figure
                aria-label={`Disposición final de fallecimientos — ${m.byBucket.length} ${pluralizeEs(
                  m.byBucket.length,
                  "método",
                )}. Máximo: ${maxBucket} ${pluralizeEs(maxBucket, "fallecimiento")}.`}
              >
                <figcaption className="sr-only">
                  Gráfico de barras horizontales: distribución de fallecimientos por método de
                  disposición final. Los valores representan conteo de fallecimientos registrados en
                  el período seleccionado.
                </figcaption>
                <ul className="space-y-2" aria-label="Métodos de disposición">
                  {m.byBucket.map((b) => {
                    const pct = maxBucket > 0 ? (b.count / maxBucket) * 100 : 0;
                    const label = BUCKET_LABELS[b.bucket] ?? b.bucket;
                    return (
                      <li
                        key={b.bucket}
                        className="flex items-center gap-3"
                        // Bug fix (qa-triage-2026-07-23, finding #14): "(100%
                        // del máximo)" read as a Ley 5470 COMPLIANCE figure
                        // (the KPI row above literally shows a traceability
                        // %) when it is only this bar's height relative to
                        // the chart's own tallest bar — a distribution fact,
                        // not a legal one. Spelled out honestly so "máximo"
                        // unambiguously means "the most-used disposal method
                        // this period", never a target/obligation.
                        aria-label={`${label}: ${b.count} ${pluralizeEs(b.count, "fallecimiento")} — ${Math.round(pct)}% del método más frecuente en el período (no es una cifra de cumplimiento)`}
                      >
                        <span className="w-40 shrink-0 text-md text-ln-op-ink">{label}</span>
                        <div
                          className="flex-1 h-4 rounded bg-ln-op-stripe overflow-hidden"
                          aria-hidden="true"
                        >
                          <div
                            className="h-full rounded bg-ln-op-azul"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span
                          className="w-8 shrink-0 text-right text-md tabular-nums text-ln-op-ink"
                          aria-hidden="true"
                        >
                          {b.count}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-1.5 text-xs text-ln-op-mute">
                  Escala: 0 – {maxBucket} {pluralizeEs(maxBucket, "fallecimiento")} · cada barra
                  representa el total en el período.
                </p>
              </figure>
            )}
          </OpCardBody>
        </OpCard>

        <OpCard aria-labelledby={panelCtxId}>
          <OpCardHead title={<span id={panelCtxId}>Contexto del fallecimiento</span>} />
          <OpCardBody>
            {/* Stacked below sm (mobile-polish 2026-07): 3-across crushed the
                tiles at 390px. */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <OpKpiSm
                label="Confirmado por vet"
                value={hasDeaths ? formatPercent(m.contextSplits.vetConfirmedRate) : "—"}
                sub="del total"
              />
              <OpKpiSm
                label="En clínica"
                value={hasDeaths ? formatPercent(m.contextSplits.deathAtClinicRate) : "—"}
                sub="muertes en establecimiento"
              />
              <OpKpiSm
                label="Crematorio privado"
                value={hasDeaths ? formatPercent(m.contextSplits.privateCrematoriumRate) : "—"}
                sub="derivación del propietario"
              />
            </div>
          </OpCardBody>
        </OpCard>
      </div>

      {/* Causas — B1 cause-by-period (D1: stacked time-series, was a flat table) */}
      <OpCard aria-labelledby={panelCauseId}>
        <OpCardHead
          title={<span id={panelCauseId}>{causesCardTitle}</span>}
          actions={
            causesTrend.suppressedCount > 0 ? (
              <span className="text-sm font-normal text-ln-op-mute">
                {causesTrend.suppressedCount}{" "}
                {causesTrend.suppressedCount === 1 ? "celda oculta" : "celdas ocultas"} (privacidad)
              </span>
            ) : null
          }
        />
        <OpCardBody>
          {!hasCausesTrend ? (
            // C4 (2026-07-22, §S4): same reporting dependency as the
            // disposal panel above — no-signal, not "all clear".
            <LnEmptyState
              icon="eye-off"
              nature="no-signal"
              title="Sin fallecimientos registrados en miMAR"
              description="La ausencia de registro no implica ausencia de mortalidad — depende de que un dueño o profesional lo registre en el rango y la cobertura seleccionados."
            />
          ) : (
            <StackedTimeSeriesChartDynamic
              seriesKeys={causesTrend.series.seriesKeys}
              points={causesTrend.series.points}
              seriesLabels={Object.fromEntries(
                causesTrend.series.seriesKeys.map((key) => [key, deathCauseLabel(key)]),
              )}
              yLabel="Fallecimientos"
              fallbackTableLabel={`Fallecimientos por ${causeBucketWord} y causa`}
              // Visual review 2026-07-23 (#4): when suppression blanks the whole
              // plot, the in-chart empty state names the privacy treatment
              // (same count the card header already discloses above).
              suppressedCount={causesTrend.suppressedCount}
            />
          )}
        </OpCardBody>
      </OpCard>

      {/* Distribución — B8 deaths by locality (k-anonymity suppressed) */}
      <OpCard aria-labelledby={panelLocId}>
        <OpCardHead
          title={<span id={panelLocId}>Distribución por localidad</span>}
          actions={
            m.byLocality.suppressedCount > 0 ? (
              <span className="text-sm font-normal text-ln-op-mute">
                {m.byLocality.suppressedCount}{" "}
                {m.byLocality.suppressedCount === 1 ? "localidad oculta" : "localidades ocultas"}{" "}
                (privacidad)
              </span>
            ) : null
          }
        />
        <OpCardBody>
          {localityCells.length === 0 ? (
            <p className="text-md text-ln-op-mute">
              No hay localidades con fallecimientos visibles en el período.
            </p>
          ) : (
            // Q2: same role="img" subtree-flattening fix as the Disposición
            // chart above — the per-locality <li> aria-labels below were
            // unreachable while the role sat here.
            <figure
              aria-label={`Fallecimientos por localidad — máximo: ${maxLocality} ${pluralizeEs(maxLocality, "fallecimiento")}.`}
            >
              <figcaption className="sr-only">
                Gráfico de barras horizontales: distribución de fallecimientos por localidad.
                Localidades con menos de 5 fallecimientos están ocultas por privacidad
                (k-anonimato).
              </figcaption>
              <ul className="space-y-2" aria-label="Fallecimientos por localidad">
                {localityCells.map((c) => {
                  const pct = maxLocality > 0 ? (c.count / maxLocality) * 100 : 0;
                  const isRollup = (c as { isRollup?: boolean }).isRollup === true;
                  return (
                    <li
                      key={c.key}
                      className="flex items-center gap-3"
                      aria-label={
                        isRollup
                          ? `${c.key}: ${c.count} ${pluralizeEs(c.count, "fallecimiento")} — agregado de varias localidades con menos de 5 fallecimientos cada una (privacidad), no una única localidad`
                          : `${c.key}: ${c.count} ${pluralizeEs(c.count, "fallecimiento")}`
                      }
                    >
                      <span
                        className={`w-40 shrink-0 truncate text-md ${isRollup ? "italic text-ln-op-mute" : "text-ln-op-ink"}`}
                      >
                        {c.key}
                      </span>
                      <div
                        className="flex-1 h-4 rounded bg-ln-op-stripe overflow-hidden"
                        aria-hidden="true"
                      >
                        <div
                          className={`h-full rounded ${isRollup ? "bg-ln-op-mute/50" : "bg-ln-op-azul"}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span
                        className="w-8 shrink-0 text-right text-md tabular-nums text-ln-op-ink"
                        aria-hidden="true"
                      >
                        {c.count}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-1.5 text-xs text-ln-op-mute">
                Escala: 0 – {maxLocality} {pluralizeEs(maxLocality, "fallecimiento")} · celdas &lt;
                5 ocultas (k-anonimato).
              </p>
            </figure>
          )}
        </OpCardBody>
      </OpCard>

      <DashboardFreshnessFooter ctx={ctx} />
    </div>
  );
}
