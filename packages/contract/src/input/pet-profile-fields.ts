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
// Keep this file free of imports from other schema modules; `zod` is the only
// dependency it may have.

import { z } from "zod";

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
 * The upper bound on a stated age, in YEARS.
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
 * WHY IT CLAMPS INSTEAD OF REFUSING. An age field is an ESTIMATE, and rejecting
 * "aprox 2" would block a registration over a guess. The ceiling exists to keep
 * the DERIVATION well-formed, not to police data quality — and 250 was chosen
 * partly so a clamped value cannot masquerade as a real one. A pet recorded as
 * 250 years old is visibly a typo somebody can fix; one clamped to 40 looks like
 * a fact.
 */
export const MAX_PET_AGE_YEARS = 250;

/** The same bound expressed in months, so an owner may state the whole age either way. */
export const MAX_PET_AGE_MONTHS = MAX_PET_AGE_YEARS * 12;

/**
 * A whole-number count of years or months, as the owner typed it. Absent,
 * blank or `null` → null; unparseable → 0; negatives clamp to 0; anything past
 * `max` clamps to `max` (see MAX_PET_AGE_YEARS).
 *
 * Otherwise byte-identical to the wizard's behaviour
 * (`Math.max(0, parseInt(x) || 0)`) and intentional. Accepts a NUMBER too,
 * which the FormData path could not — a JSON client has no reason to quote an
 * integer. Accepts `null` because that is what this very transform emits for
 * an untouched field, and a client sends the transform's output back.
 */
export const ageCount = (max: number) =>
  z
    .union([z.string(), z.number()])
    .nullish()
    .transform((v) => {
      if (v === undefined || v === null) return null;
      if (typeof v === "number") {
        // The `isFinite` arm is a belt, not the guard that matters: `z.number()`
        // refuses NaN and ±Infinity BEFORE any transform runs (measured against
        // zod 4), so a wire body carrying one is rejected outright — and neither
        // can come out of `JSON.parse` anyway. This covers a caller that builds
        // the object in-process.
        return Number.isFinite(v) ? Math.min(max, Math.max(0, Math.trunc(v))) : 0;
      }
      const trimmed = v.trim();
      if (!trimmed) return null;
      const parsed = Number.parseInt(trimmed, 10);
      return Number.isNaN(parsed) ? 0 : Math.min(max, Math.max(0, parsed));
    });
