// SENASA / LSUCyF batch export — format-agnostic pipeline (pure core).
//
// See dim-interno:docs/design/sdd/2026-07-07-senasa-lsucyf-batch-export.md.
//
// This module is the PURE core of the SENASA export: types, vocabulary
// resolution, the privacy-allowlisting transform, the pluggable formatter
// interface, and a CSV baseline formatter. It imports NO database — the scoped
// gather lives in senasa-export-query.ts (the IO stage). Keeping this file
// db-free makes the transform + formatters unit-testable without a connection.
//
// CRITICAL — the real SENASA on-the-wire format is NOT known. Everything here
// is defined by OUR aligned schema (ref.* vocab + the SENASA columns on
// pet_events, migration 0061), which is knowable today. The unknown byte layout
// is isolated behind SenasaFormatter; the real formatter drops into
// SENASA_FORMATTERS with zero upstream change once the homologation spec lands.

import { rowsToCsv } from "@/lib/analytics/govt-exports";
import {
  VIA_APLICACION,
  type ViaAplicacionCode,
  tipoEventoLabel,
  tipoEventoNorma,
} from "@/lib/reference/sanitary-vocab";

// ---------------------------------------------------------------------------
// Input row — what the query stage (senasa-export-query.ts) selects.
// Kept as a plain shape (not a Drizzle inference) so this module stays db-free
// and the transform is testable with hand-built fixtures.
// ---------------------------------------------------------------------------

export type SenasaEventRow = {
  /** pets.public_token — the opaque animal identifier (NEVER owner identity). */
  animalToken: string;
  species: string;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  /** pet_events.occurred_at — the clinical date. */
  occurredAt: Date;
  /** pet_events.tipo_evento_code — the SENASA sanitary-event vocabulary code. */
  tipoEventoCode: string;
  loteBiologico: string | null;
  laboratorio: string | null;
  /** date column → ISO "YYYY-MM-DD" string from postgres. */
  vencimientoBiologico: string | null;
  viaAplicacionCode: string | null;
  vetMatricula: string | null;
  vetJurisdiccionCode: string | null;
  establecimientoRenspa: string | null;
  /** date column → ISO "YYYY-MM-DD" string. */
  proximaDosisAt: string | null;
};

// ---------------------------------------------------------------------------
// Canonical row — the neutral, format-agnostic shape (privacy allowlist).
// Physically cannot carry owner PII: those fields are never mapped in.
// ---------------------------------------------------------------------------

export type SenasaCanonicalRow = {
  animal_token: string;
  species: string;
  jurisdiction_province: string | null;
  jurisdiction_locality: string | null;
  /** YYYY-MM-DD (date only — no time, no precise location). */
  occurred_on: string;
  tipo_evento_code: string;
  /** Resolved es-AR label via sanitary-vocab (self-describing, formatter-agnostic). */
  tipo_evento_label: string | null;
  /** Legal norm of origin via sanitary-vocab. */
  tipo_evento_norma: string | null;
  lote_biologico: string | null;
  laboratorio: string | null;
  vencimiento_biologico: string | null;
  via_aplicacion_code: string | null;
  via_aplicacion_label: string | null;
  vet_matricula: string | null;
  vet_jurisdiccion_code: string | null;
  establecimiento_renspa: string | null;
  proxima_dosis_on: string | null;
};

const VIA_INDEX = new Map<string, string>(VIA_APLICACION.map((v) => [v.code, v.labelEs]));

function viaAplicacionLabel(code: string | null): string | null {
  if (!code) return null;
  return VIA_INDEX.get(code as ViaAplicacionCode) ?? null;
}

/** Formats a Date as YYYY-MM-DD (UTC-stable — the clinical date, not a moment). */
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Transform — the privacy boundary. Raw event → canonical row.
// ---------------------------------------------------------------------------

