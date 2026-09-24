// What a client may send to `POST /api/v1/me/caretaker-grants` — the five
// cuidador-temporal commands the WEB actually offers.
//
// FIVE, NOT SEVEN, AND THE TWO MISSING ONES ARE THE INTERESTING PART
// ---------------------------------------------------------------------------
// `src/modules/caretakers/actions.ts` exports six citizen-facing controllers and
// the state machine (`domain/grant-state.ts`) names eight actions. This contract
// carries five, because five is what an owner can reach from the web:
//
//   · `withdraw` — the CARETAKER stepping down — has a server action
//     (`withdrawCaretakerGrantAction`) and NO CALLER. Nothing in `app/**`
//     imports it; the only other mentions in the tree are its own definition and
//     the migration comment that declared its audit action. A caretaker cannot
//     renounce from a browser today. Shipping it here would not be parity, it
//     would be a native-only power to end somebody else's arrangement — and the
//     screen that should ask "¿y el animal, dónde está?" was never designed,
//     because the flow was never built.
//   · `return` — "el cuidador me devolvió el animal" — has no action wrapper at
//     all. `endCaretakerGrant` accepts it; nothing calls it with that argument.
//
// Both are recorded here rather than left as an absence, so the next reader does
// not "complete the set" and hand a phone something the browser refuses.
//
// WHY ALL FIVE LIVE UNDER `/me` AND NOT UNDER `/pets/{token}`
// ---------------------------------------------------------------------------
// Same shape as `transfer.ts`, and for the same reason, with one extra wrinkle:
//
//   · `accept` and `reject` are sent by the INVITEE, who holds no `ownerships`
//     row on the animal — that is what an invitation is. Their authorization is
//     an id-or-email match against the grant ROW (`accept-caretaker-grant.ts`,
//     the `matchesId || matchesEmail` pair), not a custody check. A URL shaped
//     `/pets/{publicToken}/…` would invite an implementer to reach for
//     `resolvePetHolderAccess`, which refuses the one caller the command exists
//     for.
//   · `designate`, `cancel` and `revoke` ARE pet-addressed and carry
//     `petPublicToken` in the body, because the web guards all three with
//     `requireTitularAccess(petPublicToken)` and this surface must run the same
//     guard on the same input. They still live here rather than under the pet,
//     because splitting a five-command feature across two URLs to buy a path
//     segment two of them cannot honour is the trade `transfer.ts` already
//     refused.
//
// THE PET TOKEN IS NOT REDUNDANT ON `cancel` AND `revoke`, even though the grant
// token alone identifies the row: it is the GUARD'S INPUT. Resolving the pet FROM
// the grant would be a second way to reach `requireTitularAccess`'s argument that
// the web has never used — one a forged grant token would steer.
//
// Nothing cross-checks that the named grant belongs to the named pet, and the web
// does not either. What makes a mismatched pair harmless is that the WRITERS
// check the thing that matters: `cancelCaretakerGrant` refuses unless the caller
// granted the row, and `endCaretakerGrant` refuses `revoke` on the same rule. A
// caller who names pet A and a grant they made on pet B ends up doing exactly
// what naming pet B would have done.
//
// IDEMPOTENCY: NO HEADER, AND THAT IS A REFUSAL TO PROMISE
// ---------------------------------------------------------------------------
// None of the five use-cases takes a `clientIdempotencyKey` — checked, not
// assumed. What they have instead is NOT the same thing:
//
//   · `designate` is refused by two partial unique indexes (at most one pending
//     and at most one accepted grant per pet), surfaced as
//     `caretaker_grant_exists`. A refusal is a safe outcome and it is not a
//     replay: the caller cannot tell it apart from a genuine collision with an
//     invitation they forgot they sent.
//   · `accept` and `revoke` re-read the row under `SELECT … FOR UPDATE` and
//     abort unless it is still `pending` / `accepted`.
//   · `reject` and `cancel` guard on `expectedStatus: "pending"` in a
//     conditional UPDATE; a replay matches zero rows.
//
// So a replay is REFUSED, never absorbed. The consequence a client must handle
// is stated rather than hidden: a `caretaker_already_resolved` refusal after a
// timeout is AMBIGUOUS — the first attempt may have landed, or the other party
// may have moved. The screen's job is to re-read, never to guess. Same call
// `transfer.ts` makes, and `events/writers.ts` for atestación PPP.

