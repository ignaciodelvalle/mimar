import Link from "next/link";
import { type ReactNode, Suspense } from "react";

import { MapChoroplethDynamic } from "@/components/charts/MapChoroplethDynamic";
import { LnEmptyState } from "@/components/ui/EmptyState";
import { type UrlTabItem, UrlTabs, UrlTabsContent } from "@/components/ui/UrlTabs";
import {
  CsvExportLink,
  OpCard,
  OpCardBody,
  OpCardHead,
  type OpFilterAxis,
  OpFilterBar,
  OpKpi,
  SearchFilterField,
  ViewScopeCaption,
} from "@/components/ui/dashboard";
import { AnalyticsLoadFallback } from "@/components/ui/dashboard/AnalyticsLoadFallback";
import { DashboardFreshnessFooter } from "@/components/ui/dashboard/DashboardFreshnessFooter";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { analyticsRetryHref, loadWithTimeout } from "@/lib/analytics/analytics-load";
import {
  aggregateChoroplethData,
  scopedChoroplethProps,
  sinUbicacionNote,
} from "@/lib/analytics/choropleth-data";
import { fetchReunificationRate } from "@/lib/analytics/compliance-metrics";
import {
  PROVINCE_ISO_MAP,
  type PetListSelector,
  fetchLostPets,
  fetchPerdidasMetrics,
} from "@/lib/analytics/govt-dashboards";
import { resolveJurisdictionScope } from "@/lib/analytics/jurisdiction-scope";
import { aggregateRowsByDepartment } from "@/lib/analytics/subregion-aggregate";
import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import { requireGobReadAccessOrRedirect } from "@/lib/infra/auth-guards";
import { fetchLostEpisodeCaseCodesForPets } from "@/lib/infra/case-queries";
import {
  TARGETS,
  buildProjectionContext,
  smallNGate,
  smallNNote,
  toneForTarget,
  windows,
} from "@/lib/metrics";
import { KPI_CATALOG } from "@/lib/metrics/kpi-catalog";
import { CONTACT_EMAILS, mailtoHref } from "@/lib/ui/contact";
import {
  describeNarrowedView,
  isNarrowedToOperativeJurisdiction,
} from "@/lib/ui/view-scope-caption";
import {
  formatCount,
  formatDate,
  formatPercent,
  pluralizeEs,
  speciesLabel,
  speciesOptions,
  todayIsoInAr,
} from "@/lib/utils/format";
import { trimmedSearchParam } from "@/lib/utils/search-params";
import { LostPetRow as LostPetRowComponent } from "./_components/LostPetRow";

const VALID_STATUSES: PetListSelector[] = ["all", "lost", "recovered", "active", "deceased"];

function parseStatusFilter(raw: string | undefined): PetListSelector {
  if (!raw) return "lost";
  return (VALID_STATUSES as string[]).includes(raw) ? (raw as PetListSelector) : "lost";
}

const STATUS_TABS: UrlTabItem[] = [
  { value: "lost", label: "Perdidas" },
  // Event-sourced, not a status: pets that went lost → active inside the KPI's
  // own 30-day window. This tab used to map to `status=active` and therefore
  // listed the entire living padrón (260 rows) next to a KPI reading 2 — two
  // orders of magnitude apart, as a list headline (live review 2026-07-28).
  { value: "recovered", label: "Recuperadas" },
  { value: "active", label: "Activas" },
  { value: "deceased", label: "Fallecidas" },
  { value: "all", label: "Todas" },
];

// Species domain axis — the page already reads `sp.species` and fetchLostPets
// applies `eq(pets.species, species)`; this surfaces the previously-hidden
// control. dog/cat match a single stored species; "other" is the exact value
// `pets.species='other'` the fetcher honors as-is (no query change).
// Los VALORES son la decisión de producto de esta pantalla; la ORTOGRAFÍA sale
// de speciesLabel, que es la única fuente (ver speciesOptions).
const SPECIES_OPTIONS = speciesOptions(["dog", "cat", "other"]);

