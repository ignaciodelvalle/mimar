// What a client may send to `POST /api/v1/me/transfers` — the four owner→owner
// transfer commands.
//
// WHY ALL FOUR LIVE UNDER `/me` AND NOT UNDER `/pets/{token}`
// ---------------------------------------------------------------------------
// Three of them are addressed by a TRANSFER token, not by a pet, and the fourth
// is the one that creates a transfer in the first place. That asymmetry is not
// cosmetic — it is the whole security shape of this feature:
//
//   · `accept` and `reject` are sent by somebody who does NOT hold the animal.
//     That is the entire point of a transfer, and it means the authorization
//     cannot be a custody check. It is an id-or-email match against the transfer
//     ROW (`validateRecipientMatch`, owner-transfer-rules.ts:124-134). A URL
//     shaped `/pets/{publicToken}/…` would invite a reader — and an implementer
//     — to reach for `resolvePetHolderAccess`, which is precisely the widening
//     bug this surface must not have: it would refuse the one caller the command
//     is for and admit every co-owner it is not.
//   · `cancel` is sent by the SENDER, who still holds the animal but whose
//     authorization is nonetheless `fromOwnerId === caller`
//     (`cancel-pet-transfer.ts:46-53`) — a co-owner of the same pet may not
//     withdraw somebody else's proposal.
//   · `initiate` is the only pet-addressed one, and its rule is narrower than
//     any pet guard in `lib/infra/pet-access.ts`: the caller must hold the ACTIVE
//     `role='owner'` ownership row (`initiate-pet-transfer.ts:101-105`). A
//     co-owner passes `requireTitularAccess` and is refused here.
//
// So there is no pet segment that would be true for all four, and inventing one
// for `initiate` alone would split a four-command feature across two URLs to buy
// a path segment that three of them cannot honour. The pet travels in the body,
// where the writer's own check reads it.
//
// This mirrors the web, which puts all four behind ONE hub (`/transferencias`)
// plus a sheet on the pet page for `initiate` — and the hub is where a person
// goes when the question is "what is in flight", which is the question this
// endpoint answers.
//
// IDEMPOTENCY: NO HEADER, AND THAT IS A REFUSAL TO PROMISE
// ---------------------------------------------------------------------------
// None of the four use-cases takes a `clientIdempotencyKey` — a fact, checked,
// not an assumption. What they have instead is NOT the same thing, and a client
// must not be told it is:
//
//   · `initiate` is protected by a partial unique index
//     (`pet_transfers_one_pending_per_pet`), so a replayed initiate does not
//     create a second proposal — it is REFUSED, with "Ya hay una transferencia
//     pendiente para esta mascota." A refusal is a safe outcome and it is not a
//     replay: the caller cannot tell it apart from a genuine collision with a
//     transfer they forgot they sent.
//   · `accept`, `reject` and `cancel` guard on `expectedStatus: "pending"` in a
//     conditional UPDATE. A replay after success matches zero rows and answers
//     `La transferencia ya está accepted.` — again a refusal, not a replay.
//
// Requiring a header the server would ignore is a client believing it holds a
// guarantee it does not; that is the same call `events/writers.ts` makes for
// atestación PPP, and `shares/commands.ts` for all four of its commands. The
// consequence a client must actually handle is stated here rather than hidden:
// a `transfer_already_resolved` refusal after a timeout is AMBIGUOUS — it may
// mean the first attempt landed, or that the other party moved. The screen's job
// is to re-read, never to guess.

import { z } from "zod";

/**
 * Why the animal is changing hands, as the `pet_transfers.reason` column's own
 * four values (`PET_TRANSFER_REASONS`, db/schema.ts).
 *
 * REQUIRED HERE, THOUGH THE COLUMN IS NULLABLE. The web's sender form renders a
 * `<select>` that is `required` and defaults to `"gift"`
 * (`TransferSenderForm.tsx:14-19,29,84`), so no owner-initiated transfer has ever
 * been written without one; the column's nullability is what lets OTHER channels
 * (the org handshake) leave it empty. A contract that made it optional would let
 * a native client create a row the web cannot, and the reason is what the
 * receiving person reads first.
 */
export const OWNER_TRANSFER_REASONS = ["sale", "gift", "inheritance", "other"] as const;
export type OwnerTransferReason = (typeof OWNER_TRANSFER_REASONS)[number];

/**
 * How long a proposal stays answerable — `TRANSFER_EXPIRY_DAYS`, mirrored from
 * `src/modules/transfers/domain/types.ts` where it is enforced.
 *
 * Carried so a client can say "tenés 7 días" in its own copy without inventing
 * the number, and so a countdown reads the same sentence the invitation e-mail
 * does. It is NOT the rule: `expiresAt` comes back on every row, computed by the
 * server's clock, and that timestamp is what a screen must render. A client that
 * recomputed `initiatedAt + 7d` would disagree with the server the day this
 * constant moves.
 */
export const TRANSFER_EXPIRY_DAYS = 7;

/**
 * The sender's free-text note, and the recipient's optional rejection reason.
 *
 * BOTH ARE 500 ON THE WEB and both are enforced there only by the `maxLength`
 * attribute on the control (`TransferSenderForm.tsx:107`,
 * `AcceptTransferActions.tsx:82`) — which is to say: not enforced at all for
 * anything that is not that form. The column is `text`. An API is a far easier
 * place to post a 40 kB note from than a textarea is, so the bound moves here
 * where it binds every door, at the number the web already shows.
 */
