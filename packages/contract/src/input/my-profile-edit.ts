// What a client may SEND to `POST /api/v1/me/profile` — the person's own data.
//
// THE THREE-WAY FIELD SEMANTICS, WHICH ARE THE WRITER'S AND NOT AN INVENTION
// ---------------------------------------------------------------------------
// `update-profile.ts` states them and this mirrors them exactly:
//
//   undefined  → the caller is not touching this field; the stored value stays.
//   ""         → the caller is CLEARING it; the column becomes NULL.
//   "algo"     → store as given.
//
// The distinction is load-bearing and it is the reason this schema does not
// simply mark the five optional fields `.optional().default("")`. A form that
// posted `""` for a field it never showed would silently erase a phone number
// somebody entered on the web; a schema that folded `""` into `undefined` would
// make clearing a field impossible from the phone. Both are one line away, which
// is why the line is written down.
//
// `displayName` IS THE ONE REQUIRED FIELD, and it inherits the writer's own
// bounds rather than inventing friendlier ones: two to eighty characters,
// trimmed. A person cannot clear their display name — `profiles.display_name`
// is what every other surface renders them as.
//
// NO AVATAR, NO EMAIL, NO DNI, NO JURISDICTION, NO ROLE. The list is exactly the
// writer's six columns; see `@dim/contract/api`'s `my-profile.ts` for why the
// read's list has to be the same six and what breaks when it stops being.
//
// PHONE FORMAT IS NOT VALIDATED HERE, AND THAT IS DELIBERATE ON THE SERVER TOO.
// `update-profile.ts` says why: "Phone fields no longer enforce AR format
// server-side — the client form surfaces a soft warning via `lib/ar-phone.ts`
// instead. Older landlines, satellite phones, and foreign numbers all save
// without error." A schema that rejected them would be this package overruling
// a decision the writer already made, on behalf of a person in Salta with a
// landline.

import { z } from "zod";

import { isWritableName } from "./writable-name.ts";

/** The writer's own bounds. Named so a client can size its inputs. */
export const DISPLAY_NAME_MIN_LENGTH = 2;
export const DISPLAY_NAME_MAX_LENGTH = 80;
/** Free-form contact names — vet, emergency contact. */
export const CONTACT_NAME_MAX_LENGTH = 80;
/** Phone-shaped fields. Long enough for `+54 9 11 …` with separators. */
export const CONTACT_PHONE_MAX_LENGTH = 40;

/**
 * The per-field codes a client can act on locally.
 *
 * SCREAMING_SNAKE, like every other input module here, and deliberately NOT the
 * `lowercase_snake` of `@dim/contract/api`'s error vocabulary: these are refusals
 * a client computes for ITSELF before any round trip.
 */
export const MY_PROFILE_EDIT_INPUT_CODES = [
  "DISPLAY_NAME_TOO_SHORT",
  "DISPLAY_NAME_TOO_LONG",
  "DISPLAY_NAME_INVALID",
  "CONTACT_NAME_TOO_LONG",
  "CONTACT_PHONE_TOO_LONG",
] as const;

export type MyProfileEditInputCode = (typeof MY_PROFILE_EDIT_INPUT_CODES)[number];

/**
 * A clearable free-text field. `""` survives the parse — see the header; only
 * the LENGTH is bounded, and `.optional()` keeps "not sent" distinct from
 * "sent empty".
 */
const contactName = z
  .string()
  .max(CONTACT_NAME_MAX_LENGTH, { error: "CONTACT_NAME_TOO_LONG" })
  .optional();

const contactPhone = z
  .string()
  .max(CONTACT_PHONE_MAX_LENGTH, { error: "CONTACT_PHONE_TOO_LONG" })
  .optional();

export const myProfileEditInputSchema = z.object({
  // The shape rule is `completeIdentityInputSchema`'s, and this is the OTHER
  // door onto the same column (A2-alta-asentar-09). Two zero-width spaces trim
  // to length 2, clear `DISPLAY_NAME_MIN_LENGTH`, save, and leave a titular
  // whose name renders as nothing on their credential and on the public page
  // while every gate in the product reports the identity complete — which is
  // precisely the hole step 2 closed and this door kept open.
  displayName: z
    .string()
    .trim()
    .min(DISPLAY_NAME_MIN_LENGTH, { error: "DISPLAY_NAME_TOO_SHORT" })
    .max(DISPLAY_NAME_MAX_LENGTH, { error: "DISPLAY_NAME_TOO_LONG" })
    .refine(isWritableName, { error: "DISPLAY_NAME_INVALID" }),
  phone: contactPhone,
  preferredVetName: contactName,
  preferredVetPhone: contactPhone,
  emergencyContactName: contactName,
  emergencyContactPhone: contactPhone,
});

export type MyProfileEditInput = z.infer<typeof myProfileEditInputSchema>;

/**
 * The FIRST input code in a failed parse, for a client that wants to show one
 * message. Mirrors `firstAmendEventInputCode` — same shape, same reason.
 */
export function firstMyProfileEditInputCode(
  error: z.ZodError<unknown>,
): MyProfileEditInputCode | null {
  for (const issue of error.issues) {
    const code = issue.message;
    if ((MY_PROFILE_EDIT_INPUT_CODES as readonly string[]).includes(code)) {
      return code as MyProfileEditInputCode;
    }
  }
  return null;
}
