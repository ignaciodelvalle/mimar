// Brachycephalic (short-nosed) breeds, as catalogue labels (viajes-fase-2,
// design D1).
//
// WHY A LIST OF OUR OWN. Almost every airline restricts "brachycephalic" or
// "snub-nosed" breeds — usually out of the hold, sometimes out of the cabin
// too — and almost none publishes the breeds it means. A restriction that
// names a physiology rather than breeds cannot be checked against a pet's
// `breed` without someone deciding which breeds it covers. This file is that
// decision: miMAR's curated reading, written in the labels of the breed
// catalogue (@dim/contract/reference), so `resolveBreedLabel` matches it.
//
// It is therefore UNVERIFIED by construction — no airline signed it — and
// every airline rule that points here says `breeds: "BRACHYCEPHALIC_LIST"` so
// the attribution stays honest: the airline restricts brachycephalic breeds;
// miMAR decides these are them. The UI never presents a match as certain.
//
// Kept to breeds the catalogue has. A brachycephalic breed the catalogue does
// not list ("Pura raza no listada") never matches here and renders amber
// ("No pudimos confirmar la raza…") wherever a restriction applies.
//
// Freshness: airline TTL (90 days), because what it feeds is airline policy.

import type { Sourced } from "@/lib/domain/travel-freshness";

export const BRACHYCEPHALIC_BREEDS: Sourced<{
  dog: readonly string[];
  cat: readonly string[];
}> = {
  value: {
    dog: [
      "Boxer",
      "Bullmastiff",
      "Bulldog Francés",
      "Bulldog Inglés",
      "Dogo Canario (Presa Canario)",
      "Mastín Napolitano",
      "Pequinés",
      "Pug",
      "Shih Tzu",
    ],
    cat: ["British Shorthair", "Persa", "Scottish Fold"],
  },
  // Delta's requirements page is the one airline source read in full on
  // 2026-09-30 that describes snub-nosed restrictions; the breed-by-breed
  // mapping to the catalogue is miMAR's.
  sourceUrl:
    "https://www.delta.com/content/www/en_US/traveling-with-us/special-travel-needs/pets/pet-requirements-restrictions.html",
  lastVerifiedAt: "2026-09-30",
  reviewBy: "2026-12-29",
  verification: "unverified",
  note: "Lectura curada de miMAR: las aerolíneas restringen razas braquicéfalas sin listarlas; esta lista traduce esa categoría a razas del catálogo y no la firmó ninguna aerolínea.",
};

/** The brachycephalic labels for a species (empty for any other species). */
export function brachycephalicBreedsFor(species: string): readonly string[] {
  if (species === "dog") return BRACHYCEPHALIC_BREEDS.value.dog;
  if (species === "cat") return BRACHYCEPHALIC_BREEDS.value.cat;
  return [];
}
