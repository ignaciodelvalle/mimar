"use client";

// MapDataTable — the accessible ("Ley 26.653") table view of the situational
// MAP's active layers, per administrative unit.
//
// The map is the LEAST accessible surface: a WebGL canvas whose aria-label is
// only a point count. The right-rail RankedUnitsPanel/PanoramaDataTable already
// tabulate the single RANKED base layer; this table instead mirrors EVERY active
// aggregate layer's per-unit value the map is painting, right next to the map,
// so a screen-reader or keyboard user reads the same numbers — plus a client-side
// CSV download (no new endpoint; a <a download> over an in-memory Blob).
//
// PRIVACY (invariant §5): a k-anon-suppressed cell renders "Protegido (k<5)",
// NEVER a number — the same trichotomy the map legend and pinned popup keep.
//
// English identifiers, es-AR user copy (project invariant #4).
//
// El contrato de datos —`MapTableRow`, `ValueMetric`, el armado del CSV y su
// hook— vive en `map-table-csv.ts` desde el Lote E paso 2, porque la CONSOLA lo
// necesita siempre y este COMPONENTE sólo cuando el operador abre el pane
// "Registros". Ver ese archivo para por qué la costura quedó ahí.

import { useMemo } from "react";

import {
  type MapTableRow,
  type ValueMetric,
  mapTableValueHeader,
  useMapTableCsvHref,
} from "@/components/panorama/map-table-csv";
import type { ViewScopeDescriptor } from "@/lib/ui/view-scope-descriptor";

type Props = {
  rows: MapTableRow[];
  /** es-AR table caption naming the active scope + period (auditable context). */
  caption: string;
  /** CSV download filename (without extension). */
  filename: string;
  /**
   * Active aggregate metrics (label + dataType + level) — lets the table NAME the
   * "Valor" column after the metric it shows and its true unit. Absent → the
   * column keeps the generic "Valor" header (backward compatible).
   */
  metrics?: ValueMetric[];
  /**
   * Labels of active layers whose fetch hit the server row cap (2000) — the
   * CSV export appends a per-layer truncation comment so a capped layer never
   * exports looking complete. Absent/empty → no comment lines.
   */
  truncatedLayers?: string[];
  /**
   * UX audit 2026-07-26 (finding 2) — labels of active layers that WOULD tabulate
   * but are currently painting individual records (the near-zoom points band), so
   * they contribute no per-unit cells.
   *
   * Live repro (CABA · vista Bienestar): the CABA inset drill lands the camera at
   * z=11, denuncias flips to points, this table gets zero rows and used to print
   * "Sin datos por unidad" — beside a KPI reading 39 denuncias, ~20 bubbles on the
   * map and an Estadísticas ranking saying "20 comunas SÍ reportaron". Zooming out
   * one step (z=9) restored 21 rows from the SAME scope and period. "Sin datos" is
   * a claim about the world; that was a fact about the zoom.
   */
  pointModeLayers?: string[];
  /**
   * How many in-scope units reported but had to be withheld by k-anonymity. Same
   * epistemic split PanoramaDataTable's `rankingEmptyState` keeps: "protected" and
   * "nobody reported" are OPPOSITE states and must never share one sentence.
   */
  suppressedUnits?: number;
  /**
   * V2 — the serializable scope the exported CSV carries in its `#` header
   * block. Absent → a pre-V2 (prose-only) export.
   */
  viewScope?: ViewScopeDescriptor | null;
};

/**
 * Why this table is empty, in es-AR — the three causes the old single sentence
 * collapsed into one blind "no hay datos". Pure, so the branches are testable
 * without a DOM.
 */
export function mapTableEmptyMessage(input: {
  pointModeLayers: string[];
  suppressedUnits: number;
}): string {
  const { pointModeLayers, suppressedUnits } = input;
  if (pointModeLayers.length > 0) {
    const named = pointModeLayers.length === 1 ? pointModeLayers[0] : pointModeLayers.join(" y ");
    return `A este nivel de zoom, ${named} se dibuja${pointModeLayers.length === 1 ? "" : "n"} como registros individuales, no como valores por unidad. Alejá el mapa para volver a la tabla por unidad — no es que no haya datos.`;
  }
  if (suppressedUnits > 0) {
    // RA-7 F6 — DECLARE THE UNIVERSE. `suppressedUnits` is Σ over the layers that
    // FEED THIS TABLE (sumSuppressedTableUnits), not the view's protected-cell
    // total that the legend pill publishes. "del alcance" claimed the wider one.
    return `${suppressedUnits.toLocaleString("es-AR")} unidades de las capas de esta tabla SÍ reportaron, pero sus valores son tan bajos que mostrarlos identificaría casos (k<5). Hay señal; no se puede publicar al detalle.`;
  }
  return "Sin datos por unidad para las capas activas en este alcance.";
}

