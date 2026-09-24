"use client";

// DetailDrawer — the Panorama console's slide-in feature inspector.
//
// When a map feature is clicked (SituationalMap → PanoramaConsole →
// onFeatureClick), the console sets the selected feature and renders this
// drawer. It shows the feature's properties plus a layer-specific drill action:
//
//   - decomisos → "Abrir expediente →" linking the unified case detail route
//     (/casos/{publicCode}) using the publicCode the layer already carries.
//   - denuncias → states the location is APPROXIMATE (locality centroid) and
//     links to the welfare/maltrato bandeja. NEVER reveals an exact coordinate
//     (privacy=coarse, spec §8 — Slice 5 gates exact welfare coordinates).
//   - perdidas / mordeduras / zoonosis / refugios / choropleth → show the
//     feature's properties + a link to the relevant dashboard when one exists.
//
// F4 UNIT HISTORY (§6 detail on-demand):
//   Clicking an AGGREGATED unit (province/locality symbol or choropleth cell)
//   opens a "Historia de la unidad" section below the existing FeatureBody.
//   It fetches /api/panorama/unit-history with AbortController (cancels stale),
//   then renders: a Sparkline of the daily trend, a recent-events list, and a
//   byType breakdown. Reference layers (refugios, decomisos) keep their existing
//   body only — no unit-history fetch for individual pins.
//
// ACCESSIBILITY (WCAG 2.1):
//   - role="dialog" + aria-modal="true" + aria-labelledby (the title),
//   - Escape closes (keydown on the drawer; the backdrop is also a close target),
//   - focus moves INTO the drawer on open (the close button) and RETURNS to the
//     element that had focus before opening on close,
//   - a focus trap keeps Tab within the drawer while it is open.
//
// PRIVACY: this drawer renders ONLY the properties the layer already exposes.
// The denuncias feature carries a coarse centroid + kind/severity — never an
// exact coordinate — so there is nothing precise to leak here. The unit-history
// fetch respects the same privacy rules as the repository (denuncias: kind/
// severity only, no coordinates; govt scope always intersected server-side).

