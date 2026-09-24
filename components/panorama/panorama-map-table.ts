// panorama-map-table — the pure model behind the dock's "Registros" pane.
//
// Extracted from PanoramaConsole so the honesty rules encoded here (k-anon
// wording, the locality-rate count fallback, the summable-layer contract) are
// testable on their own instead of only through the console's render tree.
// Every function is a pure `(view data) → table model` projection: no hooks, no
// fetching, no component state.

import type { LayerPanelState } from "@/components/panorama/LayerPanel";
import type { ActiveLayer } from "@/components/panorama/SituationalMap";
import { buildLayerReadout } from "@/components/panorama/map-popup";
import type { MapTableRow } from "@/components/panorama/map-table-csv";
import {
  AGGREGATED_POINT_IDS,
  getLayer,
  isTemporalLayer,
} from "@/src/modules/panorama/domain/layers";
import type { LayerId } from "@/src/modules/panorama/domain/types";

/** Σ over the aggregate COUNT layers — see `summarizeDockRecords`. */
export type DockRecordSummary = {
  /** At least one summable count layer contributed (else the badge falls back
   *  to the unit-row count). */
  hasCountLayer: boolean;
  /** Σ of the visible cell values across those layers. */
  total: number;
  /** Cells the server withheld under k-anonymity (existence, never value). */
  suppressed: number;
  /** Units carrying at least one visible event. */
  unitsWithEvents: number;
  /** Any contributing layer is period-flow (vs. a current-state stock). */
  anyPeriodLayer: boolean;
};

/**
 * Mirror ranking.identify(): a detail-tier cell's own unit label
 * (locality/place/departmentName) BEFORE the province, so N departments of
 * one province don't all render as rows named after the province (WARNING 5).
 */
function unitLabelOf(p: Record<string, unknown>): string {
  const candidates = [
    p.name,
    p.localityName,
    p.locality,
    p.place,
    p.departmentName,
    p.province,
    p.provinceName,
    p.department,
    p.provinceCode,
    p.code,
  ];
  for (const c of candidates) {
    if (c != null) return String(c);
  }
  return "—";
}

/**
 * Each aggregate layer's cells become table rows, reusing the pinned popup's
 * buildLayerReadout so value/unit/protected formatting is identical. A
 * k-anon-suppressed cell reads "Protegido (k<5)", never a number.
 */
export function buildMapTableRows(aggregateLayers: readonly ActiveLayer[]): MapTableRow[] {
  const rows: MapTableRow[] = [];
  for (const layer of aggregateLayers) {
    for (const f of layer.features.features) {
      const p = f.properties as Record<string, unknown>;
      const unit = unitLabelOf(p);
      const suppressed = p.suppressed === true;
      const rawValue =
        typeof p.value === "number" ? p.value : typeof p.count === "number" ? p.count : null;
      // DATA-TRUTH (cowork QA ronda 3 §3, "204%" bug): a rate layer is a
      // percentage ONLY at province grain. At locality grain the repository
      // returns a per-unit COUNT (rate-by-locality deferred — repository.ts
      // "V1 LIMITATION"), so formatting it as "%" produced the impossible
      // "Palermo 204%". Format the locality count as a plain count (no %, no
      // meta gap) — the column header names it "(conteo)" so it reads truthfully.
      const localityRateCount = layer.dataType === "rate" && layer.level === "locality";
      const readout = buildLayerReadout({
        label: layer.label,
        value: rawValue,
        suppressed,
        dataType: localityRateCount ? "density" : layer.dataType,
        complianceTarget: localityRateCount ? undefined : layer.complianceTarget,
      });
      const value =
        readout.state === "suppressed"
          ? "Protegido (k<5)"
          : readout.state === "nodata"
            ? "Sin dato"
            : (readout.valueText ?? "Sin dato");
      // Backlog item 10: the export carries the comparison, not just the number.
      // `gapText` exists exactly when the readout printed a "meta … · gap" (a
      // province-grain rate with a target, unsuppressed) — the locality COUNT
      // demotion above already stripped the target, so the "204%" bug cannot
      // come back through this column.
      rows.push({ layer: layer.label, unit, value, gap: readout.gapText });
    }
  }
  rows.sort((a, b) => a.layer.localeCompare(b.layer, "es") || a.unit.localeCompare(b.unit, "es"));
  return rows;
}

/**
 * Units the server measured but withheld under k-anonymity, across every layer
 * that feeds (or would feed) the per-unit table. Lets the empty table separate
 * "protegido" from "nadie reportó" — the same trichotomy the ranking keeps.
 */
export function sumSuppressedTableUnits(
  activeLayers: readonly ActiveLayer[],
  states: Record<LayerId, LayerPanelState>,
): number {
  return activeLayers
    .filter(
      (l) =>
        l.geomType === "choropleth" ||
        l.renderMode === "graduated" ||
        (l.renderMode === "points" && AGGREGATED_POINT_IDS.has(l.id as LayerId)),
    )
    .reduce((n, l) => n + (states[l.id as LayerId]?.suppressedCount ?? 0), 0);
}

/**
 * Round-2 review #4: the dock badge used to show mapTableRows.length (the number
 * of UNITS with a row — e.g. 24 provinces), which read as a mismatch against a
 * KPI that counts EVENTS (denuncias 3.026, zoonosis señales). Compute Σ(cell
 * counts) across the aggregate COUNT layers (density/signal — NOT rate, whose
 * cells are percentages that don't sum) so the dock total equals the primary KPI
 * population. k-anon-suppressed cells hide their VALUE (only their existence), so
 * Σ(visible) ≤ KPI at detail grain — surfaced as "(+N protegidas)" so the gap is
 * honest, not silent. At province grain nothing is suppressed → Σ == KPI exactly.
 */
export function summarizeDockRecords(activeLayers: readonly ActiveLayer[]): DockRecordSummary {
  let total = 0;
  let suppressed = 0;
  let unitsWithEvents = 0;
  let hasCountLayer = false;
  // Cursor review: the summary copy hardcoded "Eventos en el período", wrong for
  // current-state count layers (mortalidad, acceso-veterinario — temporal:false).
  // Track whether ANY contributing count layer is period-flow; if none are, the
  // total is a current-state stock and the copy must say so (label=number canon).
  let anyPeriodLayer = false;
  for (const layer of activeLayers) {
    const isAggregate = layer.geomType === "choropleth" || layer.renderMode === "graduated";
    if (!isAggregate || layer.dataType === "rate" || layer.dataType === "reference") continue;
    // Summability is DECLARED, not inferred — see PanoramaLayer.valueKind.
    if ((getLayer(layer.id as LayerId)?.valueKind ?? "count") !== "count") continue;
    hasCountLayer = true;
    if (isTemporalLayer(layer.id as LayerId)) anyPeriodLayer = true;
    for (const f of layer.features.features) {
      const p = f.properties as Record<string, unknown>;
      if (p.suppressed === true) {
        suppressed += 1;
        continue;
      }
      const v = typeof p.value === "number" ? p.value : typeof p.count === "number" ? p.count : 0;
      total += v;
      // Cowork QA ronda 3 §"Consistencia": the header said "en 5 unidades" using
      // mapTableRows.length (which counts rate count-density rows too), so "0
      // eventos en 5 unidades" contradicted itself. Count ONLY the units that
      // actually carry a visible event, so 0 events honestly reads "en 0 unidades".
      if (v > 0) unitsWithEvents += 1;
    }
  }
  return { hasCountLayer, total, suppressed, unitsWithEvents, anyPeriodLayer };
}