export function MapDataTable({
  rows,
  caption,
  filename,
  metrics,
  truncatedLayers,
  pointModeLayers = [],
  suppressedUnits = 0,
  viewScope = null,
}: Props) {
  const href = useMapTableCsvHref(rows, truncatedLayers, viewScope);
  // Round-2 review #3a: the Capa column repeats the SAME value on every row
  // when a single layer is active — zero information, pure noise. Derive the
  // count straight from the rows already in scope (no new prop): when 2+
  // distinct layers actually produced rows, Capa disambiguates them and stays;
  // with exactly one, drop the column (the CSV export keeps Capa regardless —
  // a self-contained file has no adjacent context to lean on).
  const rowLabels = useMemo(() => new Set(rows.map((r) => r.layer)), [rows]);
  const showLayerColumn = rowLabels.size > 1;
  // Same rows-derived gating as Capa: with no compliance target in view the
  // column would be empty on every row — noise next to the map. The CSV header
  // stays fixed regardless (two exports of the same board must be diffable);
  // an on-screen table has no such contract.
  const showGapColumn = useMemo(() => rows.some((r) => r.gap !== undefined), [rows]);
  // CSS-5: table-layout:fixed pins column widths so they stop recomputing from
  // content on every period/layer change (the columns visibly jumped while an
  // operator scrubbed the timeline). Widths are chosen per the columns actually
  // shown (showLayerColumn / showGapColumn already gate that) — from Tailwind's
  // default fraction scale, never an arbitrary value.
  const columnWidths = showLayerColumn
    ? showGapColumn
      ? { layer: "w-1/5", unit: "w-2/5", value: "w-1/5", gap: "w-1/5" }
      : { layer: "w-1/4", unit: "w-1/2", value: "w-1/4", gap: "" }
    : showGapColumn
      ? { layer: "", unit: "w-1/2", value: "w-1/4", gap: "w-1/4" }
      : { layer: "", unit: "w-2/3", value: "w-1/3", gap: "" };
  // Cowork QA ronda 3 §3: the "Valor" column never named its metric — with a
  // single metric in view, name it (and its true unit) so "204" is not read as a
  // bare, unlabeled number. With several metrics the Capa column already
  // disambiguates, so the column stays a generic "Valor".
  const valueHeader = useMemo(() => {
    if (rowLabels.size !== 1 || !metrics) return "Valor";
    const [only] = rowLabels;
    const metric = metrics.find((m) => m.label === only);
    return metric ? mapTableValueHeader([metric]) : "Valor";
  }, [rowLabels, metrics]);

  if (rows.length === 0) {
    return (
      <p className="text-xs leading-snug text-ln-op-mute">
        {mapTableEmptyMessage({ pointModeLayers, suppressedUnits })}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-ln-op-mute">{rows.length} filas</p>
        {href !== null && (
          <a
            href={href}
            download={`${filename}.csv`}
            className="rounded-[var(--radius-sm)] border border-ln-op-line bg-ln-op-card px-2 py-0.5 text-xs font-medium text-ln-op-ink-2 hover:border-ln-op-azul/40"
          >
            Descargar CSV
          </a>
        )}
      </div>
      {/* L-19: the scroll container is keyboard-focusable (axe
          scrollable-region-focusable) — a table taller than max-h-80 was
          mouse-scroll-only. A named <section> is a region; the caption doubles
          as its accessible name. Same shape as Ledger.tsx's scroll container:
          a scrollable region is the documented exception to the tabindex rule
          (WCAG 2.1.1 — without a tab stop a keyboard user can never scroll). */}
      <section
        // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region, see above
        tabIndex={0}
        aria-label={caption}
        className="max-h-80 overflow-auto rounded-[var(--radius-md)] border border-ln-op-line"
      >
        <table className="w-full table-fixed border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>
          <colgroup>
            {showLayerColumn && <col className={columnWidths.layer} />}
            <col className={columnWidths.unit} />
            <col className={columnWidths.value} />
            {showGapColumn && <col className={columnWidths.gap} />}
          </colgroup>
          <thead className="sticky top-0 bg-ln-op-card">
            <tr className="border-b border-ln-op-line text-xs uppercase tracking-[0.08em]">
              {showLayerColumn && (
                <th scope="col" className="px-2 py-1 text-left font-bold text-ln-op-ink-2">
                  Capa
                </th>
              )}
              <th scope="col" className="px-2 py-1 text-left font-bold text-ln-op-ink-2">
                Unidad
              </th>
              <th scope="col" className="px-2 py-1 text-right font-bold text-ln-op-ink-2">
                {valueHeader}
              </th>
              {showGapColumn && (
                <th scope="col" className="px-2 py-1 text-right font-bold text-ln-op-ink-2">
                  Brecha vs meta
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                // Rows can repeat (layer, unit) across levels; index keeps keys
                // stable for this read-only projection.
                key={`${row.layer} ${row.unit} ${i}`}
                className="border-b border-ln-op-line/50"
              >
                {showLayerColumn && (
                  <td title={row.layer} className="truncate px-2 py-1 text-ln-op-ink-2">
                    {row.layer}
                  </td>
                )}
                <th
                  scope="row"
                  title={row.unit}
                  className="truncate px-2 py-1 text-left font-normal text-ln-op-ink"
                >
                  {row.unit}
                </th>
                <td className="px-2 py-1 text-right tabular-nums text-ln-op-ink-2">{row.value}</td>
                {showGapColumn && (
                  // No target → EMPTY, never "0": a zero here would read as
                  // "exactly on target", the opposite of "no hay comparación".
                  <td className="px-2 py-1 text-right tabular-nums text-ln-op-ink-2">
                    {row.gap ?? ""}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
