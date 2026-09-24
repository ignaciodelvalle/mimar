// CampanasScreen — campaign performance dashboard for sanitary authority operators.
//
// F2 fusion (2026-07-22): this is the byte-identical body of the former
// /gob/campanas page.tsx, relocated so the Operativos hub (app/gob/operativos/
// page.tsx) can render it as its "Campañas" tab under ?vista=campanas.
// /gob/campanas itself now only redirects here via the hub (see
// app/gob/campanas/page.tsx) — this is a RELOCATION, not a redesign: same
// searchParams contract, same auth guard, same query logic.
//
// Route is ASCII ("campanas", not "campañas"): a non-ASCII App Router segment is
// served percent-encoded (/gob/campa%C3%B1as), which breaks usePathname-based
// active-nav matchPrefix and is a credibility smell in a government URL bar.
//
// Surfaces: enrollment (bookings), completion (attended), no-show, and
// geographic reach per health-campaign offering in the operator's jurisdiction.
//
// Data: pure projection over existing appointments + service_offerings — NO schema changes.
// Consumes Item 23 primitives: OpKpi v2, MapChoropleth v2, JurisdictionSwitcher, PeriodPicker.
// Builds on lib/metrics/ (ProjectionContext, buildProjectionContext).

import { Icon } from "@/components/Icon";
import { LnEmptyState } from "@/components/ui/EmptyState";
import {
  OpCard,
  OpCardBody,
  OpCardHead,
  type OpFilterAxis,
  OpFilterBar,
  OpKpi,
  OpSortHeader,
  ViewScopeCaption,
} from "@/components/ui/dashboard";
import { AnalyticsLoadFallback } from "@/components/ui/dashboard/AnalyticsLoadFallback";
import { DashboardFreshnessFooter } from "@/components/ui/dashboard/DashboardFreshnessFooter";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { analyticsRetryHref, loadWithTimeout } from "@/lib/analytics/analytics-load";
import { fetchCampaignDashboard, formatDelta } from "@/lib/analytics/campaign-metrics";
import { resolveJurisdictionScope } from "@/lib/analytics/jurisdiction-scope";
import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import { requireGobReadAccessOrRedirect } from "@/lib/infra/auth-guards";
import {
  TARGETS,
  buildProjectionContext,
  resolveAnalyticsPeriod,
  toneForTarget,
  windows,
} from "@/lib/metrics";
import { SERVICE_KINDS, findServiceKind } from "@/lib/reference/service-kinds";
import { parseUrlSort, sortRowsByUrlSort } from "@/lib/ui/url-sort";
import { describeNarrowedView } from "@/lib/ui/view-scope-caption";
import { pluralizeEs } from "@/lib/utils/format";

// Service-kind domain axis — SERVICE_KINDS (lib/reference/service-kinds.ts) is
// the closed catalog serviceOfferings.serviceKind is drawn from; reusing it
// directly needs no new mapping and no new column.
const SERVICE_KIND_OPTIONS = SERVICE_KINDS.map((k) => ({ value: k.code, label: k.label }));

export type CampanasScreenProps = {
  searchParams: {
    period?: string;
    from?: string;
    to?: string;
    province?: string;
    locality?: string;
    kind?: string;
    /** Q4 (URL sort) — Alcance geográfico column sort, see parseUrlSort below. */
    orden?: string;
    dir?: string;
  };
  /**
   * True when rendered as the Operativos hub's "Campañas" tab
   * (app/gob/operativos/page.tsx) — see components/ui/dashboard/ScreenHeader.tsx.
   */
  underHub?: boolean;
};

