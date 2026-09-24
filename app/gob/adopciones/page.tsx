// /gob/adopciones — Pipeline de custodia & adopción (Paquete F).
//
// Jurisdiction-scoped, period-aware gobierno screen answering:
// "¿Funciona el ciclo de colocación en mi cobertura?"
//
// Layout (Op* design system):
//   KPI row       — en custodia · en tránsito · adopciones (período) · tasa de retorno
//   Funnel        — horizontal bars (intake → foster → adopción → devolución)
//   Time-in-state — tabla mediana/p75 días por rol
//   Shelter occ.  — ocupación de refugios en la jurisdicción
//   Foster pool   — voluntarios activos / con cupo / colocaciones activas
//   Adoption trend— TimeSeriesChartDynamic
//   Freshness footer

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
import { formatDelta } from "@/lib/analytics/campaign-metrics";
import { resolveJurisdictionScope } from "@/lib/analytics/jurisdiction-scope";
import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import { requireGobReadAccessOrRedirect } from "@/lib/infra/auth-guards";
import {
  TARGETS,
  buildProjectionContext,
  fetchAdoptionApplicationFunnel,
  fetchAdoptionTrend,
  fetchCustodyFunnel,
  fetchFosterPoolUtilization,
  fetchPrevAdoptionCount,
  fetchReturnRate,
  fetchShelterOccupancyNational,
  fetchTimeInState,
  funnelBarWidths,
  toneForTarget,
} from "@/lib/metrics";
import { KPI_CATALOG, getKpiInfo } from "@/lib/metrics/kpi-catalog";
import { resolveAnalyticsPeriod } from "@/lib/metrics/period";
import { describeNarrowedView } from "@/lib/ui/view-scope-caption";
import { formatPercent, speciesOptions } from "@/lib/utils/format";

export const dynamic = "force-dynamic";

// Species domain axis — mirrors /gob/perdidas' SPECIES_OPTIONS exactly.
// pets.species is free text ('dog' | 'cat' | 'other' in practice); "other" is
// the exact stored value the fetchers honor as-is (no query change).
// Valores: decisión de esta pantalla. Ortografía: speciesLabel, fuente única.
const SPECIES_OPTIONS = speciesOptions(["dog", "cat", "other"]);

