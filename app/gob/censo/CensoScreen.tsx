// /gob/censo — Censo poblacional & salud del registro (Paquete E).
//
// Jurisdiction-scoped, period-aware gobierno screen answering:
// "¿Crece y está sano el registro de mascotas?"
//
// Layout (Op* design system):
//   KPI row      — total registradas · activas · dormant · perfiles incompletos
//   Altas nuevas — TimeSeriesChart (registrationTrend, pets.created_at)
//   Embudo       — horizontal bars in OpCard (mortalidad "Disposición" pattern)
//   Coropleta    — MapChoroplethDynamic (registryByProvince)
//   Freshness footer
//
// F8 fusion (2026-07-22): this is the byte-identical body of the former
// /gob/censo page.tsx, relocated so the Padrón hub (app/gob/padron/page.tsx)
// can render it as its "Censo" vista. /gob/censo itself now only redirects
// here via the hub (see app/gob/censo/page.tsx) — this is a RELOCATION, not
// a redesign: same searchParams contract, same auth guard, same query logic.
// The exportHref still targets /gob/censo/export — that API route is
// UNCHANGED.

import { MapChoroplethDynamic } from "@/components/charts/MapChoroplethDynamic";
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
import { toChoroplethData } from "@/lib/analytics/choropleth-data";
import { resolveJurisdictionScope } from "@/lib/analytics/jurisdiction-scope";
import {
  JURISDICTION_ADJUSTED_TARGET_NOTE,
  resolveJurisdictionTargetsForScope,
} from "@/lib/analytics/jurisdiction-targets";
import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import { requireGobReadAccessOrRedirect } from "@/lib/infra/auth-guards";
import {
  DORMANT_MONTHS_DEFAULT,
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
import { resolveAnalyticsPeriod } from "@/lib/metrics/period";
import { GOB_MAP_HEIGHT } from "@/lib/ui/map-bounds";
import { describeNarrowedView } from "@/lib/ui/view-scope-caption";
import { formatPercent, speciesOptions } from "@/lib/utils/format";

// Species domain axis — mirrors /gob/perdidas' SPECIES_OPTIONS exactly.
// pets.species is free text ('dog' | 'cat' | 'other' in practice); "other" is
// the exact stored value the fetchers honor as-is (no query change).
// Valores: decisión de esta pantalla. Ortografía: speciesLabel, fuente única.
const SPECIES_OPTIONS = speciesOptions(["dog", "cat", "other"]);

export type CensoScreenProps = {
  searchParams: {
    period?: string;
    from?: string;
    to?: string;
    province?: string;
    locality?: string;
    species?: string;
  };
  /**
   * True when rendered as the Padrón hub's "Censo" tab (app/gob/padron/page.tsx)
   * — the hub's own h1 + the active tab already name this screen, so its own
   * eyebrow+h1 are suppressed (ScreenHeader keeps only the subtitle, which adds
   * scope info the tab label doesn't carry). See components/ui/dashboard/ScreenHeader.tsx.
   */
  underHub?: boolean;
};

export async function CensoScreen({ searchParams: sp, underHub = false }: CensoScreenProps) {
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
          description="Tu rol no tiene acceso al censo. Pedile al admin que te asigne capabilities."
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
  const exportHref = `/gob/censo/export${exportParams.size > 0 ? `?${exportParams}` : ""}`;

  const {
    selectedProvince,
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

  // ADR-8 (jurisdiction-compliance WU4b): jurisdiction-resolved microchip
  // target for the identification funnel's chip stage. Fail-safe (flat TARGETS
  // on any read failure) AND bounded inside the module by
  // JURISDICTION_TARGETS_TIMEOUT_MS (T6 review M1 — this await precedes the
  // page's loadWithTimeout group, so it needs its own deadline); admin
  // national/cross-province views stay flat (JT5); an adjusted meta is
  // disclosed in the funnel footnote (JT4).
  const jurisdictionTargets = await resolveJurisdictionTargetsForScope(
    hasNationalReadScope(profile.role)
      ? adminProvince
        ? [{ province: adminProvince, locality: adminLocality ?? "" }]
        : []
      : filteredJurisdictions,
  );
  const chipTargetPct = jurisdictionTargets.values.MICROCHIP_PENETRATION_PCT;
  const chipTargetAdjusted = jurisdictionTargets.adjusted.MICROCHIP_PENETRATION_PCT;

  // Header + filters render in both the data and degraded (timeout) branches.
  const header = (
    <ScreenHeader
      underHub={underHub}
      className="space-y-2"
      eyebrow="Registro · Censo poblacional"
      title="Censo y salud del registro"
      subtitle={
        <>
          {/* The universal claim yields to the narrowed-view caption (never both). */}
          {hasNationalReadScope(profile.role) ? (
            narrowedView ? null : (
              <p className="text-md text-ln-op-mute">Vista universal — todas las jurisdicciones.</p>
            )
          ) : (
            <p className="text-md text-ln-op-mute">
              Crecimiento del padrón, mascotas inactivas y calidad de identificación en tu
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
  // "reintentar" state instead of an unbounded hang (parity with /admin/censo).
  // species narrows all four sub-queries identically so the KPI row, trend,
  // funnel, and choropleth stay internally consistent (domain-axes work).
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
          retryHref={analyticsRetryHref("/gob/padron", { ...sp, vista: "censo" })}
        />
      </div>
    );
  }

  const [counts, trend, funnel, registry] = load.value;

  // D.10: the verdict was made ONCE inside registryByProvince. This screen and
  // /gob/censo/export both read those already-decided rows, which is what makes
  // the CSV incapable of publishing a cell the map hatches.
  const provinceRows = registry.rows;
  const provinceNotice = provinceSuppressionNotice(registry.suppressedCount);

  // THE HEADLINE OBEYS THE SAME VERDICT AS THE ROWS (RA-3 finding C1). With
  // `?province=AR-V` the scope narrows to ONE province, so every scope aggregate
  // on this page — the KPI row, the funnel's "Total registradas", the trend — is
  // that province's cell under another label, and the map beside them hatches
  // it. There is no second decision here: `registryByProvince` handed down
  // `scopeTotalPublishable` from the same `planProvinceDisclosure` call that
  // decided the rows, which is why /gob/censo/export cannot publish what this
  // screen withholds.
  const scopeNotice = scopeTotalSuppressionNotice(registry.scopeTotalPublishable);
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

  const hasData = counts.total > 0;
  const hasTrend = trend.points.length > 0;

  const dormantPct = counts.total > 0 ? Math.round((counts.dormant / counts.total) * 100) : 0;
  const incompletePct = counts.total > 0 ? Math.round((counts.incomplete / counts.total) * 100) : 0;
  const chipPct = funnel.total > 0 ? Math.round((funnel.chipped / funnel.total) * 100) : 0;

  const fPct = funnelPercents(funnel);

  // task #31c dedup: shared toChoroplethData (same shaping as /gob/poblacion).
  // A withheld cell is EMITTED with the `suppressed` flag MapChoropleth already
  // renders as the hatch + "DATOS INSUFICIENTES" tooltip + the "— (suprimido)"
  // fallback-table row. It is never dropped (absence would stipple it "nadie
  // registró acá", which is false) and its `value` is inert: every code path in
  // MapChoropleth that could paint a number reads the flag first.
  const choroplethData = toChoroplethData(provinceRows, (r) => r.count);

  // Camera lockdown (gob/map-zoom-lockdown, 2026-07-21): censo has no
  // department/barrio subregion drill (unlike perdidas/vigilancia's
  // scopedChoroplethProps) — it stays at province grain. But the jurisdiction
  // filter should still lock the map's viewport to the selected province
  // instead of always showing the national extent: `visibleCodes` is
  // MapChoropleth's existing render-only filter (no data/privacy effect —
  // `choroplethData` itself is unchanged), so passing the single selected
  // province's code narrows the rendered GeoJSON to that province and its
  // own fitBounds tightens the camera to it.
  const mapScopeProps = selectedProvince ? { visibleCodes: [selectedProvince.code] } : {};

  const maxFunnel = funnel.total;

  const panelTrendId = "panel-altas-titulo";
  const panelFunnelId = "panel-embudo-titulo";
  const panelMapId = "panel-mapa-titulo";

  return (
    <div className="space-y-6">
      {/* Page header */}
      {header}

      {/* Filters row */}
      {filtersRow}

      {/* KPI row */}
      <section aria-label="Indicadores del censo" className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <OpKpi
          label="Total registradas"
          value={hasData ? counts.total.toLocaleString("es-AR") : "—"}
          sub={hasData ? "mascotas activas o extraviadas" : "Sin datos en la cobertura"}
          tone={!hasData ? "neutral" : undefined}
          sparkline={hasTrend ? trend.points : undefined}
          info={{
            definition:
              "Total de mascotas con status 'active' o 'lost' en el scope de jurisdicción.",
            formula: "COUNT(pets) WHERE status IN ('active','lost') AND scope",
          }}
          descriptorId="registry_total_pets"
        />
        <OpKpi
          label="Activas"
          value={hasData ? counts.active.toLocaleString("es-AR") : "—"}
          sub={hasData ? "con status activo (excluye extraviadas)" : undefined}
          tone={!hasData ? "neutral" : undefined}
          info={{
            definition: "Mascotas con status='active' en scope (excluye 'lost').",
            formula: "COUNT(pets) WHERE status = 'active' AND scope",
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
            definition: `Mascotas activas/extraviadas sin ningún evento de actividad del propietario en los últimos ${TARGETS.DORMANT_MONTHS} meses. Mascotas sin ningún evento registrado también cuentan como inactivas.`,
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
              "Mascotas activas/extraviadas que no tienen al menos uno de: chip ISO activo, sexo conocido (≠ 'unknown'), o localidad de jurisdicción.",
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
              description="No hay mascotas registradas en el rango y la cobertura seleccionados."
            />
          ) : (
            <TimeSeriesChartDynamic
              data={trend.points}
              seriesLabel="Altas nuevas"
              yLabel="Mascotas registradas"
              variant="area"
              fallbackTableLabel={`Altas nuevas por ${trend.granularity === "month" ? "mes" : "semana"}`}
              // A fully masked series must say "Datos ocultos por privacidad
              // (k<5)" inside the plot, not fall back to "Sin datos para el
              // período seleccionado" — that copy claims a measured absence.
              suppressedCount={trend.suppressedCount}
            />
          )}
        </OpCardBody>
      </OpCard>

      {/* Embudo de identificación — horizontal bars (mortalidad Disposición pattern) */}
      <OpCard aria-labelledby={panelFunnelId}>
        <OpCardHead title={<span id={panelFunnelId}>Embudo de identificación</span>} />
        <OpCardBody>
          {funnel.total === 0 ? (
            <LnEmptyState
              icon="heart"
              title="Sin datos de identificación"
              description="No hay mascotas en la cobertura seleccionada."
            />
          ) : (
            // Q2: role="img" flattens the whole subtree to a single opaque
            // image for assistive tech — the figcaption AND every stage
            // <li>'s aria-label below were unreachable while it sat here.
            // Same fix already shipped for StaticFirstMap's static-map role.
            <figure aria-label={`Embudo de identificación — ${funnel.total} mascotas en total.`}>
              <figcaption className="sr-only">
                Gráfico de barras horizontales: etapas del embudo de identificación de mascotas.
                Cada barra muestra el porcentaje de mascotas que alcanzan esa etapa del total.
              </figcaption>
              <ul className="space-y-2" aria-label="Etapas del embudo de identificación">
                {/* Stage 1: Total */}
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

                {/* Stage 2: Chipped */}
                {(() => {
                  const pct = fPct.chipped;
                  const tone = toneForTarget(chipPct, chipTargetPct);
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

                {/* Stage 3: ISO válido */}
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

                {/* Stage 4: Escaneada en el período */}
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
                Meta chip: {chipTargetPct}%
                {chipTargetAdjusted ? ` (${JURISDICTION_ADJUSTED_TARGET_NOTE.toLowerCase()})` : ""}{" "}
                · Escaneada en el período: solo últimos 90 días (los eventos se purgan
                automáticamente).
              </p>
            </figure>
          )}
        </OpCardBody>
      </OpCard>

      {/* Coropleta por provincia */}
      {choroplethData.length > 0 && (
        <OpCard aria-labelledby={panelMapId}>
          <OpCardHead title={<span id={panelMapId}>Distribución por provincia</span>} />
          <OpCardBody>
            <MapChoroplethDynamic
              // Camera lockdown (gob/map-zoom-lockdown, 2026-07-21): keying on
              // the resolved scope forces a clean remount whenever the
              // jurisdiction filter changes, so the locked-down viewport
              // always fitBounds to the newly selected area (see
              // mapScopeProps above) instead of silently keeping the old one.
              key={selectedProvince?.code ?? "national"}
              data={choroplethData}
              level="province"
              scaleLabel="Mascotas registradas"
              caption="Conteos absolutos por jurisdicción — no es una tasa poblacional."
              fallbackTableLabel="Mascotas registradas por provincia"
              height={GOB_MAP_HEIGHT}
              {...mapScopeProps}
            />
            {/* Rule 7 / #40 follow-up: wherever we suppress, the surface SAYS SO.
                The map's own legend carries a permanent "datos insuficientes"
                swatch, which cannot tell the operator whether THIS frame hides
                anything — this line can, and renders only when it does. */}
            {provinceNotice && <p className="mt-2 text-xs text-ln-op-mute">{provinceNotice}</p>}
          </OpCardBody>
        </OpCard>
      )}

      <DashboardFreshnessFooter ctx={ctx} />
    </div>
  );
}
