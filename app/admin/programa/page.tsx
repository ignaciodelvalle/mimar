// /admin/programa — Resumen ejecutivo del programa (Paquete H).
//
// Executive summary: North-Star KPIs + outliers + PII oversight + data quality
// + a cron-health link-out (Sistema owns the actual cron read — see below).
//
// Data sources:
//   fetchEnoSla          ← lib/surveillance-metrics.ts  (A7)
//   fetchQueueHealth     ← lib/admin-metrics.ts
//   fetchDataQuality     ← lib/metrics/program-health.ts
//   fetchCrossJurisdictionOutliers ← lib/metrics/program-health.ts
//   fetchPiiOversight    ← lib/metrics/program-health.ts
//   registryCounts       ← lib/metrics/census.ts  (total registradas)
//   fetchSterilizationCoverage ← lib/metrics/population-control.ts
//   fetchMicrochipPenetration  ← lib/compliance-metrics.ts
//
// MOVED (2026-07-21): the embedded "Alertas y suscripciones" panel
// (evaluateAlertSubscriptions + create/toggle/delete) was promoted to its own
// page at /admin/suscripciones (thin wrapper over /gob/suscripciones) — see
// that file for the full rationale. This page keeps only a discovery link.
//
// TRIMMED (leanness sweep, 2026-08-02): this page used to fetch fetchCronRuns
// and render its own full cron list — a byte-for-byte duplicate read of
// /admin/sistema's SistemaCronsCard, which owns cron health as its whole
// purpose. The "Salud de crons" card below is now a link-out, not a fetch.

import { inArray } from "drizzle-orm";

import { ForecastChartDynamic } from "@/components/charts/ForecastChartDynamic";
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
import { db, profiles } from "@/db";
import { fetchQueueHealth } from "@/lib/analytics/admin-metrics";
import { analyticsRetryHref, loadWithTimeout } from "@/lib/analytics/analytics-load";
import { DEFAULT_DASHBOARD_PRESET } from "@/lib/analytics/analytics-period";
import { fetchMicrochipPenetration } from "@/lib/analytics/compliance-metrics";
import { fetchEnoSla } from "@/lib/analytics/surveillance-metrics";
import { adminProvinceHref } from "@/lib/infra/admin-province-link";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import {
  K_ANON_MIN,
  NO_POPULATION_NOTE,
  type OutlierMetric,
  TARGETS,
  buildProjectionContext,
  countAlertedProvinces,
  enoSlaHeadline,
  enoSlaTone,
  fetchCrossJurisdictionOutliers,
  fetchDataQuality,
  fetchPiiOversight,
  fetchRabiesVaccinationTrend,
  formatImpactUnits,
  formatTopImpactLine,
  futureBucketLabel,
  projectSeries,
  rankByImpact,
  resourceGap,
  scopeTotalSuppressionNotice,
  summarizeTopImpact,
  toneForTarget,
  totalImpactByJurisdiction,
} from "@/lib/metrics";
import { DORMANT_MONTHS_DEFAULT, registryCounts } from "@/lib/metrics/census";
import { KPI_CATALOG, getKpiInfo } from "@/lib/metrics/kpi-catalog";
import { windows } from "@/lib/metrics/period";
import { fetchSterilizationCoverage } from "@/lib/metrics/population-control";
import { auditActionLabel } from "@/lib/ui/audit-action-labels";
import { describeNarrowedView } from "@/lib/ui/view-scope-caption";
import { formatDateShort, formatPercent, pluralizeEs } from "@/lib/utils/format";

import { PhysicalTagDemandCard } from "./PhysicalTagDemandCard";

export const dynamic = "force-dynamic";

const METRIC_LABEL: Record<string, string> = {
  rabies: "Antirrábica",
  sterilization: "Esterilización",
  microchip: "Microchip",
};

// PO-interview decision 2, item 1 — the honest unit per metric for the
// impact-ranking column: "~N perros del padrón sin vacunar", never an abstract
// score.
//
// "del padrón" is load-bearing, not filler (metric-honesty audit, PO
// 2026-09-16). The impact is counted over the metric's OWN denominator, so the
// unit is registered animals, and each of these three labels names the exact
// population its row divided by: todas las mascotas activas para chip y
// esterilización, sólo los perros activos para antirrábica.
const IMPACT_UNIT_LABEL: Record<OutlierMetric, string> = {
  rabies: "perros del padrón sin vacunar",
  sterilization: "mascotas del padrón sin esterilizar",
  microchip: "mascotas del padrón sin chip",
};

