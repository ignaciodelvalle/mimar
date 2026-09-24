// AnalyticsScreen — the "Analítica" vista of the Programa hub.
//
// F9 fusion (2026-08-01, PO decision on an external-QA gate): /gob/programa
// ABSORBS this screen as a tabbed vista (`?vista=resumen|analitica`). The body
// below is a RELOCATION, not a redesign — byte-identical to the former
// standalone app/gob/analytics/page.tsx, minus the three things a hub tab owns
// instead of the screen: `export const dynamic` (now on the hub page), the
// eyebrow/h1 (suppressed via ScreenHeader's `underHub`), and the retry href
// (which must return to the hub URL, not to the redirect-only old route).
//
// /gob/analytics survives only as a permanent redirect into
// /gob/programa?vista=analitica (see ./page.tsx). The `_components/` in this
// directory stay put and are imported from here — the SAME arrangement as the
// F8 Padrón fusion, where PoblacionScreen/CensoScreen kept living under their
// now-redirect-only route directories. A route directory that only serves a
// redirect is still a real directory; moving the components would churn every
// import and every path-keyed lint allowlist for no behavioral gain.

import { TimeSeriesChartDynamic } from "@/components/charts/TimeSeriesChartDynamic";
import { LnEmptyState } from "@/components/ui/EmptyState";
import {
  OpCard,
  OpCardBody,
  OpCardHead,
  OpFilterBar,
  OpKpi,
  ViewScopeCaption,
} from "@/components/ui/dashboard";
import { AnalyticsLoadFallback } from "@/components/ui/dashboard/AnalyticsLoadFallback";
import { DashboardFreshnessFooter } from "@/components/ui/dashboard/DashboardFreshnessFooter";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { analyticsRetryHref, loadWithTimeout } from "@/lib/analytics/analytics-load";
import { resolveAnalyticsPeriod } from "@/lib/analytics/analytics-period";
import { fetchRegionRanking } from "@/lib/analytics/analytics-ranking";
import {
  RABIES_VACCINATION_RATE_LABEL_ES,
  acquisitionAdoptionRateSeries,
  fetchAcquisitionTrend,
  fetchAnalyticsMetrics,
  fetchCasesPerCapita,
  fetchDeathCauses,
  fetchOutbreakHistory,
} from "@/lib/analytics/govt-dashboards";
import { resolveJurisdictionScope } from "@/lib/analytics/jurisdiction-scope";
import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import { requireGobReadAccessOrRedirect } from "@/lib/infra/auth-guards";
import {
  TARGETS,
  buildProjectionContext,
  fetchOutbreakSignalsTrend,
  fetchVetAccessByLocality,
  forecastToTarget,
  toneForTarget,
} from "@/lib/metrics";
import { KPI_CATALOG, getKpiInfo } from "@/lib/metrics/kpi-catalog";
import {
  VET_ACCESS_DESERT_MIN_PERIOD_DAYS,
  VET_ACCESS_MIN_ACTIVE_PETS,
} from "@/lib/metrics/vet-access";
import { CONTACT_EMAILS, mailtoHref } from "@/lib/ui/contact";
import { describeNarrowedView } from "@/lib/ui/view-scope-caption";
import { deathCauseLabel, formatCount, formatPercent } from "@/lib/utils/format";
import { AcquisitionChartDynamic } from "./_components/AcquisitionChartDynamic";
import { CasesPerCapitaTable } from "./_components/CasesPerCapitaTable";
import { OutbreakHistoryTable } from "./_components/OutbreakHistoryTable";
import { RegionRankingTable } from "./_components/RegionRankingTable";
import { SuppressionChip } from "./_components/SuppressionChip";

export type AnalyticsSearchParams = {
  period?: string;
  from?: string;
  to?: string;
  province?: string;
  locality?: string;
};

export type AnalyticsScreenProps = {
  searchParams: AnalyticsSearchParams;
  /**
   * True when rendered as the Programa hub's "Analítica" tab (app/gob/programa/
   * page.tsx) — see components/ui/dashboard/ScreenHeader.tsx.
   */
  underHub?: boolean;
};

