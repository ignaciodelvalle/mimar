// Predefined options for the pet form's fields.
//
// THE PROFILE PICKERS MOVED TO `@dim/contract/reference` (owner-pet-actions,
// 2026-10-01): the foods, the allergies, the training levels and the insurance
// companies, because the app's "Editar datos" draws the same pickers. They are
// RE-EXPORTED here rather than copied, so every web importer keeps this path and
// each list has exactly one copy. Everything still defined below is web-only.
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

export function findVaccineByName(name: string): VaccineDef | null {
  const target = name.trim().toLowerCase();
  return VACCINE_CATALOG.find((v) => v.name.toLowerCase() === target) ?? null;
}