export default async function GobAdopcionesPage({
  searchParams,
}: {
  searchParams: Promise<{
    period?: string;
    from?: string;
    to?: string;
    province?: string;
    locality?: string;
    species?: string;
  }>;
}) {
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
          description="Tu rol no tiene acceso a adopciones. Pedile al admin que te asigne capabilities."
        />
      </div>
    );
  }

  const sp = await searchParams;

  // "Exportar CSV" always mirrors the active period + jurisdiction filters —
  // the export route re-derives filteredJurisdictions from the same params.
  const exportParams = new URLSearchParams();
  if (sp.period) exportParams.set("period", sp.period);
  if (sp.from) exportParams.set("from", sp.from);
  if (sp.to) exportParams.set("to", sp.to);
  if (sp.province) exportParams.set("province", sp.province);
  if (sp.locality) exportParams.set("locality", sp.locality);
  if (sp.species) exportParams.set("species", sp.species);
  const exportHref = `/gob/adopciones/export${exportParams.size > 0 ? `?${exportParams}` : ""}`;

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

  // Header + filter bar render in BOTH the data and the degraded branch (same
  // shape as app/gob/censo/CensoScreen.tsx). Nothing here depends on the eight
  // aggregates below: the bar is built from allowedProvinces/localities, which
  // resolveJurisdictionScope already resolved, and exportHref from searchParams
  // alone. Returning a bare fallback took away the province selector — the one
  // control that would have narrowed the national query that timed out — while
  // "Reintentar" re-issues that identical query, so every retry timed out too
  // and the page was unrecoverable without hand-editing the URL.
  const shell = (
    <>
      {/* Page header */}
      <ScreenHeader
        className="space-y-2"
        eyebrow="Custodia & adopción"
        title="Adopciones"
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
                Flujo de custodia, tiempos de custodia y pool de tránsitos en tu cobertura.
              </p>
            )}
            <ViewScopeCaption scope={narrowedView} />
          </>
        }
      />

      {/* Unified filter bar — jurisdiction + period, with "Exportar CSV"
          rendered via the bar's `actions` slot (header row) instead of
          floating beside it (same pattern as /gob/censo). */}
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
    </>
  );

  // fetchPrevAdoptionCount adds ONE new query (same scope, shifted one period
  // back) purely to power the "Adopciones" deltaV2 chip — mirrors
  // campaign-metrics.ts' fetchPrevTotals pattern.
  //
  // species narrows funnel/timeInState/returnRate/adoptionTrend/appFunnel/
  // prevAdoptionCount identically (domain-axes work). fosterPool and
  // shelterOccupancy deliberately do NOT take species: fosterPool's
  // activeVolunteers/withCapacity are volunteer-level counts with no species
  // dimension, and shelterOccupancy's capacity denominator is org-level
  // config that can't be split by species — narrowing only the numerator
  // would reproduce the exact mixed-scope-ratio dishonesty this page already
  // fences off for local operators (see the "escala nacional" comment below).
  // BOUNDED — eight population-scale aggregates, the biggest fan-out in the
  // portal after panorama, awaited bare until the 2026-08-09 outage pass.
  const load = await loadWithTimeout(
    Promise.all([
      fetchCustodyFunnel(ctx, { species }),
      fetchTimeInState(ctx, { species }),
      fetchReturnRate(ctx, { species }),
      fetchFosterPoolUtilization(ctx),
      fetchShelterOccupancyNational(ctx),
      fetchAdoptionTrend(ctx, { species }),
      fetchAdoptionApplicationFunnel(ctx, { species }),
      fetchPrevAdoptionCount(ctx, { species }),
    ]),
  );
  if (!load.ok) {
    return (
      <div className="space-y-6">
        {shell}
        <AnalyticsLoadFallback
          reason={load.reason}
          correlationId={load.id}
          retryHref={analyticsRetryHref("/gob/adopciones", sp)}
        />
      </div>
    );
  }
  const [
    funnel,
    timeInState,
    returnRateValue,
    fosterPool,
    shelterOccupancy,
    adoptionTrend,
    appFunnel,
    prevAdoptionCount,
  ] = load.value;

  const adoptionDelta = formatDelta(funnel.adoption, prevAdoptionCount, "vs período anterior");

  const fPct = funnelBarWidths(funnel);

  const hasFunnel = funnel.intake > 0 || funnel.foster > 0 || funnel.adoption > 0;
  const hasTrend = adoptionTrend.points.length > 0;

  const returnRatePct = returnRateValue != null ? Math.round(returnRateValue * 1000) / 10 : null;

  const conversionPct =
    appFunnel.conversionRate != null ? Math.round(appFunnel.conversionRate * 1000) / 10 : null;
  const hasAppFunnel = appFunnel.submitted > 0 || appFunnel.resolved > 0;

  const panelAppFunnelId = "gob-panel-adopciones-postulaciones-titulo";
  const panelFunnelId = "gob-panel-adopciones-embudo-titulo";
  const panelTimeId = "gob-panel-adopciones-tiempo-titulo";
  const panelOccupancyId = "gob-panel-adopciones-ocupacion-titulo";
  const panelFosterPoolId = "gob-panel-adopciones-pool-titulo";
  const panelTrendId = "gob-panel-adopciones-tendencia-titulo";

  return (
    <div className="space-y-6">
      {/* Header + filter bar — hoisted above the load so the degraded branch
          keeps them (see the `shell` definition). */}
      {shell}

      {/* KPI row */}
      <section
        aria-label="Indicadores de adopciones"
        className="grid grid-cols-2 md:grid-cols-4 gap-3"
      >
        <OpKpi
          label={KPI_CATALOG.shelter_custody_occupied.label}
          value={
            shelterOccupancy.occupied > 0 ? shelterOccupancy.occupied.toLocaleString("es-AR") : "—"
          }
          sub="custodias en refugio activas en la cobertura"
          info={{
            definition:
              "Animales con ownerships.role = 'shelter_custody' y ended_at IS NULL, scoped a la jurisdicción.",
            formula:
              "COUNT(ownerships) WHERE role='shelter_custody' AND ended_at IS NULL AND scope",
          }}
          descriptorId="shelter_custody_occupied"
        />
        <OpKpi
          label={KPI_CATALOG.foster_active_placements.label}
          value={
            fosterPool.activeFosterPlacements > 0
              ? fosterPool.activeFosterPlacements.toLocaleString("es-AR")
              : "—"
          }
          sub="colocaciones en tránsito activas en la cobertura"
          info={{
            definition: "Ownerships.role = 'foster' con ended_at IS NULL en el scope.",
            formula: "COUNT(ownerships) WHERE role='foster' AND ended_at IS NULL AND scope",
          }}
          descriptorId="foster_active_placements"
        />
        <OpKpi
          label={KPI_CATALOG.adoptions_finalized.label}
          value={funnel.adoption > 0 ? funnel.adoption.toLocaleString("es-AR") : "—"}
          sub="adopciones finalizadas en el período y la cobertura"
          deltaV2={funnel.adoption > 0 ? (adoptionDelta ?? undefined) : undefined}
          sparkline={adoptionTrend.points.length > 0 ? adoptionTrend.points : undefined}
          info={{
            definition: "Eventos adoption_finalized en el período, scoped a la jurisdicción.",
            formula: "COUNT(pet_events) WHERE event_type='adoption_finalized' AND period AND scope",
          }}
          descriptorId="adoptions_finalized"
          guardInput={{ priorBase: prevAdoptionCount }}
        />
        <OpKpi
          label="Tasa de retorno"
          value={formatPercent(returnRatePct)}
          sub={
            returnRatePct != null
              ? "devoluciones / adopciones (período)"
              : "Sin adopciones en el período"
          }
          tone={
            returnRatePct == null
              ? "neutral"
              : toneForTarget(returnRatePct, TARGETS.ADOPTION_RETURN_RATE_PCT, {
                  higherIsBetter: false,
                })
          }
          info={getKpiInfo("custody_return_rate")}
          descriptorId="custody_return_rate"
          guardInput={{ n: funnel.adoption }}
        />
      </section>

      {/* Funnel — intake → foster → adopción → devolución.
          Renamed from "Embudo de colocación" (PO interview 2026-07-23, item
          13): "embudo" implies a tracked cohort narrowing stage by stage,
          but each stage below is an independent event count over the
          period/coverage — see the "no cohorte" disclaimer under the chart.
          The new title states that honestly instead of relying on the
          disclaimer to walk it back after the fact. */}
      <OpCard aria-labelledby={panelFunnelId}>
        <OpCardHead title={<span id={panelFunnelId}>Flujo de custodia (no cohorte)</span>} />
        <OpCardBody>
          {!hasFunnel ? (
            <LnEmptyState
              icon="heart"
              title="Sin eventos de custodia en el período"
              description="No hay registros de intake, tránsitos o adopciones en el rango y la cobertura seleccionados."
            />
          ) : (
            // Q2: role="img" flattens the whole subtree to a single opaque
            // image for assistive tech — the figcaption AND every stage
            // <li>'s aria-label below were unreachable while it sat here.
            // Same fix already shipped for StaticFirstMap's static-map role.
            <figure
              aria-label={`Flujo de custodia — ${funnel.intake.toLocaleString("es-AR")} ingresos en total.`}
            >
              <figcaption className="sr-only">
                Gráfico de barras horizontales: etapas del pipeline de custodia y adopción en la
                cobertura seleccionada.
              </figcaption>
              <ul className="space-y-2" aria-label="Etapas del pipeline de custodia">
                {/* Stage 1: Intake */}
                <li
                  className="flex items-center gap-3"
                  aria-label={`Ingresos al refugio: ${funnel.intake.toLocaleString("es-AR")}`}
                >
                  <span className="w-48 shrink-0 text-md text-ln-op-ink">Ingresos al refugio</span>
                  <div
                    className="flex-1 h-4 rounded bg-ln-op-stripe overflow-hidden"
                    aria-hidden="true"
                  >
                    <div
                      className="h-full rounded bg-ln-op-azul"
                      style={{ width: `${fPct.intakePct}%` }}
                    />
                  </div>
                  <span className="w-28 shrink-0 text-right text-md tabular-nums text-ln-op-ink">
                    {funnel.intake.toLocaleString("es-AR")}
                  </span>
                </li>

                {/* Stage 2: Foster */}
                <li
                  className="flex items-center gap-3"
                  aria-label={`Asignados a tránsito: ${funnel.foster.toLocaleString("es-AR")}`}
                >
                  <span className="w-48 shrink-0 text-md text-ln-op-ink">Asignados a tránsito</span>
                  <div
                    className="flex-1 h-4 rounded bg-ln-op-stripe overflow-hidden"
                    aria-hidden="true"
                  >
                    <div
                      className="h-full rounded bg-ln-op-azul"
                      style={{ width: `${fPct.fosterPct}%` }}
                    />
                  </div>
                  <span className="w-28 shrink-0 text-right text-md tabular-nums text-ln-op-ink">
                    {funnel.foster.toLocaleString("es-AR")}
                  </span>
                </li>

                {/* Stage 3: Adoption — same underlying count (funnel.adoption)
                    as the Adopciones finalizadas KPI tile above; label
                    sourced from the catalog so the funnel stage and the tile
                    can never drift apart. */}
                <li
                  className="flex items-center gap-3"
                  aria-label={`${KPI_CATALOG.adoptions_finalized.label}: ${funnel.adoption.toLocaleString("es-AR")}`}
                >
                  <span className="w-48 shrink-0 text-md text-ln-op-ink">
                    {KPI_CATALOG.adoptions_finalized.label}
                  </span>
                  <div
                    className="flex-1 h-4 rounded bg-ln-op-stripe overflow-hidden"
                    aria-hidden="true"
                  >
                    <div
                      className="h-full rounded bg-ln-op-ok"
                      style={{ width: `${fPct.adoptionPct}%` }}
                    />
                  </div>
                  <span className="w-28 shrink-0 text-right text-md tabular-nums text-ln-op-ink">
                    {funnel.adoption.toLocaleString("es-AR")}
                  </span>
                </li>

                {/* Stage 4: Reversed (devolución). Rate is single-sourced from
                    returnRatePct (= reversed / adoptions) so it agrees with the
                    "tasa de retorno" KPI above — bar width is volume-proportional. */}
                <li
                  className="flex items-center gap-3"
                  aria-label={`Devoluciones: ${funnel.reversed.toLocaleString("es-AR")}${
                    returnRatePct != null
                      ? ` (${formatPercent(returnRatePct)} de las adopciones)`
                      : ""
                  }`}
                >
                  <span className="w-48 shrink-0 text-md text-ln-op-ink">Devoluciones</span>
                  <div
                    className="flex-1 h-4 rounded bg-ln-op-stripe overflow-hidden"
                    aria-hidden="true"
                  >
                    <div
                      className={`h-full rounded ${returnRatePct != null && returnRatePct > 10 ? "bg-ln-op-danger" : returnRatePct != null && returnRatePct > 5 ? "bg-ln-op-warn" : "bg-ln-op-azul"}`}
                      style={{ width: `${fPct.reversedPct}%` }}
                    />
                  </div>
                  <span className="w-28 shrink-0 text-right text-md tabular-nums text-ln-op-ink">
                    {funnel.reversed.toLocaleString("es-AR")}
                    {returnRatePct != null ? (
                      <>
                        {" "}
                        <span className="ml-1 text-ln-op-mute">
                          ({formatPercent(returnRatePct)})
                        </span>
                      </>
                    ) : null}
                  </span>
                </li>
              </ul>
              <p className="mt-2 text-xs text-ln-op-mute">
                Cada etapa es un conteo de eventos independiente del período y la cobertura (no
                cohorte): una etapa posterior puede superar a una anterior. Las barras son
                proporcionales al conteo de cada etapa (relativas a la de mayor volumen). El % de
                Devoluciones es sobre las adopciones del período — misma base que la tasa de
                retorno.
              </p>
            </figure>
          )}
        </OpCardBody>
      </OpCard>

      {/* Application funnel — DEMAND side (online postulaciones), distinct from
          the supply-side placement funnel above. submitted → resolved (aprobadas /
          rechazadas / retiradas) with an approval conversion rate. */}
      <OpCard aria-labelledby={panelAppFunnelId}>
        <OpCardHead title={<span id={panelAppFunnelId}>Embudo de postulaciones</span>} />
        <OpCardBody>
          {!hasAppFunnel ? (
            <LnEmptyState
              icon="heart"
              title="Sin postulaciones en el período"
              description="No hay eventos adoption_application_submitted ni adoption_application_resolved en el rango y la cobertura seleccionados."
            />
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                <div className="text-center">
                  <div className="text-xl font-semibold text-ln-op-ink tabular-nums">
                    {appFunnel.submitted.toLocaleString("es-AR")}
                  </div>
                  <div className="text-sm text-ln-op-mute mt-0.5">Postulaciones</div>
                </div>
                <div className="text-center">
                  <div className="text-xl font-semibold text-ln-op-ink tabular-nums">
                    {appFunnel.resolved.toLocaleString("es-AR")}
                  </div>
                  <div className="text-sm text-ln-op-mute mt-0.5">Resueltas</div>
                </div>
                <div className="text-center">
                  <div className="text-xl font-semibold text-ln-op-ok tabular-nums">
                    {appFunnel.approved.toLocaleString("es-AR")}
                  </div>
                  <div className="text-sm text-ln-op-mute mt-0.5">Aprobadas</div>
                </div>
                <div className="text-center">
                  <div className="text-xl font-semibold text-ln-op-ink tabular-nums">
                    {appFunnel.rejected.toLocaleString("es-AR")}
                  </div>
                  <div className="text-sm text-ln-op-mute mt-0.5">Rechazadas</div>
                </div>
                <div className="text-center">
                  <div className="text-xl font-semibold text-ln-op-ink tabular-nums">
                    {formatPercent(conversionPct)}
                  </div>
                  <div className="text-sm text-ln-op-mute mt-0.5">Conversión</div>
                </div>
              </div>
              <p className="mt-3 text-xs text-ln-op-mute">
                Conversión = aprobadas / postulaciones del período.{" "}
                {appFunnel.withdrawn > 0
                  ? `${appFunnel.withdrawn.toLocaleString("es-AR")} retirada(s) por el postulante. `
                  : ""}
                Postulaciones y resoluciones son conteos independientes del período (no cohorte):
                una resolución puede referirse a una postulación anterior al rango.
              </p>
            </>
          )}
        </OpCardBody>
      </OpCard>

      {/* Time-in-state panel */}
      <OpCard aria-labelledby={panelTimeId}>
        <OpCardHead title={<span id={panelTimeId}>Tiempo en estado</span>} />
        <OpCardBody>
          {timeInState.length === 0 ? (
            <LnEmptyState
              icon="clock"
              title="Sin datos de custodia"
              description="No hay ownerships de custodia o tránsito en el período y cobertura seleccionados."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-md text-ln-op-ink border-collapse">
                <caption className="sr-only">
                  {/* "Mediana", not "promedio" — fetchTimeInState computes
                      percentile_cont(0.5); the caption must name the statistic
                      the table actually shows. */}
                  Mediana y percentil 75 en estado de custodia o tránsito, en días.
                </caption>
                <thead>
                  <tr className="border-b border-ln-op-line">
                    <th scope="col" className="text-left py-2 pr-4 font-semibold text-ln-op-mute">
                      Rol
                    </th>
                    <th scope="col" className="text-right py-2 px-4 font-semibold text-ln-op-mute">
                      Mediana (días)
                    </th>
                    <th scope="col" className="text-right py-2 px-4 font-semibold text-ln-op-mute">
                      P75 (días)
                    </th>
                    <th scope="col" className="text-right py-2 pl-4 font-semibold text-ln-op-mute">
                      Registros
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { key: "shelter_custody", label: "Custodia en refugio" },
                    { key: "foster", label: "Tránsito" },
                  ].map(({ key, label }) => {
                    const row = timeInState.find((r) => r.role === key);
                    if (!row) return null;
                    return (
                      <tr
                        key={key}
                        className="border-b border-ln-op-line last:border-0 hover:bg-ln-op-stripe/50 transition-colors"
                      >
                        <td className="py-2 pr-4">{label}</td>
                        <td className="py-2 px-4 text-right tabular-nums">
                          {row.medianDays != null ? `${Math.round(row.medianDays * 10) / 10}` : "—"}
                        </td>
                        <td className="py-2 px-4 text-right tabular-nums">
                          {row.p75Days != null ? `${Math.round(row.p75Days * 10) / 10}` : "—"}
                        </td>
                        <td className="py-2 pl-4 text-right tabular-nums text-ln-op-mute">
                          {row.n.toLocaleString("es-AR")}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-ln-op-mute">
                Duración: desde el inicio de la custodia hasta su cierre (o hasta hoy si sigue
                activa), para custodias que se superponen con el período en la cobertura
                seleccionada.
              </p>
            </div>
          )}
        </OpCardBody>
      </OpCard>

      {/* Shelter occupancy — NATIONAL metric (metric-honesty 2026-07-09).
          `capacity` is org-config summed across ALL shelters (never scoped),
          while `occupied` is scoped to the operator's jurisdiction: a local
          operator's scoped-occupied ÷ national-capacity is a misleading ratio.
          The scoped occupied count already appears in the "En custodia
          (refugio)" headline KPI above, so this national comparison is shown
          ONLY at national (admin) scope, explicitly labelled "escala nacional".
          Local govt operators no longer see the mixed-scope percentage. */}
      {hasNationalReadScope(profile.role) && (
        <OpCard aria-labelledby={panelOccupancyId}>
          <OpCardHead
            title={<span id={panelOccupancyId}>Ocupación de refugios (escala nacional)</span>}
          />
          <OpCardBody>
            {shelterOccupancy.occupied === 0 && shelterOccupancy.capacity == null ? (
              <LnEmptyState
                icon="home"
                title="Sin datos de ocupación"
                description="No hay custodia activa ni cupo declarado para refugios en tu cobertura."
              />
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-4">
                  <div className="text-2xl font-semibold text-ln-op-ink tabular-nums">
                    {shelterOccupancy.occupied.toLocaleString("es-AR")}
                  </div>
                  <div className="text-md text-ln-op-mute">
                    {shelterOccupancy.capacity != null ? (
                      <>
                        de {shelterOccupancy.capacity.toLocaleString("es-AR")} cupos declarados
                        {shelterOccupancy.pct != null && (
                          <>
                            {" "}
                            <span
                              className={`ml-2 font-semibold ${shelterOccupancy.pct > 90 ? "text-ln-op-danger" : shelterOccupancy.pct > 70 ? "text-ln-op-warn" : "text-ln-op-ok"}`}
                            >
                              ({shelterOccupancy.pct}%)
                            </span>
                          </>
                        )}
                      </>
                    ) : (
                      "animales en custodia · cupo no declarado"
                    )}
                  </div>
                </div>
                {shelterOccupancy.capacity != null && shelterOccupancy.pct != null && (
                  <div
                    className="h-3 rounded bg-ln-op-stripe overflow-hidden"
                    aria-hidden="true"
                    role="presentation"
                  >
                    <div
                      className={`h-full rounded transition-all ${shelterOccupancy.pct > 90 ? "bg-ln-op-danger" : shelterOccupancy.pct > 70 ? "bg-ln-op-warn" : "bg-ln-op-ok"}`}
                      style={{ width: `${Math.min(100, shelterOccupancy.pct)}%` }}
                    />
                  </div>
                )}
                <p className="text-xs text-ln-op-mute">
                  Ocupados: total nacional de animales en custodia activa en refugios · Cupo: SUM de
                  organizations.capacity_total para orgs tipo shelter (escala nacional).
                </p>
              </div>
            )}
          </OpCardBody>
        </OpCard>
      )}

      {/* Foster pool utilization */}
      <OpCard aria-labelledby={panelFosterPoolId}>
        <OpCardHead title={<span id={panelFosterPoolId}>Pool de tránsitos</span>} />
        <OpCardBody>
          {/* Stacked below sm (mobile-polish 2026-07): 3-across crushed the
              stat captions at 390px. */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="text-center">
              <div className="text-xl font-semibold text-ln-op-ink tabular-nums">
                {fosterPool.activeVolunteers.toLocaleString("es-AR")}
              </div>
              <div className="text-sm text-ln-op-mute mt-0.5">Voluntarios activos</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-semibold text-ln-op-ink tabular-nums">
                {fosterPool.withCapacity.toLocaleString("es-AR")}
              </div>
              <div className="text-sm text-ln-op-mute mt-0.5">Con cupo disponible</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-semibold text-ln-op-ink tabular-nums">
                {fosterPool.activeFosterPlacements.toLocaleString("es-AR")}
              </div>
              <div className="text-sm text-ln-op-mute mt-0.5">Colocaciones activas</div>
            </div>
          </div>
          <p className="mt-3 text-xs text-ln-op-mute">
            Voluntarios filtrados por jurisdicción cuando corresponde.
          </p>
        </OpCardBody>
      </OpCard>

      {/* Adoption trend */}
      <OpCard aria-labelledby={panelTrendId}>
        <OpCardHead
          title={<span id={panelTrendId}>Tendencia de adopciones</span>}
          actions={
            adoptionTrend.suppressedCount > 0 ? (
              <span className="text-sm font-normal text-ln-op-mute">
                {adoptionTrend.suppressedCount}{" "}
                {adoptionTrend.suppressedCount === 1 ? "período oculto" : "períodos ocultos"}{" "}
                (privacidad)
              </span>
            ) : null
          }
        />
        <OpCardBody>
          {!hasTrend ? (
            <LnEmptyState
              icon="chart-line"
              title="Sin adopciones en el período"
              description="No hay adopciones finalizadas en el rango y la cobertura seleccionados."
            />
          ) : (
            <TimeSeriesChartDynamic
              data={adoptionTrend.points}
              seriesLabel={KPI_CATALOG.adoptions_finalized.label}
              yLabel="Adopciones"
              variant="area"
              fallbackTableLabel={`Adopciones por ${adoptionTrend.granularity === "month" ? "mes" : "semana"}`}
              // A fully masked series must say "Datos ocultos por privacidad
              // (k<5)" inside the plot, not fall back to "Sin datos para el
              // período seleccionado" — that copy claims a measured absence.
              suppressedCount={adoptionTrend.suppressedCount}
            />
          )}
        </OpCardBody>
      </OpCard>

      <DashboardFreshnessFooter ctx={ctx} />
    </div>
  );
}
