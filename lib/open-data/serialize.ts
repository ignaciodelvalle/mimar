// Serialization for the public open-data downloads (Epic B, item 2).
//
// Two formats, one metadata contract. Both carry the dataset's license,
// generated-at, methodology + dictionary URLs and suppression rule so a
// downloaded file is self-describing offline (not only via HTTP headers).
//
// Pure (no DB, no Next.js) so the framing is unit-testable directly.

import type { BuiltDataset } from "@/lib/open-data/datasets";
import { SUPPRESSED_MARKER } from "@/lib/open-data/province-suppression";
import { neutralizeCsvFormula } from "@/lib/utils/csv-formula";

export type DatasetFormat = "csv" | "json";

/** Parse the ?format= query value. Anything but "csv" falls back to JSON. */
export function parseFormat(value: string | null | undefined): DatasetFormat {
  return value === "csv" ? "csv" : "json";
}

/** Quote one CSV cell per RFC 4180 (comma / newline / embedded double quote),
 *  AND always quote the exact suppression-marker value even though it
 *  contains none of those triggers. A suppressed cell is a privacy signal,
 *  not ordinary data; quoting it unconditionally keeps it visually and
 *  mechanically distinct from a real value for any downstream CSV consumer.
 *  Mirrors lib/analytics/govt-exports.ts's rowsToCsv escaping otherwise — kept
 *  as a local variant (not a shared-function option) so this stricter rule
 *  never changes behavior for the unrelated authenticated exports that reuse
 *  rowsToCsv. */
function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  // Neutralise BEFORE the quoting decision. This dataset is PUBLIC — the file
  // is downloadable by anyone and opened in a spreadsheet by most of them.
  const str = neutralizeCsvFormula(value, raw);
  if (str === SUPPRESSED_MARKER || str.includes(",") || str.includes("\n") || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** RFC 4180 table for the dataset rows, with the suppression marker always
 *  quoted (see csvCell). */
function rowsToCsvWithQuotedMarker(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvCell(row[h])).join(","));
  }
  return lines.join("\r\n");
}

/**
 * CSV document: UTF-8 BOM (Excel), then a metadata preamble as `#` comment
 * lines, a blank line, then the RFC 4180 table. Suppressed cells are already
 * the literal marker string in `rows`; the marker is always quoted in the
 * exported table (see rowsToCsvWithQuotedMarker).
 */
export function datasetToCsv(built: BuiltDataset): string {
  const { meta, rows } = built;
  const preamble = [
    `# ${meta.title}`,
    `# dataset: ${meta.id}`,
    `# descripcion: ${meta.summary}`,
    `# unidad: ${meta.unit}`,
    `# actualizacion: ${meta.cadence}`,
    `# generado: ${meta.generatedAt}`,
    `# licencia: ${meta.license.name}`,
    `# licencia_url: ${meta.license.url}`,
    `# atribucion: ${meta.license.attribution}`,
    `# metodologia: ${meta.methodologyUrl}`,
    `# diccionario: ${meta.dictionaryUrl}`,
    `# supresion: k=${meta.suppression.k}; ${meta.suppression.rule}`,
    `# filas: ${meta.rowCount} (suprimidas: ${meta.suppressedCount})`,
  ].join("\r\n");
  const table = rowsToCsvWithQuotedMarker(rows);
  return `﻿${preamble}\r\n\r\n${table}\r\n`;
}

/** JSON document: `{ meta, data }`. The metadata block is identical to CSV's
 *  preamble content, structured. */
export function datasetToJson(built: BuiltDataset): string {
  return JSON.stringify({ meta: built.meta, data: built.rows }, null, 2);
}
