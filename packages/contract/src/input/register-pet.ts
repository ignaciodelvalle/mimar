// Client-input contract for CITIZEN pet registration — `POST /api/v1/pets`
// (native-readiness WU-B).
//
// WHAT THIS IS, AND HOW IT DIFFERS FROM `intake.ts`
// ---------------------------------------------------------------------------
// `intake.ts` describes what an ORGANIZATION sends when an animal arrives at a
// shelter: an intake reason, a custody role, a rescue jurisdiction. This
// describes what a PERSON sends when they register their own animal. The two
// overlap on the animal's identity fields and diverge on everything that is
// about the transaction, which is why they are two schemas and not one with
// half its fields conditional.
//
// The reference point is the web alta wizard
// (`app/(app)/mis-mascotas/nueva/MinimalNewPetForm.tsx`) — the same fields, in
// the same meanings, so the two clients cannot disagree about what a
// registration IS. The server reads it a field at a time out of `FormData`;
// a native client cannot, and neither can a reviewer.
//
// WHAT DELIBERATELY STAYS IN THE APP (same boundary `intake.ts` draws)
//   - breed catalog resolution — the CATALOG ships in
//     `@dim/contract/reference` so a client can render the picker offline, but
//     the RESOLUTION (folding, aliases, species membership) is the server's
//     authority (`lib/domain/breed-validation.ts`, QA A4). A client picks a
//     label; the server decides what it means.
//   - province/locality canonicalization against the INDEC catalogue,
//   - the estimated-age → date-of-birth derivation, which needs a clock,
//   - PPP classification, which needs the pet's jurisdiction and its rules.
//
// WHAT IS NOT HERE AT ALL, AND WHY — read this before adding a field
// ---------------------------------------------------------------------------
//   · `clientIdempotencyKey`. `intake.ts` carries it as a body field because the
//     web posts a FormData with a hidden input. This endpoint takes it as the
//     `Idempotency-Key` HTTP HEADER instead — it is a property of the REQUEST,
//     not a fact about the animal, and a header is where an HTTP client's own
//     retry machinery can see and re-send it. Same mechanism underneath: it
//     lands in `pet_events.client_idempotency_key` exactly as the form's does.
//   · The MICROCHIP fields. Registering a chip is not a field, it is a protocol:
//     format validation, then a cross-check that can find the code on a LOST pet
//     (the web navigates to a match page), on an ACTIVE pet (a force-token
//     escape hatch plus a dispute written to the other pet's spine) or on a
//     DECEASED one (a hard block). None of that has a native counterpart yet, and
//     half a protocol is worse than none — a client that could register a chip
//     but not adjudicate a collision would dead-end its user at a web URL. An
//     owner registers the animal here and adds the chip afterwards. Deferred to
//     the work unit that ports the collision flow.
//   · The PHOTO. Multipart upload is its own transport decision; `POST
//     /api/v1/pets` takes JSON. A pet registers without one, exactly as it can
//     on the web.
//   · `custodyKind`. The web's minimal alta does not offer it either — declaring
//     an animal as held in tránsito is a custody claim with its own flow, not a
//     checkbox on a registration form. Registrations through this endpoint are
//     `owner`.
//   · The profile extras (favourite foods, allergies, training level, insurance,
//     permanent conditions). They are edits to a pet that already exists, and the
//     alta wizard does not ask for them either.
//
// WHY MACHINE CODES INSTEAD OF MESSAGES: the contract carries data and rules;
// the consumer owns its words. Same reasoning as `intake.ts`.

import { z } from "zod";

import { maxStatedAgeYears } from "../reference/pet-age.ts";

// The sex vocabulary has exactly ONE definition in this package and it is
// `intake.ts`'s. Re-declaring it here would compile, would look identical, and
// would be the first day of two lists drifting.
import { PET_SEXES } from "./intake.ts";
// The caps on `pets.name` and `pets.color` have exactly ONE definition too, and
// it is the EDIT door's. Alta accepted a 90-character name that Editar then
// refused to re-save (A2-alta-asentar-11): two doors onto one column disagreeing
// about what fits in it. Imported rather than re-declared, for the reason above.
import { PET_COLOR_MAX, PET_NAME_MAX } from "./pet-profile-edit.ts";
// The acquisition vocabulary and the age parsing are the EDIT door's too
// (`edit_profile`), so they live in a leaf below both — see that file for the
// cycle it avoids. Imported for this schema and re-exported for every existing
// import path.
import {
  ACQUISITION_METHODS,
  type AcquisitionMethod,
  MAX_PET_AGE_MONTHS,
  MAX_PET_AGE_YEARS,
} from "./pet-profile-fields.ts";
// Imported, not just re-exported: this file's own `registerPetInputSchema` names
// PET_SPECIES at module-evaluation time, so it needs the local binding too.
import { PET_SPECIES, type PetSpecies } from "./pet-species.ts";
import { isWritableName } from "./writable-name.ts";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * The species the credential accepts — DEFINED in `pet-species.ts` and
 * re-exported here so every existing import path keeps working.
 *
 * It moved out on 2026-09-10 because `pet-profile-edit.ts` needed it for the
 * species-correction command, and this file already imports that file's length
 * caps: the two together closed an import cycle that silently broke every
 * registration. See `pet-species.ts` for the full account.
 */