import { usePathname } from "next/navigation";
import type React from "react";
import { useEffect, useId, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { CASE_STATUS_CONFIG } from "@/components/ui/dashboard";
import type { CaseStatus } from "@/db/schema";
import {
  AR_TIME_ZONE,
  eventTypeLabel,
  formatPercent,
  pluralizeEs,
  speciesLabel,
} from "@/lib/utils/format";
import { REFERENCE_LAYERS } from "@/src/modules/panorama/domain/layers";
import type { LayerId } from "@/src/modules/panorama/domain/types";
import { SEVERITY_BASE_LABEL, welfareReportKindLabel } from "@/src/modules/welfare/domain/types";

import { Sparkline } from "./Sparkline";

import { REUNIFICATION_RATE_LABEL_ES } from "@/lib/metrics/kpi-label-constants";

// Re-exported for situational-map-config.ts's popup-html builder, which reads
// this shared severity-tier map (bite-incident severity uses the same
// low/medium/high/critical vocabulary as welfare denuncias) — canonical source
// is now welfare's domain module (see T5.2 dedup below); this keeps that
// import path working unchanged.
export { SEVERITY_BASE_LABEL as SEVERITY_LABEL } from "@/src/modules/welfare/domain/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The payload the console hands the drawer when a feature is clicked. */
export type SelectedFeature = {
  layerId: LayerId;
  /** Human label of the layer (from the registry) for the drawer header. */
  layerLabel: string;
  /** The clicked feature's GeoJSON properties (shape varies per layer). */
  properties: Record<string, unknown>;
  /**
   * The raw query-string from the console's active searchParams (period/scope).
   * Forwarded to /api/panorama/unit-history so the history window matches the
   * map's current time window. Omit for reference-pin layers (no history fetch).
   */
  periodQs?: string;
};

type Props = {
  /** The selected feature, or null when the drawer is closed. */
  selected: SelectedFeature | null;
  /** Active period label ("últimos 90 días") — shown in the aggregate unit
   * summary so an aggregated bubble's readout carries its time window. */
  periodLabel?: string;
  onClose: () => void;
};

// ---------------------------------------------------------------------------
// Unit-history API response shape (mirrors UnitHistoryResult in repository.ts)
// ---------------------------------------------------------------------------

type UnitHistoryEvent = {
  date: string;
  type: string;
  label: string;
};

type TrendBucket = {
  date: string;
  count: number;
};

type UnitHistoryResult = {
  /** True when the locality's total event count is below the k-anon threshold (k=5). */
  suppressed?: boolean;
  events: UnitHistoryEvent[];
  trend: TrendBucket[];
  byType: Record<string, number>;
};

// ---------------------------------------------------------------------------
// es-AR label maps (local; no shared helper exists for these enums)
// ---------------------------------------------------------------------------

export const PET_STATUS_LABEL: Record<string, string> = {
  active: "Activa",
  lost: "Perdida",
  deceased: "Fallecida",
};

export const INCIDENT_LABEL: Record<string, string> = {
  bite_inflicted: "Mordedura infligida",
  bite_suffered: "Mordedura sufrida",
};

/**
 * Synthetic byType keys the unit-history repository mints that live in NO
 * shared catalog: the perdidas kind pair (labels mirror repository-history's
 * own event labels), the decomisos episode key, and the microchip
 * identification kind.
 */
const BY_TYPE_SYNTHETIC_LABEL: Record<string, string> = {
  pet_lost: "Mascota perdida",
  pet_found_sighting: "Avistaje",
  custody_episode: "Episodio de custodia",
  microchip_iso: "Microchip (ISO)",
};

/**
 * T5.1 — es-AR label for a unit-history `byType` key. The API mixes WELFARE
 * REPORT kinds (abandonment, neglect…), PET-EVENT types (outbreak_signal…),
 * incident kinds (bite_inflicted…) and synthetic keys (pet_lost…) in one
 * breakdown, and the drawer rendered the raw English keys verbatim. Known
 * catalogs resolve in order; a key none of them knows falls back to itself —
 * raw, but only for genuinely unknown kinds, never for known ones.
 */
export function byTypeLabel(key: string): string {
  const synthetic = BY_TYPE_SYNTHETIC_LABEL[key] ?? INCIDENT_LABEL[key];
  if (synthetic) return synthetic;
  const welfare = welfareReportKindLabel(key);
  if (welfare !== key) return welfare;
  const event = eventTypeLabel(key as Parameters<typeof eventTypeLabel>[0]) as string | undefined;
  return event ?? key;
}

/** Read a string-ish property safely. */
function str(props: Record<string, unknown>, key: string): string | null {
  const v = props[key];
  return v === null || v === undefined ? null : String(v);
}

/**
 * T4.5 (2026-08-01): thread the clicked unit's province/locality into a drill
 * href so the destination (perdidas/vigilancia/denuncias/programa — all
 * already read these searchParams) opens scoped to the unit the operator just
 * looked at, instead of dumping them back into the unfiltered national list.
 * Appends to any existing query string (e.g. "?etapa=triage"); omits an
 * absent/empty province or locality rather than writing a blank param — most
 * individual points-mode dots (perdidas/mordeduras/zoonosis) carry neither by
 * design (privacy invariant, see LostPointProps), so this is then a no-op.
 */
function withUnitScope(href: string, properties: Record<string, unknown>): string {
  const province = str(properties, "province");
  const locality = str(properties, "locality");
  if (!province && !locality) return href;
  const [base, qs] = href.split("?");
  const params = new URLSearchParams(qs);
  if (province) params.set("province", province);
  if (locality) params.set("locality", locality);
  return `${base}?${params.toString()}`;
}

/**
 * Row label for the administrative unit of a FOLDED detail cell (PO "Option A"):
 * the detail tier aggregates at the departamento/partido (the barrio in CABA), so
 * the value carried in `locality` is a DIVISION, never a bare locality — labeling
 * it "Localidad" would misname it. Province level keeps "Provincia". Used by the
 * folded layers (sintomas + the division-fill choropleths); reunificacion is not
 * folded and keeps "Localidad".
 */
function unitRowLabel(properties: Record<string, unknown>, isProvince: boolean): string {
  if (isProvince) return "Provincia";
  return str(properties, "province") === "CABA" ? "Barrio" : "Departamento/partido";
}

/**
 * True when the clicked feature is an AGGREGATED unit cell (province/locality
 * rollup) rather than an individual points-mode dot. Aggregated point cells carry
 * the `place` unit label + `level`; points-mode dots (perdidas/mordeduras) carry
 * per-entity fields only (name/species/incidentType…) and neither of those keys.
 * Used by the dual-mode point layers to pick the unit-summary body vs the per-pet
 * body — the same feature the map plots as a bubble vs a real dot.
 */
function isAggregatedUnit(properties: Record<string, unknown>): boolean {
  return typeof properties.place === "string" || typeof properties.level === "string";
}

/** Format an ISO date string to es-AR short date; "—" when absent/invalid. */
function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("es-AR", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: AR_TIME_ZONE,
  });
}

