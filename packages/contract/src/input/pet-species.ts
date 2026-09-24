// The species vocabulary, in a module with NO imports of its own.
//
// WHY IT LIVES ALONE. It used to sit in `register-pet.ts`, which is fine while
// only the alta needs it. On 2026-09-10 the species CORRECTION command was added
// to `pet-profile-edit.ts`, which imported the list from `register-pet.ts` — and
// `register-pet.ts` already imported `PET_NAME_MAX` / `PET_COLOR_MAX` from
// `pet-profile-edit.ts`. That closed a cycle, and a cycle between two modules
// that both build zod schemas AT MODULE-EVALUATION TIME is not a style problem:
// whichever side evaluates second sees `undefined` for the other's binding, so
// `.max(PET_NAME_MAX)` became `.max(undefined)` and EVERY pet name was refused
// as `NAME_TOO_LONG` — including the minimum valid registration. The mobile
// suite caught it; nothing in the web path did.
//
// A vocabulary shared by two doors belongs below both of them, the way
// `packages/contract/src/events/event-types.ts` sits below everything that names
// an event. Keep this file import-free: the moment it imports a schema module,
// the cycle can come back.
//
// `register-pet.ts` re-exports these two names so every existing consumer — and
// the package index — keeps its import path.

/**
 * The species the credential accepts.
 *
 * Enumerated HERE and enforced, unlike `intake.ts`'s free-text `species`. The
 * web alta is a picker offering exactly these six, so an enum is parity with
 * what the form can actually produce — and a free-text species is the same class
 * of defect as the free-text breed QA A4 closed: `breedsForSpecies` keys off
 * these strings, so a species outside the list silently gets an empty catalog.
 */
export const PET_SPECIES = ["dog", "cat", "rabbit", "guinea_pig", "ferret", "other"] as const;
export type PetSpecies = (typeof PET_SPECIES)[number];
