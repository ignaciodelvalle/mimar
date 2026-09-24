// Permanent-conditions catalog (spec
// 2026-05-18-additional-species-and-permanent-conditions plan).
//
// "Permanent condition" = a lifelong functional / sensory / medical
// characteristic that materially shapes care (e.g. blind, deaf,
// FIV-positive, requires a cart). DIFFERS from a transient
// `clinical_info_logged` or symptom — these are persistent traits that
// follow the pet for life and the caregiver chooses to disclose.
//
// The codes are app-layer-enforced (no DB enum on the array column) so
// growing the catalog never needs a migration. Adding a new code:
//   1. Append to `PERMANENT_CONDITIONS`.
//   2. Add label + group.
//   3. PetForm picks it up automatically via the catalog iteration.
//
// `otra` is the escape hatch — when the array contains 'otra', the
// caregiver MUST fill `pets.permanent_conditions_other` (enforced by
// the CHECK constraint in migration 0031). Use sparingly so the catalog
// stays useful for filtering.

export const PERMANENT_CONDITIONS = [
  "ciego",
  "vision_reducida",
  "sordo",
  "audicion_reducida",
  "tres_patas",
  "miembro_no_funcional",
  "paralisis_posterior",
  "usa_carrito",
  "incontinencia_urinaria",
  "incontinencia_fecal",
  "epilepsia",
  "diabetes",
  "fiv_positivo",
  "felv_positivo",
  "cardiopatia",
  "cognitiva",
  "otra",
] as const;

export type PermanentCondition = (typeof PERMANENT_CONDITIONS)[number];

export const PERMANENT_CONDITIONS_SET: ReadonlySet<string> = new Set(PERMANENT_CONDITIONS);

export function isPermanentCondition(value: string): value is PermanentCondition {
  return PERMANENT_CONDITIONS_SET.has(value);
}

type ConditionMeta = {
  label: string;
  group: "sensorial" | "motor" | "medico" | "otro";
  short: string;
};

const META: Record<PermanentCondition, ConditionMeta> = {
  ciego: { label: "Ciego/a", group: "sensorial", short: "Ciego/a" },
  vision_reducida: { label: "Visión reducida", group: "sensorial", short: "Visión ↓" },
  sordo: { label: "Sordo/a", group: "sensorial", short: "Sordo/a" },
  audicion_reducida: { label: "Audición reducida", group: "sensorial", short: "Audición ↓" },
  tres_patas: { label: "Tres patas (amputación)", group: "motor", short: "3 patas" },
  miembro_no_funcional: {
    label: "Miembro no funcional",
    group: "motor",
    short: "Miembro no funcional",
  },
  paralisis_posterior: {
    label: "Parálisis posterior",
    group: "motor",
    short: "Parálisis post.",
  },
  usa_carrito: { label: "Usa carrito de movilidad", group: "motor", short: "Usa carrito" },
  incontinencia_urinaria: {
    label: "Incontinencia urinaria",
    group: "medico",
    short: "Inc. urinaria",
  },
  incontinencia_fecal: {
    label: "Incontinencia fecal",
    group: "medico",
    short: "Inc. fecal",
  },
  epilepsia: { label: "Epilepsia", group: "medico", short: "Epilepsia" },
  diabetes: { label: "Diabetes", group: "medico", short: "Diabetes" },
  fiv_positivo: { label: "FIV positivo", group: "medico", short: "FIV+" },
  felv_positivo: { label: "FeLV positivo", group: "medico", short: "FeLV+" },
  cardiopatia: { label: "Cardiopatía", group: "medico", short: "Cardiopatía" },
  cognitiva: { label: "Deterioro cognitivo", group: "medico", short: "Deterioro cog." },
  otra: { label: "Otra (especificar)", group: "otro", short: "Otra" },
};

export function permanentConditionLabel(code: PermanentCondition): string {
  return META[code].label;
}

export function permanentConditionShortLabel(code: PermanentCondition): string {
  return META[code].short;
}

export function permanentConditionGroup(
  code: PermanentCondition,
): "sensorial" | "motor" | "medico" | "otro" {
  return META[code].group;
}

export const PERMANENT_CONDITION_GROUPS = [
  { id: "sensorial" as const, label: "Sensorial" },
  { id: "motor" as const, label: "Motor" },
  { id: "medico" as const, label: "Médico" },
  { id: "otro" as const, label: "Otro" },
];

// Filter helpers — keep only codes that are actually in the catalog.
// Useful for trusting URL input or potentially-stale legacy rows.
export function sanitizeConditionCodes(input: ReadonlyArray<string>): PermanentCondition[] {
  return input.filter(isPermanentCondition);
}

/**
 * Resolve which permanent conditions should reach the LOST Tier-1 public
 * credential. A finder handling a lost blind, deaf, or medicated pet needs to
 * know before they act — this is a welfare-safety disclosure, not a cosmetic
 * one, so it's gated ONLY by `discloseConditionsPublicly` (the owner's
 * explicit "let people know" choice), same gate the active-credential banner
 * and the Tier-2 medical view already use for this field.
 *
 * Uses the full label (`permanentConditionLabel`), matching Tier2MedicalView's
 * rendering, so e.g. "ciego" reads as "Ciego/a" identically in both places —
 * the active-credential chip banner uses the short label instead, which is a
 * deliberate difference for that denser layout, not something to mirror here.
 *
 * Returns null when disclosure is off or there is nothing disclosable — the
 * caller (page.tsx) passes that straight through as the `specialConditions`
 * prop, and the component renders no section at all in that case.
 */
export function resolveLostSpecialConditions(
  codes: ReadonlyArray<string>,
  other: string | null,
  discloseConditionsPublicly: boolean,
): { labels: string[]; other: string | null } | null {
  if (!discloseConditionsPublicly) return null;
  const safe = codes.filter(isPermanentCondition);
  if (safe.length === 0) return null;

  const labels = safe.filter((code) => code !== "otra").map(permanentConditionLabel);
  const hasOther = safe.includes("otra") && !!other;

  if (labels.length === 0 && !hasOther) return null;
  return { labels, other: hasOther ? other : null };
}