export { PET_SPECIES, type PetSpecies };

/**
 * How the animal came to live with this person, and the ceilings on a stated
 * age — DEFINED in `pet-profile-fields.ts` since owner-pet-actions and
 * re-exported here so every existing import path keeps working.
 */
export { ACQUISITION_METHODS, type AcquisitionMethod, MAX_PET_AGE_MONTHS, MAX_PET_AGE_YEARS };

// ---------------------------------------------------------------------------
// Field helpers (same semantics as intake.ts — see the notes there)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THE OUTPUT OF THIS SCHEMA MUST BE A VALID INPUT TO IT
// ---------------------------------------------------------------------------
// The native wizard parses its draft with this object and sends `parsed.data`
// — the OUTPUT — as the request body, which the route re-parses with the same
// object. That is the whole point of sharing the schema: one verdict, reached
// twice. It holds only if every value this schema EMITS is a value it ACCEPTS.
//
// It did not hold. The optional helpers below emit `null` for a blank field,
// and their input side was `.optional()`, which admits `undefined` and refuses
// `null`. So a registration that left ANY optional blank — breed, colour,
// weight, age — validated on the phone, travelled as `"breed": null`, and came
// back 400 `invalid_request` from the server. Every optional filled in, it
// passed; which is exactly why an emulator run through the wizard never caught
// it and the PO's first real registration on the Play build did (2026-09-05).
//
// Hence every field whose absent value is `null` must ACCEPT `null`:
// `.nullish()` for the text and age helpers below, and the preprocess on
// `acquisitionMethod`, which already did. The contract test parses the
// schema's own output back through it so the fixed point stays fenced.
//
// THE CLASS IS NOT CLOSED ACROSS THE PACKAGE. `record-event.ts`, `lost-mode.ts`
// and `welfare-report.ts` accept `null`. `intake.ts` (thirteen optionals) and
// `auth.ts`'s `returnTo` still do not — they are safe only because their sole
// consumers build the body from FormData, which omits a blank key rather than
// nulling it. A native client that parses a draft with either schema and posts
// the output is this bug again; give that schema the same round-trip test first.

/** A trimmed optional string: absent, blank and `null` all mean "not stated". */
const optionalText = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v : null));

/** A required trimmed string, failing with the given code when blank. */
const requiredText = (code: string) => z.string({ error: code }).trim().min(1, { error: code });

/**
 * The ceiling on an estimated weight, in kilograms.
 *
 * NOT a data-quality opinion — `record-event.ts`'s `MAX_WEIGHT_KG` (120) is the
 * one of those, on a weight somebody MEASURED. This number is the COLUMN:
 * `pets.estimated_weight_kg` is `numeric(5, 2)`, so 999.99 is the largest value
 * it can hold and anything above it is a Postgres `numeric field value out of
 * range`, which arrives at the owner as a 500 (A2-alta-asentar-01). Kept wider
 * than 120 deliberately: `species` includes `other`, and a cerdo vietnamita of
 * 150 kg is a real registration this door has no business refusing.
 *
 * The rounding matters at BOTH ends. `numeric(5, 2)` rounds to two decimals
 * BEFORE it checks the precision, so `999.999` becomes `1000.00` and overflows —
 * and `0.001` becomes `0.00`, a stored weight of zero the typed value never
 * looked like. That is why the guard below compares the ROUNDED value against
 * both bounds rather than the typed one.
 */
export const MAX_ESTIMATED_WEIGHT_KG = 999.99;

/** A decimal comma with digits on both sides, as an es-AR keyboard produces it. */
const DECIMAL_COMMA = /^\d+,\d+$/;

