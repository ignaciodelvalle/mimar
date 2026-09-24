// Client-input contract for org-side intake (native-readiness T1.3).
//
// WHAT THIS IS, AND WHAT IT IS NOT
// ---------------------------------------------------------------------------
// The web app already has zod schemas for intake, but they validate the DB
// WRITE shape — the row and the event payload, after every domain resolution
// has run. Nothing described what a CLIENT is allowed to send. The application
// layer read it a field at a time out of FormData
// (`String(formData.get("name") ?? "").trim()`), so the accepted input shape
// existed only as the sum of ~20 statements inside one 660-line use-case. A
// native client cannot read that, and neither can a reviewer.
//
// So this is the CLIENT-INPUT boundary: what fields exist, which are required,
// which are enums, and what an empty string means. It stops exactly where
// domain knowledge starts.
//
// WHAT DELIBERATELY STAYS IN THE APP
//   - breed catalog resolution (species-scoped, jurisdiction-aware),
//   - province/locality canonicalization against the INDEC catalogue,
//   - date parsing and the future-date plausibility guard,
//   - tattoo normalization,
//   - the chip cross-check.
// Every one of those needs a catalogue, a clock, or the database. Pulling them
// in here would make the contract un-installable, which is the one thing it
// exists to avoid.
//
// WHY MACHINE CODES INSTEAD OF MESSAGES
// ---------------------------------------------------------------------------
// The failure messages are stable CODES, not es-AR copy. The contract carries
// data and rules; the consumer owns its words. Web maps them to the exact
// strings the intake wizard has always shown; a native client maps the same
// codes to whatever its screens say, without importing a web app's copy deck.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * Why the animal came in. "seizure" is deliberately absent: a decomiso is a
 * State act and goes through the government flow, never the org intake form.
 * (The DB enum still carries the value — this is the CLIENT's vocabulary.)
 */
export const INTAKE_REASONS = ["rescue", "surrender", "stray_found", "other"] as const;
export type IntakeReason = (typeof INTAKE_REASONS)[number];

/**
 * The custody role the organization takes. "shelter_custody" is the
 * rescue-and-rehome default; "owner" covers sanctuary / long-term-keep cases
 * with no rehoming pathway planned.
 */
export const CUSTODY_ROLES = ["shelter_custody", "owner"] as const;
export type CustodyRole = (typeof CUSTODY_ROLES)[number];

export const PET_SEXES = ["male", "female", "unknown"] as const;
export type PetSex = (typeof PET_SEXES)[number];

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

/** A trimmed optional string; absent, blank and `null` all mean "not stated".
 *
 *  `.nullish()` AND NOT `.optional()`, which is what it was (A5-ciudadanas-11).
 *  This helper EMITS `null` for a blank field and its input side refused one, so
 *  the schema's own output was not a valid input to it — the exact defect
 *  35f6e9430 fixed in `register-pet.ts` after the PO's first Play-build
 *  registration answered 400. It was latent here only because this schema's sole
 *  consumers build the body out of `FormData`, which omits a blank key rather
 *  than nulling it; the next client that parses a draft and posts `parsed.data`
 *  would have been the same bug again. The round-trip test in
 *  `__tests__/input-round-trip.test.ts` now fences every schema in the package. */
const optionalText = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v : null));

/** A required trimmed string, failing with the given code when blank. */
const requiredText = (code: string) => z.string({ error: code }).trim().min(1, { error: code });

/**
 * A trimmed enum. The trim matters: form encodings and CSV mappers pad values,
 * and rejecting " rescue " while accepting "rescue" would be an invisible
 * difference between two clients sending the same intent.
 */
const trimmedEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.enum(values));

/**
 * A whole-number count of years or months. Absent or blank → null. Anything
 * unparseable → 0, and negatives clamp to 0: this mirrors the behaviour the
 * intake wizard has always had (`Math.max(0, parseInt(x) || 0)`), and it is
 * intentional — an age field is an ESTIMATE typed at a kennel door, so
 * rejecting "aprox 2" outright would block the intake over a guess.
 */
const ageCount = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => {
    if (v === undefined || v === null) return null;
    // ACCEPTS ITS OWN OUTPUT (A5-ciudadanas-11). This transform emits a NUMBER
    // and its input side took only a string, so re-parsing the parsed value
    // failed on every filled age — the `register-pet.ts` round-trip defect with
    // one extra step, since here even a non-blank field breaks it. The number
    // arm mirrors `register-pet.ts`'s `ageCount`, which grew the same union for
    // the same reason: a JSON client has no reason to quote an integer.
    if (typeof v === "number") return Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
    const trimmed = v.trim();
    if (!trimmed) return null;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isNaN(parsed) ? 0 : Math.max(0, parsed);
  });

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Failure codes, in the order the consumer should report them. The order is
 * part of the contract: the wizard shows ONE message, and which one it shows
 * must not depend on the order zod happens to collect issues in.
 */
export const CREATE_INTAKE_INPUT_CODES = [
  "NAME_REQUIRED",
  "SPECIES_REQUIRED",
  "INTAKE_REASON_REQUIRED",
] as const;
export type CreateIntakeInputCode = (typeof CREATE_INTAKE_INPUT_CODES)[number];

export const createIntakeInputSchema = z.object({
  // Required.
  name: requiredText("NAME_REQUIRED"),
  species: requiredText("SPECIES_REQUIRED"),
  intakeReason: z.preprocess(
    (v) => (typeof v === "string" ? v.trim() : v),
    z.enum(INTAKE_REASONS, { error: "INTAKE_REASON_REQUIRED" }),
  ),

  // Enums that fall back rather than fail. A client that sends nothing, or
  // something unrecognised, gets the safe default — neither field is a claim
  // about the animal that a wrong guess could corrupt.
  sex: trimmedEnum(PET_SEXES).catch("unknown"),
  custodyRole: trimmedEnum(CUSTODY_ROLES).catch("shelter_custody"),

  // Estimated age, from which the app derives an estimated date of birth.
  ageYears: ageCount,
  ageMonths: ageCount,

  // Free text and identifiers. Kept as raw trimmed strings: every one of these
  // is resolved, normalized or cross-checked by the app against something the
  // contract cannot see (a breed catalogue, a chip index, a tattoo registry).
  breed: optionalText,
  color: optionalText,
  distinguishingFeatures: optionalText,
  estimatedWeightKg: optionalText,
  microchipId: optionalText,
  microchipCountryCode: optionalText,
  tattooCode: optionalText,
  intakeCondition: optionalText,
  rescueJurisdiction: optionalText,

  // Date-only as the client typed it. Parsing and the future-date guard are
  // the app's, because "is this in the future" needs a clock and a timezone.
  occurredAt: optionalText,

  // Stable per-form-session UUID, so a double-tap does not create a second pet.
  clientIdempotencyKey: optionalText,
});

export type CreateIntakeInput = z.infer<typeof createIntakeInputSchema>;

/**
 * The single code a consumer should report for a failed parse, chosen by
 * CREATE_INTAKE_INPUT_CODES order rather than by whichever issue zod listed
 * first. Returns null when the error carries no code this contract defines,
 * which is the consumer's cue to fall back to a generic message instead of
 * showing a raw zod string to an operator.
 */
export function firstIntakeInputCode(error: z.ZodError): CreateIntakeInputCode | null {
  const seen = new Set(error.issues.map((issue) => issue.message));
  return CREATE_INTAKE_INPUT_CODES.find((code) => seen.has(code)) ?? null;
}
