// AlcanceScreen — actionable outreach pipelines (Item 21).
//
// F2 fusion (2026-07-22): this is the byte-identical body of the former
// /gob/outreach page.tsx, relocated so the Operativos hub (app/gob/operativos/
// page.tsx) can render it as its "Alcance comunitario" tab under
// ?vista=alcance. /gob/outreach itself now only redirects here via the hub
// (see app/gob/outreach/page.tsx).
//
// "Del dato a la acción": each pipeline converts a KPI into a target list
// that an operator can review and export for a contact campaign.
//
// Three pipelines (v1):
//   (a) Overdue antirrábica — pets with overdue rabies vaccine by jurisdiction
//   (b) Stray-scan density  — barrios with elevated stray-scan count
//   (c) Sterilization ranking — vets ranked by throughput (recognition)
//
// GEO-FIRST redesign (PO decision 3, "Operativos geo-first + PII tras
// confirmación", 2026-07-23): pipeline (a) used to render up to 500 NAMED
// pet rows the instant the page loaded. It now opens with LOCALITY
// AGGREGATES ("dónde intervenir" — ranked desc by overdue count), computed
// in-memory from the SAME single fetchOverdueRabiesVaccine query (no second
// DB round-trip — aggregateOverdueByLocality in lib/infra/outreach-pipelines.ts).
// The named PII list for one zone appears only after the operator clicks
// that zone's "Armar operativo →" — a plain `?zona=<locality>&provincia=
// <province>` link (server-rendered, honest URL — no client-side disclosure
// widget), read via the searchParams prop below. That expansion IS the
// confirmation; the "Recordar" reminder buttons + CSV export live INSIDE it.
// Pipelines (b)/(c) were already aggregate-shaped (locality/vet counts, not a
// named-row dump) — unchanged.
//
// PII contract: pipelines (b)/(c) still write a pii_queried audit row on every
// page render (they were never a row-level PII dump). Pipeline (a) now writes
// its audit row on ZONE EXPANSION ONLY, carrying the zone — aggregates are
// not row-level PII, so there is nothing to audit until a zone is opened.
//
// Capability gate: requireGobReadAccessOrRedirect (same as all /gob pages).
// Export: /gob/outreach/export?pipeline=<id>&... for CSV download (zone-scoped
// for overdue_rabies when accessed from inside an expanded zone).

import Link from "next/link";

import { Icon } from "@/components/Icon";
import { OutreachRabiesReminderList } from "@/components/gob/OutreachRabiesReminderList";
import { LnEmptyState } from "@/components/ui/EmptyState";
import { OpCard, OpCardBody, OpCardHead, OpKpi, OpSortHeader } from "@/components/ui/dashboard";
import { AnalyticsLoadFallback } from "@/components/ui/dashboard/AnalyticsLoadFallback";
import { DashboardFreshnessFooter } from "@/components/ui/dashboard/DashboardFreshnessFooter";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { analyticsRetryHref, loadWithTimeout } from "@/lib/analytics/analytics-load";
import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import { requireGobReadAccessOrRedirect } from "@/lib/infra/auth-guards";
import {
  type OverdueRabiesPet,
  type OverdueRabiesResult,
  aggregateOverdueByLocality,
  fetchOverdueRabiesVaccine,
  fetchSterilizationVetRanking,
  fetchStrayDensityAreas,
  logOutreachPiiQuery,
} from "@/lib/infra/outreach-pipelines";
import { buildProjectionContext } from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";
import { type UrlSort, parseUrlSort, sortRowsByUrlSort } from "@/lib/ui/url-sort";
import { formatCount } from "@/lib/utils/format";

