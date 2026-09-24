"use server";

// Bulk-intake CSV actions (org-pilot-pack Req 1, design D1-D5).
//
// Two-step contract:
//   1. validateIntakeCsvAction — decode + parse + map + validate EVERY row
//      through the real write-time rules (parseIntakeForm) plus the chip/
//      tattoo pre-checks, WITHOUT writing anything. Returns a per-row preview
//      and the file's SHA-256 (the idempotency anchor).
//   2. importIntakeRowsAction — writes confirmed rows ONE AT A TIME through
//      the existing per-animal use-case (createIntake). There is NO parallel
//      bulk-write path: each row is its own transaction on the event spine,
//      no batch rollback (events append-only).
//
// Idempotency (spec 1.7, HARD): every row's clientIdempotencyKey is
// deriveBulkIdempotencyKey(fileHash, rowIndex) — deterministic, so an
// accidental resubmission of an already-committed chunk hits createIntake's
// advisory-lock + pet_registered key check and reports the ORIGINAL pet as a
// no-op instead of creating a duplicate.

import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";

import {
  INTAKE_CSV_MAX_BYTES,
  INTAKE_CSV_MAX_ROWS,
  decodeIntakeCsv,
  findExactDuplicateRows,
  sniffIntakeCsvDelimiter,
} from "@/lib/domain/intake-csv";
import { deriveBulkIdempotencyKey } from "@/lib/events/event-idempotency";
import { pluralizeEs } from "@/lib/utils/format";
import { requireCapabilityForOrgToken } from "@/src/modules/organizations/infrastructure/authz-resolver";
import { createIntake } from "@/src/modules/pets/application/intake/create-intake";

import { buildRowFormData, validateIntakeRows } from "./validate-rows";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IntakeCsvRowPreview = {
  /** 0-based data-row index within the uploaded file. */
  index: number;
  /** Original es-AR values as uploaded — preserved for the failed-rows CSV. */
  record: Record<string, string>;
  /** Mapped intake FormData fields (meaningful when valid). */
  fields: Record<string, string>;
  valid: boolean;
  /** es-AR errors naming column and reason (spec 1.3). */
  errors: string[];
  /** Exact full-row duplicate within the file — warning only (spec 1.10). */
  duplicate: boolean;
};

export type ValidateIntakeCsvResult =
  | { ok: true; fileHash: string; rows: IntakeCsvRowPreview[] }
  | { error: string };

export type ImportIntakeRowResult = {
  index: number;
  outcome: "imported" | "failed" | "skipped";
  petToken?: string;
  petName?: string;
  reason?: string;
};

export type ImportIntakeRowsResult =
  | { ok: true; results: ImportIntakeRowResult[] }
  | { error: string };

// ---------------------------------------------------------------------------
// validateIntakeCsvAction
// ---------------------------------------------------------------------------

// @no-audit-required: READ ONLY — parses and validates the uploaded CSV and
// hands the rows back to the browser for review. NOTHING is written here; the
// write happens in importIntakeRowsAction below, when the operator confirms.
// It lands as a candidate only because lint:audit-log follows reachability one
// hop and this file's siblings do write.
export async function validateIntakeCsvAction(
  orgToken: string,
  formData: FormData,
): Promise<ValidateIntakeCsvResult> {
  const auth = await requireCapabilityForOrgToken("intake.create", orgToken);
  if (auth.error !== null) return { error: auth.error };

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { error: "Subí un archivo CSV." };
  }
  if (file.size > INTAKE_CSV_MAX_BYTES) {
    return { error: "El archivo supera el límite de 512 KB. Dividilo en partes más chicas." };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const fileHash = createHash("sha256").update(bytes).digest("hex");

  const { text } = decodeIntakeCsv(bytes);
  const delimiter = sniffIntakeCsvDelimiter(text);

  let records: Record<string, string>[];
  try {
    records = parse(text, {
      columns: true,
      delimiter,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    }) as Record<string, string>[];
  } catch (err) {
    return {
      error: `No pudimos leer el CSV: ${err instanceof Error ? err.message : "formato inválido"}. Verificá que use la plantilla.`,
    };
  }

  if (records.length === 0) {
    return {
      error: "El archivo no tiene filas de datos. Completá la plantilla y volvé a subirla.",
    };
  }
  if (records.length > INTAKE_CSV_MAX_ROWS) {
    return {
      error: `El archivo tiene ${records.length} ${pluralizeEs(records.length, "fila")} — el máximo por importación es ${INTAKE_CSV_MAX_ROWS}.`,
    };
  }

  const duplicates = findExactDuplicateRows(records);

  // Up to two lookups per row, under a budget (L-15) — see validate-rows.ts.
  const rows = await validateIntakeRows(records, duplicates);
  if (rows === null) {
    return {
      error:
        "La validación del archivo tardó demasiado y la cortamos. No se importó nada. Probá de nuevo en unos minutos o dividí el archivo en partes más chicas.",
    };
  }

  return { ok: true, fileHash, rows };
}