export const TRANSFER_NOTE_MAX = 500;

/**
 * The upper bound on a transfer token, which is a BOUND AND NOT A FORMAT.
 *
 * `generatePrefixedToken("PTR")` produces `PTR-XXXX-XXXX` today, and enumerating
 * that shape here would be a second copy of a generator this package cannot
 * import — one that goes silently wrong the day the token gains a segment. What
 * the contract owes is that a lookup key cannot be a megabyte; which strings
 * actually resolve is the server's question, answered with `not_found` / 404 —
 * the shared code, not a transfer-specific one. There is no `transfer_not_found`
 * in `ApiV1ErrorCode` and this docblock used to name one; a client written
 * against that sentence would have switched on a string the server never sends.
 */
const TRANSFER_TOKEN_MAX = 64;

export const TRANSFER_COMMAND_INPUT_CODES = [
  "COMMAND_REQUIRED",
  "EMAIL_INVALID",
  "NOTE_TOO_LONG",
  "PET_TOKEN_REQUIRED",
  "REASON_INVALID",
  "TRANSFER_TOKEN_REQUIRED",
] as const;
export type TransferCommandInputCode = (typeof TRANSFER_COMMAND_INPUT_CODES)[number];

/** An optional free-text field: absent, blank and `null` all mean "not stated". */
const optionalNote = z
  .string()
  .trim()
  .max(TRANSFER_NOTE_MAX, { error: "NOTE_TOO_LONG" })
  .nullish()
  .transform((v) => (v ? v : null));

/** The handle for the three commands that name an existing proposal. */
const transferToken = z
  .string({ error: "TRANSFER_TOKEN_REQUIRED" })
  .trim()
  .min(1, { error: "TRANSFER_TOKEN_REQUIRED" })
  .max(TRANSFER_TOKEN_MAX, { error: "TRANSFER_TOKEN_REQUIRED" });

/**
 * OFFER THE ANIMAL TO SOMEBODY ELSE.
 *
 * `toEmail` IS THE ONLY WAY TO NAME A RECIPIENT, and it is deliberately not a
 * user id. The web resolves the address to an account when one exists and leaves
 * `to_owner_id` NULL when it does not, sending a Supabase invitation instead
 * (`src/modules/transfers/actions.ts:165-181`) — so a transfer can be addressed
 * to somebody who has no
 * MiMAR account yet, and that is a feature rather than a gap. A contract that
 * took a user id would make the commonest real case ("mi hermana se queda con
 * Firu") impossible to express.
 *
 * IT IS ALSO WHY THE ACCEPT SIDE MATCHES ON EMAIL. See `validateRecipientMatch`.
 *
 * The address is NOT validated for existence here and must not be: answering
 * "that account does not exist" would turn this endpoint into an oracle over the
 * user table. The shape check below is the same regex the domain uses
 * (`isValidTransferEmail`, owner-transfer-rules.ts:16-18) restated as a zod rule
 * so the client gets a local code instead of a round trip.
 */
const initiateTransfer = z.object({
  command: z.literal("initiate"),
  petPublicToken: z
    .string({ error: "PET_TOKEN_REQUIRED" })
    .trim()
    .min(1, { error: "PET_TOKEN_REQUIRED" }),
  toEmail: z
    .string({ error: "EMAIL_INVALID" })
    .trim()
    .toLowerCase()
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, { error: "EMAIL_INVALID" }),
  reason: z.enum(OWNER_TRANSFER_REASONS, { error: "REASON_INVALID" }),
  note: optionalNote,
});

/**
 * TAKE THE ANIMAL. The irreversible one.
 *
 * Takes nothing but the token: everything else — who the sender was, which
 * animal, whether the proposal is still open — is read from the row under a
 * `SELECT … FOR UPDATE`, because every one of those facts can change during the
 * seven days the offer stands. A command that carried them would let a stale
 * screen assert a world that no longer exists.
 */
const acceptTransfer = z.object({ command: z.literal("accept"), transferToken });

/** REFUSE IT, optionally saying why. The reason reaches the sender's notification. */
const rejectTransfer = z.object({
  command: z.literal("reject"),
  transferToken,
  reason: optionalNote,
});

/** WITHDRAW A PROPOSAL YOU SENT. Sender-only; see the header. */
const cancelTransfer = z.object({ command: z.literal("cancel"), transferToken });

export const transferCommandInputSchema = z.discriminatedUnion("command", [
  initiateTransfer,
  acceptTransfer,
  rejectTransfer,
  cancelTransfer,
]);

export type TransferCommandInput = z.infer<typeof transferCommandInputSchema>;
export type TransferCommand = TransferCommandInput["command"];

/**
 * The FIRST input code in a failed parse, for a client that wants to show one
 * message. Mirrors `firstShareCommandInputCode` — same shape, same reason.
 */
export function firstTransferCommandInputCode(
  error: z.ZodError<unknown>,
): TransferCommandInputCode | null {
  for (const issue of error.issues) {
    const code = issue.message;
    if ((TRANSFER_COMMAND_INPUT_CODES as readonly string[]).includes(code)) {
      return code as TransferCommandInputCode;
    }
  }
  for (const issue of error.issues) {
    if (issue.code === "invalid_union" || issue.path.length === 0 || issue.path[0] === "command") {
      return "COMMAND_REQUIRED";
    }
  }
  return null;
}
