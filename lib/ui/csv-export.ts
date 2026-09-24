// csv-export — the shared CSV text builder for operator list/queue screens
// (Lote Q, Q1: CSV export parity).
//
// WHY THIS MODULE EXISTS
// ---------------------------------------------------------------------------
// The CSV affordance existed 9× before this file, in two idioms:
//
//   1. Server route (`app/gob/censo/export/route.ts` + siblings) — re-derives
//      the SAME aggregates the screen fetched, via the same disclosure-decided
//      fetchers (buildSectionedCsv / csvDownloadResponse). Right for aggregate
//      dashboards whose export must carry k-anon verdicts made upstream.
//   2. Client blob (`components/panorama/MapDataTable.tsx` buildMapTableCsv +
//      useMapTableCsvHref) — builds the file from the ROWS ALREADY ON SCREEN,
//      as an in-memory Blob URL. No new endpoint, no second query, and — the
//      property this rollout leans on — the export CANNOT be wider than the
//      screen, because it is built from the screen's own rendered values.
//
// The ~30 OpFilterBar queue screens without an export (denuncias/maltrato,
// casos, moderación, perdidas, observaciones…) show PAGE-scoped, row-level
// records the operator is already authorized to read. For those, idiom 2 is
// the honest generalization: exporting exactly the rendered page means a
// suppressed or redacted cell exports as its on-screen text (never a raw
// value), and a keyset-paginated queue exports its PAGE, declared as such in
// the `#` context block — never a silently-wider set.
//
// This module is the PURE half (unit-testable, no DOM): field escaping and
// line assembly, mirroring buildMapTableCsv's discipline (RFC 4180 escaping,
// CRLF line endings, `#` comment lines ABOVE the column header so a truncated
// read still carries its context). The Blob/anchor half lives in
// components/ui/dashboard/CsvExportLink.tsx.
//
// English identifiers, es-AR user copy in the callers (project invariant #4).

import { neutralizeCsvFormula } from "@/lib/utils/csv-formula";

/** Escape one CSV field: wrap in quotes and double any embedded quote when the
 * field contains a comma, quote, or newline (RFC 4180 — same rule
 * buildMapTableCsv applies; duplicated 3 lines rather than importing from
 * components/panorama/**, which is read-only reference territory). */
export function csvField(value: string): string {
  // Formula neutralisation FIRST, then the RFC 4180 decision — a payload that
  // gains a leading `'` must still be quoted if it also contains a comma.
  //
  // Everything reaching here is already a display string (the contract above:
  // "values EXACTLY as the screen displays them"), so there is no JS number to
  // exempt by type. That is why `value` is passed as both arguments: the
  // numeric exemption in `lib/utils/csv-formula.ts` is correct and simply does
  // not apply on this path. These seven operator queues carry free-text case
  // and observation descriptions straight to a funcionario's spreadsheet, which
  // is the reachable half of that file's threat model.
  const cell = neutralizeCsvFormula(value, value);
  return /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

export type OperatorCsvInput = {
  /** Column headers, in render order. Fixed per screen — two exports of the
   * same screen must be diffable, so callers never make headers conditional
   * on the rows (the MapDataTable CSV_HEADER rule). */
  columns: readonly string[];
  /** One string[] per rendered row, values EXACTLY as the screen displays
   * them (labels, formatted dates, suppressed-cell text) — never raw values
   * the screen chose not to show. */
  rows: ReadonlyArray<readonly string[]>;
  /**
   * `#` comment lines prepended ABOVE the column header: scope, active
   * filters, and — on a paginated queue — the "page N rows of M total"
   * disclosure, so a partial export never travels looking complete. A line
   * already starting with "#" is kept verbatim; anything else is prefixed.
   */
  contextLines?: readonly string[];
};

/**
 * Build the CSV text (context block + header + rows). Pure — unit-tested.
 * CRLF line endings, matching every existing export in the repo.
 */
export function buildOperatorCsv(input: OperatorCsvInput): string {
  const lines: string[] = [];
  for (const raw of input.contextLines ?? []) {
    lines.push(raw.startsWith("#") ? raw : `# ${raw}`);
  }
  lines.push(input.columns.map(csvField).join(","));
  for (const row of input.rows) {
    lines.push(row.map(csvField).join(","));
  }
  return lines.join("\r\n");
}

/**
 * The "page vs total" honesty line for a paginated queue export. Emitted by
 * every keyset-paginated caller so the file itself says it is a page — the
 * same disclosure discipline as MapDataTable's truncated-layer comments.
 * Returns null when the export IS the whole filtered set (nothing to declare).
 */
export function csvPageDisclosure(shownRows: number, totalRows: number): string | null {
  if (totalRows <= shownRows) return null;
  const fila = shownRows === 1 ? "fila" : "filas";
  return `# Exportando la página visible: ${shownRows.toLocaleString("es-AR")} ${fila} de ${totalRows.toLocaleString("es-AR")} en total — paginá para exportar el resto`;
}
