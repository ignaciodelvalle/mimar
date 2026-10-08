// The stated age — the rule BOTH doors run, the alta and the edit
// (alta-validacion-edad, 2026-10-07). In a module below both of them, for the
// cycle `pet-species.ts` records: `register-pet.ts` imports
// `pet-profile-edit.ts`, so the edit door cannot import the alta's schema back.
// Imports: zod and the import-free `reference/pet-age.ts`, nothing else.
//
// REFUSE, NEVER CLAMP. Both doors used `ageCount`, which clamped: "-4" and
// "aprox 2" became 0 and "3310" became 250. That is how QA, on a real phone, got
// "3310 años" all the way to the app's confirm step — the confirm row reads the
// draft, the schema had quietly turned it into 250, and the server would have
// stored a 250-year-old dog. A clamp that turns a typo into a different number
// is worse than a refusal: the owner is the only person who knows what they
// meant to type.
//
// THE RULE
//   · each field is a whole, non-negative number, or blank;
//   · when years are stated, months are the remainder (0..11) — "3 años 30
//     meses" is a typo, not an age. Months ALONE may run past 11 ("18 meses"
//     is how people talk about a cachorro) up to the cap below;
//   · the TOTAL is at most `maxStatedAgeYears(species)` — 40 years, or the old
//     derivation ceiling for `other` (see `reference/pet-age.ts` for why).
//
// THE EDIT DOOR APPLIES IT TO A CHANGED AGE ONLY (`editedAgeRefusal`). An edit
// form shows the stored birth date as an age and posts it back; a stored date
// that reads as 60 years on a dog — written when the door clamped at 250 — must
// not lock its owner out of correcting the animal's colour. Only an age the
// person actually TYPED is held to the rule.

import { z } from "zod";

import { ageMatchesBirthDate, maxStatedAgeYears } from "../reference/pet-age.ts";

/** The four age codes, in the order a form reports them. */
export const STATED_AGE_CODES = [
  "AGE_YEARS_INVALID",
  "AGE_MONTHS_INVALID",
  "AGE_MONTHS_OUT_OF_RANGE",
  "AGE_TOO_HIGH",
] as const;
export type StatedAgeCode = (typeof STATED_AGE_CODES)[number];

/** A whole non-negative number as typed: digits only once trimmed. */
const WHOLE_NUMBER = /^\d+$/;

/**
 * A stated count of years or months: blank → null, otherwise a whole number or
 * refused with `code`. Shape only — the RANGE needs the species and, on an edit,
 * the stored date, which a field cannot see.
 */
export const statedAgeCount = (code: "AGE_YEARS_INVALID" | "AGE_MONTHS_INVALID") =>
  z
    .union([z.string(), z.number()])
    .nullish()
    .refine(
      (v) => {
        if (v === undefined || v === null) return true;
        if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0;
        const trimmed = v.trim();
        return trimmed === "" || WHOLE_NUMBER.test(trimmed);
      },
      { error: code },
    )
    .transform((v) => {
      if (v === undefined || v === null) return null;
      if (typeof v === "number") return v;
      const trimmed = v.trim();
      return trimmed === "" ? null : Number.parseInt(trimmed, 10);
    });

/**
 * The range half of the rule: the months remainder and the species cap. ONE
 * function, run by `registerPetInputSchema` and by the standalone checks below,
 * so the doors cannot drift.
 *
 * Reads every value defensively: zod 4 runs an object refinement even after a
 * NON-fatal field issue (a blank name, a malformed age — measured), so a value
 * here may be one its own field refused.
 */
export function refuseImplausibleAge(
  input: { species?: unknown; ageYears?: unknown; ageMonths?: unknown },
  ctx: z.RefinementCtx,
): void {
  const years = typeof input.ageYears === "number" ? input.ageYears : null;
  const months = typeof input.ageMonths === "number" ? input.ageMonths : null;
  if (years !== null && years > 0 && months !== null && months > 11) {
    ctx.addIssue({ code: "custom", message: "AGE_MONTHS_OUT_OF_RANGE", path: ["ageMonths"] });
  }
  const species = typeof input.species === "string" ? input.species.trim() : null;
  const totalMonths = (years ?? 0) * 12 + (months ?? 0);
  if (totalMonths > maxStatedAgeYears(species) * 12) {
    ctx.addIssue({
      code: "custom",
      message: "AGE_TOO_HIGH",
      path: [years !== null && years > 0 ? "ageYears" : "ageMonths"],
    });
  }
}

const statedAgeSchema = z
  .object({
    species: z.unknown(),
    ageYears: statedAgeCount("AGE_YEARS_INVALID"),
    ageMonths: statedAgeCount("AGE_MONTHS_INVALID"),
  })
  .superRefine(refuseImplausibleAge);

/** The raw age as a door received it — strings from a form, numbers from JSON. */
export type RawStatedAge = { species: unknown; ageYears: unknown; ageMonths: unknown };

/**
 * The stated-age rule ALONE, for a door that is not `registerPetInputSchema` —
 * the web alta's server action reads a `FormData`, not that JSON body, and had
 * no age rule at all (its parser did `Math.max(0, parseInt(x) || 0)`, uncapped).
 * Same field helpers, same refinement, same codes, same order.
 */
export function statedAgeRefusal(raw: RawStatedAge): StatedAgeCode | null {
  const parsed = statedAgeSchema.safeParse(raw);
  if (parsed.success) return null;
  const seen = new Set(parsed.error.issues.map((issue) => issue.message));
  return STATED_AGE_CODES.find((code) => seen.has(code)) ?? "AGE_YEARS_INVALID";
}

/**
 * The rule for an EDIT: `statedAgeRefusal`, but only for an age the person
 * changed. `null` when the posted age is blank (clearing the date), is the age
 * `storedDateOfBirth` reads as `now` (the form posted back what it showed — the
 * same ±1-day match `resolveEditedBirthDate` uses to keep the stored date), or
 * is a plausible new age.
 *
 * The SHAPE is checked first and always: a form only ever shows whole numbers,
 * so a malformed value was typed, never posted back.
 */
export function editedAgeRefusal(
  raw: RawStatedAge,
  storedDateOfBirth: string | null,
  now: Date,
): StatedAgeCode | null {
  const years = statedAgeCount("AGE_YEARS_INVALID").safeParse(raw.ageYears);
  if (!years.success) return "AGE_YEARS_INVALID";
  const months = statedAgeCount("AGE_MONTHS_INVALID").safeParse(raw.ageMonths);
  if (!months.success) return "AGE_MONTHS_INVALID";
  if (years.data === null && months.data === null) return null;
  if (
    storedDateOfBirth !== null &&
    ageMatchesBirthDate(storedDateOfBirth, { years: years.data, months: months.data }, now)
  ) {
    return null;
  }
  return statedAgeRefusal(raw);
}
