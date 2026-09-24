// /admin/censo — Censo poblacional (vista admin universal, Paquete E).
//
// Universal view: no JurisdictionSwitcher, admin sees all pets regardless of province.
// Adds a cross-jurisdiction ranked table on top of the gob/censo panels.
//
// Layout:
//   KPI row      — total registradas · activas · dormant · perfiles incompletos
//   Altas nuevas — TimeSeriesChart (registrationTrend)
//   Embudo       — horizontal bars (identification funnel)
//   Tabla ranked — per-province registry count (<table>)
//   Freshness footer
//
// F8 fusion (2026-07-22): this is the byte-identical body of the former
// /admin/censo page.tsx, relocated so the admin Padrón hub
// (app/admin/padron/page.tsx) can render it as its "Censo" vista. /admin/
// censo itself now only redirects here (see app/admin/censo/page.tsx) —
// this is a RELOCATION, not a redesign: same searchParams contract, same
// auth guard, same query logic. NOT shared with gob's CensoScreen — the
// admin body genuinely diverges (national ranked table, no jurisdiction
// filter or choropleth).

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
import { adminProvinceHref } from "@/lib/infra/admin-province-link";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import {
  DORMANT_MONTHS_DEFAULT,
  SUPPRESSED_CELL_TEXT,
  TARGETS,
  buildProjectionContext,
  funnelPercents,
  identificationFunnel,
  provinceSuppressionNotice,
  registrationTrend,
  registryByProvince,
  registryCounts,
  scopeTotalSuppressionNotice,
  toneForTarget,
} from "@/lib/metrics";
import { KPI_CATALOG } from "@/lib/metrics/kpi-catalog";
import { windows } from "@/lib/metrics/period";
import { describeNarrowedView } from "@/lib/ui/view-scope-caption";
import { formatPercent, speciesOptions } from "@/lib/utils/format";

/**
 * A cell whose value the D.10 disclosure rule withheld. An em dash for sighted
 * users, the full reason for assistive tech and on hover — never a 0 (a false
 * zero asserts) and never blank (blank reads as "no aplica"). Local to this
 * screen so the twin at /admin/poblacion can diverge in layout without a shared
 * component pretending they are the same widget.
 */
function SuppressedCellText() {
  return (
    <span className="text-ln-op-mute" title={SUPPRESSED_CELL_TEXT}>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{SUPPRESSED_CELL_TEXT}</span>
    </span>
  );
}

// Species domain axis — mirrors /gob/censo's SPECIES_OPTIONS exactly (twin
// port, Fase B "regalos olvidados"). pets.species is free text ('dog' | 'cat'
// | 'other' in practice); "other" is the exact stored value the fetchers
// honor as-is (no query change).
// Valores: decisión de esta pantalla. Ortografía: speciesLabel, fuente única.
const SPECIES_OPTIONS = speciesOptions(["dog", "cat", "other"]);

export type AdminCensoScreenProps = {
  searchParams: { period?: string; from?: string; to?: string; species?: string };
  /**
   * True when rendered as the admin Padrón hub's "Censo" tab
   * (app/admin/padron/page.tsx) — see components/ui/dashboard/ScreenHeader.tsx.
   */
  underHub?: boolean;
};