// ---------------------------------------------------------------------------
// A single definition row
// ---------------------------------------------------------------------------

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-ln-op-line-2 py-2 last:border-b-0">
      <dt className="text-xs font-bold uppercase tracking-[0.1em] text-ln-op-mute">{label}</dt>
      <dd className="text-md text-ln-op-ink">{value ?? "—"}</dd>
    </div>
  );
}

const DRILL_CLS =
  "inline-flex items-center gap-1 rounded-[var(--radius-md)] bg-ln-op-azul px-3 py-1.5 text-md font-medium text-white no-underline hover:bg-ln-op-azul-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ln-op-azul";

/**
 * map-QOL no-silent-crossing: drill links to /gob/* surfaces get an explicit
 * "abre en portal Gobierno" suffix when the drawer is mounted on the ADMIN
 * portal (/admin/panorama) — the operator must never cross portals silently.
 * On the Gobierno portal the link is same-portal and renders unchanged.
 */
function DrillLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const crossesPortal = href.startsWith("/gob/") && (pathname?.startsWith("/admin") ?? false);
  return (
    <a href={href} className={DRILL_CLS}>
      {children}
      {crossesPortal && (
        <span className="text-xs font-normal opacity-90">· abre en portal Gobierno ↗</span>
      )}
    </a>
  );
}

/**
 * The unit-summary body for an AGGREGATED cell of a dual-mode point layer
 * (perdidas/mordeduras clicked as a bubble, not a real dot). Mirrors the
 * sintomas/choropleth aggregate shape so the drawer header is never dead weight:
 * the unit name (labeled by its department/barrio/province KIND), the layer's
 * value with its unit, and the active period. Suppressed cells honor k-anon.
 */
function AggregateUnitBody({
  properties,
  valueLabel,
  periodLabel,
  drillHref,
  drillLabel,
}: {
  properties: Record<string, unknown>;
  valueLabel: string;
  periodLabel?: string;
  drillHref: string;
  drillLabel: string;
}) {
  const isProvince = str(properties, "level") === "province";
  const suppressed = properties.suppressed === true;
  const place =
    str(properties, "place") ??
    (isProvince
      ? (str(properties, "province") ?? "—")
      : [str(properties, "locality"), str(properties, "province")].filter(Boolean).join(", "));
  const count = properties.count;
  return (
    <>
      <dl>
        <Row label={unitRowLabel(properties, isProvince)} value={place || "—"} />
        <Row
          label={valueLabel}
          value={
            suppressed ? (
              <span className="text-ln-op-mute">Suprimido (privacidad · k‑anon)</span>
            ) : (
              (typeof count === "number" ? count : 0).toLocaleString("es-AR")
            )
          }
        />
        {periodLabel ? <Row label="Período" value={periodLabel} /> : null}
      </dl>
      <DrillLink href={withUnitScope(drillHref, properties)}>{drillLabel}</DrillLink>
    </>
  );
}

// ---------------------------------------------------------------------------
// Per-layer body (individual-feature detail; no unit history)
// ---------------------------------------------------------------------------

