// Field vocabularies the ALTA and the EDIT share — in a module that imports no
// other schema module.
//
// WHY IT LIVES ALONE (owner-pet-actions, 2026-10-01). These sat in
// `register-pet.ts` while only the alta needed them. The sectioned "Editar
// datos" (`edit_profile` in `pet-profile-edit.ts`) needs the same acquisition
// vocabulary and the same age parsing — and `register-pet.ts` already imports
// `pet-profile-edit.ts` for the name and colour caps. Importing back would close
// the cycle `pet-species.ts` records: two modules that build zod schemas at
// module-evaluation time, one of them reading the other's bindings as
// `undefined`. So the shared pieces move BELOW both doors, and `register-pet.ts`
// re-exports them so every existing import path keeps working.
//
// Keep this file free of imports from other schema modules. Its age PARSING
// moved to `stated-age.ts` (alta-validacion-edad); only the ceilings stay here.

/**
 * How the animal came to live with this person. Optional everywhere — an owner
 * who does not want to say is not blocked from registering, or from editing.
 */
export const ACQUISITION_METHODS = [
  "adopted",
  "purchased",
  "found_stray",
  "gift",
  "born_in_litter",
  "other",
] as const;
export type AcquisitionMethod = (typeof ACQUISITION_METHODS)[number];

/**
 * The upper bound on a stated age, in YEARS — the cap `other` gets
 * (`MAX_STATED_AGE_YEARS_OTHER` in `reference/pet-age.ts` restates it), and the
 * bound that keeps the age → date derivation well-formed for every species.
 *
 * 250 is not a guess at how long a pet lives — it is the point past which a
 * number is certainly not an age. The bound has to exist at all because the
 * consumer DERIVES a date of birth from it with unguarded `Date` arithmetic:
 * `ageYears: 3000` produced the malformed string `"-000974-08"` on its way into
 * a Postgres `date` column (a 500), and `ageYears: 300000` threw a `RangeError`
 * out of `toISOString()` — outside any try/catch, so the response was not even
 * the error envelope. Both were demonstrated, not theorised (WU-B review FB-2).
 *
 * WHY SO HIGH, when no dog reaches 30. Because `species` includes `other`, and
 * in Argentina that is routinely a tortuga terrestre: 50-100 years is ordinary
 * for one and they are handed down within a family. A ceiling of 40 would
 * silently mangle a legitimate entry. 250 clears the longest-lived companion
 * animal on record several times over while keeping the derived date a
 * well-formed four-digit ISO year (worst case: 500 years back, ~1526).
 *
 * IT NO LONGER CLAMPS (alta-validacion-edad, 2026-10-07). The `ageCount` that
 * clamped to it let "3310 años" through as 250; both doors now REFUSE an age
 * past the species' cap (`stated-age.ts`), and every other species is capped
 * well below this.
 */
export const MAX_PET_AGE_YEARS = 250;

/** The same bound expressed in months, so an owner may state the whole age either way. */
export const MAX_PET_AGE_MONTHS = MAX_PET_AGE_YEARS * 12;
