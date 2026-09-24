// Anonymization helpers for /gob/analytics/export (E6).
//
// Each export slice is defined as a Zod schema listing ONLY the fields that
// are allowed to leave the system. Running raw DB rows through schema.parse()
// silently strips any field not declared in the schema — no extra code needed.
//
// Design decision (E-D3): Zod-schema-per-slice is the anonymization mechanism.
// This avoids adding a new dependency (PII detection libs target unstructured
// text, which is out of scope). Zod is already in the tree and the schemas are
// explicit and auditable. The schema_version is stamped in every audit log row
// so any exported dataset is reproducible.

import { neutralizeCsvFormula } from "@/lib/utils/csv-formula";
import { z } from "zod";

/** Schema version stamped on every export's audit log payload. */
export const EXPORT_SCHEMA_VERSION = "2026-05-21";

// ---------------------------------------------------------------------------
// Slice schemas
// ---------------------------------------------------------------------------

/** Pets slice — opaque identifier only; no name, no owner info, no microchip, no DNI. */
export const petsExportSchema = z.object({
  publicToken: z.string(),
  species: z.string(),
  acquisitionMethod: z.string().optional(),
  jurisdictionProvince: z.string().optional(),
  jurisdictionLocality: z.string().optional(),
  status: z.string().optional(),
  /** YYYY-MM bucketed; not the exact registration date (privacy). */
  registeredAtMonth: z.string().optional(),
});

/** Events slice — pet_events without performer identity or precise location. */
export const eventsExportSchema = z.object({
  petPublicToken: z.string(),
  eventType: z.string(),
  /** YYYY-MM bucketed; not the exact date. */
  occurredAtMonth: z.string(),
  // INTENTIONALLY OMITTED: performedByUserId, recordedByUserId,
  //   locationLat, locationLng, payload.notes (privacy)
});

/** Cases slice — public code + kind + status; no party identities. */
export const casesExportSchema = z.object({
  publicCode: z.string(),
  caseKind: z.string(),
  status: z.string(),
  jurisdictionProvince: z.string().optional(),
  jurisdictionLocality: z.string().optional(),
  /** YYYY-MM bucketed. */
  createdAtMonth: z.string(),
});

/**
 * Organizations slice — display name + verified flag + jurisdiction.
 * Already public-facing data so minimal anonymization needed.
 */
export const organizationsExportSchema = z.object({
  publicToken: z.string(),
  displayName: z.string(),
  orgType: z.string(),
  verified: z.boolean(),
  jurisdictionProvince: z.string().optional(),
  jurisdictionLocality: z.string().optional(),
});

export type ExportSlice = "pets" | "events" | "cases" | "organizations";

export const SCHEMAS_BY_SLICE = {
  pets: petsExportSchema,
  events: eventsExportSchema,
  cases: casesExportSchema,
  organizations: organizationsExportSchema,
} as const;

// ---------------------------------------------------------------------------
// anonymizeRows
// ---------------------------------------------------------------------------

/**
 * Parse each row through the slice's Zod schema. Zod strips fields not
 * declared in the schema by default (strict mode is NOT enabled here).
 * Returns cleaned rows + a count of rows that failed validation (rejected rows
 * are excluded from the output — they are not silently included with partial data).
 */
export function anonymizeRows<S extends ExportSlice>(
  slice: S,
  rawRows: unknown[],
): { rows: z.infer<(typeof SCHEMAS_BY_SLICE)[S]>[]; rejected: number } {
  const schema = SCHEMAS_BY_SLICE[slice];
  type Row = z.infer<(typeof SCHEMAS_BY_SLICE)[S]>;
  const rows: Row[] = [];
  let rejected = 0;

  for (const raw of rawRows) {
    const result = schema.safeParse(raw);
    if (result.success) {
      rows.push(result.data as Row);
    } else {
      rejected += 1;
    }
  }

  return { rows, rejected };
}

// ---------------------------------------------------------------------------
// CSV / JSON formatters
// ---------------------------------------------------------------------------

/**
 * Format rows as CSV. First row is headers (keys from the first object, in
 * insertion order). String cells containing commas, double quotes, or
 * newlines are enclosed in double quotes per RFC 4180; internal quotes are
 * doubled. Cells a spreadsheet would evaluate as a formula are prefixed with
 * `'` — see `lib/utils/csv-formula.ts`.
 *
 * Returns an empty string when `rows` is empty.
 */
export function rowsToCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";

  const headers = Object.keys(rows[0]);

  function escapeCell(value: unknown): string {
    const raw = value === null || value === undefined ? "" : String(value);
    // Formula neutralisation runs BEFORE the quoting decision, so a payload
    // that gains a leading `'` is still quoted when it also contains a comma.
    const str = neutralizeCsvFormula(value, raw);
    // Enclose in quotes if the cell contains a comma, newline, or double quote.
    if (str.includes(",") || str.includes("\n") || str.includes('"')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  const lines: string[] = [headers.map(escapeCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCell(row[h])).join(","));
  }
  return lines.join("\r\n");
}

/** Format rows as pretty-printed JSON. */
export function rowsToJson(rows: Record<string, unknown>[]): string {
  return JSON.stringify(rows, null, 2);
}
