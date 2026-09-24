// What a client may SEND to `POST /api/v1/adoptions/{petToken}`.
//
// IT IS A MIRROR OF `validateApplicationInput`, NOT A SECOND OPINION
// ---------------------------------------------------------------------------
// `src/modules/adoption/domain/application-rules.ts` is the rule and it stays
// the rule: the use-case runs it on every submission from either door, and this
// schema exists so the PHONE can refuse a form locally instead of spending a
// round trip to be told the motivation is too short.
//
// That makes "identical" a requirement rather than a nicety, in BOTH directions:
//
//   · STRICTER HERE would refuse a submission the server would have accepted —
//     a form that cannot be sent, with no server message to explain it.
//   · LOOSER HERE would let a client draw a "Enviar" it has already been told
//     will fail, and hand back a generic envelope code instead of the field.
//
// The two bounds below are therefore transcribed from that file and NAMED, so
// the transcription is visible in a diff rather than buried in a `.min(30)`.
// `__tests__/adoption-application-input-parity.test.ts` is what keeps them
// honest: it runs both validators over the same inputs and fails when they
// disagree about any of them.
//
// THE CONSENT IS `z.literal(true)` AND NOT `z.boolean()`
// ---------------------------------------------------------------------------
// `profileSharingConsent` is the applicant agreeing that a shelter may read
// their name, e-mail and phone. The server refuses anything but `true` (Ley
// 25.326 — consent is an act, not a default), so a schema that accepted `false`
// here would parse a submission whose only possible outcome is a refusal.
//
// NO PET TOKEN IN THE BODY. It is in the path, the server resolves the animal
// from the path, and a body field naming a second pet would be a field somebody
// eventually trusts. The web action takes `petPublicToken` in its input because
// a server action has no path to read it from; an HTTP route does.
//
// ONE PATH, TWO METHODS. `GET /api/v1/adoptions/{petToken}` is the ficha and
// `POST` is the application — the shape `pets/{token}/profile` and `me/privacy`
// already use, and the reason is the same one WU-R wrote down: a sub-path per
// verb is a second URL to authorize, to rate-limit and to keep in step with the
// first. There is no command discriminator in this body because there is one
// command; a union member is one line away the day there are two.

import { z } from "zod";

/** Where the applicant lives. The four the web form offers, unchanged. */
export const ADOPTION_HOUSING_TYPES = [
  "casa_con_patio",
  "casa_sin_patio",
  "departamento",
  "otro",
] as const;

export type AdoptionHousingType = (typeof ADOPTION_HOUSING_TYPES)[number];

/** Whether the applicant has lived with an animal before. */
export const ADOPTION_PRIOR_PETS = ["yes_currently", "yes_before", "no"] as const;

export type AdoptionPriorPets = (typeof ADOPTION_PRIOR_PETS)[number];

/**
 * Transcribed from `application-rules.ts`. A minimum on the MOTIVATION and
 * nothing else: it is the one field a shelter reads first, and thirty
 * characters is the length below which somebody has typed "quiero un perro".
 */
export const ADOPTION_MOTIVATION_MIN_LENGTH = 30;
/** Also transcribed. Applies to all four free-text fields, after trimming. */
export const ADOPTION_TEXT_MAX_LENGTH = 2000;

/**
 * The per-field codes a client can act on locally.
 *
 * SCREAMING_SNAKE, like every other input module here, and deliberately NOT the
 * `lowercase_snake` of `@dim/contract/api`'s error vocabulary: these are refusals
 * a client computes for ITSELF before any round trip.
 */
export const ADOPTION_APPLICATION_INPUT_CODES = [
  "HOUSING_TYPE_REQUIRED",
  "CONSENT_REQUIRED",
  "MOTIVATION_TOO_SHORT",
  "TEXT_TOO_LONG",
  "PRIOR_PETS_REQUIRED",
] as const;

export type AdoptionApplicationInputCode = (typeof ADOPTION_APPLICATION_INPUT_CODES)[number];

/**
 * An optional free-text answer.
 *
 * `null` AND `undefined` BOTH MEAN "no answer", because the writer already
 * treats them identically — `input.otherPets ? input.otherPets.trim() || null :
 * null` collapses `undefined`, `null` and `"   "` onto the same stored `NULL`.
 * There is no clearing semantics to preserve here (an application is appended
 * once and never edited), so keeping the two apart the way `my-profile-edit.ts`
 * does would model a distinction the spine cannot hold.
 */
const optionalAnswer = z
  .string()
  .trim()
  .max(ADOPTION_TEXT_MAX_LENGTH, { error: "TEXT_TOO_LONG" })
  .nullish();

export const adoptionApplicationInputSchema = z.object({
  housingType: z.enum(ADOPTION_HOUSING_TYPES, { error: "HOUSING_TYPE_REQUIRED" }),
  /**
   * REQUIRED, unlike the other three, and it carries BOTH bounds. The order
   * matters: `.trim()` runs before both, so thirty spaces is too short rather
   * than acceptable — which is what the server's `motivation?.trim() ?? ""`
   * does.
   */
  motivation: z
    .string()
    .trim()
    .min(ADOPTION_MOTIVATION_MIN_LENGTH, { error: "MOTIVATION_TOO_SHORT" })
    .max(ADOPTION_TEXT_MAX_LENGTH, { error: "TEXT_TOO_LONG" }),
  priorPets: z.enum(ADOPTION_PRIOR_PETS, { error: "PRIOR_PETS_REQUIRED" }),
  otherPets: optionalAnswer,
  dailyRoutine: optionalAnswer,
  notes: optionalAnswer,
  profileSharingConsent: z.literal(true, { error: "CONSENT_REQUIRED" }),
});

export type AdoptionApplicationInput = z.infer<typeof adoptionApplicationInputSchema>;

/**
 * The FIRST input code in a failed parse, for a client that wants to show one
 * message. Mirrors `firstMyProfileEditInputCode` — same shape, same reason.
 */
export function firstAdoptionApplicationInputCode(
  error: z.ZodError<unknown>,
): AdoptionApplicationInputCode | null {
  for (const issue of error.issues) {
    const code = issue.message;
    if ((ADOPTION_APPLICATION_INPUT_CODES as readonly string[]).includes(code)) {
      return code as AdoptionApplicationInputCode;
    }
  }
  return null;
}