// Exported for unit tests: the layer-specific drawer body renders the honest
// k-anon copy ("Suprimido …") for a suppressed cell instead of a bogus "0".
export function FeatureBody({
  layerId,
  properties,
  periodLabel,
}: { layerId: LayerId; properties: Record<string, unknown>; periodLabel?: string }) {
  // This drawer is shared by /admin/panorama and /gob/panorama (both render the
  // same layer registry). "organizaciones" is one of the dual-portal surfaces
  // (cola/usuarios/organizaciones/reglas/servicios — portal-follows-viewer,
  // 2026-07-02): it exists under BOTH /admin and /gob, so its drill link must
  // follow the viewer's current portal instead of hardcoding /gob (server twin:
  // lib/ui/portal-base.ts; this is the client-side derivation since DetailDrawer
  // is a client component and cannot call headers()).
  //
  // The other drill links below (maltrato/perdidas/vigilancia/analytics) stay
  // hardcoded to /gob — those pages have NO /admin copy, so deriving the portal
  // for them would 404 for an admin viewer instead of fixing anything.
  const pathname = usePathname();
  const portal = pathname?.startsWith("/admin") ? "/admin" : "/gob";

  switch (layerId) {
    case "decomisos": {
      const code = str(properties, "code");
      const status = str(properties, "status");
      return (
        <>
          <dl>
            <Row label="Expediente" value={code ?? "—"} />
            <Row
              label="Estado"
              value={status ? (CASE_STATUS_CONFIG[status as CaseStatus]?.label ?? status) : "—"}
            />
            <Row label="Apertura" value={shortDate(str(properties, "openedAt"))} />
          </dl>
          {code && (
            <a href={`/casos/${encodeURIComponent(code)}`} className={DRILL_CLS}>
              Abrir expediente →
            </a>
          )}
        </>
      );
    }

    case "denuncias": {
      // COARSE location — never a precise spot. We surface kind/severity and a
      // link to the bandeja, but no code is carried by this layer (the welfare
      // report id never leaves the repository), so we cannot deep-link a record.
      const kind = str(properties, "kind");
      const severity = str(properties, "severity");
      const place = [str(properties, "locality"), str(properties, "province")]
        .filter(Boolean)
        .join(", ");
      return (
        <>
          <p className="rounded-[var(--radius-md)] border border-ln-op-warn-bd bg-ln-op-warn-bg px-3 py-2 text-sm text-ln-op-ink-2">
            Ubicación aproximada (centroide de localidad). No se muestra la ubicación exacta de la
            denuncia.
          </p>
          <dl>
            <Row label="Zona" value={place || "—"} />
            <Row label="Tipo" value={kind ? welfareReportKindLabel(kind) : "—"} />
            <Row
              label="Gravedad"
              value={severity ? (SEVERITY_BASE_LABEL[severity] ?? severity) : "—"}
            />
            <Row label="Ingreso" value={shortDate(str(properties, "createdAt"))} />
          </dl>
          {/* F1 fusion (2026-07-22): Maltrato is now the Denuncias hub's
              "Triage" stage — link straight there instead of through the old
              /gob/maltrato redirect. */}
          <DrillLink href={withUnitScope("/gob/denuncias?etapa=triage", properties)}>
            Ver bandeja de denuncias →
          </DrillLink>
        </>
      );
    }

    case "perdidas": {
      // An aggregated bubble (province/locality rollup) carries no per-pet
      // identity — render the unit summary instead of four dead "—" rows. The
      // real per-pet header below is kept for points-mode sighting dots.
      if (isAggregatedUnit(properties)) {
        return (
          <AggregateUnitBody
            properties={properties}
            valueLabel="Reportes de pérdida"
            periodLabel={periodLabel}
            drillHref="/gob/perdidas"
            drillLabel="Ver pérdidas →"
          />
        );
      }
      const status = str(properties, "status");
      const species = str(properties, "species");
      return (
        <>
          <dl>
            <Row label="Mascota" value={str(properties, "name") ?? "—"} />
            <Row label="Especie" value={species ? speciesLabel(species) : "—"} />
            <Row label="Estado" value={status ? (PET_STATUS_LABEL[status] ?? status) : "—"} />
            <Row label="Visto por última vez" value={shortDate(str(properties, "lastSeenAt"))} />
          </dl>
          <DrillLink href={withUnitScope("/gob/perdidas", properties)}>Ver pérdidas →</DrillLink>
        </>
      );
    }

    case "mordeduras": {
      // Same duality as perdidas: an aggregated bubble has no per-incident fields
      // (incidentType/severity/occurredAt), so render the unit summary. The
      // per-incident header below is kept for points-mode incident dots.
      if (isAggregatedUnit(properties)) {
        return (
          <AggregateUnitBody
            properties={properties}
            valueLabel="Mordeduras registradas"
            periodLabel={periodLabel}
            drillHref="/gob/vigilancia"
            drillLabel="Ver vigilancia →"
          />
        );
      }
      const incident = str(properties, "incidentType");
      const severity = str(properties, "severity");
      return (
        <>
          <dl>
            <Row
              label="Incidente"
              value={incident ? (INCIDENT_LABEL[incident] ?? incident) : "—"}
            />
            <Row
              label="Gravedad"
              value={severity ? (SEVERITY_BASE_LABEL[severity] ?? severity) : "—"}
            />
            <Row label="Fecha" value={shortDate(str(properties, "occurredAt"))} />
          </dl>
          <DrillLink href={withUnitScope("/gob/vigilancia", properties)}>
            Ver vigilancia →
          </DrillLink>
        </>
      );
    }

    case "zoonosis": {
      return (
        <>
          <dl>
            <Row
              label="Enfermedad"
              value={str(properties, "diseaseLabel") ?? str(properties, "diseaseCode") ?? "—"}
            />
            <Row label="Detectado" value={shortDate(str(properties, "occurredAt"))} />
          </dl>
          <DrillLink href={withUnitScope("/gob/vigilancia", properties)}>
            Ver vigilancia →
          </DrillLink>
        </>
      );
    }

    case "sintomas": {
      // Aggregated point cell — sintomas has no near-zoom individual-dot mode
      // (unlike perdidas/mordeduras), so this always renders a unit summary
      // (place + reported-symptom count), same shape as the choropleth cells.
      const isProvince = str(properties, "level") === "province";
      const suppressed = properties.suppressed === true;
      const place =
        str(properties, "place") ??
        (isProvince
          ? (str(properties, "province") ?? "—")
          : [str(properties, "locality"), str(properties, "province")].filter(Boolean).join(", "));
      return (
        <>
          <dl>
            <Row label={unitRowLabel(properties, isProvince)} value={place || "—"} />
            <Row
              label="Síntomas reportados"
              value={
                suppressed ? (
                  <span className="text-ln-op-mute">Suprimido (privacidad · k‑anon)</span>
                ) : (
                  String(properties.count ?? 0)
                )
              }
            />
          </dl>
          <DrillLink href={withUnitScope("/gob/vigilancia", properties)}>
            Ver vigilancia →
          </DrillLink>
        </>
      );
    }

    case "reunificacion": {
      // Aggregated signal cell — the graduated-symbol count IS the D4
      // reunification ratePct (0–100), not an event count (see loadReunificacionByUnit).
      // The detail tier now folds to the departamento/partido (barrio in CABA), so
      // the unit noun follows unitRowLabel like the other folded layers.
      const isProvince = str(properties, "level") === "province";
      const suppressed = properties.suppressed === true;
      const place =
        str(properties, "place") ??
        (isProvince
          ? (str(properties, "province") ?? "—")
          : [str(properties, "locality"), str(properties, "province")].filter(Boolean).join(", "));
      return (
        <>
          <dl>
            <Row label={unitRowLabel(properties, isProvince)} value={place || "—"} />
            <Row
              label={REUNIFICATION_RATE_LABEL_ES}
              value={
                suppressed ? (
                  <span className="text-ln-op-mute">Suprimido (privacidad · k‑anon)</span>
                ) : (
                  // `count` here is the reunification RATE (0–100), typed loose
                  // on the popup props — coerce, and let formatPercent answer "—"
                  // for anything non-finite.
                  formatPercent(Number(properties.count ?? 0))
                )
              }
            />
          </dl>
          <DrillLink href={withUnitScope("/gob/perdidas", properties)}>Ver pérdidas →</DrillLink>
        </>
      );
    }

    case "refugios": {
      const verified = properties.verified === true;
      return (
        <>
          <dl>
            <Row label="Refugio" value={str(properties, "name") ?? "—"} />
            <Row label="Verificación" value={verified ? "Verificado" : "Sin verificar"} />
          </dl>
          {/* Organizaciones has an /admin twin (portal parity) — portal-aware
              href keeps the viewer in-portal; DrillLink adds the cross-portal
              suffix only for surfaces without a twin. */}
          <DrillLink href={`${portal}/organizaciones`}>Ver organizaciones →</DrillLink>
        </>
      );
    }

    case "clinicas": {
      const verified = properties.verified === true;
      return (
        <>
          <dl>
            <Row label="Clínica" value={str(properties, "name") ?? "—"} />
            <Row label="Verificación" value={verified ? "Verificada" : "Sin verificar"} />
          </dl>
          <DrillLink href={`${portal}/organizaciones`}>Ver organizaciones →</DrillLink>
        </>
      );
    }

    case "cobertura":
    case "esterilizacion":
    case "mortalidad":
    case "microchip":
    case "ppp": {
      // Choropleth cell. U5: province mode carries no locality. EITHER grain can
      // be k-anon suppressed — task #40 retired the "province cells are large"
      // exemption for the choropleth loaders (they build cells through
      // `provinceCell`, whose denominator decides suppression) and #40b did the
      // same for the aggregated point loaders.
      const isProvince = str(properties, "level") === "province";
      const suppressed = properties.suppressed === true;
      const value = properties.value;
      // A department fill carries its name in `departmentName` (no single
      // locality to drill); a barrio carries `locality`. Fall back so a
      // department click still shows its name + province, not "—".
      const unitName = str(properties, "locality") ?? str(properties, "departmentName");
      const place = isProvince
        ? (str(properties, "province") ?? "—")
        : [unitName, str(properties, "province")].filter(Boolean).join(", ");
      const valueLabel = {
        cobertura: "Perros vacunados",
        esterilizacion: "Mascotas esterilizadas",
        mortalidad: "Mascotas fallecidas",
        microchip: "Mascotas con microchip activo",
        ppp: "Mascotas PPP registradas",
      }[layerId];
      return (
        <>
          <dl>
            <Row label={unitRowLabel(properties, isProvince)} value={place || "—"} />
            <Row
              label={valueLabel}
              value={
                // #40b: the `!isProvince &&` that used to guard this was the last
                // live consumer of the retired premise — it made the drawer print
                // `String(value ?? 0)` for a k-anon-protected PROVINCE, i.e. a
                // confident "0" for a cell the map was hatching. The flag decides,
                // at any grain.
                //
                // RA-7 F1, the second false zero on the same line: a province the
                // layer carries NO cell for resolves to `{ value: null,
                // suppressed: false }`, and `?? 0` turned that absence into a
                // measured "0". The map already separates the three states
                // (colour = value · hatch = protegido · stipple = sin datos —
                // province-choropleth-style.ts); the drawer must not collapse the
                // last two back into a number the data never contained.
                suppressed ? (
                  <span className="text-ln-op-mute">Suprimido (privacidad · k‑anon)</span>
                ) : value === null || value === undefined ? (
                  <span className="text-ln-op-mute">Sin datos</span>
                ) : (
                  String(value)
                )
              }
            />
          </dl>
          {/* F9 (2026-08-01): Analítica is the Programa hub's second vista. */}
          <DrillLink href={withUnitScope("/gob/programa?vista=analitica", properties)}>
            Ver analítica →
          </DrillLink>
        </>
      );
    }

    default:
      return <p className="text-md text-ln-op-mute">Sin detalle para esta capa.</p>;
  }
}