export async function AdminCensoScreen({
  searchParams: sp,
  underHub = false,
}: AdminCensoScreenProps) {
  await requireAdminOrRedirect();

  // Admin context: global scope (no jurisdiction restriction), trailing 12m window.
  // PeriodPicker allows customisation but the default is always trailing 12m.
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
      eyebrow="Admin · Censo nacional"
      title="Censo y salud del registro"
      subtitle={
        <>
          <p className="text-md text-ln-op-mute">
            Vista nacional: total del padrón, mascotas inactivas, calidad de identificación y
            ranking por provincia.
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

  // D2: bound the fetcher set with a deadline so a pathological query degrades
  // to an honest "tardando… reintentar" state instead of hanging the page.
  // species narrows all four sub-queries identically (twin of /gob/censo's
  // domain-axes work) so the KPI row, trend, funnel, and choropleth stay
  // internally consistent.
  const load = await loadWithTimeout(
    Promise.all([
      registryCounts(ctx, DORMANT_MONTHS_DEFAULT, { species }),
      registrationTrend(ctx, { species }),
      identificationFunnel(ctx, { species }),
      registryByProvince(ctx, { species }),
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
          retryHref={analyticsRetryHref("/admin/padron", { ...sp, vista: "censo" })}
        />
      </div>
    );
  }

  const [counts, trend, funnel, registry] = load.value;

  // D.10: the suppression verdict is made ONCE, inside registryByProvince, and
  // this screen consumes it — it never sees a withheld count, so it cannot
  // publish one and cannot disagree with /gob/censo/export for the same viewer.
  const provinceRows = registry.rows;
  const provinceNotice = provinceSuppressionNotice(registry.suppressedCount);

  // Same single verdict as /gob/censo (RA-3 finding C1). This screen has no
  // province drill, so it only trips when the WHOLE national grouping is one
  // withheld province — a sparse pilot where "Total registradas" would be that
  // province's protected count with a national label on it.
  const scopeNotice = scopeTotalSuppressionNotice(registry.scopeTotalPublishable);
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

  const hasData = counts.total > 0;
  const hasTrend = trend.points.length > 0;

  const dormantPct = counts.total > 0 ? Math.round((counts.dormant / counts.total) * 100) : 0;
  const incompletePct = counts.total > 0 ? Math.round((counts.incomplete / counts.total) * 100) : 0;
  const chipPct = funnel.total > 0 ? Math.round((funnel.chipped / funnel.total) * 100) : 0;

  const fPct = funnelPercents(funnel);

  const panelTrendId = "admin-panel-altas-titulo";
  const panelFunnelId = "admin-panel-embudo-titulo";
  const panelTableId = "admin-panel-tabla-titulo";

  return (
    <div className="space-y-6">
      {/* Page header */}
      {header}

      {/* Unified filter bar — period + species (no jurisdiction for admin —
          universal scope). Twin of /gob/censo's rail. */}
      {filtersRow}

      {/* KPI row */}
      <section
        aria-label="Indicadores del censo nacional"
        className="grid grid-cols-2 md:grid-cols-4 gap-3"
      >
        <OpKpi
          label="Total registradas"
          value={hasData ? counts.total.toLocaleString("es-AR") : "—"}
          sub={hasData ? "mascotas activas o extraviadas (nacional)" : "Sin datos"}
          tone={!hasData ? "neutral" : undefined}
          info={{
            definition:
              "Total de mascotas con status 'active' o 'lost' a nivel nacional (alcance global admin).",
            formula: "COUNT(pets) WHERE status IN ('active','lost')",
          }}
          descriptorId="registry_total_pets"
        />
        <OpKpi
          label="Activas"
          value={hasData ? counts.active.toLocaleString("es-AR") : "—"}
          sub={hasData ? "con status activo (excluye extraviadas)" : undefined}
          tone={!hasData ? "neutral" : undefined}
          info={{
            definition: "Mascotas con status='active' a nivel nacional.",
            formula: "COUNT(pets) WHERE status = 'active'",
          }}
          descriptorId="registry_active_pets"
        />
        <OpKpi
          label="Inactivas"
          value={hasData ? counts.dormant.toLocaleString("es-AR") : "—"}
          sub={`sin actividad >${TARGETS.DORMANT_MONTHS}m · ${dormantPct}% del total`}
          tone={
            hasData && dormantPct > 40 ? "danger" : hasData && dormantPct > 20 ? "warn" : undefined
          }
          info={{
            definition: `Mascotas activas/extraviadas sin ningún evento del propietario en los últimos ${TARGETS.DORMANT_MONTHS} meses. Mascotas sin ningún evento registrado también cuentan como inactivas.`,
            formula: `NOT EXISTS (pet_events WHERE event_type <> 'credential_scanned' AND occurred_at >= now - ${TARGETS.DORMANT_MONTHS}m)`,
            caveat:
              "Los eventos credential_scanned se excluyen porque se purgan automáticamente a los 90 días y no representan actividad del propietario.",
          }}
          descriptorId="registry_dormant_pets"
          guardInput={{ n: counts.total }}
        />
        <OpKpi
          label={KPI_CATALOG.registry_incomplete_profiles.label}
          value={hasData ? counts.incomplete.toLocaleString("es-AR") : "—"}
          sub={`${incompletePct}% del total · sin chip, sexo o localidad`}
          tone={
            hasData && incompletePct > 30
              ? "danger"
              : hasData && incompletePct > 15
                ? "warn"
                : undefined
          }
          info={{
            definition:
              "Mascotas activas/extraviadas sin chip ISO activo, sexo desconocido, o sin localidad de jurisdicción.",
            formula:
              "NOT EXISTS active microchip_iso OR sex = 'unknown' OR jurisdiction_locality IS NULL",
          }}
          descriptorId="registry_incomplete_profiles"
          guardInput={{ n: counts.total }}
        />
      </section>

      {/* Altas nuevas — registration trend */}
      <OpCard aria-labelledby={panelTrendId}>
        <OpCardHead
          title={<span id={panelTrendId}>Altas nuevas</span>}
          actions={
            trend.suppressedCount > 0 ? (
              <span className="text-sm font-normal text-ln-op-mute">
                {trend.suppressedCount}{" "}
                {trend.suppressedCount === 1 ? "período oculto" : "períodos ocultos"} (privacidad)
              </span>
            ) : null
          }
        />
        <OpCardBody>
          {!hasTrend ? (
            <LnEmptyState
              icon="chart-line"
              title="Sin altas en el período"
              description="No hay mascotas registradas en el rango seleccionado."
            />
          ) : (
            <TimeSeriesChartDynamic
              data={trend.points}
              seriesLabel="Altas nuevas"
              yLabel="Mascotas registradas"
              variant="area"
              fallbackTableLabel={`Altas nuevas por ${trend.granularity === "month" ? "mes" : "semana"}`}
            />
          )}
        </OpCardBody>
      </OpCard>

      {/* Embudo de identificación */}
      <OpCard aria-labelledby={panelFunnelId}>
        <OpCardHead title={<span id={panelFunnelId}>Embudo de identificación</span>} />
        <OpCardBody>
          {funnel.total === 0 ? (
            <LnEmptyState
              icon="heart"
              title="Sin datos de identificación"
              description="No hay mascotas en el registro nacional."
            />
          ) : (
            // Q2: role="img" flattens the whole subtree to a single opaque
            // image for assistive tech — the figcaption AND every stage
            // <li>'s aria-label below were unreachable while it sat here.
            // Same fix already shipped for StaticFirstMap's static-map role.
            <figure
              aria-label={`Embudo de identificación — ${funnel.total.toLocaleString("es-AR")} mascotas en total.`}
            >
              <figcaption className="sr-only">
                Gráfico de barras horizontales: etapas del embudo de identificación de mascotas a
                nivel nacional.
              </figcaption>
              <ul className="space-y-2" aria-label="Etapas del embudo de identificación">
                <li
                  className="flex items-center gap-3"
                  aria-label={`Total: ${funnel.total.toLocaleString("es-AR")} mascotas (100%)`}
                >
                  <span className="w-44 shrink-0 text-md text-ln-op-ink">Total registradas</span>
                  <div
                    className="flex-1 h-4 rounded bg-ln-op-stripe overflow-hidden"
                    aria-hidden="true"
                  >
                    <div className="h-full rounded bg-ln-op-azul" style={{ width: "100%" }} />
                  </div>
                  <span
                    className="w-20 shrink-0 text-right text-md tabular-nums text-ln-op-ink"
                    aria-hidden="true"
                  >
                    {funnel.total.toLocaleString("es-AR")} (100%)
                  </span>
                </li>

                {(() => {
                  const pct = fPct.chipped;
                  const tone = toneForTarget(chipPct, TARGETS.MICROCHIP_PENETRATION_PCT);
                  const barColor =
                    tone === "ok"
                      ? "bg-ln-op-ok"
                      : tone === "warn"
                        ? "bg-ln-op-warn"
                        : "bg-ln-op-danger";
                  return (
                    <li
                      className="flex items-center gap-3"
                      aria-label={`Con chip: ${funnel.chipped.toLocaleString("es-AR")} mascotas (${formatPercent(pct)})`}
                    >
                      <span className="w-44 shrink-0 text-md text-ln-op-ink">
                        Con chip ISO activo
                      </span>
                      <div
                        className="flex-1 h-4 rounded bg-ln-op-stripe overflow-hidden"
                        aria-hidden="true"
                      >
                        <div
                          className={`h-full rounded ${barColor}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span
                        className="w-20 shrink-0 text-right text-md tabular-nums text-ln-op-ink"
                        aria-hidden="true"
                      >
                        {funnel.chipped.toLocaleString("es-AR")} ({formatPercent(pct)})
                      </span>
                    </li>
                  );
                })()}

                {(() => {
                  const pct = fPct.isoValid;
                  return (
                    <li
                      className="flex items-center gap-3"
                      aria-label={`ISO válido: ${funnel.isoValid.toLocaleString("es-AR")} mascotas (${formatPercent(pct)})`}
                    >
                      <span className="w-44 shrink-0 text-md text-ln-op-ink">
                        ISO 11784/11785 válido
                      </span>
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
                        className="w-20 shrink-0 text-right text-md tabular-nums text-ln-op-ink"
                        aria-hidden="true"
                      >
                        {funnel.isoValid.toLocaleString("es-AR")} ({formatPercent(pct)})
                      </span>
                    </li>
                  );
                })()}

                {(() => {
                  const pct = fPct.scanned;
                  return (
                    <li
                      className="flex items-center gap-3"
                      aria-label={`Escaneada en el período: ${funnel.scanned.toLocaleString("es-AR")} mascotas (${formatPercent(pct)})`}
                    >
                      <span className="w-44 shrink-0 text-md text-ln-op-ink">
                        Escaneada en el período
                        <span className="sr-only"> (eventos de los últimos 90 días solamente)</span>
                      </span>
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
                        className="w-20 shrink-0 text-right text-md tabular-nums text-ln-op-ink"
                        aria-hidden="true"
                      >
                        {funnel.scanned.toLocaleString("es-AR")} ({formatPercent(pct)})
                      </span>
                    </li>
                  );
                })()}
              </ul>
              <p className="mt-2 text-xs text-ln-op-mute">
                Meta chip: {TARGETS.MICROCHIP_PENETRATION_PCT}% · Escaneada en el período: solo
                últimos 90 días (los eventos se purgan automáticamente).
              </p>
            </figure>
          )}
        </OpCardBody>
      </OpCard>

      {/* Cross-jurisdiction ranked table */}
      <OpCard aria-labelledby={panelTableId}>
        <OpCardHead title={<span id={panelTableId}>Ranking por provincia</span>} />
        <OpCardBody>
          {provinceRows.length === 0 ? (
            <p className="text-md text-ln-op-mute">Sin datos provinciales disponibles.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-md text-ln-op-ink border-collapse">
                <caption className="sr-only">
                  Ranking de mascotas registradas por provincia, ordenado de mayor a menor.
                </caption>
                <thead>
                  <tr className="border-b border-ln-op-line">
                    <th scope="col" className="text-left py-2 pr-4 font-semibold text-ln-op-mute">
                      Provincia
                    </th>
                    <th scope="col" className="text-right py-2 font-semibold text-ln-op-mute">
                      Registradas
                    </th>
                    <th scope="col" className="text-right py-2 pl-4 font-semibold text-ln-op-mute">
                      % del total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {provinceRows.map((row, i) => {
                    // A withheld cell has NO share either — publishing a share
                    // over a published national total is the same disclosure
                    // wearing a percent sign.
                    const sharePct =
                      row.suppressed || counts.total === 0
                        ? null
                        : Math.round((row.count / counts.total) * 1000) / 10;
                    const drillHref = adminProvinceHref(row.province);
                    return (
                      <tr
                        key={row.province}
                        className={[
                          "border-b border-ln-op-line last:border-0",
                          // Only signal interactivity when the row actually links
                          // out — an unresolvable province is not clickable (C4).
                          drillHref ? "hover:bg-ln-op-stripe/50 transition-colors" : "",
                        ].join(" ")}
                      >
                        <td className="py-2 pr-4">
                          <span className="text-sm tabular-nums text-ln-op-mute mr-2">
                            {i + 1}.
                          </span>
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
                        <td className="py-2 text-right tabular-nums">
                          {row.suppressed ? (
                            <SuppressedCellText />
                          ) : (
                            row.count.toLocaleString("es-AR")
                          )}
                        </td>
                        <td className="py-2 pl-4 text-right tabular-nums text-ln-op-mute">
                          {sharePct === null ? <SuppressedCellText /> : `${sharePct}%`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {provinceNotice && <p className="mt-2 text-xs text-ln-op-mute">{provinceNotice}</p>}
              {(() => {
                // registry.assignedTotal is the sum over ALL provinces, withheld
                // ones included — recomputing it from the visible rows would both
                // overstate the residual AND turn this footnote into the
                // subtraction channel that recovers a hidden cell. It is null
                // exactly when publishing it would isolate one; then we say
                // nothing rather than say something recoverable.
                const assignedTotal = registry.assignedTotal;
                if (assignedTotal === null) return null;
                const unassigned = counts.total - assignedTotal;
                const unassignedPct =
                  counts.total > 0 ? Math.round((unassigned / counts.total) * 1000) / 10 : 0;
                if (unassigned <= 0) return null;
                return (
                  <p className="mt-2 text-xs text-ln-op-mute">
                    * {unassignedPct}% sin provincia asignada ({unassigned.toLocaleString("es-AR")}{" "}
                    mascotas) no aparece en la tabla — los porcentajes no suman 100%.
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
