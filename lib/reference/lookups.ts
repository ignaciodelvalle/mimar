// Predefined options for the pet form's fields.
//
// THE PROFILE PICKERS MOVED TO `@dim/contract/reference` (owner-pet-actions,
// 2026-10-01): the foods, the allergies, the training levels and the insurance
// companies, because the app's "Editar datos" draws the same pickers. They are
// RE-EXPORTED here rather than copied, so every web importer keeps this path and
// each list has exactly one copy. Everything still defined below is web-only.
import { foldForSearch } from "@dim/contract/reference";

export {
  COMMON_ALLERGIES,
  COMMON_FOODS,
  INSURANCE_COMPANIES,
  TRAINING_LEVELS,
} from "@dim/contract/reference";

// Microchip implant location — WSAVA recommends interscapular (between the
// shoulder blades). We default to interscapular_left to match the most common
// practice in Argentinian veterinary clinics.
export const MICROCHIP_LOCATIONS = [
  { value: "interscapular_left", label: "Interescapular izquierdo (recomendado)" },
  { value: "interscapular_right", label: "Interescapular derecho" },
  { value: "neck_back", label: "Cuello (dorsal)" },
  { value: "inguinal", label: "Inguinal" },
  { value: "other", label: "Otra ubicación" },
];

// Tattoo body location — closed lookup mirroring the chip pattern. Free-text
// origin/registry lives in pets.tattoo_description (D1 closed 2026-05-22 — no
// registry enum; the owner writes the origin in description).
export const TATTOO_LOCATIONS = [
  { value: "inner_ear_left", label: "Oreja interna izquierda" },
  { value: "inner_ear_right", label: "Oreja interna derecha" },
  { value: "inner_thigh", label: "Muslo interno" },
  { value: "belly", label: "Panza" },
  { value: "other", label: "Otra ubicación" },
] as const;

export function tattooLocationLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return TATTOO_LOCATIONS.find((l) => l.value === value)?.label ?? value;
}

// Common vaccines administered in Argentine veterinary practice. Used for
// the vaccination event form datalist and to suggest next-dose dates based
// on standard intervals. Free text is still allowed — owners can record
// vaccines outside this catalog and just enter the next-dose date manually.
export type VaccineDef = {
  name: string;
  species: ReadonlyArray<"dog" | "cat" | "other">;
  isCore: boolean;
  // null = single dose / owner-specified; otherwise number of months until
  // the recommended next dose.
  intervalMonths: number | null;
  /**
   * Core vaccines that are ALTERNATIVES to each other share a group label: the
   * calendar asks for ONE of them, not each. Séxtuple and Quíntuple are the
   * same polyvalent shot with and without leptospirosis — a dog gets one or the
   * other, and counting both as owed told every dog it was missing a vaccine
   * it could never need (QA v14, 2026-10-07).
   */
  alternativeGroup?: string;
};

/** The requirement label for the dog's polyvalent shot (either member satisfies it). */
export const POLYVALENT_GROUP_LABEL = "Polivalente (séxtuple o quíntuple)";

export const VACCINE_CATALOG: ReadonlyArray<VaccineDef> = [
  { name: "Antirrábica", species: ["dog", "cat"], isCore: true, intervalMonths: 12 },
  {
    name: "Séxtuple (DHPPi-L)",
    species: ["dog"],
    isCore: true,
    intervalMonths: 12,
    alternativeGroup: POLYVALENT_GROUP_LABEL,
  },
  {
    name: "Quíntuple (DHPPi)",
    species: ["dog"],
    isCore: true,
    intervalMonths: 12,
    alternativeGroup: POLYVALENT_GROUP_LABEL,
  },
  {
    name: "Tos de las perreras (Bordetella)",
    species: ["dog"],
    isCore: false,
    intervalMonths: 6,
  },
  { name: "Coronavirus canino", species: ["dog"], isCore: false, intervalMonths: 12 },
  { name: "Giardia", species: ["dog"], isCore: false, intervalMonths: 12 },
  { name: "Triple felina (FVRCP)", species: ["cat"], isCore: true, intervalMonths: 12 },
  { name: "Leucemia felina (FeLV)", species: ["cat"], isCore: false, intervalMonths: 12 },
  { name: "PIF (Peritonitis infecciosa)", species: ["cat"], isCore: false, intervalMonths: 12 },
];

export function vaccinesForSpecies(species: string): VaccineDef[] {
  if (species === "dog" || species === "cat") {
    return VACCINE_CATALOG.filter((v) => v.species.includes(species));
  }
  return [...VACCINE_CATALOG];
}

/**
 * One line of the recommended calendar: satisfied by a dose of ANY member.
 * A single-member requirement is labelled with the vaccine's own name.
 */
export type VaccineRequirement = {
  label: string;
  members: readonly VaccineDef[];
};

/**
 * The recommended (core) calendar for a species, or `null` when our reference
 * data defines none for it.
 *
 * NOT `vaccinesForSpecies`. That helper deliberately returns the WHOLE catalog
 * for a species it does not know, so a vaccine form can still offer names to
 * pick from. Reusing it for the calendar is what made a ferret owe Séxtuple,
 * Quíntuple and Triple felina (QA v14, 2026-10-07). A calendar is an assertion
 * about what an animal SHOULD have received; for a species the catalog does not
 * cover we have nothing to assert, and we do not invent one — not even rabies,
 * which the catalog lists for dogs and cats only.
 */
