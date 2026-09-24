// What a client may send to `POST /api/v1/me/foster` — the two tránsito
// commands a VOLUNTEER can act on from their own inbox: aceptar, rechazar.
//
// TWO, NOT FOURTEEN. `src/modules/foster` has fourteen use-cases and the
// great majority are the ORG's: proposing, assigning, expiring, allowing a
// co-foster, searching the pool. What a citizen reaches from the web is
// `acceptFosterProposalAction` and `rejectFosterProposalAction`
// (`src/modules/foster/actions.ts`) — the only two exported controllers with
// no `requireCapabilityForOrgToken` guard, because the caller who accepts or
// declines a proposal holds no `ownerships` row on the animal yet. Offering
// anything else here (enrolling as a volunteer, ending an active foster)
// would be inventing an entry point the browser does not have, not parity.
//
// WHY THIS LIVES UNDER `/me` AND NOT UNDER A PROPOSAL-SCOPED PATH
// ---------------------------------------------------------------------------
// Same shape as `caretaker.ts`'s `accept`/`reject` pair: the caller is the
// ADDRESSEE of the proposal, not its holder. `acceptFosterProposal` and
// `rejectFosterProposal` authorize with `proposal.volunteerUserId === user.id`,
// an id match against the proposal ROW, never a pet guard — a pet-scoped URL
// would invite `resolvePetHolderAccess`, which refuses the one caller this
// command exists for (the volunteer holds nothing on the animal until they
// accept).
//
// IDEMPOTENCY: NO HEADER, AND THAT IS A REFUSAL TO PROMISE
// ---------------------------------------------------------------------------
// Neither use-case takes a `clientIdempotencyKey`. Both re-read the proposal
// and refuse unless `status === "pending"`, so a replay is REFUSED rather
// than absorbed — the same call `caretaker.ts` makes for `accept`/`reject`.
// A `foster_already_resolved` refusal after a timeout is AMBIGUOUS: the first
// attempt may have landed, or the org may have cancelled the proposal in the
// meantime. The client's move is to re-read the hub, never to guess.

import { z } from "zod";

/**
 * The six reasons `ProposalActions.tsx` offers a volunteer declining a
 * proposal — mirrored from `REJECTION_REASONS`
 * (`src/modules/foster/domain/types.ts`), which `validateRejectionReason`
 * enforces server-side. NOT THE RULE: the domain re-validates on every
 * request. Carried so a client renders the same six radio options the web
 * form does, in the same order, without inventing a seventh.
 */
export const FOSTER_REJECTION_REASONS = [
  "capacity",
  "health_mismatch",
  "timing",
  "distance",
  "household",
  "other",
] as const;
export type FosterRejectionReason = (typeof FOSTER_REJECTION_REASONS)[number];

/**
 * Free-text notes a volunteer may add to either answer. 500 characters, the
 * same bound `CARETAKER_NOTE_MAX` uses for the analogous field — the web's
 * own `<textarea>` on `ProposalActions.tsx` carries no `maxLength`, so this
 * bound is new rather than mirrored, and the direction is safe: it can only
 * refuse a write, never widen one.
 */
export const FOSTER_RESPONSE_NOTES_MAX = 500;

export const FOSTER_COMMAND_INPUT_CODES = [
  "COMMAND_REQUIRED",
  "PROPOSAL_TOKEN_REQUIRED",
  "REJECTION_REASON_INVALID",
  "NOTE_TOO_LONG",
] as const;
export type FosterCommandInputCode = (typeof FOSTER_COMMAND_INPUT_CODES)[number];

/**
 * The upper bound on a proposal token, a BOUND AND NOT A FORMAT — see
 * `caretaker.ts`'s `GRANT_TOKEN_MAX` for the same call. What this contract
 * owes is that a lookup key cannot be a megabyte; which strings actually
 * resolve is the server's question, answered with `foster_forbidden` /
 * `not_found`.
 */
const PROPOSAL_TOKEN_MAX = 64;

const proposalToken = z
  .string({ error: "PROPOSAL_TOKEN_REQUIRED" })
  .trim()
  .min(1, { error: "PROPOSAL_TOKEN_REQUIRED" })
  .max(PROPOSAL_TOKEN_MAX, { error: "PROPOSAL_TOKEN_REQUIRED" });

/** An optional free-text field: absent, blank and `null` all mean "not stated". */
const optionalResponseNotes = z
  .string()
  .trim()
  .max(FOSTER_RESPONSE_NOTES_MAX, { error: "NOTE_TOO_LONG" })
  .nullish()
  .transform((v) => (v ? v : null));

/**
 * ACCEPT THE PROPOSAL. Writes a foster ownership row and the spine events.
 *
 * `allowCoFoster` MIRRORS THE WEB'S CHECKBOX (`ProposalActions.tsx`) exactly:
 * it defaults to `false` when absent, because D17 is opt-in and silence must
 * not be read as consent to share the animal with another volunteer.
 */
const acceptFosterProposal = z.object({
  command: z.literal("accept"),
  proposalToken,
  allowCoFoster: z.boolean().default(false),
  responseNotes: optionalResponseNotes,
});

/**
 * DECLINE THE PROPOSAL. `rejectionReason` is required — the web's form has no
 * "sin motivo" option, and `validateRejectionReason` refuses anything outside
 * the six values.
 */
const rejectFosterProposal = z.object({
  command: z.literal("reject"),
  proposalToken,
  rejectionReason: z.enum(FOSTER_REJECTION_REASONS, { error: "REJECTION_REASON_INVALID" }),
  responseNotes: optionalResponseNotes,
});

export const fosterCommandInputSchema = z.discriminatedUnion("command", [
  acceptFosterProposal,
  rejectFosterProposal,
]);

export type FosterCommandInput = z.infer<typeof fosterCommandInputSchema>;
export type FosterCommand = FosterCommandInput["command"];

/**
 * The FIRST input code in a failed parse, for a client that wants to show one
 * message. Mirrors `firstCaretakerCommandInputCode` — same shape, same
 * reason.
 */
export function firstFosterCommandInputCode(
  error: z.ZodError<unknown>,
): FosterCommandInputCode | null {
  for (const issue of error.issues) {
    const code = issue.message;
    if ((FOSTER_COMMAND_INPUT_CODES as readonly string[]).includes(code)) {
      return code as FosterCommandInputCode;
    }
  }
  for (const issue of error.issues) {
    if (issue.code === "invalid_union" || issue.path.length === 0 || issue.path[0] === "command") {
      return "COMMAND_REQUIRED";
    }
  }
  return null;
}