/** Transform one gathered event into a neutral, export-safe canonical row. */
export function toSenasaCanonicalRow(row: SenasaEventRow): SenasaCanonicalRow {
  return {
    animal_token: row.animalToken,
    species: row.species,
    jurisdiction_province: row.jurisdictionProvince,
    jurisdiction_locality: row.jurisdictionLocality,
    occurred_on: toIsoDate(row.occurredAt),
    tipo_evento_code: row.tipoEventoCode,
    tipo_evento_label: tipoEventoLabel(row.tipoEventoCode),
    tipo_evento_norma: tipoEventoNorma(row.tipoEventoCode),
    lote_biologico: row.loteBiologico,
    laboratorio: row.laboratorio,
    vencimiento_biologico: row.vencimientoBiologico,
    via_aplicacion_code: row.viaAplicacionCode,
    via_aplicacion_label: viaAplicacionLabel(row.viaAplicacionCode),
    vet_matricula: row.vetMatricula,
    vet_jurisdiccion_code: row.vetJurisdiccionCode,
    establecimiento_renspa: row.establecimientoRenspa,
    proxima_dosis_on: row.proximaDosisAt,
  };
}

/** Batch transform. */
export function toSenasaCanonicalRows(rows: SenasaEventRow[]): SenasaCanonicalRow[] {
  return rows.map(toSenasaCanonicalRow);
}

// ---------------------------------------------------------------------------
// Pluggable formatter
// ---------------------------------------------------------------------------

/**
 * Incremental serializer — the half of a formatter a STREAMED download needs.
 *
 * `open()` and `close()` run exactly once, around any number of `write()`
 * calls, so a document with a preamble (a CSV header, an XML root element) or
 * a trailer can still be produced without ever holding every row at once.
 *
 * Concatenating `open() + write(a) + write(b) + close()` MUST equal
 * `format([...a, ...b])` byte for byte. That is not an aspiration: it is
 * asserted in __tests__/senasa-export-route.test.ts, and `format()` below is
 * IMPLEMENTED in terms of these three so the two paths cannot drift by
 * construction.
 */
export type SenasaChunkWriter = {
  /** Bytes emitted once, before any row chunk. */
  open(): string;
  /** Serialize one chunk of rows. MUST NOT repeat the preamble. */
  write(rows: SenasaCanonicalRow[]): string;
  /** Bytes emitted once, after the last chunk. */
  close(): string;
};

export interface SenasaFormatter {
  /** Stable id used in the ?format= query param and audit log. */
  id: string;
  /** Human label (es-AR) for a formatter picker. */
  label: string;
  /** MIME type for the download response. */
  contentType: string;
  /** File extension (no dot). */
  fileExtension: string;
  /** Serialize canonical rows to the target byte layout. */
  format(rows: SenasaCanonicalRow[]): string;
  /**
   * REQUIRED, not optional, and that is the point (2026-09-11, when the route
   * was wired). `streamSenasaBatch` is a generator precisely so nobody
   * materializes the whole batch; a formatter that could only accept an array
   * would force the route to undo that at the last step, which is the exact
   * trap that docblock exists to prevent. Making the incremental path part of
   * the INTERFACE means the real SENASA formatter cannot land without deciding
   * how it chunks — a decision, visible in its own code, rather than an
   * accidental `[...rows]` in a route nobody re-audits.
   */
  openChunked(): SenasaChunkWriter;
}

/**
 * Stable CSV column order. Explicit (not Object.keys) so the layout is a
 * reviewed contract, not an accident of object construction order.
 */
export const SENASA_CSV_COLUMNS: readonly (keyof SenasaCanonicalRow)[] = [
  "animal_token",
  "species",
  "jurisdiction_province",
  "jurisdiction_locality",
  "occurred_on",
  "tipo_evento_code",
  "tipo_evento_label",
  "tipo_evento_norma",
  "lote_biologico",
  "laboratorio",
  "vencimiento_biologico",
  "via_aplicacion_code",
  "via_aplicacion_label",
  "vet_matricula",
  "vet_jurisdiccion_code",
  "establecimiento_renspa",
  "proxima_dosis_on",
] as const;

/**
 * CSV baseline formatter. Real, useful deliverable (a funcionario can open it
 * in Excel and cross-load today) AND the end-to-end pipeline exerciser. Reuses
 * rowsToCsv (RFC-4180 escaping) — no third CSV implementation. Prepends a
 * UTF-8 BOM for Excel, same convention as buildSectionedCsv.
 */