/** What `numeric` accepts once the comma is a dot: digits, one optional point. */
const PLAIN_DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * An estimated weight, as the owner typed it, in a form Postgres can store.
 *
 * WHY THIS IS NOT `optionalText`, which is what it was. The value goes into
 * `numeric(5, 2)` UNPARSED — the repository hands the string straight to the
 * insert — so the column is the validator, and its refusals are 500s. Two of
 * them, both measured:
 *
 *   · `"12,5"` — the es-AR decimal comma, which is what the phone's
 *     `inputMode="decimal"` keyboard puts under the owner's thumb and what every
 *     Argentine writes. `invalid input syntax for type numeric` → the route's
 *     `pet_registration_failed` 500 → "Volvé a intentar en unos minutos", and
 *     the retry re-sends the same body and fails identically. Nothing in the
 *     message names the weight field.
 *   · `"1000"` and up — `numeric field value out of range`, same 500.
 *
 * So the comma is NORMALISED (the repo already does exactly this rewrite for the
 * org CSV path, `lib/domain/intake-csv.ts`) and everything the column cannot
 * hold is refused HERE, with a code the form can point at a field, instead of
 * downstream with a code that says the server broke.
 *
 * NORMALISED, NOT RE-SPELLED: only `12,5` → `12.5`. Not "kg" suffixes, not
 * internal spaces — `"1 2"` collapsing to `"12"` would be this schema inventing
 * a weight nobody typed, which is the failure mode `writable-name.ts` refuses
 * for names and the same argument applies to a number.
 */
const estimatedWeight = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => {
    if (v === undefined || v === null) return null;
    // A JSON client has no reason to quote a number; `String(12.5)` is the same
    // "12.5" the string arm produces, so both wire shapes converge here. A
    // non-finite one never gets this far — `z.number()` refuses NaN and ±Infinity
    // before any transform runs — and would fail the shape check below anyway.
    if (typeof v === "number") return String(v);
    const trimmed = v.trim();
    if (!trimmed) return null;
    return DECIMAL_COMMA.test(trimmed) ? trimmed.replace(",", ".") : trimmed;
  })
  .refine(
    (v) => {
      if (v === null) return true;
      if (!PLAIN_DECIMAL.test(v)) return false;
      const n = Number.parseFloat(v);
      if (!Number.isFinite(n)) return false;
      // BOTH bounds are about the value the COLUMN ends up holding, not the one
      // the owner typed: `numeric(5, 2)` rounds to two decimals before it stores
      // or checks anything. At the ceiling that is `999.999` → `1000.00` → out
      // of range. At the FLOOR it is `0.001` → `0.00` (verified against the live
      // Postgres), and a `n <= 0` guard reads the typed value, waves it through,
      // and stores a weight of zero as a fact about an animal — a number a vet
      // or a PPP threshold will later read as a measurement.
      const stored = Math.round(n * 100) / 100;
      return stored > 0 && stored <= MAX_ESTIMATED_WEIGHT_KG;
    },
    { error: "WEIGHT_INVALID" },
  );

/** A trimmed enum — form encodings and JSON serialisers both pad values. */
const trimmedEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.enum(values));

// ---------------------------------------------------------------------------
// The stated age — REFUSED when implausible, no longer clamped
// ---------------------------------------------------------------------------
// The alta used `ageCount` from `pet-profile-fields.ts`, which clamps: "-4" and
// "aprox 2" became 0 and "3310" became 250. That is how QA, on a real phone,
// got "3310 años" all the way to the app's confirm step — the confirm row reads
// the draft, the schema had quietly turned it into 250, and the server would
// have stored a 250-year-old dog (alta-validacion-edad, 2026-10-07). A clamp
// that turns a typo into a different number is worse than a refusal: the owner
// is the only person who knows what they meant to type.
//
// So the ALTA refuses, with a code per field the form can point at:
//   · each field is a whole, non-negative number, or blank;
//   · when years are stated, months are the remainder (0..11) — "3 años 30
//     meses" is a typo, not an age. Months ALONE may run past 11 ("18 meses"
//     is how people talk about a cachorro) up to the cap below;
//   · the TOTAL is at most `maxStatedAgeYears(species)` — 40 years, or the old
//     derivation ceiling for `other` (see `reference/pet-age.ts` for why).
//
// The EDIT door (`pet-profile-edit.ts`) still parses with the clamping
// `ageCount`; tightening it is a separate change, because it re-saves STORED
// ages and a refusal there can lock an owner out of editing an unrelated field.

/** A whole non-negative number as typed: digits only once trimmed. */
const WHOLE_NUMBER = /^\d+$/;

