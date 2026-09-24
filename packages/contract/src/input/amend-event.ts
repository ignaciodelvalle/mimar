// Client-input contract for CORRECTING an event —
// `POST /api/v1/pets/{publicToken}/events/{eventId}/amend`.
//
// A CORRECTION IS A NEW EVENT. Nothing in this repo edits or deletes a
// `pet_events` row — a database trigger refuses both — so "corregir" appends an
// `event_amended` record that references the original. The original stays
// readable forever; the reader projects the corrected value over it. That is
// the shape this schema describes, and it is why there is no `PATCH`.
//
// THE REFERENCE POINT is the web form
// (`app/(app)/mis-mascotas/[publicToken]/eventos/[eventId]/AmendEventForm.tsx`),
// field for field, so the two clients cannot disagree about what a correction
// IS. Two deliberate differences, both narrowing:
//
//   · NO `old` VALUE. The web sends the value it rendered; this sends only the
//     NEW one and the server fills `old` from the record it reads inside the
//     write. A client-supplied `old` is a claim about the server's own state,
//     and a stale one (a second correction landed while a form was open) would
//     write a history that never happened.
//   · A CHANGE IS A STRING OR A CLEARING. The web form stringifies every value
//     before sending, so a web correction can only ever produce text; accepting
//     richer JSON here would let a native client write a shape into a field
//     every renderer treats as text, and no web correction could produce it.
//     `null` clears the field, which is the one non-text outcome the form can
//     reach (an emptied input).
//
// WHAT IS NOT HERE, AND WHY:
//   · `targetEventId` and `publicToken` — both are PATH segments. A body that
//     also named them would create two sources for one identity and a way for
//     them to disagree.
//   · `Idempotency-Key` — a HEADER, like every other write on this surface. It
//     is a property of the REQUEST, not a fact about the correction, and a
//     header is where an HTTP client's own retry machinery can re-send it.
//
// WHY MACHINE CODES INSTEAD OF MESSAGES: the contract carries data and rules;
// the consumer owns its words. Same reasoning as `intake.ts`.

import { z } from "zod";

/**
 * Payload keys a correction may never name.
 *
 * The same four the web form excludes from its editable list, and each one is a
 * field ABOUT the record rather than a fact IN it: `payload_version` is what the
 * upcaster reads to decide the payload's shape (correcting it would hand every
 * later reader a mis-shaped record), and `actor_role` / `actor_user_id` /
 * `target_event_id` belong to the correction machinery itself.
 *
 * Exported so a client can filter its own form the same way instead of
 * discovering the rule from a refusal.
 */
export const NON_AMENDABLE_PAYLOAD_KEYS = [
  "payload_version",
  "actor_role",
  "actor_user_id",
  "target_event_id",
] as const;

/**
 * The minimum length of a stated reason.
 *
 * Matches the spine's own schema (`event_amended.reason` is `min(5)` when
 * present), so a reason this schema accepts is one the write can store. A
 * correction by an owner may omit it entirely; an administrative one may not,
 * and THAT rule lives on the server because it depends on who is asking.
 */
export const AMEND_REASON_MIN_LENGTH = 5;

export const AMEND_EVENT_INPUT_CODES = [
  "CHANGES_REQUIRED",
  "CHANGE_FIELD_REQUIRED",
  "CHANGE_FIELD_NOT_AMENDABLE",
  "REASON_TOO_SHORT",
] as const;
export type AmendEventInputCode = (typeof AMEND_EVENT_INPUT_CODES)[number];

const NON_AMENDABLE: ReadonlySet<string> = new Set(NON_AMENDABLE_PAYLOAD_KEYS);

const changeSchema = z.object({
  /** A key of the record's own payload. The server checks it is one. */
  field: z
    .string({ error: "CHANGE_FIELD_REQUIRED" })
    .trim()
    .min(1, { error: "CHANGE_FIELD_REQUIRED" })
    .refine((f) => !NON_AMENDABLE.has(f), { error: "CHANGE_FIELD_NOT_AMENDABLE" }),
  /** The corrected value. `null` clears the field. */
  value: z.union([z.string(), z.null()]),
});

export const amendEventInputSchema = z.object({
  /**
   * Why. Optional for an owner correcting their own record — the CHANGE is the
   * record, and demanding prose for "I mistyped the lot number" is how a form
   * teaches people to write "correccion".
   */
  reason: z
    .string()
    .trim()
    .min(AMEND_REASON_MIN_LENGTH, { error: "REASON_TOO_SHORT" })
    .nullish()
    .transform((v) => v ?? null),
  /**
   * At least one. A correction that changes nothing is not a correction, and
   * appending one would put an empty entry in a ledger people read as history.
   */
  changes: z.array(changeSchema).min(1, { error: "CHANGES_REQUIRED" }),
});

export type AmendEventInput = z.infer<typeof amendEventInputSchema>;

/**
 * The FIRST input code in a failed parse, for a client that wants to show one
 * message. Mirrors `firstRegisterPetInputCode` — same shape, same reason.
 */
export function firstAmendEventInputCode(error: z.ZodError<unknown>): AmendEventInputCode | null {
  for (const issue of error.issues) {
    const code = issue.message;
    if ((AMEND_EVENT_INPUT_CODES as readonly string[]).includes(code)) {
      return code as AmendEventInputCode;
    }
  }
  return null;
}