export function recommendedCalendarForSpecies(species: string): VaccineRequirement[] | null {
  if (species !== "dog" && species !== "cat") return null;
  const requirements: VaccineRequirement[] = [];
  const byGroup = new Map<string, VaccineDef[]>();
  for (const v of VACCINE_CATALOG) {
    if (!v.isCore || !v.species.includes(species)) continue;
    if (!v.alternativeGroup) {
      requirements.push({ label: v.name, members: [v] });
      continue;
    }
    const group = byGroup.get(v.alternativeGroup);
    if (group) {
      group.push(v);
      continue;
    }
    const members = [v];
    byGroup.set(v.alternativeGroup, members);
    requirements.push({ label: v.alternativeGroup, members });
  }
  return requirements;
}

/**
 * The one key a vaccine name is compared by: accents and case folded
 * (`foldForSearch`, the same fold the app's searches use), edges trimmed and
 * inner whitespace collapsed. "Antirrabica", "ANTIRRÁBICA" and " antirrábica "
 * all key to "antirrabica".
 *
 * Why it exists (surface audit 2026-10-07, item A): an owner typed
 * "Antirrabica" without the accent. The credential front read it as the rabies
 * dose ("Declarada"), while the libreta back compared with `toLowerCase()` only,
 * missed the catalog, and reported "Antirrábica · Sin confirmar" plus "1 vacuna
 * fuera del catálogo" for the same asiento.
 */
export function vaccineNameKey(name: string): string {
  return foldForSearch(name).replace(/\s+/g, " ").trim();
}

/**
 * The catalog entry a recorded vaccine name resolves to, or null. Equality on
 * `vaccineNameKey` — accent-, case- and spacing-insensitive, and nothing more:
 * no substring, no fuzzy distance, no alias table (the catalog declares none).
 * PO decision 2026-07-28 keeps it that strict on purpose: resolving a medical
 * record to a vaccine nobody gave is the worse error.
 */
export function findVaccineByName(name: string): VaccineDef | null {
  const target = vaccineNameKey(name);
  if (!target) return null;
  return VACCINE_CATALOG.find((v) => vaccineNameKey(v.name) === target) ?? null;
}

/** The catalog's rabies entry name. */
export const RABIES_VACCINE_NAME = "Antirrábica";

/**
 * The rabies FAMILY ("antirrab" or "rabi" anywhere in the name) as a POSIX/JS
 * regex source, to be applied ONLY to a folded name: `vaccineNameKey` in
 * TypeScript, `lower(unaccent(name))` in SQL (`rabiesVaccineNameSql` in
 * lib/metrics/rabies.ts). The same source on both sides is what keeps a SQL
 * metric and a TS surface from disagreeing over an accent, a capital, a
 * decomposed "á" or "Rabia" (surface audit 2026-10-07, A).
 */
export const RABIES_FAMILY_PATTERN = "antirrab|rabi";

const RABIES_FAMILY_IN_KEY = new RegExp(RABIES_FAMILY_PATTERN);

/**
 * Whether a recorded vaccine name is a rabies dose — THE rabies matcher for
 * every TypeScript surface (credential front, libreta, badges, surveillance).
 *
 * Built on the same key as `findVaccineByName`, and a strict superset of it for
 * rabies: every name the libreta resolves to "Antirrábica" is a rabies dose
 * here too (tested). The family pattern also recognises composite names the
 * catalog does not resolve ("DHPP + antirrábica") — for RABIES only; nothing
 * about the other components is inferred (see `isPlainRabiesVaccineName`).
 */
export function isRabiesVaccineName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  if (findVaccineByName(name)?.name === RABIES_VACCINE_NAME) return true;
  return RABIES_FAMILY_IN_KEY.test(vaccineNameKey(name));
}

// Words that say nothing about WHICH vaccine a dose was: they may sit beside
// the rabies word without making the name carry anything else.
const RABIES_NAME_FILLER: ReadonlySet<string> = new Set([
  "vacuna",
  "contra",
  "la",
  "anual",
  "refuerzo",
  "dosis",
  "de",
]);

// A "+" joins vaccines; parentheses may name one ("Séxtuple (DHPPi-L)") or a
// brand that makes several ("Nobivac"). Either way the name may carry another
// vaccine, so it is never plain.
const MAY_CARRY_ANOTHER_VACCINE = /[+()]/;

/**
 * True when the name is ONLY a rabies vaccine: once the rabies word, digits,
 * punctuation and filler words (vacuna, contra, la, anual, refuerzo, dosis, de)
 * are stripped, nothing is left. "Vacuna antirrábica anual" and "antirrabica
 * 2024" are plain; "DHPP + antirrábica" and "Rabia (Nobivac)" are not.
 *
 * A rabies-family name that is not plain is a dose that ALSO counts as
 * something unidentified — the libreta keeps it in its off-catalog set so the
 * other core vaccines stay "unconfirmed" instead of being asserted as never
 * given (PO 2026-07-28).
 */
export function isPlainRabiesVaccineName(name: string): boolean {
  const key = vaccineNameKey(name);
  if (!RABIES_FAMILY_IN_KEY.test(key) || MAY_CARRY_ANOTHER_VACCINE.test(key)) return false;
  const rest = key
    .split(/[^a-z]+/)
    .filter((word) => word && !RABIES_FAMILY_IN_KEY.test(word) && !RABIES_NAME_FILLER.has(word));
  return rest.length === 0;
}
