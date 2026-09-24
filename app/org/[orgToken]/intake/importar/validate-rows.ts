// Per-row validation for the bulk-intake CSV preview, under a time budget (L-15).
//
// Lives outside actions.ts because a "use server" module may export only async
// functions — the budget constant and the injectable budget the tests need
// cannot live there.
//
// WHY A BUDGET. A 200-row file with chips and tattoos issues up to 400 lookups
// (one chip + one tattoo per row). They used to run strictly one after another
// with no ceiling, so on a degraded pooler the operator watched "Validando el
// archivo…" with no end and no message. Now:
//   - rows are checked in small concurrent groups (PRECHECK_CONCURRENCY), which
//     cuts the wall-clock without changing a single query;
//   - the whole phase runs under withDbBudget, the repo's bound for a server-side
//     DB fan-out (lib/infra/db-budget.ts): past the budget the caller gets
//     `null` — a degraded-but-honest answer — instead of a hang, and a lookup
//     that rejects after the deadline is swallowed rather than crashing the
//     lambda;
//   - the loop checks the same deadline before each group, so an abandoned run
//     stops issuing queries instead of finishing 400 of them for nobody.
//
// Row order in the result is the file's order regardless of which lookup
// finished first.

import { mapIntakeCsvRecord } from "@/lib/domain/intake-csv";
import { validateMicrochipId } from "@/lib/domain/microchip-validation";
import { lookupByChip } from "@/lib/infra/chip-lookup";
import { withDbBudget } from "@/lib/infra/db-budget";
import { lookupByTattoo } from "@/lib/infra/tattoo-lookup";
import { parseIntakeForm } from "@/src/modules/pets/application/intake/create-intake";

import type { IntakeCsvRowPreview } from "./actions";

/** Wall-clock ceiling for the preview's DB work, well under a lambda's limit. */
export const INTAKE_CSV_VALIDATE_BUDGET_MS = 20_000;

/** Rows whose lookups run at once. Small: this shares the pool with everyone. */
export const PRECHECK_CONCURRENCY = 5;

export function buildRowFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string" && value !== "") fd.set(key, value);
  }
  return fd;
}

/**
 * Chip/tattoo pre-checks (design D5). Chip collisions with lost/active/
 * deceased pets and possible tattoo matches all require the INDIVIDUAL form —
 * a bulk import must never auto-confirm an identity match, and the
 * photo-verification rule for tattoos is non-negotiable.
 */
async function identifierPrecheckErrors(fields: Record<string, string>): Promise<string[]> {
  const errors: string[] = [];

  const chip = fields.microchipId ?? "";
  if (chip) {
    const chipValidation = validateMicrochipId(chip);
    if (!chipValidation.ok) {
      errors.push("microchip: formato inválido (15 dígitos ISO 11784/11785)");
    } else {
      const match = await lookupByChip(chipValidation.normalized);
      if (match) {
        if (match.pet.status === "lost") {
          errors.push(
            "microchip: coincide con una mascota perdida en miMAR — usá el formulario individual para confirmar la coincidencia",
          );
        } else if (match.pet.status === "active") {
          errors.push(
            "microchip: ya registrado para una mascota activa con familia — usá el formulario individual",
          );
        } else {
          errors.push(
            "microchip: asociado a una mascota registrada como fallecida — requiere revisión, usá el formulario individual",
          );
        }
      }
    }
  }

  const tattoo = fields.tattooCode ?? "";
  if (tattoo) {
    const tattooMatch = await lookupByTattoo(tattoo);
    if (tattooMatch && tattooMatch.pet.status !== "deceased") {
      errors.push(
        "tatuaje: posible coincidencia con una mascota registrada — requiere verificación por foto, usá el formulario individual",
      );
    }
  }

  return errors;
}

async function validateOne(
  index: number,
  record: Record<string, string>,
  duplicates: Set<number>,
): Promise<IntakeCsvRowPreview> {
  const { fields, errors } = mapIntakeCsvRecord(record);

  if (errors.length === 0) {
    // The EXACT write-time rules — preview and write can never diverge (D1).
    const { error: parseError } = parseIntakeForm(buildRowFormData(fields));
    if (parseError) errors.push(parseError);
  }

  if (errors.length === 0) {
    errors.push(...(await identifierPrecheckErrors(fields)));
  }

  return {
    index,
    record,
    fields,
    valid: errors.length === 0,
    errors,
    duplicate: duplicates.has(index),
  };
}

/**
 * Validate every row. Resolves the previews in file order, or `null` when the
 * budget ran out first (the caller turns that into an es-AR error).
 */
export async function validateIntakeRows(
  records: Record<string, string>[],
  duplicates: Set<number>,
  budgetMs: number = INTAKE_CSV_VALIDATE_BUDGET_MS,
): Promise<IntakeCsvRowPreview[] | null> {
  const deadline = Date.now() + budgetMs;

  async function run(): Promise<IntakeCsvRowPreview[] | null> {
    const rows: IntakeCsvRowPreview[] = [];
    for (let start = 0; start < records.length; start += PRECHECK_CONCURRENCY) {
      // The budget already answered the caller; stop spending the pool.
      if (Date.now() > deadline) return null;
      const group = records.slice(start, start + PRECHECK_CONCURRENCY);
      rows.push(
        ...(await Promise.all(
          group.map((record, offset) => validateOne(start + offset, record, duplicates)),
        )),
      );
    }
    return rows;
  }

  return withDbBudget(run(), budgetMs, "validateIntakeCsvAction prechecks", null);
}