// es-AR labels for the PII-oversight "surface" dimension (operator search origin).
const SURFACE_LABEL: Record<string, string> = {
  users: "Usuarios",
  organizations: "Organizaciones",
  omnibox: "Buscador",
};

export default async function AdminProgramaPage({
  searchParams,
}: {
  searchParams?: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  await requireAdminOrRedirect();

  const sp = searchParams ? await searchParams : {};
  const { resolveAnalyticsPeriod } = await import("@/lib/metrics/period");
  const period = sp.period || sp.from ? resolveAnalyticsPeriod(sp) : windows.trailing12m();

  const adminCtx = buildProjectionContext({ role: "admin" }, [], period);

  // C3 disclosure: caption when this page's filters narrow below the mandate.
  // This screen has no province/locality drill-down (fully national, universal
  // admin scope) — always null, kept for parity with the other admin screens.
  const narrowedView = describeNarrowedView({
    role: "admin",
    mandateJurisdictions: [],
  });

  // Page header — rendered in both the data and degraded (D2) branches.
  const header = (
    <header className="space-y-2">
      <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
        Admin · Resumen ejecutivo
      </p>
      <h1 className="text-title font-semibold text-ln-op-ink">Salud del programa</h1>
      <p className="text-md text-ln-op-mute">
        KPIs principales, valores atípicos por jurisdicción, calidad de datos y supervisión de PII.
      </p>
      <a
        href="/admin/suscripciones"
        className="inline-block text-sm font-semibold text-ln-op-azul no-underline underline-offset-4 hover:underline"
      >
        Alertas y suscripciones →
      </a>
      <ViewScopeCaption scope={narrowedView} />
    </header>
  );

  // Hoisted with the header so the degraded branch keeps it. The bar depends on
  // nothing but a default preset, and changing the period is exactly how an
  // operator retries with a cheaper window — dropping it on the one render where
  // the query timed out removes the only lever they had. The explanatory copy
  // around it stays in the success branch, where the projection it names exists.
  const filtersRow = <OpFilterBar period={{ defaultPreset: DEFAULT_DASHBOARD_PRESET }} />;

  // D2: bound the fetcher set with a deadline (see /admin/censo).
  //
  // getCensusPopulationsCached USED TO BE IN THIS LIST. Its only consumer here
  // was the impact column's canine population estimate, which was the wrong
  // denominator for two of the three metrics it multiplied (metric-honesty
  // audit, PO 2026-09-16 — see the impact wiring below). The cache lives on for
  // the surfaces that legitimately use it; this page no longer asks for it.
  const load = await loadWithTimeout(
    Promise.all([
      registryCounts(adminCtx, DORMANT_MONTHS_DEFAULT),
      fetchSterilizationCoverage(adminCtx),
      fetchMicrochipPenetration(adminCtx),
      fetchEnoSla(adminCtx),
      fetchQueueHealth(),
      fetchDataQuality(adminCtx),
      fetchCrossJurisdictionOutliers(adminCtx),
      fetchPiiOversight(adminCtx),
      fetchRabiesVaccinationTrend(adminCtx),
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
          retryHref={analyticsRetryHref("/admin/programa", sp)}
        />
      </div>
    );
  }

  const [
    registry,
    sterilization,
    microchip,
    enoSla,
    queue,
    dataQuality,
    outliers,
    piiOversight,
    rabiesTrend,
  ] = load.value;

  // Same single verdict as /gob/programa (RA-3 finding C1), and the same guard
  // /admin/censo and /admin/poblacion carry.
  //
  // SCOPE NOTE, because it is the reason this guard looks redundant and is not:
  // unlike its /gob twin this screen does NOT accept `?province=` — its
  // searchParams are period-only and `adminCtx` is built with no
  // `adminProvince`, so the grouping is always national. What still trips the
  // rule is a sparse deployment where the whole national grouping holds ONE
  // withheld province: then "Total registradas" and the esterilización rate are
  // that province's protected numbers wearing a national label. Wiring the
  // verdict in now also means a future province drill on this page cannot
  // reintroduce C1 by omission — the failure mode that put this defect on three
  // separate screens.
  const scopeNotice = scopeTotalSuppressionNotice(sterilization.scopeTotalPublishable);
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

  // Paquete J — forward projection over the antirrábica vaccination FLOW series
  // (distinct dogs vaccinated/bucket). §J-D3: the LEGAL target is COVERAGE %
  // (a stock, 80%), which is a DIFFERENT unit than these vaccination COUNTS — so
  // we project the volume band WITHOUT painting a %-meta ReferenceLine on the
  // counts axis. The coverage-% forecast is deferred to Fase J3.
  // Projection ticks carry REAL calendar labels ("ago 26"), not "+1/+2/+3"
  // (axis-format unification, visual review 2026-07-23 #13).
  const rabiesForecast = projectSeries(rabiesTrend.points, {
    horizon: 3,
    labelForecast: (h) =>
      futureBucketLabel(period, rabiesTrend.granularity, rabiesTrend.points.length, h),
  });
  const hasRabiesTrend = rabiesTrend.points.length > 0;

  // Batch-resolve actor UUIDs in the PII oversight table to display names.
  const actorIds = piiOversight
    .map((r) => r.actorUserId)
    .filter((id): id is string => id !== null && id !== undefined);
  const uniqueActorIds = [...new Set(actorIds)];
  const actorNameMap = new Map<string, string>();
  if (uniqueActorIds.length > 0) {
    const actorRows = await db
      .select({ id: profiles.id, displayName: profiles.displayName })
      .from(profiles)
      .where(inArray(profiles.id, uniqueActorIds));
    for (const row of actorRows) {
      actorNameMap.set(row.id, row.displayName);
    }
  }

  // outlierCount is a COMBINATION count (provincia × métrica) — correct for the
  // outliers table caption below ("N de M combinaciones bajo meta"), but NOT
  // honest as the value behind a KPI literally labeled Provincias en alerta
  // (a province can contribute several rows here, one per below-target
  // metric — hence outlierCount routinely exceeding the ~24 AR provinces).
  // alertedProvinceCount collapses those rows to DISTINCT provinces so the KPI
  // matches its own label; it can never exceed the real province count.
  const outlierCount = outliers.filter((r) => r.isOutlier).length;
  const alertedProvinceCount = countAlertedProvinces(outliers);
  const chipRatePct = microchip.ratePct;
  const sterilRatePct = sterilization.rate;
  // Denominadores: un 0 significa algo distinto según si estos también son 0.
  const hasPadron = sterilization.total > 0;
  const hasChipPadron = microchip.active > 0;

  // Gap x poblacion ranking (PO-interview decision 2, item 1), re-based on the
  // metric's OWN denominator (metric-honesty audit, PO 2026-09-16).
  //
  // WHAT WAS WRONG. This block used to hand every row
  // `estimateDogPopulation(censusPopulations[row.province])` — INDEC's human
  // census x ESTIMATED_DOGS_PER_INHABITANT, a CANINE figure. `rabies` is a
  // dog-only metric and that was coherent. `sterilization` and `microchip` are
  // ALL-SPECIES (their rate divides by every active pet, see
  // fetchCrossJurisdictionOutliers), so multiplying their gap fraction by a dog
  // population mixed two universes and the cell then printed "~N mascotas sin
  // chip" off a denominator containing no cats.
  //
  // WHY THE DENOMINATOR AND NOT THE SPECIES. Narrowing those two rows to dogs
  // was the other honest repair and it is out of reach here: their `rate` is
  // read by eight other surfaces (the territorial index, the panorama
  // choropleth, the home teasers) and judged against an all-species target, so
  // redefining it would publish two different numbers under one label. What is
  // in reach is the population: `row.denominator` is the exact base each rate
  // was divided by, counted in the same aggregate.
  //
  // WHAT IT COSTS, stated plainly because it is a narrower claim than before:
  // the impact is now "how many REGISTERED animals must still be covered to
  // reach the target", not a projection onto the estimated real population. It
  // is smaller, it is exact, it carries no assumption — and, unlike a per-metric
  // mix of a canine estimate for one row and a padron count for the others, it
  // keeps every row on ONE scale, which is the only way a ranked list means
  // anything. The note under the table says so to the reader.
  const outlierImpactInputs = outliers.map((row) => ({
    ...row,
    jurisdiction: row.province,
    coverage: row.rate,
    population: row.denominator,
  }));
  // rankByImpact excludes already-met rows (no gap to rank) — appended back
  // below so the table keeps showing them (green, "meets target"), just
  // ordered AFTER the real gaps instead of interleaved by province-count.
  const impactRankedOutliers = rankByImpact(outlierImpactInputs);
  const metOutlierRows = outliers
    .filter((r) => !r.isOutlier)
    .map((r) => ({ ...r, impact: undefined as number | null | undefined }));
  const displayOutliers = [...impactRankedOutliers, ...metOutlierRows];
  const topImpactSummary = summarizeTopImpact(totalImpactByJurisdiction(outlierImpactInputs));

  // PO-interview decision 2, item 2 — forecasts/gap tiles state WHAT is
  // missing, not just the %. registry.total is the SAME denominator these
  // ratios were computed over ("COUNT active/lost pets in scope" — see
  // kpi-catalog.ts's sterilization_coverage_population/microchip_penetration
  // entries), so this is zero new fetch, never a second population figure.
  const sterilResourceLine = KPI_CATALOG.sterilization_coverage_population.resourceUnit
    ? (resourceGap(
        {
          current: sterilRatePct,
          target: TARGETS.STERILIZATION_COVERAGE_PCT,
          denominator: registry.total,
        },
        KPI_CATALOG.sterilization_coverage_population.resourceUnit,
      ).line ?? undefined)
    : undefined;
  const chipResourceLine = KPI_CATALOG.microchip_penetration.resourceUnit
    ? (resourceGap(
        {
          current: chipRatePct,
          target: TARGETS.MICROCHIP_PENETRATION_PCT,
          denominator: registry.total,
        },
        KPI_CATALOG.microchip_penetration.resourceUnit,
      ).line ?? undefined)
    : undefined;

  // Panel element IDs for accessible aria-labelledby.
  const panelRabiesForecastId = "admin-programa-rabies-proyeccion-titulo";
  const panelOutliersId = "admin-programa-outliers-titulo";
  const panelPiiId = "admin-programa-pii-titulo";
  const panelQualityId = "admin-programa-calidad-titulo";
  const panelCronsId = "admin-programa-crons-titulo";

  return (
    <div className="space-y-6">
      {/* Page header */}
      {header}

      {/* North-Star KPI strip — CURRENT STATE. red-team-admin-2 #1 (Path B,
          RESOLVE not label): the page-level period control used to sit HERE, above
          KPIs it never moved (registradas/esterilización/microchip are
          point-in-time). That read as a broken filter. The control now lives down
          at the projection — the only period-driven visual — and this strip is
          framed as estado actual, so no KPI sits under a filter that ignores it. */}
      <h2 className="text-sm font-semibold text-ln-op-ink-2">Estado actual del programa</h2>
      <section
        aria-label="KPIs principales del programa (estado actual)"
        className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3"
      >
        <OpKpi
          label="Total registradas"
          value={registry.total > 0 ? registry.total.toLocaleString("es-AR") : "—"}
          // count-up demo (AnimatedNumber): reveal from 0 on load.
          animatedValue={registry.total > 0 ? registry.total : undefined}
          animatedFormat="integer"
          animatedStartAt={0}
          sub="mascotas activas o extraviadas"
          href="/admin/padron?vista=censo"
          info={{
            definition: "Total de mascotas con status 'active' o 'lost' a nivel nacional.",
            formula: "COUNT(pets) WHERE status IN ('active','lost')",
          }}
          descriptorId="registry_total_pets"
        />
        {/* Gemelo del de /gob/programa — misma corrección, mismo motivo: ver la
            nota extensa en ProgramaResumenScreen.tsx. En corto: "—" solo cuando
            no hay padrón que medir, y en tono NEUTRO, porque pintar de rojo una
            jurisdicción que todavía no cargó nada la hace ver como una que está
            incumpliendo su meta. */}
        <OpKpi
          label="Esterilización"
          value={hasPadron ? formatPercent(sterilRatePct) : "—"}
          animatedValue={hasPadron ? sterilRatePct : undefined}
          animatedFormat="percent"
          animatedStartAt={0}
          tone={
            hasPadron ? toneForTarget(sterilRatePct, TARGETS.STERILIZATION_COVERAGE_PCT) : "neutral"
          }
          sub={`meta ${TARGETS.STERILIZATION_COVERAGE_PCT}%`}
          href="/admin/padron?vista=poblacion"
          info={getKpiInfo("sterilization_coverage_population")}
          descriptorId="sterilization_coverage_population"
          // PO decision 2 item 2 — "faltan ~N cirugías sobre el padrón
          // registrado" (undefined when the target is already met).
          forecast={sterilResourceLine}
        />
        <OpKpi
          label="Microchip"
          value={hasChipPadron ? formatPercent(chipRatePct) : "—"}
          animatedValue={hasChipPadron ? chipRatePct : undefined}
          animatedFormat="percent"
          animatedStartAt={0}
          tone={
            hasChipPadron
              ? toneForTarget(chipRatePct, TARGETS.MICROCHIP_PENETRATION_PCT)
              : "neutral"
          }
          sub={`meta ${TARGETS.MICROCHIP_PENETRATION_PCT}%`}
          href="/admin/padron?vista=censo"
          info={getKpiInfo("microchip_penetration")}
          descriptorId="microchip_penetration"
          // Red-team 2026-07 #3: zero-denominator guard input (padrón size).
          guardInput={{ n: microchip.active }}
          forecast={chipResourceLine}
        />
        {/* Breach-aware headline (red-team 2026-07-24 #3): the bare % read
            "100%" beside "12 en incumplimiento activo" — the exact contradiction
            enoSlaHeadline resolves (leads with "N vencidas ahora", demotes the
            historical % to a reference sub). The K2 fix on /gob/vigilancia was
            never propagated here. */}
        <OpKpi
          label="SLA ENO (resueltos)"
          value={enoSlaHeadline(enoSla, formatPercent).value}
          tone={enoSlaTone(enoSla)}
          sub={enoSlaHeadline(enoSla, formatPercent).sub}
          href="/admin/outbox"
          info={getKpiInfo("eno_sla_compliance")}
          descriptorId="eno_sla_compliance"
        />
        <OpKpi
          label="Aprobaciones — más vieja"
          value={queue.oldestPendingDaysAgo !== null ? `${queue.oldestPendingDaysAgo}d` : "—"}
          tone={
            queue.oldestPendingDaysAgo !== null
              ? queue.oldestPendingDaysAgo > 30
                ? "danger"
                : queue.oldestPendingDaysAgo > 14
                  ? "warn"
                  : "ok"
              : undefined
          }
          sub={`${queue.pendingTotal} ${pluralizeEs(queue.pendingTotal, "pendiente")}`}
          href="/admin/cola"
          info={{
            definition: "Días de antigüedad de la solicitud pendiente más antigua.",
            formula: "now() - min(created_at) WHERE status='pending'",
          }}
          descriptorId="queue_oldest_pending_days"
        />
        {/* Honesty fix (2026-07-22): this used to render outlierCount, a
            provincia×métrica COMBINATION count — routinely > 24, impossible
            for a KPI labeled Provincias en alerta when Argentina has ~24
            provinces. alertedProvinceCount is the DISTINCT-province count
            (≤ total provinces) that actually matches the label. */}
        <OpKpi
          label={KPI_CATALOG.alerted_provinces_below_target.label}
          value={alertedProvinceCount.toLocaleString("es-AR")}
          tone={alertedProvinceCount === 0 ? "ok" : alertedProvinceCount > 5 ? "danger" : "warn"}
          sub={
            // The count stays honest (unchanged); the ACTION is the ranking
            // below — "si todo está en peligro, nada está en peligro" unless
            // the operator can jump straight to WHICH one to fix first.
            <>
              provincias con ≥1 métrica bajo meta{" "}
              <a href={`#${panelOutliersId}`} className="text-ln-op-azul hover:underline">
                ver por impacto →
              </a>
            </>
          }
          info={{
            definition:
              "Número de provincias con al menos una métrica (esterilización, microchip, etc.) por debajo de la meta programática.",
            formula: "COUNT(DISTINCT province) WHERE EXISTS métrica con rate < target",
          }}
          descriptorId="alerted_provinces_below_target"
        />
      </section>

      {/* Period control — relocated here from the page top (red-team-admin-2 #1,
          Path B). The projection below is the ONLY period-driven visual on this
          page; binding the control to it (with the scope caption) removes the
          "I changed the period and nothing moved" confusion the top placement
          created over the current-state KPI strip above. */}
      <div className="space-y-1">
        <p className="text-sm font-semibold text-ln-op-ink-2">Tendencia y proyección</p>
        <p className="text-xs text-ln-op-mute">
          El período aplica a la proyección de abajo; los indicadores de estado actual no varían con
          él.
        </p>
        {filtersRow}
      </div>

      {/* Antirrábica vaccination forecast — Paquete J (additive) */}
      <OpCard aria-labelledby={panelRabiesForecastId}>
        <OpCardHead
          title={<span id={panelRabiesForecastId}>Proyección de vacunación antirrábica</span>}
          actions={
            rabiesTrend.suppressedCount > 0 ? (
              <span className="text-sm text-ln-op-mute">
                {rabiesTrend.suppressedCount}{" "}
                {rabiesTrend.suppressedCount === 1 ? "período oculto" : "períodos ocultos"}{" "}
                (privacidad)
              </span>
            ) : null
          }
        />
        <OpCardBody>
          {!hasRabiesTrend ? (
            <p className="text-md text-ln-op-mute">
              Sin eventos de vacunación antirrábica en el período para proyectar.
            </p>
          ) : (
            <ForecastChartDynamic
              result={rabiesForecast}
              seriesLabel="Vacunación antirrábica"
              unit="perros vacunados"
            />
          )}
        </OpCardBody>
      </OpCard>

      {/* Outliers table — re-ranked by estimated real-world impact
          (gap×población), not province-count order — PO-interview decision 2,
          item 1. */}
      <OpCard aria-labelledby={panelOutliersId}>
        <OpCardHead
          title={<span id={panelOutliersId}>Valores atípicos por provincia</span>}
          actions={
            <span className="text-sm text-ln-op-mute">
              {outlierCount} de {outliers.length} combinaciones bajo meta
            </span>
          }
        />
        <OpCardBody>
          {outliers.length === 0 ? (
            <LnEmptyState
              icon="chart-line"
              title="Sin datos"
              description="Sin datos provinciales disponibles."
            />
          ) : (
            <div className="space-y-2">
              {topImpactSummary && (
                <p className="text-md font-medium text-ln-op-ink-2">
                  {formatTopImpactLine(topImpactSummary, "national")}
                </p>
              )}
              {/* Denominator honesty (red-team 2026-07-24 #4, rewritten by the
                  metric-honesty audit 2026-09-16). The note used to say the
                  impact projected the gap over the ESTIMATED canine population,
                  which was true and was the problem: the same canine estimate
                  multiplied an ALL-SPECIES gap for chip and esterilización. It
                  now counts over each métrica's own measured base, so the note
                  states a floor instead of warning about an inflation. Kept
                  verbatim in sync with the gob twin
                  (app/gob/programa/ProgramaResumenScreen.tsx). */}
              <p className="text-sm text-ln-op-mute">
                El impacto cuenta cuántos registros del padrón faltan cubrir para alcanzar la meta,
                sobre la misma base con la que se calcula cada cobertura: mascotas activas en chip y
                esterilización, perros activos en antirrábica. Es un piso <strong>medido</strong>,
                no una proyección sobre la población estimada del territorio, así que la cifra real
                a nivel provincia es mayor.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-md text-ln-op-ink border-collapse">
                  <caption className="sr-only">
                    Cobertura por provincia y métrica vs meta programática, ordenada por impacto
                    (registros del padrón sin cobertura). Filas marcadas en rojo están por debajo de
                    la meta.
                  </caption>
                  <thead>
                    <tr className="border-b border-ln-op-line">
                      <th scope="col" className="text-left py-2 pr-4 font-semibold text-ln-op-mute">
                        Provincia
                      </th>
                      <th scope="col" className="text-left py-2 pr-4 font-semibold text-ln-op-mute">
                        Métrica
                      </th>
                      <th
                        scope="col"
                        className="text-right py-2 pr-4 font-semibold text-ln-op-mute"
                      >
                        Cobertura
                      </th>
                      <th
                        scope="col"
                        className="text-right py-2 pr-4 font-semibold text-ln-op-mute"
                      >
                        Meta
                      </th>
                      <th
                        scope="col"
                        className="text-right py-2 pr-4 font-semibold text-ln-op-mute"
                      >
                        Brecha
                      </th>
                      <th scope="col" className="text-right py-2 font-semibold text-ln-op-mute">
                        {/* red-team-admin #6: tie the column to the "(estimado)"
                            caption below so the big number survives a skim. */}
                        Impacto (padrón)
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayOutliers.map((row, i) => {
                      const drillHref = adminProvinceHref(row.province);
                      const impactLabel =
                        row.impact === undefined
                          ? "—"
                          : row.impact === null
                            ? NO_POPULATION_NOTE
                            : `~${formatImpactUnits(row.impact)} ${IMPACT_UNIT_LABEL[row.metric]}`;
                      return (
                        <tr
                          key={`${row.province}-${row.metric}-${i}`}
                          className={[
                            "border-b border-ln-op-line last:border-0",
                            row.isOutlier
                              ? "bg-ln-op-danger-bg/30"
                              : "hover:bg-ln-op-stripe/50 transition-colors",
                          ].join(" ")}
                          aria-label={`${row.province} — ${METRIC_LABEL[row.metric] ?? row.metric}: ${formatPercent(row.rate)} (meta ${row.target}%)${row.isOutlier ? ", bajo meta" : ""}. Impacto: ${impactLabel}`}
                        >
                          <td className="py-2 pr-4">
                            {drillHref ? (
                              <a
                                href={drillHref}
                                className="text-ln-op-azul underline-offset-2 hover:underline"
                              >
                                {row.province}
                              </a>
                            ) : (
                              row.province
                            )}
                          </td>
                          <td className="py-2 pr-4 text-ln-op-ink-2">
                            {METRIC_LABEL[row.metric] ?? row.metric}
                          </td>
                          <td
                            className={[
                              "py-2 pr-4 text-right tabular-nums font-medium",
                              row.isOutlier ? "text-ln-op-danger" : "text-ln-op-ok",
                            ].join(" ")}
                            aria-label={`Cobertura: ${formatPercent(row.rate)}`}
                          >
                            {formatPercent(row.rate)}
                          </td>
                          <td className="py-2 pr-4 text-right tabular-nums text-ln-op-mute">
                            {row.target}%
                          </td>
                          <td
                            className={[
                              "py-2 pr-4 text-right tabular-nums",
                              row.isOutlier ? "text-ln-op-danger" : "text-ln-op-mute",
                            ].join(" ")}
                          >
                            {row.gap > 0
                              ? `−${formatPercent(row.gap)}`
                              : row.gap < 0
                                ? `+${formatPercent(Math.abs(row.gap))}`
                                : "—"}
                          </td>
                          <td className="py-2 text-right tabular-nums text-ln-op-mute">
                            {impactLabel}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-ln-op-mute">
                  Provincias con menos de {K_ANON_MIN} mascotas no se listan (privacidad).
                </p>
              </div>
            </div>
          )}
        </OpCardBody>
      </OpCard>

      {/* Diagnóstico (Ola 4 / decision-density audit, 2026-07-21): PII
          oversight + data quality + cron health are operational detail, not
          the executive headline — collapsed behind a disclosure so they read
          as secondary depth instead of co-equal with the KPI hierarchy and
          the rabies-forecast/outliers story above. */}
      <details className="group">
        <summary className="cursor-pointer select-none text-sm font-semibold text-ln-op-ink-2 hover:text-ln-op-ink">
          Diagnóstico — PII, calidad de datos y crons
        </summary>
        <div className="mt-4 space-y-4">
          {/* PII oversight */}
          <OpCard aria-labelledby={panelPiiId}>
            <OpCardHead
              title={<span id={panelPiiId}>Supervisión de PII — ¿quién consultó qué?</span>}
            />
            <OpCardBody>
              {piiOversight.length === 0 ? (
                <p className="text-md text-ln-op-mute">
                  Sin consultas PII registradas en el período.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-md text-ln-op-ink border-collapse">
                    <caption className="sr-only">
                      Top actores por cantidad de consultas PII-sensibles en el período. Datos del
                      audit_log (pii_queried, welfare_location_viewed).
                    </caption>
                    <thead>
                      <tr className="border-b border-ln-op-line">
                        <th
                          scope="col"
                          className="text-left py-2 pr-4 font-semibold text-ln-op-mute"
                        >
                          Actor
                        </th>
                        <th
                          scope="col"
                          className="text-left py-2 pr-4 font-semibold text-ln-op-mute"
                        >
                          Acción
                        </th>
                        <th
                          scope="col"
                          className="text-left py-2 pr-4 font-semibold text-ln-op-mute"
                        >
                          Superficie
                        </th>
                        <th
                          scope="col"
                          className="text-right py-2 pr-4 font-semibold text-ln-op-mute"
                        >
                          Consultas
                        </th>
                        <th scope="col" className="text-right py-2 font-semibold text-ln-op-mute">
                          Última
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {piiOversight.map((row) => (
                        <tr
                          key={`${row.actorUserId ?? "deleted"}-${row.action}-${row.surface ?? ""}`}
                          className="border-b border-ln-op-line last:border-0 hover:bg-ln-op-stripe/50 transition-colors"
                        >
                          <td className="py-2 pr-4 text-md text-ln-op-ink-2">
                            {row.actorUserId
                              ? (actorNameMap.get(row.actorUserId) ?? "Operador desconocido")
                              : "Usuario eliminado"}
                          </td>
                          <td className="py-2 pr-4 text-ln-op-ink-2" title={row.action}>
                            {auditActionLabel(row.action)}
                          </td>
                          <td className="py-2 pr-4 text-ln-op-mute">
                            {row.surface ? (SURFACE_LABEL[row.surface] ?? row.surface) : "—"}
                          </td>
                          <td className="py-2 pr-4 text-right tabular-nums font-medium">
                            {row.count.toLocaleString("es-AR")}
                          </td>
                          <td className="py-2 text-right text-sm text-ln-op-mute">
                            {formatDateShort(row.lastAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </OpCardBody>
          </OpCard>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {/* Data quality scorecard */}
            <OpCard aria-labelledby={panelQualityId}>
              <OpCardHead title={<span id={panelQualityId}>Calidad de datos</span>} />
              <OpCardBody>
                {dataQuality.total === 0 ? (
                  <p className="text-md text-ln-op-mute">Sin mascotas activas en el padrón.</p>
                ) : (
                  <div className="space-y-3">
                    {/* Completeness bar */}
                    <div>
                      <div className="flex justify-between items-baseline mb-1">
                        <span className="text-sm text-ln-op-mute">Completitud</span>
                        <span
                          className={[
                            "text-md font-semibold tabular-nums",
                            dataQuality.completenessPct >= 80
                              ? "text-ln-op-ok"
                              : dataQuality.completenessPct >= 60
                                ? "text-ln-op-warn"
                                : "text-ln-op-danger",
                          ].join(" ")}
                          aria-label={`Completitud: ${dataQuality.completenessPct}%`}
                        >
                          {dataQuality.completenessPct}%
                        </span>
                      </div>
                      <div
                        className="h-2 rounded bg-ln-op-stripe overflow-hidden"
                        aria-hidden="true"
                        role="presentation"
                      >
                        <div
                          className={[
                            "h-full rounded transition-all",
                            dataQuality.completenessPct >= 80
                              ? "bg-ln-op-ok"
                              : dataQuality.completenessPct >= 60
                                ? "bg-ln-op-warn"
                                : "bg-ln-op-danger",
                          ].join(" ")}
                          style={{ width: `${dataQuality.completenessPct}%` }}
                        />
                      </div>
                    </div>

                    {/* Missing field counts */}
                    <ul className="space-y-1.5 text-sm" aria-label="Campos faltantes por categoría">
                      <li className="flex justify-between items-baseline">
                        <span className="text-ln-op-mute">Sin localidad</span>
                        <span className="tabular-nums text-ln-op-ink">
                          {dataQuality.missingLocality.toLocaleString("es-AR")}
                        </span>
                      </li>
                      <li className="flex justify-between items-baseline">
                        <span className="text-ln-op-mute">Sexo desconocido</span>
                        <span className="tabular-nums text-ln-op-ink">
                          {dataQuality.missingSex.toLocaleString("es-AR")}
                        </span>
                      </li>
                      <li className="flex justify-between items-baseline">
                        <span className="text-ln-op-mute">Sin microchip activo</span>
                        <span className="tabular-nums text-ln-op-ink">
                          {dataQuality.missingChip.toLocaleString("es-AR")}
                        </span>
                      </li>
                      <li className="flex justify-between items-baseline border-t border-ln-op-line pt-1.5">
                        <span className="text-ln-op-mute">Huérfanas (sin propietario)</span>
                        <span
                          className={[
                            "tabular-nums font-medium",
                            dataQuality.orphans > 0 ? "text-ln-op-warn" : "text-ln-op-ink",
                          ].join(" ")}
                        >
                          {dataQuality.orphans.toLocaleString("es-AR")}
                        </span>
                      </li>
                    </ul>

                    <p className="text-xs text-ln-op-mute">
                      Completitud = mascotas sin ningún campo faltante (localidad + sexo + chip) ÷
                      total. Huérfanas: sin ninguna fila en ownerships.
                    </p>
                  </div>
                )}
              </OpCardBody>
            </OpCard>

            {/* Cron health (leanness sweep, 2026-08-02): this card used to
                embed its own copy of the cron list, read off the same
                fetchCronRuns() that /admin/sistema's SistemaCronsCard already
                renders as its whole reason to exist — two live copies of the
                same read, one of them dead weight. Sistema owns cron health;
                this link-outs there instead, same pattern as the ENO SLA KPI
                tile above (href="/admin/outbox"). */}
            <OpCard aria-labelledby={panelCronsId}>
              <OpCardHead title={<span id={panelCronsId}>Salud de crons</span>} />
              <OpCardBody>
                <a
                  href="/admin/sistema"
                  className="inline-flex items-center gap-1 text-sm font-semibold text-ln-op-azul no-underline underline-offset-4 hover:underline"
                >
                  Ver salud de crons en Sistema →
                </a>
              </OpCardBody>
            </OpCard>
          </div>
        </div>
      </details>

      {/* Physical-tag demand (audit 2026-08-04). The "Me interesa" sheet told
          owners "te avisamos cuando estén disponibles" and wrote a row that
          NOTHING could list — the only reader was a per-pet/per-user check
          answering "did you already ask?". Same shape as the shelter contact
          form whose messages nobody could open.

          It lives on the executive summary, not on Sistema, because the
          decision it feeds is a product one: the manufacturer and distribution
          calls that block the physical tag are made per municipality, and this
          is the only place that says where the demand actually is. */}
      <PhysicalTagDemandCard />

      <DashboardFreshnessFooter ctx={adminCtx} />
    </div>
  );
}