export async function CampanasScreen({ searchParams: sp, underHub = false }: CampanasScreenProps) {
  const { profile, jurisdictions } = await requireGobReadAccessOrRedirect();
  const actor = { role: profile.role };

  // Capability guard: same as analytics — admin or govt with assignments.
  const hasCampaignsRead =
    hasNationalReadScope(profile.role) || (profile.role === "govt" && jurisdictions.length > 0);

  if (!hasCampaignsRead) {
    return (
      <div className="space-y-6">
        <ScreenHeader
          underHub={underHub}
          eyebrow="miMAR Gobierno · Campañas"
          // English-copy sweep (validacion-A 2026-07-23, item 5 follow-on):
          // "Performance" → "Rendimiento" — es-AR invariant (AGENTS.md #4).
          title="Rendimiento de campañas"
        />
        <LnEmptyState
          icon="lock"
          title="Sin acceso"
          description="Tu rol no tiene acceso a campañas. Pedile al admin que te asigne cobertura jurisdiccional."
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

  // Jurisdiction filter (same pattern as /gob/analytics).
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
  // Validate against the closed SERVICE_KINDS catalog so an invalid URL value
  // never drives the query (same discipline as /gob/perdidas' parseStatusFilter).
  const serviceKind = sp.kind && findServiceKind(sp.kind) ? sp.kind : undefined;
  // Use the VALIDATED value (not raw sp.kind) so an invalid URL value never
  // leaks into the export link either.
  if (serviceKind) exportParams.set("kind", serviceKind);
  const exportHref = `/gob/campanas/export${exportParams.size > 0 ? `?${exportParams}` : ""}`;

  const period = sp.period || sp.from ? resolveAnalyticsPeriod(sp) : windows.trailing30d();

  const ctx = buildProjectionContext(actor, filteredJurisdictions, period, {
    adminProvince,
    adminLocality,
  });
  // Header + filter bar render in BOTH the data and the degraded branch (same
  // shape as app/gob/censo/CensoScreen.tsx). Neither depends on the fan-out
  // below — the bar comes from allowedProvinces/localities, resolved earlier —
  // and the bare fallback was taking away the period, jurisdiction and service
  // axis, i.e. every control that could have narrowed the query that timed out,
  // while "Reintentar" re-issues the identical one.
  const shell = (
    <>
      {/* Page header */}
      <ScreenHeader
        underHub={underHub}
        className="space-y-2"
        eyebrow="Campañas"
        title="Rendimiento de campañas"
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
                Inscripciones, completitud, impacto sanitario y alcance geográfico de las campañas
                sanitarias en tu cobertura.
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
        period={{ defaultPreset: "30d" }}
        jurisdiction={{ allowedProvinces, localities }}
        axes={
          [
            {
              id: "kind",
              label: "Tipo de servicio",
              paramKey: "kind",
              options: SERVICE_KIND_OPTIONS,
              current: serviceKind ?? null,
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

  // serviceKind narrows resolveOfferingIds' offering list, which cascades to
  // every downstream sub-fetch (offerings, outcomes, geo reach, sparkline,
  // prevTotals) — the whole dashboard stays internally consistent.
  // BOUNDED. fetchCampaignDashboard fans out to offerings, outcomes, geo reach,
  // sparkline and prevTotals; it was awaited bare while every analytics screen
  // in this portal (censo, poblacion, programa, analytics) already races the
  // same class of fan-out against a deadline. This screen and AlcanceScreen are
  // the TWO halves of /gob/operativos, so with neither bounded that hub had no
  // net at all: a degraded DB left it loading forever with nothing in the logs.
  const load = await loadWithTimeout(fetchCampaignDashboard(ctx, { serviceKind }));
  if (!load.ok) {
    return (
      <div className="space-y-6">
        {shell}
        <AnalyticsLoadFallback
          reason={load.reason}
          correlationId={load.id}
          retryHref={analyticsRetryHref("/gob/operativos", { ...sp, vista: "campanas" })}
        />
      </div>
    );
  }
  const dashboard = load.value;

  // Q4 (URL sort) — ?orden=&dir= re-sorts the Alcance geográfico rows
  // SERVER-SIDE before render. geoReach is the complete k-anon-suppressed
  // rollup (no pagination; withheld localities are already OUT of `rows` and
  // declared via suppressedCount), so the URL's claimed order covers the
  // whole published set. Default keeps the fetcher's own volume order.
  const geoSort = parseUrlSort(sp, ["localidad", "provincia", "asistencias"] as const, {
    key: "asistencias",
    dir: "desc",
  });
  const geoRows = sortRowsByUrlSort(dashboard.geoReach.rows, geoSort, {
    localidad: (a, b) => a.locality.localeCompare(b.locality, "es"),
    provincia: (a, b) => (a.province ?? "").localeCompare(b.province ?? "", "es"),
    asistencias: (a, b) => a.attendedCount - b.attendedCount,
  });

  // Determine the "period label" string for delta display.
  const periodLabel = "vs período anterior";

  const enrollmentDelta = formatDelta(
    dashboard.totals.enrollment,
    dashboard.prevTotals.enrollment,
    periodLabel,
  );
  const completionDelta = formatDelta(
    dashboard.totals.completion,
    dashboard.prevTotals.completion,
    periodLabel,
  );
  const noShowDelta = formatDelta(
    dashboard.totals.noShow,
    dashboard.prevTotals.noShow,
    periodLabel,
  );

  const hasData = dashboard.offerings.length > 0;

  const panelKpiId = "panel-kpis-campanias";
  const panelOfferingsId = "panel-ofertas-campanias";
  const panelGeoId = "panel-alcance-geografico-campanias";

  return (
    <div className="space-y-6">
      {/* Header + filter bar — hoisted above the load so the degraded branch
          keeps them (see the `shell` definition). */}
      {shell}

      {!hasData ? (
        // Empty state — jurisdiction with no active campaigns.
        <LnEmptyState
          icon="calendar"
          title="No hay campañas en tu cobertura"
          description={
            "Una campaña sanitaria es un servicio de salud animal (vacunación, desparasitación, esterilización) " +
            "que una organización habilitada ofrece de forma masiva en una localidad. " +
            "Cuando haya campañas activas o históricas en tu jurisdicción, vas a ver su performance acá."
          }
        />
      ) : (
        <>
          {/* KPI row */}
          <section aria-labelledby={panelKpiId} className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <span id={panelKpiId} className="sr-only">
              Indicadores de campañas
            </span>

            <OpKpi
              label="Inscripciones"
              value={dashboard.totals.enrollment.toLocaleString("es-AR")}
              tone="blue"
              deltaV2={enrollmentDelta ?? undefined}
              sparkline={dashboard.enrollmentSparkline}
              info={{
                definition: "Total de turnos reservados (confirmados + asistidos + ausentes).",
                formula: "confirmed + attended + no_show",
                caveat: "Turnos cancelados no se cuentan.",
              }}
              // F3+F7 fusion (2026-07-22): /gob/servicios is now the
              // Directorio hub's "Servicios" tab — drill straight there
              // instead of through the old /gob/servicios redirect.
              drillHref="/gob/directorio?registro=servicios"
              descriptorId="campaign_enrollment"
              guardInput={{ priorBase: dashboard.prevTotals.enrollment }}
            />

            <OpKpi
              label="Completitud"
              value={
                dashboard.totals.completionRate !== null
                  ? `${dashboard.totals.completionRate}%`
                  : "—"
              }
              tone={
                dashboard.totals.completionRate !== null
                  ? toneForTarget(dashboard.totals.completionRate, TARGETS.CAMPAIGN_COMPLETION_PCT)
                  : "neutral"
              }
              bar={dashboard.totals.completionRate ?? undefined}
              // No delta chip: the value is a RATE (%), but the only previous-period
              // signal available is a volume (count) delta — showing "+100%" next to a
              // flat 72% rate would imply the rate jumped when it didn't (C2 break).
              info={{
                definition: `Porcentaje de turnos que resultaron en asistencia efectiva. Meta: ${TARGETS.CAMPAIGN_COMPLETION_PCT}%.`,
                formula: "attended / enrollment × 100",
              }}
              descriptorId="campaign_completion_rate"
              guardInput={{ n: dashboard.totals.enrollment }}
            />

            <OpKpi
              label="Asistencias"
              value={dashboard.totals.completion.toLocaleString("es-AR")}
              tone="ok"
              deltaV2={completionDelta ?? undefined}
              info={{
                definition: "Cantidad de turnos donde el animal fue efectivamente atendido.",
              }}
              descriptorId="campaign_attendance"
              guardInput={{ priorBase: dashboard.prevTotals.completion }}
            />

            <OpKpi
              label="Ausencias"
              value={dashboard.totals.noShow.toLocaleString("es-AR")}
              tone={dashboard.totals.noShow > 0 ? "warn" : "neutral"}
              deltaV2={
                // Bad-when-up: rising absenteeism must never scan green.
                noShowDelta ? { ...noShowDelta, valence: "goodWhenDown" as const } : undefined
              }
              info={{
                definition: "Turnos donde el animal no se presentó (no-show).",
                caveat: "Las ausencias pueden indicar barreras de acceso — considerar recontacto.",
              }}
              descriptorId="campaign_no_show"
              guardInput={{ priorBase: dashboard.prevTotals.noShow }}
            />

            {/* Sanitary OUTCOME — projected over the pet_events spine, not logistics.
                Exact per-appointment attribution via appointments.outcome_event_id. */}
            <OpKpi
              label="Impacto sanitario"
              value={dashboard.totals.sanitaryOutcome.toLocaleString("es-AR")}
              tone="ok"
              info={{
                definition:
                  "Prestaciones sanitarias efectivamente registradas como evento inmutable (vacuna aplicada, castración realizada, desparasitación) a partir de turnos asistidos de la campaña. Es el RESULTADO, no la logística.",
                formula:
                  "eventos sanitarios (vaccination/sterilization/deworming) vinculados a turnos asistidos",
                caveat:
                  dashboard.totals.outcomeConversionRate !== null
                    ? `Conversión asistencia → prestación: ${dashboard.totals.outcomeConversionRate}%. Por debajo de 100% indica turnos asistidos sin registro sanitario inmutable.`
                    : "Atribución exacta por turno (outcome_event_id), no un proxy por ventana temporal.",
              }}
              descriptorId="campaign_sanitary_outcome"
            />
          </section>

          {/* Per-offering table */}
          <OpCard aria-labelledby={panelOfferingsId}>
            <OpCardHead
              title={
                <span id={panelOfferingsId}>
                  Performance por servicio
                  <span className="ml-2 text-sm font-normal text-ln-op-mute">
                    ({dashboard.offerings.length}{" "}
                    {pluralizeEs(dashboard.offerings.length, "servicio")})
                  </span>
                </span>
              }
            />
            <OpCardBody>
              <ul className="space-y-2">
                {dashboard.offerings.map((offering) => {
                  const kindLabel =
                    findServiceKind(offering.serviceKind)?.label ?? offering.serviceKind;
                  const location = [offering.jurisdictionLocality, offering.jurisdictionProvince]
                    .filter(Boolean)
                    .join(", ");

                  return (
                    <li
                      key={offering.offeringId}
                      className="flex flex-col gap-1 rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-[12px_14px]"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-md font-medium text-ln-op-ink">
                            {offering.displayName}
                          </p>
                          <p className="text-sm text-ln-op-mute">
                            {kindLabel}
                            {location ? ` · ${location}` : ""}
                          </p>
                        </div>
                        <a
                          href={`/gob/servicios/${offering.offeringToken}`}
                          className="shrink-0 text-sm text-ln-op-azul hover:underline"
                        >
                          Ver servicio →
                        </a>
                      </div>

                      {/* Metrics row */}
                      <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                        {/* Enrollment */}
                        <div className="rounded-[var(--radius-sm)] bg-ln-op-stripe px-2 py-1.5">
                          <p className="text-lg font-semibold font-ln-serif text-ln-op-ink leading-none">
                            {offering.enrollment}
                          </p>
                          <p className="text-xs font-bold uppercase tracking-[0.1em] text-ln-op-mute mt-0.5">
                            Inscripciones
                          </p>
                        </div>

                        {/* Completion */}
                        <div className="rounded-[var(--radius-sm)] bg-ln-op-stripe px-2 py-1.5">
                          <p
                            className={[
                              "text-lg font-semibold font-ln-serif leading-none",
                              offering.completionRate !== null &&
                              offering.completionRate >= TARGETS.CAMPAIGN_COMPLETION_PCT
                                ? "text-ln-op-ok"
                                : offering.completionRate !== null &&
                                    offering.completionRate >= TARGETS.CAMPAIGN_COMPLETION_PCT * 0.6
                                  ? "text-ln-op-warn"
                                  : offering.completionRate !== null
                                    ? "text-ln-op-danger"
                                    : "text-ln-op-ink",
                            ].join(" ")}
                          >
                            {offering.completionRate !== null ? `${offering.completionRate}%` : "—"}
                          </p>
                          <p className="text-xs font-bold uppercase tracking-[0.1em] text-ln-op-mute mt-0.5">
                            Completitud
                          </p>
                          {/* Icon + text a11y (Item 11 pattern: no color-only) */}
                          {offering.completionRate !== null &&
                            offering.completionRate < TARGETS.CAMPAIGN_COMPLETION_PCT * 0.6 && (
                              <p className="text-xs text-ln-op-danger mt-0.5 flex items-center justify-center gap-0.5">
                                <span aria-hidden="true">↓</span>
                                <span>Baja</span>
                              </p>
                            )}
                        </div>

                        {/* No-show */}
                        <div className="rounded-[var(--radius-sm)] bg-ln-op-stripe px-2 py-1.5">
                          <p
                            className={[
                              "text-lg font-semibold font-ln-serif leading-none",
                              offering.noShow > 0 ? "text-ln-op-warn" : "text-ln-op-ink",
                            ].join(" ")}
                          >
                            {offering.noShow}
                          </p>
                          <p className="text-xs font-bold uppercase tracking-[0.1em] text-ln-op-mute mt-0.5">
                            Ausencias
                          </p>
                          {offering.noShow > 0 && (
                            <p className="text-xs text-ln-op-warn mt-0.5 flex items-center justify-center gap-0.5">
                              <Icon name="alerta" size={12} decorative />
                              <span>Ausente</span>
                            </p>
                          )}
                        </div>

                        {/* Sanitary outcome — real prestaciones from the event spine */}
                        <div className="rounded-[var(--radius-sm)] bg-ln-op-stripe px-2 py-1.5">
                          <p className="text-lg font-semibold font-ln-serif text-ln-op-ok leading-none">
                            {offering.sanitaryOutcome}
                          </p>
                          <p className="text-xs font-bold uppercase tracking-[0.1em] text-ln-op-mute mt-0.5">
                            Prestaciones
                          </p>
                          {offering.outcomeConversionRate !== null && (
                            <p className="text-xs text-ln-op-mute mt-0.5">
                              {offering.outcomeConversionRate}% conv.
                            </p>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </OpCardBody>
          </OpCard>

          {/* Geographic reach — locality-level table. A province choropleth
              previously sat above this table, but it only re-aggregated the
              same geoReach rows to province granularity (strictly less
              detail than the table below) — demoted per PO review. */}
          {dashboard.geoReach.rows.length > 0 && (
            <OpCard aria-labelledby={panelGeoId}>
              <OpCardHead
                title={
                  <span id={panelGeoId}>
                    Alcance geográfico
                    <span className="ml-2 text-sm font-normal text-ln-op-mute">
                      localidades con asistencias
                    </span>
                  </span>
                }
                actions={
                  dashboard.geoReach.suppressedCount > 0 ? (
                    <span className="text-sm font-normal text-ln-op-mute">
                      {dashboard.geoReach.suppressedCount}{" "}
                      {dashboard.geoReach.suppressedCount === 1
                        ? "localidad oculta"
                        : "localidades ocultas"}{" "}
                      (privacidad · k-anonimato)
                    </span>
                  ) : null
                }
              />
              <OpCardBody>
                <table className="w-full text-sm border-collapse">
                  <caption className="sr-only">
                    Asistencias por localidad en campañas sanitarias (ordenable por columna)
                  </caption>
                  <thead>
                    {/* Q4 (URL sort) — OpSortHeader cells; the rows below are
                        `geoRows`, re-sorted server-side from the same params. */}
                    <tr className="border-b border-ln-op-line">
                      <OpSortHeader
                        sortKey="localidad"
                        label="Localidad"
                        defaultDir="asc"
                        current={geoSort}
                        className="py-1 text-left font-semibold text-ln-op-mute"
                      />
                      <OpSortHeader
                        sortKey="provincia"
                        label="Provincia"
                        defaultDir="asc"
                        current={geoSort}
                        className="py-1 text-left font-semibold text-ln-op-mute"
                      />
                      <OpSortHeader
                        sortKey="asistencias"
                        label="Asistencias"
                        current={geoSort}
                        className="py-1 text-right font-semibold text-ln-op-mute"
                      />
                    </tr>
                  </thead>
                  <tbody>
                    {geoRows.map((r) => (
                      <tr
                        key={`${r.province ?? "?"}·${r.locality}`}
                        className="border-b border-ln-op-line/50"
                      >
                        <td className="py-1 text-ln-op-ink">{r.locality}</td>
                        <td className="py-1 text-ln-op-mute">{r.province ?? "—"}</td>
                        <td className="py-1 text-right tabular-nums text-ln-op-ink">
                          {r.attendedCount}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </OpCardBody>
            </OpCard>
          )}
        </>
      )}

      <DashboardFreshnessFooter ctx={ctx} />
    </div>
  );
}