export type AlcanceScreenProps = {
  /**
   * True when rendered as the Operativos hub's "Alcance comunitario" tab
   * (app/gob/operativos/page.tsx) — see components/ui/dashboard/ScreenHeader.tsx.
   * This is the exact case the PO flagged (eyebrow === tab label verbatim).
   */
  underHub?: boolean;
  /**
   * `zona`/`provincia` (PO decision 3, geo-first): the locality/province of
   * the ONE zone the operator expanded to see named overdue-rabies pets. Both
   * absent = the aggregates view. A null locality/province (pets with no
   * jurisdiction on file) round-trips through the sentinel below rather than
   * an empty string, so "no locality" is a real, distinguishable zone rather
   * than indistinguishable from "no zone selected".
   */
  searchParams?: {
    zona?: string;
    provincia?: string;
    /** Q4 (URL sort) — red-zones column sort, see parseUrlSort below. */
    orden?: string;
    dir?: string;
  };
};

/** Sentinel for a null province/locality in the `?zona=`/`?provincia=` URL params. */
const ZONE_NONE = "__sin-dato__";

function zoneParamValue(value: string | null): string {
  return value ?? ZONE_NONE;
}

function zoneParamToValue(raw: string | undefined): string | null {
  if (raw === undefined || raw === ZONE_NONE) return null;
  return raw;
}

function zoneLabel(province: string | null, locality: string | null): string {
  return `${locality ?? "Sin localidad registrada"}, ${province ?? "sin provincia registrada"}`;
}

type ZoneSelection =
  | { selected: false }
  | { selected: true; locality: string | null; province: string | null; pets: OverdueRabiesPet[] };

/**
 * Resolve the `?zona=`/`?provincia=` selection against the already-fetched
 * overdue-pets list — pulled out of AlcanceScreen itself purely to keep the
 * screen's own cognitive complexity under the repo's lint ceiling (no
 * behavior change from inlining this).
 */
function resolveZoneSelection(
  searchParams: AlcanceScreenProps["searchParams"],
  pets: readonly OverdueRabiesPet[],
): ZoneSelection {
  if (searchParams?.zona === undefined) return { selected: false };
  const locality = zoneParamToValue(searchParams.zona);
  const province = zoneParamToValue(searchParams.provincia);
  const matched = pets.filter(
    (p) =>
      (p.jurisdictionLocality ?? null) === locality &&
      (p.jurisdictionProvince ?? null) === province,
  );
  return { selected: true, locality, province, pets: matched };
}

/**
 * Pipeline (a) card — extracted from AlcanceScreen (which was otherwise over
 * the repo's cognitive-complexity ceiling) with NO behavior change: the same
 * aggregates-vs-zone-detail branches, byte-identical markup/copy.
 */
function OverdueRabiesPipelineCard({
  panelId,
  overdueResult,
  overdueByLocality,
  zone,
  zoneSort,
}: {
  panelId: string;
  overdueResult: OverdueRabiesResult;
  overdueByLocality: ReturnType<typeof aggregateOverdueByLocality>;
  zone: ZoneSelection;
  /** Q4 — the current URL sort the aggregates table headers report. */
  zoneSort: UrlSort;
}) {
  return (
    <OpCard aria-labelledby={panelId}>
      <OpCardHead
        title={
          <span id={panelId} className="flex items-center gap-2">
            Antirrábica vencida
            <span className="text-sm font-normal text-ln-op-mute">
              · pipeline (a) ·{" "}
              {zone.selected
                ? "datos operativos con PII · audit registrado"
                : "agregado por localidad · sin PII"}
            </span>
          </span>
        }
        actions={
          zone.selected && zone.pets.length > 0 ? (
            <a
              href={`/gob/outreach/export?pipeline=overdue_rabies&province=${encodeURIComponent(
                zoneParamValue(zone.province),
              )}&locality=${encodeURIComponent(zoneParamValue(zone.locality))}`}
              className="text-sm text-ln-op-azul hover:underline"
            >
              Exportar CSV →
            </a>
          ) : undefined
        }
      />
      <OpCardBody>
        {overdueResult.empty ? (
          <LnEmptyState
            icon="check-circle"
            title="Sin mascotas que cumplan el criterio en tu jurisdicción"
            description="No hay mascotas activas con antirrábica vencida (> 365 días) en tu cobertura."
          />
        ) : zone.selected ? (
          <ZoneDetail zone={zone} />
        ) : (
          <ZoneAggregates
            overdueByLocality={overdueByLocality}
            totalPets={overdueResult.pets.length}
            zoneSort={zoneSort}
          />
        )}
      </OpCardBody>
    </OpCard>
  );
}

