// /admin/adopciones — Pipeline de custodia & adopción (vista admin universal, Paquete F).
//
// Universal view: no JurisdictionSwitcher, admin sees all data regardless of province.
// Answers: ¿Funciona el ciclo de colocación?
//
// Layout:
//   KPI row            — pets en custodia · en tránsito · adopciones (período) · tasa de retorno
//   Funnel             — intake→foster→adopción→devolución (horizontal bars)
//   Time-in-state      — median/p75 días por rol (shelter_custody, foster)
//   Shelter occupancy  — ocupación nacional de refugios vs cupo
//   Foster pool        — voluntarios activos / con cupo / colocaciones activas
//   Adoption trend     — TimeSeriesChartDynamic (adoption_finalized)
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
} from "@/components/ui/dashboard";
import { AnalyticsLoadFallback } from "@/components/ui/dashboard/AnalyticsLoadFallback";
import { DashboardFreshnessFooter } from "@/components/ui/dashboard/DashboardFreshnessFooter";
import { analyticsRetryHref, loadWithTimeout } from "@/lib/analytics/analytics-load";
import { DEFAULT_DASHBOARD_PRESET } from "@/lib/analytics/analytics-period";
import { formatDelta } from "@/lib/analytics/campaign-metrics";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import {
  TARGETS,
  buildProjectionContext,
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
import { windows } from "@/lib/metrics/period";
import { formatPercent, formatRate, speciesOptions } from "@/lib/utils/format";

export const dynamic = "force-dynamic";

// Species domain axis — mirrors /gob/adopciones' SPECIES_OPTIONS exactly
// (twin port, Fase B "regalos olvidados"). pets.species is free text ('dog' |
// 'cat' | 'other' in practice); "other" is the exact stored value the
// fetchers honor as-is (no query change).
// Valores: decisión de esta pantalla. Ortografía: speciesLabel, fuente única.
const SPECIES_OPTIONS = speciesOptions(["dog", "cat", "other"]);

export default async function AdminAdopcionesPage({
  searchParams,
}: {
  searchParams?: Promise<{ period?: string; from?: string; to?: string; species?: string }>;
}) {
  await requireAdminOrRedirect();

  const sp = searchParams ? await searchParams : {};
  const { resolveAnalyticsPeriod } = await import("@/lib/metrics/period");
  const period = sp.period || sp.from ? resolveAnalyticsPeriod(sp) : windows.trailing12m();
  const species = sp.species || undefined;

  const ctx = buildProjectionContext({ role: "admin" }, [], period);

  // Header + filter bar render in BOTH the data and the degraded branch (same
  // shape as app/gob/censo/CensoScreen.tsx): neither depends on the fetchers
  // below, and the period/species controls are what would narrow a query that
  // timed out.
  const shell = (
    <>
      {/* Page header */}
      <header className="space-y-2">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
          Admin · Pipeline de custodia & adopción
        </p>
        <h1 className="text-title font-semibold text-ln-op-ink">Adopciones</h1>
        <p className="text-md text-ln-op-mute">
          Vista nacional: embudo de colocación, tiempos de custodia, ocupación de refugios y pool de
          tránsitos.
        </p>
      </header>

      {/* Unified filter bar — period + species (no JurisdictionSwitcher:
          admin is a national/universal view). Twin of /gob/adopciones' rail;
          same pattern as /admin/censo, /admin/poblacion. */}
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
    </>
  );

  // fetchPrevAdoptionCount adds ONE new query (same scope, shifted one period
  // back) purely to power the "Adopciones" deltaV2 chip — mirrors
  // campaign-metrics.ts' fetchPrevTotals pattern (same as /gob/adopciones).
  //
  // species narrows funnel/timeInState/returnRate/adoptionTrend/
  // prevAdoptionCount identically (twin of /gob/adopciones' domain-axes
  // work). fosterPool and shelterOccupancy deliberately do NOT take species —
  // same reasoning as /gob/adopciones: fosterPool's counts are volunteer-level
  // (no species dimension) and shelterOccupancy's capacity denominator is
  // org-level config that can't be split by species.
  //
  // BOUNDED (2026-08-09, second resilience pass). This is the same seven-fetcher
  // set as /gob/adopciones — at UNIVERSAL scope, so strictly heavier — and it
  // was the only half left bare when its gob twin was wrapped. That twin-gets-
  // missed pattern is now on its third occurrence, which is why the fence below
  // stopped trusting a hardcoded page list (see scripts/check-db-budget.ts).
  const load = await loadWithTimeout(
    Promise.all([
      fetchCustodyFunnel(ctx, { species }),
      fetchTimeInState(ctx, { species }),
      fetchReturnRate(ctx, { species }),
      fetchFosterPoolUtilization(ctx),
      fetchShelterOccupancyNational(ctx),
      fetchAdoptionTrend(ctx, { species }),
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
          retryHref={analyticsRetryHref("/admin/adopciones", sp)}
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
    prevAdoptionCount,
  ] = load.value;

  const adoptionDelta = formatDelta(funnel.adoption, prevAdoptionCount, "vs período anterior");

  const fPct = funnelBarWidths(funnel);

  const hasFunnel = funnel.intake > 0 || funnel.foster > 0 || funnel.adoption > 0;
  const hasTrend = adoptionTrend.points.length > 0;

  const returnRatePct = returnRateValue != null ? Math.round(returnRateValue * 1000) / 10 : null;

  // Shelter custody + foster active placements as KPI values.
  const shelterCustodyRow = timeInState.find((r) => r.role === "shelter_custody");
  const fosterRow = timeInState.find((r) => r.role === "foster");

  const panelFunnelId = "admin-panel-adopciones-embudo-titulo";
  const panelTimeId = "admin-panel-adopciones-tiempo-titulo";
  const panelOccupancyId = "admin-panel-adopciones-ocupacion-titulo";
  const panelFosterPoolId = "admin-panel-adopciones-pool-titulo";
  const panelTrendId = "admin-panel-adopciones-tendencia-titulo";

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
          // A real zero (no animals in custody) is operational data, not missing
          // data — show 0, not "—" (which would read as "metric unavailable").
          value={shelterOccupancy.occupied.toLocaleString("es-AR")}
          sub="animales en custodia activa en refugios (nacional)"
          info={{
            definition:
              "Cantidad de animales con ownerships.role = 'shelter_custody' y ended_at IS NULL a nivel nacional.",
            formula: "COUNT(ownerships) WHERE role='shelter_custody' AND ended_at IS NULL",
          }}
          descriptorId="shelter_custody_occupied"
        />
        <OpKpi
          label={KPI_CATALOG.foster_active_placements.label}
          value={fosterPool.activeFosterPlacements.toLocaleString("es-AR")}
          sub="colocaciones en tránsito activas"
          info={{
            definition: "Cantidad de animales con ownerships.role = 'foster' y ended_at IS NULL.",
            formula: "COUNT(ownerships) WHERE role='foster' AND ended_at IS NULL",
          }}
          descriptorId="foster_active_placements"
        />
        <OpKpi
          label={KPI_CATALOG.adoptions_finalized.label}
          value={funnel.adoption.toLocaleString("es-AR")}
          sub="adopciones finalizadas en el período"
          deltaV2={funnel.adoption > 0 ? (adoptionDelta ?? undefined) : undefined}
          sparkline={adoptionTrend.points.length > 0 ? adoptionTrend.points : undefined}
          info={{
            definition: "Eventos adoption_finalized registrados en el período (nacional).",
            formula: "COUNT(pet_events) WHERE event_type='adoption_finalized' AND period",
          }}
          descriptorId="adoptions_finalized"
          guardInput={{ priorBase: prevAdoptionCount }}
        />
        <OpKpi
          label="Tasa de retorno"
          value={
            returnRatePct != null
              ? returnRatePct > 100
                ? `${formatPercent(returnRatePct)}*`
                : formatPercent(returnRatePct)
              : "—"
          }
          sub={
            returnRatePct != null
              ? returnRatePct > 100
                ? "reversos / adopciones (período) · puede superar 100%"
                : "reversos / adopciones (período)"
              : "Sin adopciones en el período"
          }
          tone={
            returnRatePct == null
              ? "neutral"
              : toneForTarget(Math.min(returnRatePct, 100), TARGETS.ADOPTION_RETURN_RATE_PCT, {
                  higherIsBetter: false,
                })
          }
          info={getKpiInfo("custody_return_rate")}
          descriptorId="custody_return_rate"
          guardInput={{ n: funnel.adoption }}
        />
      </section>

      {/* Funnel — intake → foster → adopción → devolución. Renamed from
          "Embudo de colocación" (PO interview 2026-07-23, item 13) — see
          app/gob/adopciones/page.tsx (the twin) for the full rationale. */}
      <OpCard aria-labelledby={panelFunnelId}>
        <OpCardHead title={<span id={panelFunnelId}>Flujo de custodia (no cohorte)</span>} />
        <OpCardBody>
          {!hasFunnel ? (
            <LnEmptyState
              icon="heart"
              title="Sin eventos de custodia en el período"
              description="No hay registros de intake, tránsitos o adopciones en el período seleccionado."
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
                Gráfico de barras horizontales: etapas del pipeline de custodia y adopción. Cada
                barra muestra la proporción respecto al total de ingresos.
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
                      <span className="ml-1 text-ln-op-mute">({formatPercent(returnRatePct)})</span>
                    ) : null}
                  </span>
                </li>
              </ul>
              <p className="mt-2 text-xs text-ln-op-mute">
                Cada etapa es un conteo de eventos independiente del período (no cohorte): una etapa
                posterior puede superar a una anterior. Las barras son proporcionales al conteo de
                cada etapa (relativas a la de mayor volumen). El % de Devoluciones es sobre las
                adopciones del período — misma base que la tasa de retorno.
              </p>
            </figure>
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
              description="No hay registros de custodia o tránsito en el período seleccionado."
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
                          {formatRate(row.medianDays)}
                        </td>
                        <td className="py-2 px-4 text-right tabular-nums">
                          {formatRate(row.p75Days)}
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
                Duración por custodia activa o cerrada en el período. Los registros abiertos usan la
                fecha actual como cierre estimado.
              </p>
            </div>
          )}
        </OpCardBody>
      </OpCard>

      {/* Shelter occupancy national */}
      <OpCard aria-labelledby={panelOccupancyId}>
        <OpCardHead title={<span id={panelOccupancyId}>Ocupación de refugios (nacional)</span>} />
        <OpCardBody>
          {shelterOccupancy.occupied === 0 && shelterOccupancy.capacity == null ? (
            <LnEmptyState
              icon="home"
              title="Sin datos de ocupación"
              description="No hay registros de custodia activa ni capacidad declarada para refugios."
            />
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-4">
                <div className="text-title font-semibold text-ln-op-ink tabular-nums">
                  {shelterOccupancy.occupied.toLocaleString("es-AR")}
                </div>
                <div className="text-md text-ln-op-mute">
                  {shelterOccupancy.capacity != null ? (
                    <>
                      de {shelterOccupancy.capacity.toLocaleString("es-AR")} cupos declarados
                      {shelterOccupancy.pct != null && (
                        <span
                          className={`ml-2 font-semibold ${shelterOccupancy.pct > 90 ? "text-ln-op-danger" : shelterOccupancy.pct > 70 ? "text-ln-op-warn" : "text-ln-op-ok"}`}
                        >
                          ({formatPercent(shelterOccupancy.pct)})
                        </span>
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
                Ocupados: total de animales en custodia activa en refugios. Cupo: capacidad
                declarada por las organizaciones tipo refugio.
              </p>
            </div>
          )}
        </OpCardBody>
      </OpCard>

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
            Voluntarios activos con estado activo en el padrón de tránsitos. Con cupo: voluntarios
            con lugares disponibles. Colocaciones activas: animales en tránsito sin fecha de cierre.
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
              description="No hay adopciones finalizadas en el rango seleccionado."
            />
          ) : (
            <TimeSeriesChartDynamic
              data={adoptionTrend.points}
              seriesLabel={KPI_CATALOG.adoptions_finalized.label}
              yLabel="Adopciones"
              variant="area"
              fallbackTableLabel={`Adopciones por ${adoptionTrend.granularity === "month" ? "mes" : "semana"}`}
            />
          )}
        </OpCardBody>
      </OpCard>

      <DashboardFreshnessFooter ctx={ctx} />
    </div>
  );
}
