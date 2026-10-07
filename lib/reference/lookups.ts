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
};

export const VACCINE_CATALOG: ReadonlyArray<VaccineDef> = [
  { name: "Antirrábica", species: ["dog", "cat"], isCore: true, intervalMonths: 12 },
  { name: "Séxtuple (DHPPi-L)", species: ["dog"], isCore: true, intervalMonths: 12 },
  { name: "Quíntuple (DHPPi)", species: ["dog"], isCore: true, intervalMonths: 12 },
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

// The rabies FAMILY as the credential has always read it ("antirr[aá]b" or
// "rabi" anywhere in the name), applied to the folded key so an accent or a
// capital can never split the two sides again.
const RABIES_FAMILY_IN_KEY = /antirrab|rabi/;

/**
 * Whether a recorded vaccine name is a rabies dose, for the compliance card on
 * the credential front.
 *
 * Built on the same key as `findVaccineByName`, and a strict superset of it for
 * rabies: every name the libreta resolves to "Antirrábica" is a rabies dose
 * here too (tested), so the front and the back can no longer disagree over an
 * accent, a capital or a space. The family pattern keeps recognising composite
 * names the catalog does not resolve ("DHPP + antirrábica") — that is the
 * existing credential behaviour, not a new alias.
 */
export function isRabiesVaccineName(name: string): boolean {
  if (findVaccineByName(name)?.name === RABIES_VACCINE_NAME) return true;
  return RABIES_FAMILY_IN_KEY.test(vaccineNameKey(name));
}