function ZoneDetail({ zone }: { zone: Extract<ZoneSelection, { selected: true }> }) {
  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-md font-medium text-ln-op-ink">
          {zoneLabel(zone.province, zone.locality)} · {zone.pets.length} mascota(s)
        </p>
        <Link
          href="?"
          className="text-sm text-ln-op-mute underline underline-offset-2 hover:text-ln-op-ink"
        >
          ← Volver a todas las zonas
        </Link>
      </div>
      {zone.pets.length === 0 ? (
        <LnEmptyState
          icon="check-circle"
          title="Sin mascotas en esta zona"
          description="Esta zona no tiene mascotas con antirrábica vencida en este momento."
        />
      ) : (
        <>
          <OutreachRabiesReminderList pets={zone.pets.slice(0, 50)} />
          {zone.pets.length > 50 && (
            <p className="py-1 text-center text-sm text-ln-op-mute">
              … y {zone.pets.length - 50} más — exportá el CSV para la lista completa
            </p>
          )}
        </>
      )}
      <p className="mt-3 text-sm text-ln-op-mute">
        Estos datos son PII operativos, scoped a esta zona. Esta consulta queda registrada.{" "}
        <Link href="/gob/historial" className="underline underline-offset-2 hover:text-ln-op-ink">
          Ver historial →
        </Link>
      </p>
    </>
  );
}

/** The `?zona=/?provincia=` expansion link for one aggregate zone row — shared
 *  by the sm+ table and the <sm card list so the two renderings can never
 *  drift apart on the URL contract. */
function zoneExpandHref(zoneRow: { locality: string | null; province: string | null }): string {
  return `?zona=${encodeURIComponent(zoneParamValue(zoneRow.locality))}&provincia=${encodeURIComponent(
    zoneParamValue(zoneRow.province),
  )}`;
}

const ZONE_ACTION_LINK_CLASSES =
  "rounded-[var(--radius-op-btn,6px)] border border-[var(--color-ln-op-azul)] bg-[var(--color-ln-op-azul)] text-sm font-semibold text-white hover:bg-[var(--color-ln-op-azul-700)]";