import { z } from "zod";

import { isRealArDay } from "./ar-calendar-day.ts";

/**
 * Maximum length of a caretaker arrangement, in days — `MAX_GRANT_DURATION_DAYS`,
 * mirrored from `src/modules/caretakers/domain/types.ts` where `validateDesignation`
 * ENFORCES it.
 *
 * Carried so a client can bound its own end-date picker at the same number the
 * server refuses past, and say "el período máximo de cuidado es de 180 días" in
 * its own copy without inventing it. The web form does exactly this
 * (`DesignateCaretakerForm.tsx:130`, `caretakerEndDateBounds`); a picker that
 * offered a date the action then refuses is worse than no picker bound at all.
 *
 * IT IS NOT THE RULE. The rule is the domain function, re-run on every request.
 * This is deliberately the CONSTANT and not a mirrored copy of
 * `caretakerEndDateBounds`: a second implementation of the arithmetic in a
 * package that cannot import the first is how the two stop agreeing, and the
 * boundary (`start + 179 days`, because the start day counts as day 1) is
 * exactly the kind of off-by-one that survives a casual re-read.
 */
export const CARETAKER_MAX_DURATION_DAYS = 180;

/**
 * How long an unanswered invitation stays open — `GRANT_INVITATION_EXPIRY_DAYS`,
 * mirrored from the same domain file.
 *
 * Carried for the copy ("la invitación vence en 7 días", the notification's own
 * words) and for nothing else. A client must NOT compute an expiry from it: the
 * sweep that closes an unanswered invitation is a nightly cron, so a row past
 * seven days is still `pending` and still acceptable until the cron reaches it.
 * The server decides; `capabilities` on the read is what a screen obeys.
 */
export const CARETAKER_INVITATION_EXPIRY_DAYS = 7;

/**
 * The titular's note to the person they are inviting.
 *
 * THE WEB HAS NO BOUND AT ALL, and this one is therefore NEW rather than
 * mirrored — worth saying plainly, because every other bound in this package is
 * a copy of a number the web already shows. `DesignateCaretakerForm.tsx` renders
 * a two-row `LnTextarea` with no `maxLength`, and `pet_caretaker_grants.note` is
 * `text`. A textarea is a poor place to paste a megabyte from; an API is an
 * excellent one. 500 is what every other free-text note on this surface takes
 * (`TRANSFER_NOTE_MAX`), so the surface stays uniform, and the direction is
 * safe: this can only ever REFUSE a write, never widen one.
 */
export const CARETAKER_NOTE_MAX = 500;

/**
 * The upper bound on a grant token, which is a BOUND AND NOT A FORMAT.
 *
 * `CG-` plus 32 hex characters today (`caretakers-repository.ts`,
 * `newGrantToken`). Enumerating that shape here would be a second copy of a
 * generator this package cannot import, wrong the day the token changes. What
 * the contract owes is that a lookup key cannot be a megabyte; which strings
 * actually resolve is the server's question, answered with `not_found` / 404.
 */
const GRANT_TOKEN_MAX = 64;

export const CARETAKER_COMMAND_INPUT_CODES = [
  "COMMAND_REQUIRED",
  "EMAIL_INVALID",
  "PET_TOKEN_REQUIRED",
  "GRANT_TOKEN_REQUIRED",
  "DATE_INVALID",
  "NOTE_TOO_LONG",
] as const;
export type CaretakerCommandInputCode = (typeof CARETAKER_COMMAND_INPUT_CODES)[number];