// ---------------------------------------------------------------------------
// importIntakeRowsAction
// ---------------------------------------------------------------------------

/** Wizard submits confirmed rows in small sequential chunks (design D3). */
const MAX_CHUNK_ROWS = 20;

// Named type (originally a workaround: the authz fence's body extractor used to
// count braces from the export line, so an inline `{ … }` param type closed its
// depth before the body's guard call was seen and the action read as unguarded).
// The extractor now tracks the parameter list separately — see
// extractExportedAsyncFunctions in scripts/check-authz-guards.ts — so this is
// kept for readability, not to dodge the linter.
type ImportIntakeRowsInput = {
  fileHash: string;
  rows: { index: number; fields: Record<string, string> }[];
};

export async function importIntakeRowsAction(
  orgToken: string,
  input: ImportIntakeRowsInput,
): Promise<ImportIntakeRowsResult> {
  // Authenticate ONCE per chunk (design D2) — the use-case receives the
  // resolved actor and runs the same write path as the individual form.
  const auth = await requireCapabilityForOrgToken("intake.create", orgToken);
  if (auth.error !== null) return { error: auth.error };
  const { user, organization } = auth;

  if (!/^[0-9a-f]{64}$/.test(input.fileHash)) {
    return { error: "Identificador de archivo inválido. Volvé a validar el CSV." };
  }
  if (!Array.isArray(input.rows) || input.rows.length === 0) {
    return { error: "No hay filas para importar." };
  }
  if (input.rows.length > MAX_CHUNK_ROWS) {
    return { error: `Máximo ${MAX_CHUNK_ROWS} filas por tanda.` };
  }

  const results: ImportIntakeRowResult[] = [];

  for (const row of input.rows) {
    const fd = buildRowFormData(row.fields);
    // Server-controlled: never trust these from the client payload.
    fd.set("noRedirect", "1");
    fd.set("clientIdempotencyKey", deriveBulkIdempotencyKey(input.fileHash, String(row.index)));
    fd.delete("tattooAckToken");

    try {
      const result = await createIntake(orgToken, user, organization, fd);

      if (result.warning === "TATTOO_MATCH_POSSIBLE") {
        results.push({
          index: row.index,
          outcome: "skipped",
          reason:
            "Posible coincidencia por tatuaje — requiere verificación por foto, usá el formulario individual.",
        });
      } else if (result.redirectTo) {
        // Lost-chip match (D5). createIntake used to THROW next/navigation's
        // NEXT_REDIRECT here and this loop caught it; since T1.3 the use-case
        // REPORTS the destination instead, so the branch moved from the catch
        // to a plain conditional. Same outcome, and now the only reason the row
        // is skipped is one the code states rather than one inferred from an
        // exception digest: in bulk, that confirmation MUST happen per animal.
        results.push({
          index: row.index,
          outcome: "skipped",
          reason:
            "El microchip coincide con una mascota perdida — requiere el flujo individual de confirmación.",
        });
      } else if (result.error) {
        results.push({ index: row.index, outcome: "failed", reason: result.error });
      } else if (result.ok && result.createdPetToken) {
        // KNOWN REPORT LIMITATION (no data risk, label only): re-importing an
        // already-committed chunk reports these rows as "imported" even though
        // nothing was written. createIntake's idempotency short-circuit returns
        // the ORIGINAL pet in exactly the same success shape as a fresh insert
        // ({ ok, createdPetToken, createdPetName }) — IntakeFormState carries no
        // wasNoop/duplicate flag, and `duplicateOf` never leaves the use-case.
        // So the spine is safe (the advisory lock + pet_registered key check
        // guarantee one pet per file row); only the wizard's per-row label
        // overstates what happened. Surfacing "Ya importada" would mean adding
        // that flag to the use-case shared with the individual intake wizard —
        // a deliberate non-change here.
        results.push({
          index: row.index,
          outcome: "imported",
          petToken: result.createdPetToken,
          petName: result.createdPetName,
        });
      } else {
        results.push({
          index: row.index,
          outcome: "failed",
          reason: "Resultado inesperado del registro — revisá la fila en el formulario individual.",
        });
      }
    } catch (err) {
      results.push({
        index: row.index,
        outcome: "failed",
        reason: err instanceof Error ? err.message : "Error desconocido",
      });
    }
  }

  return { ok: true, results };
}