export const csvSenasaFormatter: SenasaFormatter = {
  id: "csv",
  label: "CSV (planilla — compatible con Excel)",
  contentType: "text/csv; charset=utf-8",
  fileExtension: "csv",
  openChunked(): SenasaChunkWriter {
    return {
      // BOM for Excel + the header line, exactly once. No trailing break: the
      // first write() supplies the separator, so an empty batch ends as a
      // header-only document with no dangling blank row.
      open: () => `﻿${SENASA_CSV_COLUMNS.join(",")}`,
      write(rows: SenasaCanonicalRow[]): string {
        if (rows.length === 0) return "";
        // Project each row into the fixed column order so the header + cells
        // are stable even if SenasaCanonicalRow's field order ever changes.
        const ordered = rows.map((r) => {
          const out: Record<string, unknown> = {};
          for (const col of SENASA_CSV_COLUMNS) out[col] = r[col];
          return out;
        });
        // rowsToCsv re-emits the header from the first row's keys; drop that
        // line and keep its leading CRLF, which is the separator this chunk
        // needs after whatever came before. Reusing it (rather than a second
        // escaping routine here) is what keeps RFC-4180 quoting identical
        // between the batch and streamed paths.
        const csv = rowsToCsv(ordered);
        const firstBreak = csv.indexOf("\r\n");
        return firstBreak === -1 ? "" : csv.slice(firstBreak);
      },
      close: () => "",
    };
  },
  format(rows: SenasaCanonicalRow[]): string {
    // One implementation, two entry points — see SenasaChunkWriter's docblock.
    const w = csvSenasaFormatter.openChunked();
    return `${w.open()}${w.write(rows)}${w.close()}`;
  },
};

/**
 * Formatter registry. This cycle ships exactly one (csv). The real
 * SENASA/LSUCyF formatter is BLOCKED on the real homologation spec (open
 * question #1) — when it lands, add it HERE and nothing upstream changes.
 */
export const SENASA_FORMATTERS: Record<string, SenasaFormatter> = {
  [csvSenasaFormatter.id]: csvSenasaFormatter,
};

/** Resolve a formatter by id, falling back to the CSV baseline. */
export function resolveSenasaFormatter(id: string | null | undefined): SenasaFormatter {
  if (id && id in SENASA_FORMATTERS) return SENASA_FORMATTERS[id];
  return csvSenasaFormatter;
}

// ---------------------------------------------------------------------------
// Streamed document — the only sanctioned way to turn the query stage's
// generator into a downloadable body.
// ---------------------------------------------------------------------------

/** Rows transformed and serialized per chunk. Bounds memory, not the export. */
const SENASA_DOCUMENT_CHUNK_ROWS = 500;

/**
 * Serialize an async stream of gathered events into document chunks.
 *
 * The peak memory held here is `chunkRows` canonical rows, NOT the batch —
 * which is the whole reason `streamSenasaBatch` is a generator. Consumers
 * (app/gob/senasa/export/route.ts) pipe these strings straight into the
 * response body, so a 200k-row export never exists as one object.
 *
 * Pure: takes an AsyncIterable, imports no database.
 */
export async function* senasaDocumentChunks(
  source: AsyncIterable<SenasaEventRow>,
  formatter: SenasaFormatter,
  // `chunkRows` exists so a test can cross the chunk boundary with few rows,
  // same discipline as streamSenasaBatch's `pageSize`.
  opts: { chunkRows?: number } = {},
): AsyncGenerator<string, void, undefined> {
  const chunkRows = opts.chunkRows ?? SENASA_DOCUMENT_CHUNK_ROWS;
  const writer = formatter.openChunked();

  yield writer.open();

  let buffer: SenasaCanonicalRow[] = [];
  for await (const row of source) {
    buffer.push(toSenasaCanonicalRow(row));
    if (buffer.length >= chunkRows) {
      yield writer.write(buffer);
      buffer = [];
    }
  }
  if (buffer.length > 0) yield writer.write(buffer);

  yield writer.close();
}