function ZoneAggregates({
  overdueByLocality,
  totalPets,
  zoneSort,
}: {
  overdueByLocality: ReturnType<typeof aggregateOverdueByLocality>;
  totalPets: number;
  /** Q4 — the current URL sort the table headers report. */
  zoneSort: UrlSort;
}) {
  return (
    <>
      {/* <sm card list (mobile-polish 2026-07): in the table below, the
          "Armar operativo →" button crowded the counts at 390px. Each zone
          becomes a card — locality/count on the content row, the action on
          its own full-width row beneath. Hidden at sm+, where the table
          (proper th/caption semantics) takes over. */}
      <ul
        aria-label="Localidades con mascotas con antirrábica vencida"
        className="space-y-2 sm:hidden"
      >
        {overdueByLocality.map((zoneRow) => (
          <li
            key={`${zoneRow.province ?? "—"}|${zoneRow.locality ?? "—"}`}
            className="rounded-[var(--radius-md)] border border-ln-op-line p-3"
          >
            <div className="flex items-baseline justify-between gap-3">
              <p className="min-w-0">
                <span className="block truncate font-medium text-ln-op-ink">
                  {zoneRow.locality ?? "Sin localidad registrada"}
                </span>
                <span className="block text-sm text-ln-op-mute">{zoneRow.province ?? "—"}</span>
              </p>
              <p className="flex-shrink-0 text-right">
                <span className="block tabular-nums font-semibold text-ln-op-danger">
                  {zoneRow.count}
                </span>
                <span className="block text-xs text-ln-op-mute">vencidas</span>
              </p>
            </div>
            <Link
              href={zoneExpandHref(zoneRow)}
              className={`mt-2 flex w-full items-center justify-center gap-1 px-2.5 py-2 ${ZONE_ACTION_LINK_CLASSES}`}
            >
              Armar operativo →
            </Link>
          </li>
        ))}
      </ul>
      <table className="hidden w-full text-sm border-collapse sm:table">
        <caption className="sr-only">
          Localidades con mascotas con antirrábica vencida, ordenable por columna (por defecto de
          mayor a menor)
        </caption>
        <thead>
          {/* Q4 (URL sort) — OpSortHeader cells; the page re-sorted
              overdueByLocality server-side from the same params, so the <sm
              card list above follows the same order. Acción is not a sort
              axis. */}
          <tr className="border-b border-ln-op-line">
            <OpSortHeader
              sortKey="localidad"
              label="Localidad"
              defaultDir="asc"
              current={zoneSort}
              className="py-1.5 text-left font-semibold text-ln-op-mute"
            />
            <OpSortHeader
              sortKey="provincia"
              label="Provincia"
              defaultDir="asc"
              current={zoneSort}
              className="py-1.5 text-left font-semibold text-ln-op-mute"
            />
            <OpSortHeader
              sortKey="vencidas"
              label="Vencidas"
              current={zoneSort}
              className="py-1.5 text-right font-semibold text-ln-op-mute"
            />
            <th scope="col" className="py-1.5 text-right font-semibold text-ln-op-mute">
              Acción
            </th>
          </tr>
        </thead>
        <tbody>
          {overdueByLocality.map((zoneRow) => (
            <tr
              key={`${zoneRow.province ?? "—"}|${zoneRow.locality ?? "—"}`}
              className="border-b border-ln-op-line/50"
            >
              <td className="py-1.5 text-ln-op-ink">
                {zoneRow.locality ?? "Sin localidad registrada"}
              </td>
              <td className="py-1.5 text-ln-op-mute">{zoneRow.province ?? "—"}</td>
              <td className="py-1.5 text-right tabular-nums font-medium text-ln-op-danger">
                {zoneRow.count}
              </td>
              <td className="py-1.5 text-right">
                <Link
                  href={zoneExpandHref(zoneRow)}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 ${ZONE_ACTION_LINK_CLASSES}`}
                >
                  Armar operativo →
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {totalPets >= 500 && (
        <p className="mt-2 text-sm text-ln-op-mute">
          Estos totales reflejan como máximo los primeros 500 casos de tu cobertura (orden por
          antigüedad) — puede haber más sin contar aquí.
        </p>
      )}
      <p className="mt-3 text-sm text-ln-op-mute">
        Agregado por localidad — sin datos de mascotas individuales. Elegí una zona y hacé clic en
        &quot;Armar operativo →&quot; para ver la lista con nombres, contactar dueños/as y exportar
        el CSV; esa acción queda registrada en el audit log.
      </p>
    </>
  );
}

export async function AlcanceScreen({ underHub = false, searchParams }: AlcanceScreenProps = {}) {
  const { user, profile, jurisdictions } = await requireGobReadAccessOrRedirect();

  // Capability gate: same pattern as analytics/campañas.
  const hasOutreachAccess =
    hasNationalReadScope(profile.role) || (profile.role === "govt" && jurisdictions.length > 0);

  if (!hasOutreachAccess) {
    return (
      <div className="space-y-4">
        <ScreenHeader
          underHub={underHub}
          eyebrow="miMAR Gobierno · Alcance comunitario"
          title="Pipelines de alcance comunitario"
        />
        <LnEmptyState
          icon="lock"
          title="Sin acceso"
          description="Tu rol no tiene acceso a los pipelines de alcance comunitario. Pedile al admin que te asigne cobertura jurisdiccional."
        />
      </div>
    );
  }

  // Build context for the trailing 12-month window (overdue rabies) and
  // trailing 30-day window (stray scans, sterilization ranking).
  const period12m = windows.trailing12m();
  const period30d = windows.trailing30d();

  const ctx12m = buildProjectionContext({ role: profile.role }, jurisdictions, period12m);
  const ctx30d = buildProjectionContext({ role: profile.role }, jurisdictions, period30d);

  // The header renders in BOTH the data and the degraded branch. It depends on
  // none of the three pipelines below, and this screen is one of the two halves
  // of /gob/operativos — a bare fallback made the whole hub look broken rather
  // than one slow tab. (No filter bar here: this screen has none.)
  const header = (
    <ScreenHeader
      underHub={underHub}
      className="space-y-2"
      eyebrow="Alcance comunitario"
      title="Pipelines de alcance comunitario"
      subtitle={
        <p className="text-md text-ln-op-mute">
          Del dato a la acción: cada pipeline convierte un indicador en una lista objetivo para
          campañas de contacto. Las consultas quedan registradas en el audit log.
        </p>
      }
    />
  );

  // Fetch all three pipelines concurrently, BOUNDED. Awaited bare, these three
  // population-scale aggregates had no deadline: on a degraded DB the screen
  // hung inside its Suspense boundary, which renders as an endless skeleton
  // with nothing written to the logs. Together with CampanasScreen these are
  // the two halves of /gob/operativos, so neither half could degrade.
  const load = await loadWithTimeout(
    Promise.all([
      fetchOverdueRabiesVaccine(ctx12m),
      fetchStrayDensityAreas(ctx30d),
      fetchSterilizationVetRanking(ctx30d),
    ]),
  );
  if (!load.ok) {
    return (
      <div className="space-y-6">
        {header}
        <AnalyticsLoadFallback
          reason={load.reason}
          correlationId={load.id}
          retryHref={analyticsRetryHref("/gob/operativos", {
            ...(searchParams ?? {}),
            vista: "alcance",
          })}
        />
      </div>
    );
  }
  const [overdueResult, strayResult, sterilResult] = load.value;

  // Pipeline (a) geo-first aggregation — in-memory fold over the SAME query
  // above, no second DB round-trip (PO decision 3).
  //
  // Q4 (URL sort): ?orden=&dir= re-sorts the complete aggregate SERVER-SIDE
  // (no pagination — the whole set is here), so both renderings of the same
  // array (the <sm card list and the sm+ table) follow one order. Default
  // keeps the fold's own worst-volume-first order.
  const zoneSort = parseUrlSort(searchParams ?? {}, ["localidad", "provincia", "vencidas"], {
    key: "vencidas",
    dir: "desc",
  });
  const overdueByLocality = sortRowsByUrlSort(
    aggregateOverdueByLocality(overdueResult.pets),
    zoneSort,
    {
      localidad: (a, b) => (a.locality ?? "").localeCompare(b.locality ?? "", "es"),
      provincia: (a, b) => (a.province ?? "").localeCompare(b.province ?? "", "es"),
      vencidas: (a, b) => a.count - b.count,
    },
  );

  // Zone drill-down: `?zona=`/`?provincia=` select ONE locality's named list.
  // Absent `zona` = aggregates view (the default, PII-free page load).
  const zone = resolveZoneSelection(searchParams, overdueResult.pets);

  // Mandatory PII audit log. Pipelines (b)/(c) are aggregate-shaped
  // (locality/vet counts, never a named-row dump) — one row per page render,
  // as before. Pipeline (a) is now the exception: aggregates carry no
  // row-level PII, so the audit row fires ONLY when a zone is expanded,
  // logging exactly which zone + how many pets were revealed (PO decision 3).
  void logOutreachPiiQuery(user.id, "stray_density", strayResult.areas.length);
  void logOutreachPiiQuery(user.id, "sterilization_ranking", sterilResult.vets.length);
  if (zone.selected) {
    void logOutreachPiiQuery(user.id, "overdue_rabies", zone.pets.length, {
      province: zone.province,
      locality: zone.locality,
    });
  }

  const panelRabiesId = "panel-outreach-rabies";
  const panelStrayId = "panel-outreach-stray";
  const panelSterilId = "panel-outreach-steril";

  return (
    <div className="space-y-6">
      {/* Page header — hoisted above the load so the degraded branch keeps it. */}
      {header}

      {/* Summary KPIs */}
      {/* Stacked below sm (mobile-polish 2026-07): 3-across at 390px crushed
          the tiles — info icons collided with wrapped titles. */}
      <section aria-label="Resumen de pipelines" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <OpKpi
          label="Antirrábica vencida"
          value={formatCount(overdueResult.pets.length)}
          tone={overdueResult.pets.length > 0 ? "danger" : "ok"}
          sub="mascotas en cobertura (12m)"
          info={{
            definition:
              "Mascotas activas en tu jurisdicción cuya última vacuna antirrábica registrada supera los 365 días o que nunca vacunaron.",
            caveat: "Solo considera mascotas con eventos registrados en miMAR.",
          }}
          descriptorId="outreach_overdue_rabies_count"
        />
        <OpKpi
          label="Áreas con escaneos"
          value={formatCount(strayResult.areas.length)}
          tone={strayResult.areas.length > 0 ? "warn" : "neutral"}
          sub="localidades con actividad (30d)"
          info={{
            definition:
              "Localidades con al menos un escaneo de credencial no propio (indicador de animal callejero) en los últimos 30 días.",
          }}
          descriptorId="outreach_stray_scan_areas"
        />
        <OpKpi
          label="Vets en ranking"
          value={formatCount(sterilResult.vets.length)}
          tone="blue"
          sub="con esterilizaciones (30d)"
          info={{
            definition:
              "Veterinarios/as con al menos una esterilización registrada en tu jurisdicción en los últimos 30 días.",
          }}
          descriptorId="outreach_sterilization_vets_ranked"
        />
      </section>

      {/* Pipeline (a): Overdue antirrábica — geo-first (PO decision 3):
          aggregates by locality by default; a zone's named PII list appears
          only after "Armar operativo →" expands it (?zona=/?provincia=). */}
      <OverdueRabiesPipelineCard
        panelId={panelRabiesId}
        overdueResult={overdueResult}
        overdueByLocality={overdueByLocality}
        zone={zone}
        zoneSort={zoneSort}
      />

      {/* Pipeline (b): Stray-scan density */}
      <OpCard aria-labelledby={panelStrayId}>
        <OpCardHead
          title={
            <span id={panelStrayId} className="flex items-center gap-2">
              Densidad de escaneos callejeros por barrio
              <span className="text-sm font-normal text-ln-op-mute">
                · pipeline (b) · últimos 30 días
              </span>
            </span>
          }
          actions={
            !strayResult.empty ? (
              <a
                href="/gob/outreach/export?pipeline=stray_density"
                className="text-sm text-ln-op-azul hover:underline"
              >
                Exportar CSV →
              </a>
            ) : undefined
          }
        />
        <OpCardBody>
          {strayResult.empty ? (
            <LnEmptyState
              icon="map"
              title="Sin escaneos callejeros en tu jurisdicción"
              description="No se registraron escaneos de credencial no propios en los últimos 30 días en tu cobertura."
            />
          ) : (
            <table className="w-full text-sm border-collapse">
              <caption className="sr-only">Áreas con escaneos de animales callejeros</caption>
              <thead>
                <tr className="border-b border-ln-op-line">
                  <th scope="col" className="py-1.5 text-left font-semibold text-ln-op-mute">
                    Localidad
                  </th>
                  <th scope="col" className="py-1.5 text-right font-semibold text-ln-op-mute">
                    Escaneos
                  </th>
                  <th scope="col" className="py-1.5 text-right font-semibold text-ln-op-mute">
                    Acción sugerida
                  </th>
                </tr>
              </thead>
              <tbody>
                {strayResult.areas.map((area) => (
                  <tr key={area.locality} className="border-b border-ln-op-line/50">
                    <td className="py-1.5 text-ln-op-ink">{area.locality}</td>
                    <td className="py-1.5 text-right tabular-nums text-ln-op-ink">
                      {area.scanCount}
                    </td>
                    <td className="py-1.5 text-right text-ln-op-mute">Pre-posicionar recursos</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </OpCardBody>
      </OpCard>

      {/* Pipeline (c): Sterilization vet ranking — geo-first check (PO
          decision 3): this DOES name rows (vet + clinic), but it is a
          RECOGNITION ranking, not an owner-contact PII dump like pipeline
          (a) — the names ARE the point (there is no "aggregate" form of a
          leaderboard), and vets act in a professional/institutional
          capacity, not as the citizen-owner data pipeline (a) exposes.
          Left unredesigned; no "Recordar"-style write action exists here to
          relocate either. */}
      <OpCard aria-labelledby={panelSterilId}>
        <OpCardHead
          title={
            <span id={panelSterilId} className="flex items-center gap-2">
              Ranking de esterilización por veterinario/a
              <span className="text-sm font-normal text-ln-op-mute">
                · pipeline (c) · reconocimiento · últimos 30 días
              </span>
            </span>
          }
        />
        <OpCardBody>
          {sterilResult.empty ? (
            <LnEmptyState
              icon="award"
              title="Sin esterilizaciones registradas en tu jurisdicción"
              description="No hay esterilizaciones registradas en miMAR en los últimos 30 días para tu cobertura."
            />
          ) : sterilResult.vets.length === 0 ? (
            // All sterilizations in scope are unattributed — no named vet to
            // rank, but sterilizations did happen (not the same as "empty").
            // The footnote below carries the count.
            <p className="text-sm text-ln-op-mute">
              Ninguna esterilización del período tiene veterinario/a registrado/a.
            </p>
          ) : (
            <table className="w-full text-sm border-collapse">
              <caption className="sr-only">Ranking de esterilizaciones por veterinario/a</caption>
              <thead>
                <tr className="border-b border-ln-op-line">
                  <th scope="col" className="py-1.5 text-left font-semibold text-ln-op-mute">
                    Veterinario/a
                  </th>
                  <th scope="col" className="py-1.5 text-left font-semibold text-ln-op-mute">
                    Clínica
                  </th>
                  <th scope="col" className="py-1.5 text-right font-semibold text-ln-op-mute">
                    Esterilizaciones
                  </th>
                </tr>
              </thead>
              <tbody>
                {sterilResult.vets.map((vet, idx) => (
                  <tr
                    key={`${vet.vetLabel}-${vet.clinic ?? "none"}`}
                    className="border-b border-ln-op-line/50"
                  >
                    <td className="py-1.5 text-ln-op-ink">
                      {idx === 0 && (
                        <span
                          className="mr-1 inline-flex items-center text-ln-op-ok"
                          aria-hidden="true"
                        >
                          <Icon name="estrella" size={14} decorative />
                        </span>
                      )}
                      {vet.vetLabel}
                    </td>
                    <td className="py-1.5 text-ln-op-mute">{vet.clinic ?? "—"}</td>
                    <td className="py-1.5 text-right tabular-nums font-medium text-ln-op-ink">
                      {vet.count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {/* Unattributed sterilizations are excluded from the ranked list
              above (a recognition ranking cannot award "no name on file") —
              surfaced instead as an honest footnote (screenshot review
              finding #11). */}
          {sterilResult.unattributedCount > 0 && (
            <p className="mt-2 text-sm text-ln-op-mute">
              {sterilResult.unattributedCount}{" "}
              {sterilResult.unattributedCount === 1
                ? "esterilización sin veterinario/a registrado/a"
                : "esterilizaciones sin veterinario/a registrado/a"}{" "}
              (excluidas del ranking).
            </p>
          )}
        </OpCardBody>
      </OpCard>

      <p className="text-sm text-ln-op-mute">
        <Link href="/gob" className="underline underline-offset-4 hover:text-ln-op-ink-2">
          ← Volver al panel
        </Link>
      </p>

      <DashboardFreshnessFooter ctx={ctx12m} />
    </div>
  );
}
