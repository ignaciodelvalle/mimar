"use client";

// PanoramaDockRegistros — the dock's "Registros" pane: the raw per-unit
// projection of what the map paints, plus the disclosures that keep its numbers
// from reading as contradictions of the other panes.
//
// EXTRACTED from PanoramaConsole (RA-7 truth pass, 2026-08-01) under the
// file-size fence's own instruction: split rather than feed a file already over
// budget. Behaviour-preserving — the JSX and copy moved verbatim, only the
// values it used to close over became props.
//
// The disclosures are the point of this pane, not decoration. Each one exists
// because two honest numbers on this board describe DIFFERENT universes and, left
// unnamed, the smaller one reads as a contradiction rather than a narrower claim:
// reference layers that are drawn but never tabulated; a rate shown as a count
// below province grain; per-10k on the map against raw counts here; and the
// k-anon units excluded from the event total (RA-7 F6).

import { memo } from "react";

import { MapDataTableDynamic } from "@/components/panorama/MapDataTableDynamic";
import type { MapTableRow, ValueMetric } from "@/components/panorama/map-table-csv";
import type { DockRecordSummary } from "@/components/panorama/panorama-map-table";
import type { ViewScopeDescriptor } from "@/lib/ui/view-scope-descriptor";

type Props = {
  summary: DockRecordSummary;
  /** Map-only REFERENCE layers (decomisos, refugios) — drawn, never tabulated. */
  referenceLayerLabels: string[];
  /** A rate layer is drilled below province, where its per-unit value is a COUNT. */
  localityRateInView: boolean;
  rows: MapTableRow[];
  caption: string;
  metrics: ValueMetric[];
  truncatedLayers: string[];
  pointModeLayerLabels: string[];
  suppressedUnits: number;
  viewScope: ViewScopeDescriptor | null;
};

const NOTE =
  "rounded-[var(--radius-md)] border border-dashed border-ln-op-line bg-ln-op-card/60 px-3 py-1.5 text-xs text-ln-op-mute";

function PanoramaDockRegistrosImpl({
  summary,
  referenceLayerLabels,
  localityRateInView,
  rows,
  caption,
  metrics,
  truncatedLayers,
  pointModeLayerLabels,
  suppressedUnits,
  viewScope,
}: Props) {
  return (
    <div className="space-y-2">
      {/* Dock redesign (PO ask, consistency + explanation): a one-line caption
          naming what this pane IS — the raw records behind the current filtered
          view — matching the caption idiom used elsewhere in the dock. */}
      <p className="text-xs leading-snug text-ln-op-mute">
        Los registros crudos detrás de la vista filtrada actual.
      </p>
      {/* Cowork QA ronda 3 §3: the EVENT total (Σ cell counts across the active
          count/event layers) — a DIFFERENT concept from the per-unit "Valor por
          unidad" table below. It counts events, not table rows, so "0 eventos" no
          longer sits over a populated value table reading as a contradiction. The
          unit count is units-WITH-events (never the rate count-density rows). */}
      {summary.hasCountLayer && (
        <p className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card/60 px-3 py-1.5 text-xs tabular-nums text-ln-op-ink-2">
          {/* Period-flow layers say "Eventos en el período"; a current-state stock
              (mortalidad, acceso-veterinario) says "Registros (estado actual)" so
              the label matches what the number is (Cursor review). */}
          {summary.anyPeriodLayer ? "Eventos en el período: " : "Registros (estado actual): "}
          {summary.total.toLocaleString("es-AR")} en{" "}
          {summary.unitsWithEvents.toLocaleString("es-AR")}{" "}
          {summary.unitsWithEvents === 1 ? "unidad" : "unidades"}
          {/* RA-7 F6 — DECLARE THE UNIVERSE. These are the cells excluded from the
              total on THIS line, not the view's protected cells: the legend pill
              publishes a view-wide, larger figure. Both used to read "N protegidas
              por k-anonimato", so they looked like two answers to one question. */}
          {summary.suppressed > 0 &&
            ` (+${summary.suppressed.toLocaleString("es-AR")} ${
              summary.suppressed === 1
                ? "unidad protegida por k-anonimato, no incluida en este total"
                : "unidades protegidas por k-anonimato, no incluidas en este total"
            })`}
        </p>
      )}
      {referenceLayerLabels.length > 0 && (
        <p className={NOTE}>
          {referenceLayerLabels.length === 1
            ? `${referenceLayerLabels[0]} se muestra solo en el mapa (capa de referencia); no se tabula en Registros.`
            : `${referenceLayerLabels.join(" y ")} se muestran solo en el mapa (capas de referencia); no se tabulan en Registros.`}
        </p>
      )}
      {localityRateInView && (
        <p className={NOTE}>
          La cobertura por unidad se muestra como conteo; el porcentaje se calcula solo a nivel
          provincia.
        </p>
      )}
      {rows.length > 0 && <p className="text-xs font-medium text-ln-op-ink-2">Valor por unidad</p>}
      <MapDataTableDynamic
        rows={rows}
        caption={caption}
        filename="panorama-mapa"
        metrics={metrics}
        truncatedLayers={truncatedLayers}
        // Finding 2: WHY the table is empty, when it is — the near-zoom points
        // band, or k-anon protection. Never a bare "sin datos".
        pointModeLayers={pointModeLayerLabels}
        suppressedUnits={suppressedUnits}
        // V2: the CSV carries its scope as an OBJECT in a `#` header block, so a
        // file that outlives this screen can still be regenerated from itself.
        viewScope={viewScope}
      />
    </div>
  );
}

// memo(): this pane is always mounted in the dock (PanoramaConsole re-renders
// 3-4x/1100ms in play mode). NOTE: `referenceLayerLabels` and `metrics` are
// built with a fresh `.filter()/.map()` at the PanoramaConsole call site (not
// useMemo'd) — those two props defeat the shallow-equal bailout on every
// re-render even with this wrapper in place. Every other prop IS memoized
// upstream (perf sweep 2026-08-02).
export const PanoramaDockRegistros = memo(PanoramaDockRegistrosImpl);