/** An optional free-text field: absent, blank and `null` all mean "not stated". */
const optionalNote = z
  .string()
  .trim()
  .max(CARETAKER_NOTE_MAX, { error: "NOTE_TOO_LONG" })
  .nullish()
  .transform((v) => (v ? v : null));

/** The handle for the four commands that name an existing grant. */
const grantToken = z
  .string({ error: "GRANT_TOKEN_REQUIRED" })
  .trim()
  .min(1, { error: "GRANT_TOKEN_REQUIRED" })
  .max(GRANT_TOKEN_MAX, { error: "GRANT_TOKEN_REQUIRED" });

const petPublicToken = z
  .string({ error: "PET_TOKEN_REQUIRED" })
  .trim()
  .min(1, { error: "PET_TOKEN_REQUIRED" });

/**
 * AN ARGENTINE CALENDAR DAY, `YYYY-MM-DD`, AND DELIBERATELY NOT AN INSTANT.
 *
 * The web sends two `<input type="date">` values and the action turns them into
 * boundary instants with `parseArDateStartOfDay` / `parseArDateEndOfDay`
 * (`lib/utils/date-input-ar.ts`) — 00:00:00.000-03:00 and 23:59:59.999-03:00.
 * That asymmetry is the product: "hasta el 15/09" promises the whole 15th, and
 * a period that ended at midnight UTC would cut access at 21:00 on the 14th.
 *
 * A contract that took ISO INSTANTS would move that decision onto the phone,
 * where a device in another timezone — or one whose clock is simply wrong — would
 * compute a different boundary than the browser does for the same picked day.
 * The client picks a DAY; the server owns what that day means.
 *
 * THE REGEX IS NOT THE WHOLE CHECK, and leaving it at that would have been a real
 * defect rather than a tidy one. `2026-02-31` matches it perfectly and
 * `parseArDateEndOfDay` — the boundary parser this feature's writers use —
 * ROLLS IT OVER to the 3rd of March (measured 2026-08-26). A caretaker period the
 * titular meant to close on the 28th would have closed three days later: three
 * days of somebody else's access to an animal that nobody asked for.
 *
 * `isRealArDay` is what refuses it, and it is IMPORTED rather than restated: the
 * identical rule was already in this package for `record-event.ts`'s asiento
 * dates, found there by a test in WU-K. Two copies of one calendar is how two
 * doors onto one spine stop agreeing. It also means a client learns locally, with
 * a field code, instead of paying a round trip to be told `invalid_request`.
 */
const arCalendarDay = z
  .string({ error: "DATE_INVALID" })
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: "DATE_INVALID" })
  .refine(isRealArDay, { error: "DATE_INVALID" });

/**
 * INVITE SOMEBODY TO LOOK AFTER THIS ANIMAL FOR A WHILE.
 *
 * `inviteeEmail` IS THE ONLY WAY TO NAME A CARETAKER, and it is deliberately not
 * a user id — the same call `transfer.ts` makes and for a stronger reason here:
 * `profiles` has no email column, so the invitation row itself stores the
 * address, and `caretaker_user_id` stays NULL until the person accepts. The
 * commonest real case ("le dejo a Firu a mi vecina mientras viajo") is somebody
 * who has no MiMAR account yet.
 *
 * IT IS ALSO WHY THE ACCEPT SIDE MATCHES ON EMAIL.
 *
 * The address is NOT validated for existence here and must not be: answering
 * "that account does not exist" would turn this endpoint into an oracle over the
 * user table. The shape check is the same one the transfer schema applies, so a
 * client gets a local code instead of a round trip.
 *
 * NOTHING ABOUT THE INVITEE BEYOND AN ADDRESS. No DNI, hashed or otherwise: the
 * caretaker feature is addressed by e-mail end to end (`findUserIdByEmail`), and
 * `lib/utils/dni-hash.ts` has no part in it. Adding one would invent an
 * identifier the web has never asked for and put a second PII field on the wire.
 */