export default async function GobPerdidasPage({
  searchParams,
}: {
  searchParams: Promise<{
    period?: string;
    from?: string;
    to?: string;
    province?: string;
    locality?: string;
    species?: string;
    status?: string;
    q?: string;
  }>;
}) {
  const { profile, jurisdictions } = await requireGobReadAccessOrRedirect();
  const actor = { role: profile.role };

  const sp = await searchParams;
  // Perdidas has no period control (PO decision 2026-07-19): it's a
  // currently-lost STOCK view, not a period-scoped report — a date filter
  // conceptually doesn't apply. The window is a fixed trailing 30d, used only
  // to bound the reunification-rate + median-recovery KPIs below.
  const period = windows.trailing30d();
  // G0 (PO decision 2026-07): the list always shows the full currently-lost
  // STOCK (no window) so its count matches the same-page Perdidas activas
  // KPI — both count status='lost'. There is no period control to narrow it.
  const listSince = undefined;
  const species = sp.species || undefined;
  const statusFilter = parseStatusFilter(sp.status);
  // Q1: a repeated ?q= hands Next a string[] — raw `.trim()` on that throws (500).
  const q = trimmedSearchParam(sp.q);

  // Switcher inputs + THE FENCE (D4 reversal, PO decision 2026-07-19): perdidas
  // used to discard filteredJurisdictions and scope every fetcher on the
  // operator's full `jurisdictions`, while the OpFilterBar still showed an
  // active "Provincia: X" chip — a dishonest no-op filter. It now narrows
  // exactly like every other /gob screen: govt fetchers scope on
  // filteredJurisdictions (assignments ∩ selection, never wider than
  // assignments); admin has no assignments to narrow, so a selected
  // province/locality is applied as an explicit predicate via
  // adminSelectedProvince/adminSelectedLocality (both null unless
  // role === "admin" — see resolveJurisdictionScope's security guarantees).
  const {
    localities,
    allowedProvinces,
    filteredJurisdictions,
    selectedProvince,
    adminSelectedProvince,
    adminSelectedLocality,
  } = await resolveJurisdictionScope({
    role: profile.role,
    jurisdictions,
    params: { province: sp.province, locality: sp.locality },
  });
  // Both undefined unless role === "admin" (resolveJurisdictionScope's guarantee) —
  // hoisted once so every fetcher below shares the identical admin-scope value.
  const adminProvince = adminSelectedProvince ?? undefined;
  const adminLocality = adminSelectedLocality ?? undefined;

  // PO decision 4b ("Pérdidas: ubicación legible + scope operativo",
  // 2026-07-23): presentation-only minimization keyed off the SAME resolved
  // ctx/filter the fetchers above already use (C3 ViewScope) — admin's
  // universal/national view, or a govt view still spanning multiple
  // provinces, renders list rows WITHOUT owner-identifying fields; narrowing
  // to a single province (admin drill or a single-province govt view) shows
  // the full detail row. This does NOT change fetchLostPets'/
  // fetchPerdidasMetrics' scope security — it only decides what the already
  // scoped rows may DISPLAY.
  const showOwnerDetail = isNarrowedToOperativeJurisdiction({
    role: profile.role,
    effectiveJurisdictions: filteredJurisdictions,
    adminProvince,
  });

  // C3 disclosure: caption when this page's filters narrow below the mandate.
  const narrowedView = describeNarrowedView({
    role: profile.role,
    mandateJurisdictions: jurisdictions,
    effectiveJurisdictions: filteredJurisdictions,
    adminProvince,
    adminLocality,
  });

  // Header + filter bar render in BOTH the data and the degraded branch (same
  // shape as app/gob/censo/CensoScreen.tsx). Neither depends on the fetchers
  // below: the bar is built from allowedProvinces/localities, resolved by the
  // already-awaited resolveJurisdictionScope. Dropping it on timeout took away
  // the one control that could have narrowed the query that timed out, and
  // "Reintentar" re-issues the identical one — an operator with no province
  // selected had no way back except editing the URL by hand.
  const header = (
    <ScreenHeader
      className="space-y-2"
      eyebrow="Pérdidas"
      title="Mascotas perdidas"
      subtitle={
        <>
          {/* The universal claim yields to the narrowed-view caption (never both). */}
          {hasNationalReadScope(profile.role) ? (
            narrowedView ? null : (
              <p className="text-md text-ln-op-mute">Vista universal — todas las jurisdicciones.</p>
            )
          ) : (
            <p className="text-md text-ln-op-mute">
              Mascotas marcadas como perdidas dentro de tu cobertura.
            </p>
          )}
          <ViewScopeCaption scope={narrowedView} />
        </>
      }
    />
  );

  // Unified filter bar — jurisdiction + species axis + free-text search +
  // active-filter chips. Status keeps its own UrlTabs control below (a
  // queue-style tab set, not an OpFilterBar axis). Search (q) migrated
  // into the bar's children slot via the shared SearchFilterField
  // (gob-perdidas-search-migration, 2026-07-21) — same pattern as
  // /gob/organizaciones and /gob/usuarios: q is a plain searchParam
  // fetchLostPets already applies server-side, not a client-side map
  // filter, so folding it in is a pure UI consistency move (the map's
  // choroplethData is built FROM the already-q-filtered `lostPets`, so
  // its scope is unchanged either way). Period is OMITTED: perdidas is a
  // currently-lost STOCK view (PO decision 2026-07-19), not a
  // period-scoped report — a date filter conceptually doesn't apply,
  // mirrors /gob/maltrato's showPeriod={false}.
  //
  // `actions` is a parameter, not a constant: the CSV link is the one part of
  // this bar that DOES depend on the fetched rows, so the degraded branch
  // renders the bar without it rather than offering an export of nothing.
  const filtersRow = (actions?: ReactNode) => (
    <OpFilterBar
      showPeriod={false}
      jurisdiction={{ allowedProvinces, localities }}
      savedViewsKey="op-saved-views:perdidas:v1"
      actions={actions}
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
    >
      <SearchFilterField
        paramKey="q"
        value={q}
        label="Buscar"
        placeholder="Buscar por nombre de mascota o dueño/a"
      />
    </OpFilterBar>
  );

  // D4 reunification rate (Item 4) — lost episodes returned to active within a
  // fixed trailing 30d window, plus median days-to-recovery. No period control
  // on this page (PO decision 2026-07-19): `period` above is always
  // windows.trailing30d(), jurisdiction-scoped via ProjectionContext. Same
  // scope as every fetcher below: filteredJurisdictions for govt, admin
  // drill-down opts for admin. Built out here because the freshness footer
  // needs the context too.
  const reunificationCtx = buildProjectionContext(actor, filteredJurisdictions, period, {
    adminProvince,
    adminLocality,
  });

  // avgDaysActive must be computed over the UNFILTERED in-scope lost pets (the
  // full set of currently-lost pets, not just the display slice). When no
  // display filters are active the fetched list already represents that full
  // set, so it can be handed over to avoid a second DB round-trip. When any
  // filter is active (q, species, or a non-"lost" status tab) the fetched rows
  // are a subset — passing them would silently scope avgDaysActive to it — so
  // opts.lostPets is omitted and fetchPerdidasMetrics resolves the unfiltered
  // scope itself.
  //
  // "No display filters" = q absent, species absent, statusFilter the default
  // "lost" (there's no period window — listSince is always undefined, the full
  // stock). A jurisdiction selection NARROWS the scope itself, it is not a
  // display filter, so it does not disqualify the reuse.
  const noDisplayFilters = !q && !species && statusFilter === "lost" && listSince === undefined;

  // Fetch the display list with all active display filters applied, plus every
  // aggregate derived from it, under ONE deadline. `listSince` is always
  // undefined (no period control — full currently-lost stock). Scope:
  // filteredJurisdictions for govt (no-op for admin, whose jurisdictions is
  // already []), plus the admin province/locality drill-down predicate.
  //
  // BOUNDED in the 2026-08-09 outage pass, then CORRECTED by the review after
  // it. That first version ran all four fetchers SEQUENTIALLY, justified by a
  // comment claiming "metrics and caseCodesByPet depend on lostPets". Only
  // caseCodesByPet always does:
  //   - reunification NEVER does — reunificationCtx above is built from actor /
  //     filteredJurisdictions / period alone;
  //   - metrics depends CONDITIONALLY — only in the noDisplayFilters branch.
  // The serialization was a real regression, not just wasted time: four trips
  // that used to be individually unbounded now had to fit COLLECTIVELY inside
  // 10s, so a merely slow DB (~4s a query) would miss the deadline and drop the
  // operator into the degraded branch. The chain is now two rounds at worst —
  // its true dependency depth.
  const load = await loadWithTimeout(
    (async () => {
      const [lostPets, reunification, metricsWhenFiltered] = await Promise.all([
        fetchLostPets(actor, filteredJurisdictions, {
          since: listSince,
          species,
          status: statusFilter,
          q,
          adminProvince,
          adminLocality,
        }),
        fetchReunificationRate(reunificationCtx),
        // Independent of lostPets in this branch — the fetcher resolves the
        // unfiltered in-scope population itself, so it need not wait.
        noDisplayFilters
          ? null
          : fetchPerdidasMetrics(actor, filteredJurisdictions, { adminProvince, adminLocality }),
      ]);

      const [metrics, caseCodesByPet, subregionData] = await Promise.all([
        metricsWhenFiltered ??
          fetchPerdidasMetrics(actor, filteredJurisdictions, {
            lostPets,
            adminProvince,
            adminLocality,
          }),
        // Surface the CAS- case code for each lost pet. Keyed lookup over the
        // already jurisdiction-scoped lostPets (no new nationwide query) — each
        // row links to its lost_pet_episode case at /gob/casos/{code}.
        fetchLostEpisodeCaseCodesForPets(lostPets.map((p) => p.petId)),
        // Scope-aware choropleth drill (design/scoped-choropleth-drill): when a
        // province is selected, fold the SAME (already filtered/scoped) lostPets
        // into department cells — auto-drilling the map to department/barrio
        // grain. It queries ar_localities (lib/analytics/subregion-aggregate.ts),
        // so it is a real DB round-trip and belongs INSIDE the deadline. It sat
        // outside it until this pass, which left the page able to hang on
        // exactly the common operator path: a province selected.
        selectedProvince
          ? aggregateRowsByDepartment(
              selectedProvince.code,
              lostPets.map((p) => ({ locality: p.locality, value: 1 })),
            )
          : null,
      ]);

      return { lostPets, metrics, reunification, caseCodesByPet, subregionData };
    })(),
  );
  if (!load.ok) {
    return (
      <div className="space-y-6">
        {header}
        {filtersRow()}
        <AnalyticsLoadFallback
          reason={load.reason}
          correlationId={load.id}
          retryHref={analyticsRetryHref("/gob/perdidas", sp)}
        />
      </div>
    );
  }
  const { lostPets, metrics, reunification, caseCodesByPet, subregionData } = load.value;

  const noScope = profile.role === "govt" && jurisdictions.length === 0;

  // Q1 (CSV export parity) — exactly the rendered list rows, and DELIBERATELY
  // NARROWER than the on-screen detail: no owner name, no contact, no
  // coordinates, regardless of showOwnerDetail. The row's presentation-
  // minimization rule (PO decision 4, 2026-07-23) hides those fields at any
  // national/multi-province view because they identify people; a CSV outlives
  // the screen and travels, so the file keeps the minimized shape ALWAYS and
  // says so, instead of resurfacing contact data the moment someone narrows
  // the filter and clicks export.
  const csvColumns = ["Mascota", "Especie", "Token", "Estado", "Jurisdicción", "Perdida desde"];
  const csvStatusLabel: Record<string, string> = {
    lost: "Perdida",
    active: "Activa",
    deceased: "Fallecida",
  };
  const csvRows = lostPets.map((p) => [
    p.petName,
    speciesLabel(p.species),
    p.petPublicToken,
    csvStatusLabel[p.petStatus] ?? p.petStatus,
    [p.locality, p.province].filter(Boolean).join(", "),
    p.markedLostAt ? formatDate(p.markedLostAt) : "",
  ]);
  const csvContextLines = [
    `miMAR · Mascotas perdidas — estado: ${
      STATUS_TABS.find((t) => t.value === statusFilter)?.label ?? statusFilter
    }`,
    "# Sin datos de contacto ni ubicación exacta: el archivo viaja fuera de pantalla; el detalle operativo vive en la vista filtrada a tu jurisdicción",
  ];

  // task #31c dedup: shared aggregateChoroplethData (same fold as /gob/vigilancia)
  const choroplethData = aggregateChoroplethData(
    lostPets,
    (p) => (p.province ? PROVINCE_ISO_MAP[p.province] : undefined),
    () => 1,
  );

  // subregionData is resolved inside the bounded block above (it is a DB
  // round-trip); folding it into the map props is pure computation.
  const mapProps = scopedChoroplethProps(
    choroplethData,
    selectedProvince?.code,
    subregionData?.cells,
  );
  // L1·1: lost pets the drill could not place in any department/barrio.
  const sinUbicarNote = sinUbicacionNote(subregionData?.sinUbicacion, {
    singular: "mascota perdida",
    plural: "mascotas perdidas",
  });

  const panelMapId = "panel-perdidas-mapa-titulo";

  return (
    <div className="space-y-6">
      {/* Page header — hoisted above the load so the degraded branch keeps it. */}
      {header}

      {/* No-scope warning */}
      {noScope && (
        <div className="rounded-[var(--radius-md)] border border-ln-op-warn-bd bg-ln-op-warn-bg px-4 py-3 text-md text-ln-op-warn">
          Tu cuenta no tiene localidades asignadas. Un administrador debe asignarte al menos una
          para ver casos.{" "}
          <a
            href={mailtoHref(CONTACT_EMAILS.general, {
              subject: "miMAR — Asignación de localidad",
            })}
            className="underline underline-offset-4"
          >
            Solicitar asignación
          </a>
          .
        </div>
      )}

      {/* Same bar the degraded branch renders — only the CSV action, which is
          built from the fetched rows, is added here. */}
      {filtersRow(
        <CsvExportLink
          filename={`perdidas-${todayIsoInAr()}`}
          columns={csvColumns}
          rows={csvRows}
          contextLines={csvContextLines}
        />,
      )}

      {/* KPI cards — pérdidas (activas/recuperados/antigüedad) + reunificación (D4) */}
      <section
        aria-label="Indicadores de pérdidas"
        className="grid grid-cols-2 md:grid-cols-5 gap-3"
      >
        <OpKpi
          label={KPI_CATALOG.lost_pets_active_stock.label}
          value={metrics.activeCount > 0 ? String(metrics.activeCount) : "—"}
          tone={metrics.activeCount > 0 ? "warn" : "neutral"}
          drillHref="/gob/perdidas?status=lost"
          info={{
            definition: "Mascotas con estado 'lost' actualmente en la jurisdicción del operador.",
            formula: "COUNT(pets WHERE status='lost') scoped to jurisdiction",
          }}
          descriptorId="lost_pets_active_stock"
        />
        <OpKpi
          label="Recuperados (30d)"
          value={formatCount(metrics.recoveredMonth)}
          tone="ok"
          info={{
            definition:
              "Mascotas que volvieron de 'perdido' a 'activo' (reunificadas con su dueño/a) en los últimos 30 días. No incluye bajas (p. ej. fallecimiento) ocurridas mientras estaban perdidas.",
            formula:
              "COUNT(pet_events WHERE event_type='status_changed', from='lost' → to='active', últimos 30d) scoped",
          }}
          descriptorId="lost_pets_recovered_30d"
        />
        <OpKpi
          label={KPI_CATALOG.lost_pets_avg_days_active.label}
          value={String(metrics.avgDaysActive)}
          info={{
            definition:
              "Promedio de días transcurridos desde la fecha de pérdida (evento pet_lost) hasta hoy, sobre el set actualmente perdido.",
            formula: "AVG(today − lost_at) WHERE status='lost'",
          }}
          descriptorId="lost_pets_avg_days_active"
        />
        {/* D4 — reunification rate over a fixed trailing 30d window (benchmark:
            TARGETS.REUNIFICATION_PCT). No period control on this page (PO
            decision 2026-07-19) — always the last 30 days, never adjustable.
            C1 (2026-07-22, §3b / red-team "100% con N=2 junto a 68
            perdidas"): descriptorId + guardInput.n route value/tone through
            the SAME guard engine the rest of C1's consumers use —
            zeroDenominatorGate (0 episodios → "—" neutral, was an inline
            hack here) AND smallNGate (n<5 → tone forced neutral + note,
            NEW). `sub` now also names the co-primary open stock so the rate
            can't be read as a lone victory number next to it. */}
        <OpKpi
          label={KPI_CATALOG.reunification_rate.label}
          value={formatPercent(reunification.ratePct)}
          tone={toneForTarget(reunification.ratePct, TARGETS.REUNIFICATION_PCT)}
          bar={reunification.lostEpisodes === 0 ? undefined : reunification.ratePct}
          sub={`meta ${TARGETS.REUNIFICATION_PCT}% · ${reunification.recovered} de ${reunification.lostEpisodes} episodios (30d) · ${metrics.activeCount} pérdidas activas ahora`}
          info={{
            definition: `Porcentaje de episodios de pérdida abiertos en los últimos 30 días que terminaron en reunificación con el dueño/a. Benchmark internacional: ${TARGETS.REUNIFICATION_PCT}% (UK RSPCA).`,
            formula:
              "COUNT(episodios_lost → status='active') / COUNT(all lost episodes en 30d) × 100",
            caveat:
              "No filtra por especie: la meta de reunificación se mide sobre todos los episodios de pérdida, no por especie — filtrar fragmentaría el benchmark poblacional. Leer siempre junto al stock de Pérdidas activas.",
          }}
          descriptorId="reunification_rate"
          guardInput={{ n: reunification.lostEpisodes }}
        />
        <OpKpi
          label={KPI_CATALOG.reunification_median_recovery_days.label}
          // C1 (2026-07-22, §3b): "Never render mediana with N recoveries <
          // min" — a median over 1-4 recovered episodes isn't a meaningful
          // statistic, so below the SAME smallN floor as the rate tile
          // (sourced from the catalog, not re-hardcoded) this shows "—"
          // instead of a number, no caveat-and-still-show like the rate gets.
          value={
            smallNGate(KPI_CATALOG.reunification_rate, reunification.recovered) ||
            reunification.recovered === 0
              ? "—"
              : String(reunification.medianDaysToRecovery)
          }
          sub={
            reunification.recovered > 0 &&
            smallNGate(KPI_CATALOG.reunification_rate, reunification.recovered)
              ? smallNNote(KPI_CATALOG.reunification_rate.guards?.smallN?.min ?? 5)
              : undefined
          }
          info={{
            definition:
              "Mediana de días entre la apertura del episodio de pérdida y su resolución (reunificación), sobre los episodios de los últimos 30 días. Menor es mejor.",
            formula: "PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY days_to_recovery)",
            caveat: `No se muestra con menos de ${KPI_CATALOG.reunification_rate.guards?.smallN?.min ?? 5} recuperaciones — una mediana sobre pocos casos no es una estadística significativa.`,
          }}
          descriptorId="reunification_median_recovery_days"
        />
      </section>

      {/* Map panel */}
      <OpCard aria-labelledby={panelMapId}>
        <OpCardHead title={<span id={panelMapId}>Episodios por jurisdicción</span>} />
        <OpCardBody>
          <MapChoroplethDynamic
            // Camera lockdown (gob/map-zoom-lockdown, 2026-07-21): `level`/
            // `geojsonUrl`/`visibleCodes` only seed MapChoropleth's initial
            // state — a prop change alone does not re-init the map or refit
            // the (now non-pannable) camera. Keying on the resolved scope
            // forces a clean remount whenever the jurisdiction filter
            // changes, so the locked-down viewport always fitBounds to the
            // newly selected area instead of silently keeping the old one.
            key={selectedProvince?.code ?? "national"}
            {...mapProps}
            scaleLabel="Mascotas perdidas"
            caption="Conteos absolutos por jurisdicción — no es una tasa poblacional."
            fallbackTableLabel="Mascotas perdidas por provincia"
            // Visual review 2026-07-23 (#1): when the drilled view is 100%
            // k-anon suppressed, the in-map notice cites the scope aggregate.
            // `lostPets` is the SAME already-scoped/filtered list this page
            // folds into the map cells AND renders row-by-row in the table
            // below, so the count discloses nothing the screen doesn't
            // already show — no new query, no complementary-disclosure risk.
            scopeAggregate={{
              count: lostPets.length,
              noun: `${pluralizeEs(lostPets.length, "mascota")} ${pluralizeEs(lostPets.length, "perdida")}`,
            }}
          />
          {sinUbicarNote && <p className="mt-2 text-xs text-ln-op-mute">{sinUbicarNote}</p>}
        </OpCardBody>
      </OpCard>

      {/* Status tabs + list panel */}
      <Suspense>
        <UrlTabs
          paramKey="status"
          defaultValue="lost"
          tabs={STATUS_TABS}
          aria-label="Filtrar por estado"
        >
          {STATUS_TABS.map((tab) => {
            const panelListId = `panel-perdidas-lista-${tab.value}`;
            return (
              <UrlTabsContent key={tab.value} value={tab.value}>
                <OpCard aria-labelledby={panelListId} className="mt-4">
                  <OpCardHead
                    title={
                      <span id={panelListId}>
                        {tab.value === "lost" && "Mascotas perdidas"}
                        {tab.value === "recovered" && "Mascotas recuperadas (últimos 30 días)"}
                        {tab.value === "active" && "Mascotas activas (no perdidas)"}
                        {tab.value === "deceased" && "Mascotas fallecidas"}
                        {tab.value === "all" && "Todas las mascotas"} (
                        {/* When the list hits its 500 cap and the stock KPI is
                            larger, say "primeros 500 de N" so the header never
                            contradicts the Perdidas activas count above. */}
                        {tab.value === "lost" &&
                        !q &&
                        listSince === undefined &&
                        lostPets.length >= 500 &&
                        metrics.activeCount > lostPets.length
                          ? `primeros ${lostPets.length} de ${metrics.activeCount}`
                          : lostPets.length}
                        )
                        {q && (
                          <span className="ml-2 text-sm font-normal text-ln-op-mute">
                            {"—"} búsqueda: &ldquo;{q}&rdquo;
                          </span>
                        )}
                      </span>
                    }
                  />
                  <OpCardBody>
                    {/* PO decision 4b — honest disclosure of the presentation
                        rule above: only renders when the current view is
                        NOT yet narrowed to one operative jurisdiction. */}
                    {!showOwnerDetail && lostPets.length > 0 && (
                      <p className="mb-2 text-sm text-ln-op-mute">
                        Vista nacional/multi-provincial: se ocultan los datos de contacto y
                        ubicación exacta. Filtrá a tu jurisdicción operativa para ver el detalle de
                        contacto.
                      </p>
                    )}
                    {lostPets.length === 0 ? (
                      <LnEmptyState
                        icon="search"
                        title="Sin resultados"
                        description={
                          q
                            ? `No se encontraron mascotas para "${q}" con el estado seleccionado.`
                            : "No hay mascotas con este estado para tu cobertura."
                        }
                        // A dead end with an active filter is worse than a
                        // dead end with none — give the operator a way back
                        // (copy audit 2026-08-04, S8).
                        action={
                          q || sp.species || sp.status ? (
                            <Link
                              href="/gob/perdidas"
                              className="text-sm text-ln-op-azul hover:underline"
                            >
                              Limpiar filtros
                            </Link>
                          ) : undefined
                        }
                      />
                    ) : (
                      <ul className="space-y-2">
                        {lostPets.map((p) => (
                          <LostPetRowComponent
                            key={p.petId}
                            pet={p}
                            caseCode={caseCodesByPet.get(p.petId)}
                            showOwnerDetail={showOwnerDetail}
                          />
                        ))}
                      </ul>
                    )}
                  </OpCardBody>
                </OpCard>
              </UrlTabsContent>
            );
          })}
        </UrlTabs>
      </Suspense>

      <DashboardFreshnessFooter ctx={reunificationCtx} />
    </div>
  );
}