// "Exportar datos" mirrors the active period + jurisdiction filters — the
// export page (export/page.tsx) reads these same searchParam keys to
// pre-fill its PeriodPicker/JurisdictionSwitcher (same pattern as
// censo/poblacion/adopciones/campanas' `exportHref`, dec0f58f). Pulled out of
// the page component to keep its cognitive-complexity score under budget.
function buildAnalyticsExportHref(sp: AnalyticsSearchParams): string {
  const exportParams = new URLSearchParams();
  if (sp.period) exportParams.set("period", sp.period);
  if (sp.from) exportParams.set("from", sp.from);
  if (sp.to) exportParams.set("to", sp.to);
  if (sp.province) exportParams.set("province", sp.province);
  if (sp.locality) exportParams.set("locality", sp.locality);
  return `/gob/analytics/export${exportParams.size > 0 ? `?${exportParams}` : ""}`;
}

export async function AnalyticsScreen({
  searchParams: sp,
  underHub = false,
}: AnalyticsScreenProps) {
  const { profile, jurisdictions } = await requireGobReadAccessOrRedirect();
  const actor = { role: profile.role };

  // Capability guard: analytics.read = admin OR (govt AND has assignments).
  // v1 derives capability from role + jurisdictions; no dedicated capability column.
  const hasAnalyticsRead =
    hasNationalReadScope(profile.role) || (profile.role === "govt" && jurisdictions.length > 0);

  if (!hasAnalyticsRead) {
    return (
      <div className="space-y-6">
        <LnEmptyState
          icon="lock"
          title="Sin acceso"
          description="Tu rol no tiene acceso a analytics. Un administrador debe asignarte las capacidades correspondientes."
          action={
            <a
              className="text-sm text-[var(--color-ln-azul)] underline underline-offset-4"
              href={mailtoHref(CONTACT_EMAILS.general, { subject: "miMAR — Acceso a analytics" })}
            >
              Solicitar acceso
            </a>
          }
        />
      </div>
    );
  }

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

  const exportHref = buildAnalyticsExportHref(sp);

  const period = resolveAnalyticsPeriod(sp);
  const { since } = period;
  // ProjectionContext for the D1 trend fetcher (scope-aware, period-aware).
  const trendCtx = buildProjectionContext(actor, filteredJurisdictions, period, {
    adminProvince,
    adminLocality,
  });

  // Page header — rendered in both the data and degraded (D2) branches.
  const header = (
    <ScreenHeader
      underHub={underHub}
      className="space-y-2"
      eyebrow="Vigilancia sanitaria"
      title="Analítica"
      subtitle={
        <>
          {/* The universal claim yields to the narrowed-view caption (never both). */}
          {hasNationalReadScope(profile.role) ? (
            narrowedView ? null : (
              <p className="text-md text-ln-op-mute">Vista universal — todas las jurisdicciones.</p>
            )
          ) : (
            <p className="text-md text-ln-op-mute">
              Métricas analíticas de salud animal y gestión de mascotas en tu cobertura.
            </p>
          )}
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
      period={{ defaultPreset: "trailing12m" }}
      jurisdiction={{ allowedProvinces, localities }}
      actions={
        <a href={exportHref} className="text-md text-ln-op-azul hover:underline">
          Exportar datos →
        </a>
      }
    />
  );

  // D2: bound the fetcher set with a deadline so a pathological query degrades
  // to an honest "tardando… reintentar" state instead of hanging the page.
  const load = await loadWithTimeout(
    Promise.all([
      // Every fetcher below now honors the admin province/locality drill-down
      // (scope-helpers-admin-fix honesty sweep) — mirrors fetchPerdidasMetrics'
      // admin branch, additive-only (never widens scope for govt callers).
      fetchAnalyticsMetrics(actor, filteredJurisdictions, { since, adminProvince, adminLocality }),
      fetchAcquisitionTrend(actor, filteredJurisdictions, { since, adminProvince, adminLocality }),
      fetchDeathCauses(actor, filteredJurisdictions, { since, adminProvince, adminLocality }),
      fetchOutbreakHistory(actor, filteredJurisdictions, { adminProvince, adminLocality }),
      fetchRegionRanking(actor, filteredJurisdictions, { adminProvince, adminLocality }),
      // E1 (2026-07-21 facades harvest) — population-adjusted per-capita open
      // cases (INDEC 2022). No admin province/locality drill-down param: the
      // fetcher scopes by actor+jurisdictions only (province-level census
      // join), matching its existing tested contract.
      fetchCasesPerCapita(actor, filteredJurisdictions),
      fetchOutbreakSignalsTrend(trendCtx),
      // F9 (2026-08-01) DROPPED: fetchKpiTrend("pet_registered", trendCtx) fed
      // the sparkline of a "Mascotas totales" tile that no longer exists here
      // — see the KPI section below for why. One fewer query per render.
      // Access-to-care gap: vet visits per 1k active pets by locality (care deserts).
      fetchVetAccessByLocality(trendCtx),
    ]),
  );

  if (!load.ok) {
    return (
      <div className="space-y-6">
        {header}
        {filtersRow}
        {/* F9: retry returns to the HUB url with this vista selected, never
            to /gob/analytics — that route is now a redirect, so retrying
            through it would cost an extra hop on an already-degraded page. */}
        <AnalyticsLoadFallback
          reason={load.reason}
          correlationId={load.id}
          retryHref={analyticsRetryHref("/gob/programa", { ...sp, vista: "analitica" })}
        />
      </div>
    );
  }

  const [
    metrics,
    acquisitionTrend,
    deathCauses,
    outbreakHistory,
    regionRanking,
    casesPerCapita,
    signalsTrend,
    vetAccess,
  ] = load.value;

  // Shape the outbreak-signals trend for TimeSeriesChart. The `suppressed`
  // flag rides ALONG — this used to rebuild each point as a bare `{ x, y }`,
  // so a k-anonymity mask (carried as `y: 0` + `suppressed`) was republished
  // as a measured zero: the header said "N períodos ocultos (privacidad)" and
  // the "Ver datos" table underneath printed 0 for those same periods. Same
  // defect the /gob home carried (demo review 2026-08-01); a zero is an
  // epidemiological claim, "oculto" is the absence of one.
  const signalsTrendPoints = signalsTrend.points;
  const signalsBucketWord = signalsTrend.granularity === "month" ? "mes" : "semana";

  // FORECAST-A-META: acquisition_adoption_rate is the ONE catalog KPI with a
  // genuine per-bucket ratio trend already at hand (see kpi-catalog.ts's
  // "honest remainder" audit) — reconstruct the monthly adoption-rate series
  // from the SAME acquisitionTrend rows the page already fetched (zero new
  // query), then project it toward TARGETS.ADOPTION_RATE_PCT.
  const adoptionRateTrend = acquisitionAdoptionRateSeries(acquisitionTrend);
  const adoptionForecast = forecastToTarget({
    current: metrics.adoptionRate,
    target: TARGETS.ADOPTION_RATE_PCT,
    trend: adoptionRateTrend,
  });

  // Compute bar chart max for death causes.
  const maxDeathCount = deathCauses.reduce((m, r) => Math.max(m, r.count), 0);

  const panelAcquisitionId = "panel-acquisition-titulo";
  const panelDeathId = "panel-death-titulo";
  const panelOutbreakId = "panel-outbreak-titulo";
  const panelRankingId = "panel-ranking-titulo";
  const panelPerCapitaId = "panel-percapita-titulo";
  const panelVetAccessId = "panel-vet-access-titulo";
  // Lowest RELATIVE access first. fetchVetAccessByLocality sorts ascending by
  // per1k; cap the table at the 8 lowest. H6 (2026-07-30): "lowest in the
  // visible set" is all the ORDER says — whether a row is a care desert comes
  // from `row.band`, measured against `vetAccess.desertThresholdPer1k`.
  const vetAccessRows = vetAccess.localities.slice(0, 8);

  return (
    <div className="space-y-6">
      {/* Page header */}
      {header}

      {/* Unified filter bar — jurisdiction + period, with "Exportar datos" rendered
          via the bar's `actions` slot (same pattern as /gob/censo's "Exportar CSV"). */}
      {filtersRow}

      {/* F9 CONTENT RULE (PO, 2026-08-01): a figure already published by the
          Resumen vista is LINKED from here, never restated. This strip used to
          open with a "Mascotas totales" tile carrying descriptorId
          registry_total_pets — the SAME number, over the SAME predicate
          (status IN ('active','lost') AND scope), that Resumen publishes as
          "Total registradas". kpi-catalog.ts's registry_total_pets entry says
          so outright: two distinct fetchers, one verified-identical predicate.
          Once both surfaces became tabs of ONE hub, that duplicate stopped
          being a harmless echo and became the very thing this fusion exists to
          remove — two labels, one number, one screen, one tab apart. The tile
          is gone; the caption below points at the single place it lives. Its
          sparkline fetcher went with it (see the Promise.all above). */}
      <section
        aria-label="Indicadores de analytics"
        className="grid grid-cols-2 md:grid-cols-3 gap-3"
      >
        <OpKpi
          label="Tasa de adopción (12m)"
          value={formatPercent(metrics.adoptionRate)}
          tone={toneForTarget(metrics.adoptionRate, TARGETS.ADOPTION_RATE_PCT)}
          bar={metrics.adoptionRate}
          sub={`meta ${TARGETS.ADOPTION_RATE_PCT}% del total de adquisiciones`}
          // FORECAST-A-META: the forecast is a PROPERTY of this tile, shown
          // right here — no new screen. `.line` is already null-safe (met/
          // insufficient render nothing).
          forecast={adoptionForecast.line}
          info={{
            definition: `Porcentaje de mascotas adquiridas por adopción sobre el total de adquisiciones en el período (A3). Meta interna: ${TARGETS.ADOPTION_RATE_PCT}%.`,
            formula: "COUNT(acquisition_method='adoption') / COUNT(all acquisitions) × 100",
          }}
          descriptorId="acquisition_adoption_rate"
          // `n` wires the descriptor's zeroDenominator/smallN guards (prepush-
          // review-3: without the denominator the guards were dead code and a
          // 0-acquisition jurisdiction rendered a confident red 0%).
          guardInput={{ n: metrics.totalAcquisitions, trendMonths: adoptionRateTrend.length }}
        />
        <OpKpi
          label={RABIES_VACCINATION_RATE_LABEL_ES}
          value={formatPercent(metrics.rabiesVaccinationRate)}
          // tone stays hardcoded "blue" (progress/informational), matching
          // this KPI's semaphore: {paintAgainst: "none"} contract — a
          // historical, no-target count never paints a legal-verdict color.
          tone="blue"
          bar={metrics.rabiesVaccinationRate}
          sub="histórico · toda especie con ≥1 dosis registrada"
          href="/gob/vigilancia"
          info={getKpiInfo("rabies_vaccination_rate_all_species")}
          descriptorId="rabies_vaccination_rate_all_species"
        />
        <OpKpi
          label={KPI_CATALOG.custody_disputes_open.label}
          value={formatCount(metrics.custodyDisputes)}
          tone={metrics.custodyDisputes > 0 ? "warn" : undefined}
          sub="casos en curso"
          href="/gob/casos?expediente=disputas"
          info={{
            definition:
              "Disputas de custodia en curso (abiertas o escaladas) en la jurisdicción seleccionada — la misma cola accionable que lista el expediente Disputas del hub Casos (/gob/casos?expediente=disputas). Una disputa escalada pasó a la vía judicial: sigue en curso y sigue bloqueando la custodia.",
            formula: "COUNT(custody_disputes WHERE status IN ('open','escalated'))",
          }}
          descriptorId="custody_disputes_open"
        />
      </section>

      {/* The linked half of the content rule above. No number here on purpose:
          restating it in a caption would be the same duplicate wearing a
          smaller font. */}
      <p className="text-sm text-ln-op-mute">
        El tamaño del padrón (total de mascotas activas o extraviadas) se publica una sola vez, en{" "}
        <a href="/gob/programa?vista=resumen" className="text-ln-op-azul hover:underline">
          la vista Resumen →
        </a>
      </p>

      {/* Acquisition trend. The "Exportar datos" CTA lives in the filter bar's
          `actions` slot above (2026-07-21 rewire) — not beside this panel. */}
      <OpCard aria-labelledby={panelAcquisitionId}>
        <OpCardHead title={<span id={panelAcquisitionId}>Adquisición por método</span>} />
        <OpCardBody>
          {acquisitionTrend.length === 0 ? (
            <LnEmptyState
              icon="chart-line"
              title="Sin datos de adquisición"
              description="No hay registros de mascotas con método de adquisición en los últimos 12 meses."
            />
          ) : (
            <AcquisitionChartDynamic data={acquisitionTrend} />
          )}
        </OpCardBody>
      </OpCard>

      {/* D1 — señales de brote por período (tendencia) */}
      <OpCard aria-labelledby="panel-signals-trend-titulo">
        <OpCardHead
          title={
            <span id="panel-signals-trend-titulo">Señales de brote por {signalsBucketWord}</span>
          }
          actions={
            <SuppressionChip
              count={signalsTrend.suppressedCount}
              singular="período oculto"
              plural="períodos ocultos"
            />
          }
        />
        <OpCardBody>
          {signalsTrendPoints.length === 0 ? (
            // C4 (2026-07-22, §S4): same reporting dependency as
            // /gob/vigilancia's signal panels — no-signal, not "all clear".
            <LnEmptyState
              icon="eye-off"
              nature="no-signal"
              title="Sin señales registradas en miMAR"
              description="La ausencia de señales no implica ausencia de enfermedad — nadie reportó un brote en el rango y la cobertura seleccionados."
            />
          ) : (
            <TimeSeriesChartDynamic
              data={signalsTrendPoints}
              seriesLabel="Señales"
              variant="area"
              fallbackTableLabel={`Señales de brote por ${signalsBucketWord}`}
              // A fully masked series must say "Datos ocultos por privacidad
              // (k<5)" in the plot area, not read as an empty chart.
              suppressedCount={signalsTrend.suppressedCount}
            />
          )}
        </OpCardBody>
      </OpCard>

      {/* Cross-region ranking table (Item 22). A "casos por 10k hab." choropleth
          previously sat above this — removed: same spatial question (open-case
          distribution by province) as /gob/vigilancia's national map, just
          normalized instead of raw. The CHOROPLETH form was demoted per PO
          review; the underlying metric (fetchCasesPerCapita) was reinstated
          below as a compact ranking table (E1, 2026-07-21 facades harvest) —
          raw counts remain visible on /gob/vigilancia. */}
      {/* RA-3 C7: `suppressedCount > 0` keeps the card mounted when EVERY
          province in scope was withheld. Gating on rows alone made the whole
          panel vanish silently — the operator reads a missing panel as "this
          metric has no data", which is the one thing a withholding is not. */}
      {(regionRanking.top.length > 0 ||
        regionRanking.bottom.length > 0 ||
        regionRanking.suppressedCount > 0) && (
        <OpCard aria-labelledby={panelRankingId}>
          <OpCardHead
            title={
              <span id={panelRankingId}>
                Ranking · {RABIES_VACCINATION_RATE_LABEL_ES}{" "}
                <span className="text-sm font-normal text-ln-op-mute">por provincia</span>
              </span>
            }
          />
          <OpCardBody>
            <RegionRankingTable
              top={regionRanking.top}
              bottom={regionRanking.bottom}
              coverageLabel={RABIES_VACCINATION_RATE_LABEL_ES}
              totalProvinces={regionRanking.totalProvinces}
              // RA-3 C7 — the fetcher decided; this page only hands the verdict
              // to the render. A literal here would be the second decision point.
              suppressedCount={regionRanking.suppressedCount}
            />
          </OpCardBody>
        </OpCard>
      )}

      {/* E1 (2026-07-21 facades harvest) — population-adjusted per-capita open
          cases (INDEC 2022). Built + unit-tested since before this pass, with
          zero callers anywhere in app/ until now. */}
      <OpCard aria-labelledby={panelPerCapitaId}>
        <OpCardHead
          title={
            <span id={panelPerCapitaId}>
              Incidencia de casos abiertos por habitante{" "}
              <span className="text-sm font-normal text-ln-op-mute">INDEC 2022</span>
            </span>
          }
        />
        <OpCardBody>
          <CasesPerCapitaTable rows={casesPerCapita} />
        </OpCardBody>
      </OpCard>

      {/* Vet-access gap — vet visits per 1.000 active pets by locality. Lowest
          per-1k localities are care deserts (the CABA vs periphery inequity).
          Locality-grouped → k-anon (k=5) suppression on the active-pet population. */}
      <OpCard aria-labelledby={panelVetAccessId}>
        <OpCardHead
          title={<span id={panelVetAccessId}>Acceso veterinario por localidad</span>}
          actions={
            <SuppressionChip
              count={vetAccess.suppressedCount}
              singular="localidad oculta"
              plural="localidades ocultas"
            />
          }
        />
        <OpCardBody>
          {vetAccessRows.length === 0 ? (
            <LnEmptyState
              icon="chart-line"
              title="Sin datos de acceso veterinario"
              description="No hay localidades con población activa suficiente (k-anonimato) en la cobertura seleccionada."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-md text-ln-op-ink border-collapse">
                <caption className="sr-only">
                  Visitas veterinarias por cada 1.000 mascotas activas, por localidad, de menor a
                  mayor acceso relativo dentro del alcance seleccionado.
                </caption>
                <thead>
                  <tr className="border-b border-ln-op-line">
                    <th scope="col" className="text-left py-2 pr-4 font-semibold text-ln-op-mute">
                      Localidad
                    </th>
                    <th scope="col" className="text-right py-2 px-4 font-semibold text-ln-op-mute">
                      Visitas / 1.000
                    </th>
                    <th scope="col" className="text-right py-2 px-4 font-semibold text-ln-op-mute">
                      Visitas
                    </th>
                    <th scope="col" className="text-right py-2 pl-4 font-semibold text-ln-op-mute">
                      Activos
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {vetAccessRows.map((r) => (
                    <tr
                      key={`${r.province}::${r.locality}`}
                      className="border-b border-ln-op-line last:border-0 hover:bg-ln-op-stripe/50 transition-colors"
                    >
                      <td className="py-2 pr-4">
                        {r.locality}
                        <span className="text-ln-op-mute"> · {r.province}</span>
                        {/* H6: the ONLY place the table says "desierto", and it
                            says it from the absolute band, never from the row's
                            position. A locality that is merely the lowest of the
                            set gets no badge at all. */}
                        {r.band === "desert" && (
                          <span className="ml-2 rounded-full bg-ln-op-warn-bg px-2 py-0.5 text-xs font-semibold text-ln-op-warn">
                            Desierto de atención
                          </span>
                        )}
                        {r.band === "small-sample" && (
                          <span className="ml-2 rounded-full bg-ln-op-stripe px-2 py-0.5 text-xs font-medium text-ln-op-mute">
                            Muestra chica
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-4 text-right tabular-nums font-semibold">
                        {r.per1k.toLocaleString("es-AR")}
                      </td>
                      <td className="py-2 px-4 text-right tabular-nums text-ln-op-mute">
                        {r.visits.toLocaleString("es-AR")}
                      </td>
                      <td className="py-2 pl-4 text-right tabular-nums text-ln-op-mute">
                        {r.activePets.toLocaleString("es-AR")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* H6 (2026-07-30): this line used to read "las primeras filas
                  son desiertos de atención" over a purely RELATIVE sort. Live,
                  the first row was Palermo at 1.286,8 — the lowest of the set
                  and about 1,3 actos por mascota al año, which is not a desert
                  of anything. The order and the label are now two separate
                  claims, and the label states the number it was measured
                  against. */}
              <p className="mt-2 text-xs text-ln-op-mute">
                Ordenado de menor a mayor acceso <strong>relativo dentro del alcance</strong>: las
                primeras filas son las de menor acceso registrado del conjunto visible, no
                necesariamente desiertos de atención.{" "}
                {vetAccess.desertThresholdPer1k !== null ? (
                  <>
                    Se marca <strong>desierto de atención</strong> solo por debajo de{" "}
                    {vetAccess.desertThresholdPer1k.toLocaleString("es-AR")} actos / 1.000 activos
                    en este período — el equivalente a 1 acto veterinario por mascota al año, el
                    piso que implica la antirrábica anual obligatoria (Ley 22.953).
                  </>
                ) : (
                  <>
                    El período seleccionado es más corto que {VET_ACCESS_DESERT_MIN_PERIOD_DAYS}{" "}
                    días: no alcanza para afirmar que una localidad sea un desierto de atención, así
                    que ninguna fila se marca como tal.
                  </>
                )}{" "}
                Con menos de {VET_ACCESS_MIN_ACTIVE_PETS} activos el ratio se muestra pero no se
                clasifica (un solo acto lo mueve demasiado). Denominador: mascotas activas de la
                localidad (no censo humano). Localidades con menos de 5 activos se ocultan por
                k-anonimato.
              </p>
            </div>
          )}
        </OpCardBody>
      </OpCard>

      {/* Top 10 death causes -- v1: simple HTML/CSS bars (spec B.6 doesn't mandate recharts here) */}
      <OpCard aria-labelledby={panelDeathId}>
        <OpCardHead title={<span id={panelDeathId}>Principales causas de muerte (12m)</span>} />
        <OpCardBody>
          {deathCauses.length === 0 ? (
            <LnEmptyState
              icon="heart"
              title="Sin datos de fallecimiento"
              description="No hay eventos de fallecimiento en los últimos 12 meses en tu cobertura."
            />
          ) : (
            <ul className="space-y-2">
              {deathCauses.map((row) => (
                <li key={row.cause} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 text-md text-ln-op-ink">
                    {deathCauseLabel(row.cause)}
                  </span>
                  <div className="flex-1 h-4 rounded bg-ln-op-stripe overflow-hidden">
                    <div
                      className="h-full rounded bg-ln-op-azul"
                      style={{
                        width: maxDeathCount > 0 ? `${(row.count / maxDeathCount) * 100}%` : "0%",
                      }}
                    />
                  </div>
                  <span className="w-8 shrink-0 text-right text-md tabular-nums text-ln-op-ink">
                    {row.count}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {/* v1 uses HTML bars; full recharts BarChart can replace this in a follow-up */}
        </OpCardBody>
      </OpCard>

      {/* Outbreak history table. RA-3 C3: the k-anon count is announced in the
          card header, the SAME shape as the vet-access card above — that card
          is the proven standard on this very page and this one was skipped. */}
      <OpCard aria-labelledby={panelOutbreakId}>
        <OpCardHead
          title={<span id={panelOutbreakId}>Brotes históricos</span>}
          actions={
            <SuppressionChip
              count={outbreakHistory.suppressedCount}
              singular="agrupamiento oculto"
              plural="agrupamientos ocultos"
            />
          }
        />
        <OpCardBody>
          <OutbreakHistoryTable
            rows={outbreakHistory.rows}
            suppressedCount={outbreakHistory.suppressedCount}
          />
        </OpCardBody>
      </OpCard>

      <DashboardFreshnessFooter ctx={trendCtx} />
    </div>
  );
}