const designateCaretaker = z.object({
  command: z.literal("designate"),
  petPublicToken,
  inviteeEmail: z
    .string({ error: "EMAIL_INVALID" })
    .trim()
    .toLowerCase()
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, { error: "EMAIL_INVALID" }),
  /** First Argentine day of the period. The web's form defaults it to today. */
  startsAt: arCalendarDay,
  /** Last Argentine day of the period — inclusive. */
  endsAt: arCalendarDay,
  note: optionalNote,
});

/**
 * TAKE THE RESPONSIBILITY. Writes an ownership row and a spine event.
 *
 * `publicContactConsent` IS KEY 2 OF THE TWO-KEY PUBLIC-CONTACT MODEL, and this
 * is the ONLY moment it can be given. The repository writes it in the same
 * UPDATE as the status flip (a CHECK constraint forbids a consent timestamp on a
 * `pending` row), so there is no later request that could collect it.
 *
 * ABSENT MEANS NOT CONSENTED. It is optional on the wire and defaults to `false`
 * on the server, because an unticked checkbox sends no field and silence is
 * never consent (PO decision 2, 2026-08-19). A client MUST render it unticked
 * and MUST NOT infer it from anything else: what it publishes is a third party's
 * name and phone on an unauthenticated credential page, and only if the titular
 * ALSO turns on `discloseCaretakerContactWhenLost` (key 1, titular-only, and
 * `POST /api/v1/pets/{token}/lost`'s business — nothing here touches it).
 */
const acceptCaretakerGrant = z.object({
  command: z.literal("accept"),
  grantToken,
  publicContactConsent: z.boolean().optional(),
});

/** DECLINE IT. Takes nothing but the token — there is no "why" on this flow. */
const rejectCaretakerGrant = z.object({ command: z.literal("reject"), grantToken });

/**
 * WITHDRAW AN INVITATION NOBODY ANSWERED YET.
 *
 * Distinct from `revoke` and the state machine refuses to blur them: cancelling
 * touches a `pending` row, which has no ownership row and no spine event to
 * undo. Sending this for an ACTIVE arrangement is refused, with the client's
 * next move being to re-read and send `revoke`.
 */
const cancelCaretakerGrant = z.object({
  command: z.literal("cancel"),
  petPublicToken,
  grantToken,
});

/**
 * END A LIVE ARRANGEMENT, NOW. "Finalizar ahora" on the web.
 *
 * The titular's unilateral right: the caretaker loses access this instant and
 * `caretaker_ended{outcome:'revoked_by_owner'}` is appended. A CLIENT MUST SAY
 * WHAT THIS DOES NOT DO — it does not bring the animal home. The web's
 * confirmation says so in as many words (`CaretakerGrantControls.tsx`), and an
 * app that rendered "Finalizar" as "recuperar mi mascota" would be misleading
 * somebody about their own animal at the worst possible moment.
 */
const revokeCaretakerGrant = z.object({
  command: z.literal("revoke"),
  petPublicToken,
  grantToken,
});

export const caretakerCommandInputSchema = z.discriminatedUnion("command", [
  designateCaretaker,
  acceptCaretakerGrant,
  rejectCaretakerGrant,
  cancelCaretakerGrant,
  revokeCaretakerGrant,
]);

export type CaretakerCommandInput = z.infer<typeof caretakerCommandInputSchema>;
export type CaretakerCommand = CaretakerCommandInput["command"];

/**
 * The FIRST input code in a failed parse, for a client that wants to show one
 * message. Mirrors `firstTransferCommandInputCode` — same shape, same reason.
 */
export function firstCaretakerCommandInputCode(
  error: z.ZodError<unknown>,
): CaretakerCommandInputCode | null {
  for (const issue of error.issues) {
    const code = issue.message;
    if ((CARETAKER_COMMAND_INPUT_CODES as readonly string[]).includes(code)) {
      return code as CaretakerCommandInputCode;
    }
  }
  for (const issue of error.issues) {
    if (issue.code === "invalid_union" || issue.path.length === 0 || issue.path[0] === "command") {
      return "COMMAND_REQUIRED";
    }
  }
  return null;
}
