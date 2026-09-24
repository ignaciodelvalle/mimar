// parseLegalMetadata — form-data parser for the govt_business_rules legal
// provenance COLUMNS (migration 0183, spec RM5): requirement_level /
// legal_basis / authority / source_url / effective_from / effective_until.
// These are table COLUMNS, not payload fields — they never pass through the
// rule-type Zod validators. Lives in the application module (not the
// "use server" action shim) per the action line-budget fence.

import { REQUIREMENT_LEVELS, type RequirementLevel } from "@/db";

import type { BusinessRuleLegalMetadata } from "./types";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type ParseLegalMetadataResult =
  | { ok: true; value: BusinessRuleLegalMetadata }
  | { ok: false; error: string };

/**
 * Parses the fields the shared LegalMetadataFieldset submits.
 *
 * Per-field contract (mirrors BusinessRuleLegalMetadata): a field ABSENT from
 * the form parses to `undefined` (writer leaves the column untouched — a form
 * without the tier select must never erase a backfilled tier); a field
 * present-but-empty parses to `null` (writer clears the column).
 */
export function parseLegalMetadata(formData: FormData): ParseLegalMetadataResult {
  const text = (name: string): string | null | undefined => {
    if (!formData.has(name)) return undefined;
    const raw = (formData.get(name) as string).trim();
    return raw === "" ? null : raw;
  };

  const requirementLevelRaw = text("requirement_level");
  if (
    typeof requirementLevelRaw === "string" &&
    !(REQUIREMENT_LEVELS as readonly string[]).includes(requirementLevelRaw)
  ) {
    return { ok: false, error: "Nivel de exigencia inválido" };
  }

  const effectiveFrom = text("effective_from");
  const effectiveUntil = text("effective_until");
  for (const value of [effectiveFrom, effectiveUntil]) {
    if (typeof value === "string" && !ISO_DATE_RE.test(value)) {
      return { ok: false, error: "Fecha de vigencia inválida" };
    }
  }

  return {
    ok: true,
    value: {
      requirementLevel: requirementLevelRaw as RequirementLevel | null | undefined,
      legalBasis: text("legal_basis"),
      authority: text("authority"),
      sourceUrl: text("source_url"),
      effectiveFrom,
      effectiveUntil,
    },
  };
}