// ---------------------------------------------------------------------------
// F4 Unit history section
// ---------------------------------------------------------------------------

// Layers that carry individual-feature pins (NOT aggregated units). These never
// trigger a unit-history fetch — they have their own FeatureBody only. Derived
// from the domain registry so a new reference layer (e.g. clinicas) is covered
// automatically instead of silently falling through.
const REFERENCE_LAYER_IDS = new Set<LayerId>(REFERENCE_LAYERS.map((l) => l.id));

/** Determine whether the selected feature should trigger a unit-history fetch.
 * True for aggregated (density/signal/choropleth) units that carry a province. */
function shouldFetchHistory(layerId: LayerId, properties: Record<string, unknown>): boolean {
  if (REFERENCE_LAYER_IDS.has(layerId)) return false;
  // Aggregated point cells and choropleth cells carry `province` in properties.
  const province = properties.province;
  return typeof province === "string" && province.length > 0;
}

/** Build the /api/panorama/unit-history URL for the given selected feature. */
function buildHistoryUrl(
  layerId: LayerId,
  properties: Record<string, unknown>,
  periodQs: string,
): string {
  const province = String(properties.province ?? "");
  const locality =
    typeof properties.locality === "string" && properties.locality ? properties.locality : null;
  // Folded detail cells (choropleth + aggregated points) carry the INDEC department
  // code. Forward it so the unit-history guard/drill resolves member localities by
  // CODE, not the ambiguous department name (re-identification guard, WARNING 3).
  const departmentCode =
    typeof properties.departmentCode === "string" && properties.departmentCode
      ? properties.departmentCode
      : null;

  const params = new URLSearchParams();
  params.set("layer", layerId);
  params.set("province", province);
  if (locality) params.set("locality", locality);
  if (departmentCode) params.set("departmentCode", departmentCode);

  // Thread the active period (from the console's searchParams) so the history
  // window matches the map's current filters.
  if (periodQs) {
    const existing = new URLSearchParams(periodQs);
    for (const [k, v] of existing.entries()) {
      if (k === "province" || k === "locality" || k === "layer") continue;
      params.set(k, v);
    }
  }

  return `/api/panorama/unit-history?${params.toString()}`;
}

