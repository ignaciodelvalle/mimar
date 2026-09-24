"use client";

// map-table-csv — el contrato de datos de la tabla del mapa, separado del
// componente que la dibuja (Lote E, paso 2).
//
// POR QUÉ EXISTE ESTE ARCHIVO. `PanoramaConsole` necesita `useMapTableCsvHref`
// para el botón "Exportar CSV" de la barra del dock, y lo necesita SIEMPRE —
// esa barra está montada aunque el pane "Registros" nunca se abra. Mientras el
// hook vivía dentro de `MapDataTable.tsx`, ese import obligaba a que la tabla
// entera —tipos, JSX, estados vacíos, ~130 líneas de componente— viajara en el
// bundle de la ruta aunque nadie abriera el tab. Diferir el componente sin
// mover antes el hook no habría bajado un solo byte: el módulo seguía enganchado
// por su otra punta.
//
// La frontera quedó donde estaba la costura real: acá vive lo que la CONSOLA
// usa (tipos + construcción del CSV), y en `MapDataTable.tsx` lo que sólo el
// PANE usa (el componente y su copy de estado vacío).
//
// A PROPÓSITO NO HAY RE-EXPORTS desde `MapDataTable.tsx`. Un re-export de
// conveniencia dejaría que un import futuro de `buildMapTableCsv` desde el
// módulo del componente volviera a atar las dos mitades sin que se note. La
// reja de peso de ruta lo atraparía, pero preferimos que no haya nada que
// atrapar.

import { useEffect, useMemo, useState } from "react";

import { type ViewScopeDescriptor, viewScopeCsvHeaderLines } from "@/lib/ui/view-scope-descriptor";
import { neutralizeCsvFormula } from "@/lib/utils/csv-formula";

/** One per-unit cell of an active layer, as the table (and CSV) render it. */
export type MapTableRow = {
  /** Layer name — disambiguates a multi-layer table. */
  layer: string;
  /** Administrative unit name (province / locality / department). */
  unit: string;
  /**
   * The value WITH its unit ("64,4 %" | "1.234"), or the protected/no-data text.
   * `protected` cells carry "Protegido (k<5)" here — never a number.
   */
  value: string;
  /**
   * The signed distance to the layer's compliance target ("−15,6"), for the rows
   * that HAVE one: an unsuppressed province-grain rate. Absent everywhere else —
   * a count has no target, a locality-grain rate is a count, and a protected
   * cell has no value to compare. Rendered by BOTH buildMapTableCsv and the
   * on-screen "Brecha vs meta" column: this table is the accessible mirror of a
   * WebGL canvas, so shipping the gap only to the CSV and the hover popup handed
   * a screen-reader user the value but not the comparison — the very asymmetry
   * the table exists to fix.
   */
  gap?: string;
};

/** Descriptor of one active aggregate metric — used to NAME the "Valor" column
 * after the metric it actually shows (and its true unit). */
export type ValueMetric = {
  /** Layer label — matches MapTableRow.layer so a row's metric can be looked up. */
  label: string;
  dataType?: "rate" | "density" | "signal" | "reference";
  level?: "province" | "locality";
};

/**
 * Name the "Valor" column after the SINGLE contributing metric + its true unit,
 * or a generic "Valor" when several metrics interleave (the Capa column
 * disambiguates them and each cell already carries its own unit).
 *
 * DATA-TRUTH (cowork QA ronda 3 §3): a `rate` metric is a percentage ONLY at
 * province grain. At locality grain the repository returns a per-unit COUNT
 * (rate-by-locality is deferred — repository.ts "V1 LIMITATION"), so the header
 * says "(conteo)", never a false "%". Density/signal metrics are counts too.
 */
export function mapTableValueHeader(metrics: ValueMetric[]): string {
  if (metrics.length !== 1) return "Valor";
  const [m] = metrics;
  if (m.dataType === "rate") {
    return m.level === "province" ? `${m.label} (%)` : `${m.label} (conteo)`;
  }
  return `${m.label} (conteo)`;
}

// "Brecha vs meta" is fixed, not conditional on the rows: a stable header is
// what makes two exports of the same board diffable. Rows without a target
// leave the field EMPTY — an absent comparison, never a "0" that would read as
// "exactly on target".
const CSV_HEADER = ["Capa", "Unidad", "Valor", "Brecha vs meta"] as const;

/** Escape one CSV field: wrap in quotes and double any embedded quote when the
 * field contains a comma, quote, or newline (RFC 4180), after neutralising
 * anything a spreadsheet would evaluate as a formula. Locality names are the
 * free text on this path — see `lib/utils/csv-formula.ts`. */
function csvField(value: string): string {
  // Every value here is already a display string, so the numeric exemption in
  // csv-formula.ts does not apply — hence `value` twice.
  const cell = neutralizeCsvFormula(value, value);
  return /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/**
 * Build the CSV text (header + rows) for the map table. Pure — unit-tested.
 *
 * DATA-TRUTH: a layer whose server fetch hit the 2000-row cap must NOT export
 * looking complete — `truncatedLayers` (labels of capped layers) appends one
 * `#`-comment line per capped layer so the self-contained file carries the
 * same disclosure the on-screen layer panel shows.
 *
 * The "Brecha vs meta" column (backlog item 10, 2026-07-25) carries the same
 * signed gap the pinned popup prints inline as "meta 80% · −15,6". On screen
 * that comparison is one hover away; in a file handed to someone else it is
 * unreachable, which left the export unable to answer the one question a
 * compliance layer exists to answer.
 *
 * V2 — `viewScope` prepends the serializable scope descriptor as a `#` comment
 * block ABOVE the column header (see lib/ui/view-scope-descriptor.ts for why an
 * inline block beats a sidecar file, and why the block goes first). A file
 * exported without it stays byte-identical to the pre-V2 export, so every
 * existing consumer and golden keeps working.
 */
export function buildMapTableCsv(
  rows: MapTableRow[],
  truncatedLayers: string[] = [],
  viewScope?: ViewScopeDescriptor | null,
): string {
  const lines = viewScope ? [...viewScopeCsvHeaderLines(viewScope)] : [];
  lines.push(CSV_HEADER.join(","));
  for (const r of rows) {
    lines.push(
      [csvField(r.layer), csvField(r.unit), csvField(r.value), csvField(r.gap ?? "")].join(","),
    );
  }
  for (const label of truncatedLayers) {
    lines.push(`# Capa ${label} truncada: mostrando los 2000 registros más recientes`);
  }
  return lines.join("\r\n");
}

/**
 * Build the map table's CSV as an in-memory Blob URL (same-origin — the strict
 * CSP allows it; no network, no endpoint). Rebuilt when the rows change;
 * revoked on unmount / rebuild so the object URL never leaks. Exported so the
 * v2C dock bar's "Exportar CSV" action shares the exact same artifact as the
 * Registros pane's download link (one CSV builder, two affordances).
 */
export function useMapTableCsvHref(
  rows: MapTableRow[],
  truncatedLayers: string[] = [],
  viewScope?: ViewScopeDescriptor | null,
): string | null {
  const csv = useMemo(
    () => buildMapTableCsv(rows, truncatedLayers, viewScope),
    [rows, truncatedLayers, viewScope],
  );
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined" || rows.length === 0) {
      setHref(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    setHref(url);
    return () => URL.revokeObjectURL(url);
  }, [csv, rows.length]);
  return href;
}
