// The predefined options of the pet profile's "Salud y cuidados" and "Seguro"
// fields — what the pickers offer so the common case is one tap instead of
// typing. Owners can still type an entry of their own: these lists suggest,
// they do not restrict (the training level is the one closed vocabulary).
//
// MOVED HERE from `lib/reference/lookups.ts` (owner-pet-actions, 2026-10-01),
// unchanged, because the app's "Editar datos" has to draw the same pickers the
// web draws. `lookups.ts` re-exports them, so every web importer keeps its path
// and each list has one copy. The rest of `lookups.ts` (microchip and tattoo
// locations, the vaccine catalogue) stays where it is: nothing native needs it.

export const COMMON_FOODS = [
  "Comida seca (balanceada)",
  "Comida húmeda (lata / pouch)",
  "Dieta natural / BARF",
  "Dieta casera",
  "Premios / snacks",
  "Comida para edad senior",
  "Comida hipoalergénica",
  "Comida medicada / prescripción",
];

export const COMMON_ALLERGIES = [
  "Pollo",
  "Carne vacuna",
  "Cerdo",
  "Pescado",
  "Lácteos",
  "Huevo",
  "Cereales (trigo, maíz)",
  "Pulgas",
  "Polen / ambiente",
  "Ácaros del polvo",
  "Picaduras de insectos",
];

/**
 * The values `pets.training_level` admits, in the order the picker lists them.
 * A tuple so a schema can build an enum from it; the labels below are keyed by
 * it, so a value without a label is a compile error rather than a blank option.
 */
export const TRAINING_LEVEL_VALUES = [
  "none",
  "basic",
  "intermediate",
  "advanced",
  "professional",
] as const;
export type TrainingLevel = (typeof TRAINING_LEVEL_VALUES)[number];

const TRAINING_LEVEL_LABELS: Readonly<Record<TrainingLevel, string>> = {
  none: "Ninguno",
  basic: "Básico (sentarse, venir)",
  intermediate: "Intermedio (obediencia general)",
  advanced: "Avanzado",
  professional: "Profesional / trabajo",
};

/** The training picker's options: value plus es-AR label, in picker order. */
export const TRAINING_LEVELS: readonly { value: TrainingLevel; label: string }[] =
  TRAINING_LEVEL_VALUES.map((value) => ({ value, label: TRAINING_LEVEL_LABELS[value] }));

// Some pet insurance companies operating in Argentina (2025-26). Free text
// allowed too; this is just for autocomplete.
export const INSURANCE_COMPANIES = [
  "Mapfre Mascotas",
  "Sancor Seguros",
  "La Caja Mascotas",
  "Provincia Seguros",
  "Federación Patronal",
  "PetCheck",
];