type HistoryState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; data: UnitHistoryResult };

function UnitHistorySection({
  layerId,
  properties,
  periodQs,
}: {
  layerId: LayerId;
  properties: Record<string, unknown>;
  periodQs: string;
}) {
  const [state, setState] = useState<HistoryState>({ status: "loading" });

  useEffect(() => {
    setState({ status: "loading" });
    const controller = new AbortController();
    const url = buildHistoryUrl(layerId, properties, periodQs);

    fetch(url, { signal: controller.signal, headers: { accept: "application/json" } })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<UnitHistoryResult>;
      })
      .then((data) => {
        setState({ status: "ok", data });
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setState({ status: "error", message: "No se pudo cargar el historial." });
      });

    return () => controller.abort();
  }, [layerId, properties, periodQs]);

  const place = [
    typeof properties.locality === "string" && properties.locality ? properties.locality : null,
    typeof properties.province === "string" ? properties.province : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <section aria-labelledby="unit-history-heading" className="border-t border-ln-op-line pt-3">
      <h3
        id="unit-history-heading"
        className="mb-2 text-sm font-bold uppercase tracking-[0.1em] text-ln-op-mute"
      >
        Historia de la unidad
        {place ? <span className="font-normal normal-case"> · {place}</span> : null}
      </h3>

      {state.status === "loading" && (
        <output aria-busy="true" className="text-sm text-ln-op-mute">
          Cargando historial…
        </output>
      )}

      {state.status === "error" && (
        <p role="alert" className="text-sm text-ln-op-warn">
          {state.message}
        </p>
      )}

      {state.status === "ok" && state.data.suppressed && (
        <p className="rounded-[var(--radius-md)] border border-ln-op-warn-bd bg-ln-op-warn-bg px-3 py-2 text-sm text-ln-op-ink-2">
          Suprimido por k-anonimato (menos de 5 eventos en el período).
        </p>
      )}

      {state.status === "ok" && !state.data.suppressed && (
        <div className="flex flex-col gap-3">
          {/* Sparkline — daily trend over the active period */}
          {state.data.trend.length > 0 && (
            <div>
              <p className="mb-1 text-xs text-ln-op-mute">Tendencia diaria</p>
              <Sparkline
                points={state.data.trend.map((b) => b.count)}
                width={288}
                height={40}
                ariaLabel={`Tendencia de ${layerId}: ${state.data.trend.length} ${pluralizeEs(state.data.trend.length, "día")}`}
              />
            </div>
          )}

          {/* Recent events list */}
          {state.data.events.length > 0 ? (
            <div>
              <p className="mb-1 text-xs text-ln-op-mute">
                Eventos recientes ({state.data.events.length})
              </p>
              <ul className="flex flex-col gap-1">
                {state.data.events.map((ev, idx) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: stable ordered list
                  <li key={idx} className="flex items-start gap-2 text-sm">
                    <span className="shrink-0 text-ln-op-mute">{shortDate(ev.date)}</span>
                    <span className="text-ln-op-ink-2">{ev.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-ln-op-mute">Sin eventos en el período.</p>
          )}

          {/* byType breakdown */}
          {Object.keys(state.data.byType).length > 0 && (
            <div>
              <p className="mb-1 text-xs text-ln-op-mute">Por tipo</p>
              <dl className="flex flex-col gap-0.5">
                {Object.entries(state.data.byType).map(([type, n]) => (
                  <div key={type} className="flex items-center justify-between text-sm">
                    {/* T5.1: es-AR labels — never the raw English kind key. */}
                    <dt className="text-ln-op-ink-2">{byTypeLabel(type)}</dt>
                    <dd className="font-medium text-ln-op-ink">{n}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The drawer shell
// ---------------------------------------------------------------------------

// The drawer is a native <dialog> opened with showModal() — same proven pattern
// as components/ui/ConfirmDialog.tsx. The browser then provides, for free:
//   - a real focus trap (Tab stays inside the dialog),
//   - Escape dismissal via the native `cancel` event,
//   - the dialog role + aria-modal semantics (no role="dialog" hack → no
//     useSemanticElements lint error),
//   - focus restoration to the trigger on close.
// We only style it as a right-anchored, full-height sliding panel.
export function DetailDrawer({ selected, periodLabel, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // True only while a pointer press that STARTED on the backdrop is in flight.
  const backdropPressRef = useRef(false);
  const titleId = useId();
  const open = selected !== null;

  // Open/close the native dialog imperatively to match React state.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open) {
      if (!el.open) el.showModal();
    } else if (el.open) {
      el.close();
    }
  }, [open]);

  // Sync the native cancel event (Escape) back to React state. preventDefault so
  // the browser does not close the dialog before our state updates.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const handleCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    el.addEventListener("cancel", handleCancel);
    return () => el.removeEventListener("cancel", handleCancel);
  }, [onClose]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: mouse-only backdrop affordance (unreachable by Tab); Escape is the keyboard-equivalent dismissal, wired via the native `cancel` listener above.
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-modal="true"
      onClose={onClose}
      // T4.6 (2026-08-01): the doc comment above (§ACCESSIBILITY) has always
      // claimed "the backdrop is also a close target", but no handler ever
      // implemented it — a click outside the sliding panel was a dead click.
      // A click on the ::backdrop bubbles with `target === the <dialog>
      // element itself` (it lands OUTSIDE every content descendant, which
      // would stop the event at that descendant); a click inside the panel
      // targets a descendant, so this only fires for the backdrop.
      // The press must ALSO start on the backdrop: a text-selection drag that
      // begins inside the panel and releases over the backdrop fires `click`
      // on their common ancestor (this <dialog>), and closing there would
      // destroy the operator's selection (review 2026-08-01, MINOR).
      onPointerDown={(e) => {
        backdropPressRef.current = e.target === dialogRef.current;
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current && backdropPressRef.current) onClose();
        backdropPressRef.current = false;
      }}
      // Right-anchored full-height panel. `ml-auto mr-0` + max-h/h-full slides it
      // to the right edge; the native ::backdrop dims the rest. A2 (motion
      // review): op-drawer-enter (globals.css) adds the slide+fade entrance.
      className="op-drawer-enter ml-auto mr-0 h-full max-h-full w-full max-w-[360px] border-l border-ln-op-line bg-ln-op-card p-0 shadow-[0_18px_50px_rgba(20,40,60,.22)] [&::backdrop]:bg-black/40 open:flex open:flex-col"
    >
      {selected && (
        <>
          <header className="flex items-start justify-between gap-3 border-b border-ln-op-line px-4 py-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
                Detalle de capa
              </p>
              <h2 id={titleId} className="text-base font-semibold text-ln-op-ink">
                {selected.layerLabel}
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar"
              className="rounded-[var(--radius-md)] border border-ln-op-line px-2 py-1 text-md text-ln-op-ink-2 hover:bg-ln-op-stripe focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ln-op-azul"
            >
              <Icon name="close" size="sm" decorative />
            </button>
          </header>

          <div className="flex flex-col gap-3 overflow-y-auto px-4 py-3">
            <FeatureBody
              layerId={selected.layerId}
              properties={selected.properties}
              periodLabel={periodLabel}
            />

            {/* F4: unit-history section — only for aggregated units that carry a province */}
            {shouldFetchHistory(selected.layerId, selected.properties) && (
              <UnitHistorySection
                layerId={selected.layerId}
                properties={selected.properties}
                periodQs={selected.periodQs ?? ""}
              />
            )}
          </div>
        </>
      )}
    </dialog>
  );
}
