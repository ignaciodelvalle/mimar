"use client";

// CsvExportLink — the shared "Exportar CSV →" action for operator queue
// screens (Lote Q, Q1: CSV export parity).
//
// Client half of lib/ui/csv-export.ts: takes the SERVER-RENDERED page rows
// (already formatted exactly as the screen displays them) and serves them as
// an in-memory Blob download — the same same-origin, no-endpoint mechanism as
// MapDataTable's useMapTableCsvHref (strict CSP allows blob:; no network).
//
// PRIVACY / k-ANON DISCIPLINE: this component never fetches. It can only
// export the strings the server component chose to render, so an export is
// EXACTLY the rows on screen — a suppressed cell exports as its on-screen
// text, and a paginated queue exports its page (callers declare that in
// `contextLines` via csvPageDisclosure). Widening the export requires
// widening the screen first, which is the point.
//
// Placement: the OpFilterBar `actions` slot — the same header position the
// route-based "Exportar CSV →" links (gob/censo, poblacion…) already occupy,
// with the same anchor styling, so the two idioms are indistinguishable to
// the operator.

import { useEffect, useMemo, useState } from "react";

import { buildOperatorCsv } from "@/lib/ui/csv-export";

type Props = {
  /** Download filename WITHOUT the .csv extension (e.g. "casos-2026-08-02"). */
  filename: string;
  /** Column headers, fixed per screen (see lib/ui/csv-export.ts). */
  columns: readonly string[];
  /** One string[] per rendered row — values exactly as displayed. */
  rows: ReadonlyArray<readonly string[]>;
  /** `#` context block above the header (scope, filters, page disclosure). */
  contextLines?: readonly string[];
};

/**
 * Blob-URL lifecycle mirrors useMapTableCsvHref: rebuilt when the content
 * changes, revoked on unmount/rebuild so the object URL never leaks. With no
 * rows there is nothing to hand out — the link does not render (same choice
 * as MapDataTable; an empty file would just be a confusing artifact).
 */
export function CsvExportLink({ filename, columns, rows, contextLines }: Props) {
  const csv = useMemo(
    () => buildOperatorCsv({ columns, rows, contextLines }),
    [columns, rows, contextLines],
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

  if (href === null) return null;

  return (
    <a href={href} download={`${filename}.csv`} className="text-md text-ln-op-azul hover:underline">
      Exportar CSV →
    </a>
  );
}
