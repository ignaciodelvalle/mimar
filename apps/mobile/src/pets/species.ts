// es-AR names for the species vocabulary, and the reason there is no icon here.
//
// The list payload carries `species` as a plain `string` — the contract types it
// that way because the column is a string and the endpoint does not narrow it —
// so this function cannot be exhaustive over an enum and must handle a value it
// does not know.
//
// WHAT IT SHOWS FOR ONE IT DOES NOT KNOW, AND WHY THAT CHANGED (finding M1,
// review 2026-09-07). This file used to return the RAW value, and argued for it:
// "showing a user 'Otro' for an animal the server called `chinchilla` hides a
// gap in this app behind a word that looks deliberate." The objection is right
// and the remedy was wrong — it is the same defect `ui/enum-label.ts` exists
// for, one layer over. `chinchilla`, `bearded_dragon`, `pot_bellied_pig` are
// internal identifiers in English, in a wallet whose entire UI is es-AR, and an
// OTA channel makes meeting one ORDINARY: `docs/mobile/ota-policy.md` requires
// the SERVER to stay compatible with the oldest install still opening, so a
// published bundle meets a newer vocabulary by design rather than by accident.
//
// `UNKNOWN_SPECIES_LABEL` answers both halves at once. It is a real es-AR
// phrase, and it is NOT the label of the real `other` member ("Otro"), so a
// species this build has never heard of still does not disappear into a
// deliberate-looking category — which is the whole of the original objection.
//
// WHY A WORD AND NOT AN ICON. A species glyph at list size is a guessing game
// (a ferret and a rabbit are the same silhouette at 20px), and this list already
// carries a photo slot for recognition. The word is unambiguous, translatable
// and readable by a screen reader. When there is a real icon set with real
// drawings, it goes BESIDE this label, not instead of it.

import { PET_SPECIES, type PetSpecies } from "@dim/contract/input";

const LABELS: Record<PetSpecies, string> = {
  dog: "Perro",
  cat: "Gato",
  rabbit: "Conejo",
  guinea_pig: "Cobayo",
  ferret: "Hurón",
  other: "Otro",
};

const KNOWN: ReadonlySet<string> = new Set(PET_SPECIES);

/**
 * What a citizen reads for a species this build has never heard of.
 *
 * Deliberately NOT "Otro" — that is `other`'s own label, and collapsing the two
 * would hide a gap in this app behind a category somebody chose on purpose. See
 * the header.
 */
export const UNKNOWN_SPECIES_LABEL = "Otra especie";

/** The es-AR name, or an honest es-AR fallback when this build does not know it. */
export function speciesLabel(species: string): string {
  const key = species.trim();
  return KNOWN.has(key) ? LABELS[key as PetSpecies] : UNKNOWN_SPECIES_LABEL;
}

/** The species picker's options, in the order a citizen wallet should show them. */
export const SPECIES_OPTIONS: ReadonlyArray<{ value: PetSpecies; label: string }> = PET_SPECIES.map(
  (value) => ({ value, label: LABELS[value] }),
);