/** A stated count of years or months: blank → null, otherwise a whole number or refused with `code`. */
const statedAgeCount = (code: "AGE_YEARS_INVALID" | "AGE_MONTHS_INVALID") =>
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
 * The range half of the stated-age rule: the months remainder and the
 * species cap. ONE function, run by `registerPetInputSchema` and by
 * `statedAgeRefusal` (the web's FormData door), so the two cannot drift.
 *
 * Reads every value defensively: zod 4 runs an object refinement even after a
 * NON-fatal field issue (a blank name, a malformed age — measured), so a value
 * here may be one its own field refused.
 */
function refuseImplausibleAge(
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

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Failure codes, in the order the consumer should report them. The order is part
 * of the contract: a form shows ONE message, and which one it shows must not
 * depend on the order zod happens to collect issues in.
 */
export const REGISTER_PET_INPUT_CODES = [
  "NAME_REQUIRED",
  "NAME_INVALID",
  "NAME_TOO_LONG",
  "SPECIES_REQUIRED",
  "PROVINCE_REQUIRED",
  "LOCALITY_REQUIRED",
  "AGE_YEARS_INVALID",
  "AGE_MONTHS_INVALID",
  "AGE_MONTHS_OUT_OF_RANGE",
  "AGE_TOO_HIGH",
  "COLOR_TOO_LONG",
  "WEIGHT_INVALID",
] as const;
export type RegisterPetInputCode = (typeof REGISTER_PET_INPUT_CODES)[number];

export const registerPetInputSchema = z
  .object({
    // Required — the four things a credential cannot exist without.
    //
    // THREE RULES, NOT ONE, and the two beyond "not blank" are both doors this
    // schema was the only one missing:
    //   · `PET_NAME_MAX` — the EDIT door's cap (A2-alta-asentar-11). Registering a
    //     90-character name and then being told "máximo 80" the first time you
    //     rename the animal is two doors disagreeing about one column. Applied
    //     flat here, unlike `edit_identity`'s grandfather-aware gate: there is no
    //     stored value to carry over on a pet that does not exist yet.
    //   · `isWritableName` — no `\p{C}`, at least one `\p{L}` (A2-alta-asentar-09).
    //     A zero-width space trims to length 1 and renders as nothing, so the
    //     credential and the public `/p` page show a pet with no name.
    name: requiredText("NAME_REQUIRED")
      .max(PET_NAME_MAX, { error: "NAME_TOO_LONG" })
      .refine(isWritableName, { error: "NAME_INVALID" }),
    species: z.preprocess(
      (v) => (typeof v === "string" ? v.trim() : v),
      z.enum(PET_SPECIES, { error: "SPECIES_REQUIRED" }),
    ),
    /**
     * ISO 3166-2 code as `GET /api/v1/localities` returned it ("AR-C", "AR-B").
     * NOT the display name: a name can be re-spelled by a catalogue update.
     */
    provinceCode: requiredText("PROVINCE_REQUIRED"),
    /**
     * Canonical locality name as `GET /api/v1/localities` returned it. Required
     * because a pet must always carry a jurisdiction (PO decision 2026-07-08: a
     * national registry needs at least the barrio/localidad as epidemiological
     * signal), and re-resolved server-side against the INDEC catalogue — a value
     * that never came from the search will be rejected there, not here.
     */
    localityName: requiredText("LOCALITY_REQUIRED"),
    /**
     * INDEC's own id for the locality row the person TAPPED, as
     * `GET /api/v1/localities` returned it (`LocalityV1.indecId`).
     *
     * OPTIONAL, AND IT IS THE ONE THAT DECIDES (A2-alta-asentar-03). The name
     * alone is ambiguous: the catalogue ships 68 (province, name) collisions, the
     * picker disambiguates them by showing the DEPARTMENT, and the server's
     * name-only lookup then stored the alphabetically first department regardless
     * of the row chosen — so a pet in San Martín, Mendoza was registered in San
     * Martín, Buenos Aires. Jurisdiction decides the responding authority, the PPP
     * regime and the epidemiological attribution; it is not a display detail.
     *
     * Optional rather than required because an installed build does not send it
     * and must keep registering animals. The server prefers the id when it is
     * there and falls back to the pair when it is not, so this is additive on both
     * sides — and `localityName` stays required so the fallback always has a value.
     */
    localityIndecId: optionalText,

    // Enums that fall back rather than fail. Neither is a claim about the animal
    // that a wrong guess could corrupt.
    sex: trimmedEnum(PET_SEXES).catch("unknown"),

    // Optional identity fields. Raw trimmed strings: `breed` is resolved against
    // the species catalog server-side, and the rest are free text by nature.
    breed: optionalText,
    // Capped at the EDIT door's number for the same reason the name is — one
    // column, one cap. `breed` takes none: it is resolved against the species
    // catalog server-side, so its length is the catalog's problem, not a person's.
    color: optionalText.refine((v) => v === null || v.length <= PET_COLOR_MAX, {
      error: "COLOR_TOO_LONG",
    }),
    estimatedWeightKg: estimatedWeight,

    // Estimated age, from which the server derives an estimated date of birth.
    // Shape here, range in the object refinement below — the cap depends on the
    // species, which a field cannot see. See "The stated age" above.
    ageYears: statedAgeCount("AGE_YEARS_INVALID"),
    ageMonths: statedAgeCount("AGE_MONTHS_INVALID"),

    /**
     * Absent or unrecognised → null. Never a reason to refuse a registration.
     *
     * Written as a preprocess that can only ever emit a valid member or null,
     * rather than as `.nullish().catch(null)`. The chain version LOOKED right and
     * was not: an ABSENT field still reached the inner enum and failed, so every
     * body that simply omitted this optional field was refused with
     * `invalid_request`. Caught by the route's happy-path test on the first run.
     * This shape has no branch where an invalid value reaches the enum at all.
     */
    acquisitionMethod: z.preprocess((v) => {
      const candidate = typeof v === "string" ? v.trim() : "";
      return (ACQUISITION_METHODS as readonly string[]).includes(candidate) ? candidate : null;
    }, z.enum(ACQUISITION_METHODS).nullable()),

    /**
     * Re-submit after a `duplicate_pet_suspected` refusal, meaning "yes, this is a
     * different animal".
     *
     * A literal boolean with no string coercion, and defaulted rather than
     * required, so the SAFE value is what a client that has never heard of the
     * gate sends. Overriding is a deliberate act; the schema makes it look like
     * one.
     */
    duplicateOverride: z.boolean().optional().default(false),
  })
  // RUNS EVEN WHEN A FIELD FAILED (zod 4 does not abort an object's refinements
  // on a field issue — measured), so every value is re-checked for its type
  // instead of trusted. This refinement is also what keeps the server's
  // `estimatedBirthDateFromAge` inside a well-formed year: the total it allows
  // is never past `MAX_PET_AGE_YEARS`.
  .superRefine(refuseImplausibleAge);

export type RegisterPetInput = z.infer<typeof registerPetInputSchema>;

export type StatedAgeCode = Extract<
  RegisterPetInputCode,
  "AGE_YEARS_INVALID" | "AGE_MONTHS_INVALID" | "AGE_MONTHS_OUT_OF_RANGE" | "AGE_TOO_HIGH"
>;

const STATED_AGE_CODES: readonly StatedAgeCode[] = [
  "AGE_YEARS_INVALID",
  "AGE_MONTHS_INVALID",
  "AGE_MONTHS_OUT_OF_RANGE",
  "AGE_TOO_HIGH",
];

const statedAgeSchema = z
  .object({
    species: z.unknown(),
    ageYears: statedAgeCount("AGE_YEARS_INVALID"),
    ageMonths: statedAgeCount("AGE_MONTHS_INVALID"),
  })
  .superRefine(refuseImplausibleAge);

/**
 * The stated-age rule ALONE, for a door that is not this schema — the web
 * alta's server action reads a `FormData`, not this JSON body, and had no age
 * rule at all (its parser did `Math.max(0, parseInt(x) || 0)`, uncapped).
 * Same field helpers, same refinement, same codes, same order.
 */
export function statedAgeRefusal(raw: {
  species: unknown;
  ageYears: unknown;
  ageMonths: unknown;
}): StatedAgeCode | null {
  const parsed = statedAgeSchema.safeParse(raw);
  if (parsed.success) return null;
  const seen = new Set(parsed.error.issues.map((issue) => issue.message));
  return STATED_AGE_CODES.find((code) => seen.has(code)) ?? "AGE_YEARS_INVALID";
}

/**
 * The single code a consumer should report for a failed parse, chosen by
 * `REGISTER_PET_INPUT_CODES` order rather than by whichever issue zod listed
 * first. Returns null when the error carries no code this contract defines,
 * which is the consumer's cue to fall back to a generic message instead of
 * showing a raw zod string to an owner.
 */
export function firstRegisterPetInputCode(error: z.ZodError): RegisterPetInputCode | null {
  const seen = new Set(error.issues.map((issue) => issue.message));
  return REGISTER_PET_INPUT_CODES.find((code) => seen.has(code)) ?? null;
}
