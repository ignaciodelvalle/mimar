// case-queue-csv — the CSV projection of CaseQueue rows (Q1, CSV export
// parity). Server-safe (no "use client"): both casos twins (/gob/casos and
// /admin/casos) call this from their server components and hand the result to
// <CsvExportLink>, so the two queues can never drift into different exports
// of the same table.
//
// Cell vocabulary mirrors CaseQueue's own cells exactly — caseKindLabel,
// caseStatusDisplay, the "Animal sin registrar" fallback for unowned
// subjects, the "locality, province" join — because the export's contract is
// "exactly what the screen shows", not a second rendering.
//
// ORDER NOTE: rows are exported in the SERVER order, whatever it is. On the
// casos twins that is now the ACTIVE sort (SC-6, 2026-08-07: `?orden=` reaches
// the SQL ORDER BY), so the file and the screen agree; on surfaces whose queue
// still re-sorts its page client-side it is openedAt desc. Either way the order
// is declared in a `#` context line (caseQueueCsvOrderNote) rather than left
// for the reader to guess from a file that does not carry the inputs to verify
// it.

import type { CaseQueueRow } from "@/components/ui/dashboard/CaseQueue";
import { caseStatusDisplay } from "@/components/ui/dashboard/CaseStatusBadge";
import type { CaseQueueSort } from "@/lib/ui/case-queue-order";
import { formatDate } from "@/lib/utils/format";
import { caseKindLabel } from "@/src/modules/cases/domain/case-kinds";

// Columns mirror CaseQueue's own table exactly (no "Cierre" — the queue lists
// open cases and never renders a closure column; review 2026-08-02).
export const CASE_QUEUE_CSV_COLUMNS = [
  "Código",
  "Tipo",
  "Estado",
  "Mascota",
  "Jurisdicción",
  "Apertura",
];

/**
 * The `#` context line declaring what order the exported rows are in.
 *
 * Takes the ACTIVE sort (2026-08-07, SC-6). It used to be a constant claiming
 * "apertura más reciente primero" unconditionally, which was true while the
 * server always ordered by date and only the screen re-sorted. Now the casos
 * screens push the sort into SQL, so the file really does carry urgency order
 * when that is the active mode — and a fixed note would have started lying in
 * the opposite direction (understating what the file contains).
 *
 * Surfaces with no server-side sort omit the argument and keep the old line.
 */
export function caseQueueCsvOrderNote(sort: CaseQueueSort = "recientes"): string {
  return sort === "urgencia"
    ? "# Orden del archivo: urgencia (días desde la apertura × gravedad del tipo), los casos cerrados al final"
    : "# Orden del archivo: apertura más reciente primero";
}

/** One CSV row per queue row, cell-for-cell what CaseQueue renders. */
export function caseQueueCsvRows(rows: CaseQueueRow[]): string[][] {
  return rows.map((row) => [
    row.publicCode,
    caseKindLabel(row.caseKind),
    caseStatusDisplay(row.status).label,
    row.primaryPetName ??
      (row.primarySubjectKind === "unowned_animal" ? "Animal sin registrar" : "—"),
    row.jurisdictionLocality && row.jurisdictionProvince
      ? `${row.jurisdictionLocality}, ${row.jurisdictionProvince}`
      : (row.jurisdictionProvince ?? "—"),
    formatDate(row.openedAt),
  ]);
}
