// The four owner→owner transfer commands, and the one thing that makes this file
// different from every other command dispatcher on this surface.
//
// THE CALLER MAY NOT HOLD THE ANIMAL, AND THAT IS NOT AN EDGE CASE
// ---------------------------------------------------------------------------
// `/pets/{token}/lost` and `/pets/{token}/shares` both open by resolving pet
// access and refusing `kind === "none"` before anything else happens. Doing that
// here would be a bug, not a precaution: `accept` and `reject` are sent by the
// person the animal is being GIVEN to, who by definition holds no `ownerships`
// row for it. `resolvePetHolderAccess` would answer `none` and this endpoint
// would 404 the one caller each command exists for — while admitting every
// co-owner it does not.
//
// So there is NO pet-access guard in this file, anywhere, and its absence is the
// design. Each command is authorized by the rule its own writer applies, and the
// three rules are different:
//
//   · `initiate` — the ACTIVE `role='owner'` ownership row must be the caller's
//     (`initiate-pet-transfer.ts:101-105`). Narrower than `requireTitularAccess`,
//     which a co-owner passes.
//   · `accept` / `reject` — an id-or-email match against the transfer ROW
//     (`validateRecipientMatch`, owner-transfer-rules.ts:124-134). `callerEmail`
//     comes from the verified session and NEVER from the request body, because
//     an addressee who has no account yet is matched by e-mail alone: a body
//     that could name the address would be a way to claim any open invitation.
//   · `cancel` — `fromOwnerId === caller` (`cancel-pet-transfer.ts:46-53`).
//
// Every one of them runs inside the use-case, under the row lock where a lock
// applies. This file adds none of them and re-implements none of them; what it
// does is TRANSLATE their refusals into codes, which is the second thing worth
// reading here.
//
// TRANSLATING PROSE INTO CODES, WITHOUT COPYING THE PROSE WHERE IT CAN BE READ
// ---------------------------------------------------------------------------
// `UseCaseResult`'s failure arm is an untyped `string` carrying es-AR prose
// written for a web form (api-invariants.md §3). `pet_registration_failed`'s
// docblock in the contract already records what that costs an API door. Putting
// the prose on the wire is not an option — it names internal constraints, and it
// is not the vocabulary a native client switches on.
//
// The mapping below therefore does two different things, and the split is the
// point:
//
//   · Where the sentence lives in an EXPORTED DOMAIN FUNCTION, the table asks
//     that function for it at module load (`validatePetStatusForTransfer` for the
//     three pet-situation refusals, `SPONSORED_PET_TRANSFER_ERROR` for the
//     fourth, `validateSelfTransfer` and `validateOwnerTransferReason` for
//     theirs). Reword the domain and the table moves with it, with no edit here.
//     That is parity by construction rather than by copy.
//   · Where the sentence lives inside a use-case BODY, there is nothing to
//     import, so the table matches a stable prefix and `__tests__/api-v1-me-
//     transfers-route.test.ts` pins every literal the four use-cases can return.
//     The failure mode is stated rather than hidden: a reworded sentence falls
//     through to `transfer_failed`, which is a 500 for something that is not a
//     server failure. It never widens access — an unmapped refusal is still a
//     refusal — and the test is what makes it loud.

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { acceptPetTransfer } from "@/src/modules/transfers/application/accept-pet-transfer";
import { cancelPetTransfer } from "@/src/modules/transfers/application/cancel-pet-transfer";
import { initiatePetTransfer } from "@/src/modules/transfers/application/initiate-pet-transfer";
import { listTransfersForUser } from "@/src/modules/transfers/application/list-transfers-for-user";
import { rejectPetTransfer } from "@/src/modules/transfers/application/reject-pet-transfer";
import {
  SPONSORED_PET_TRANSFER_ERROR,
  UNCONFIRMED_EMAIL_TRANSFER_ERROR,
  validateOwnerTransferReason,
  validatePetStatusForTransfer,
  validateSelfTransfer,
} from "@/src/modules/transfers/domain/owner-transfer-rules";
import { TransfersRepository } from "@/src/modules/transfers/infrastructure/transfers-repository";
import type { ApiV1ErrorCode, TransferCommandAckV1 } from "@dim/contract/api";
import type { TransferCommandInput } from "@dim/contract/input";

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/**
 * The LIST read, budgeted — and it is the ONLY thing on this surface that is.
 *
 * `readTransfers`, at the bottom of this file, is the single consumer: the GET's
 * one read, bounded so a degraded pooler answers 503 instead of hanging. The
 * whole POST path runs outside any budget, and that is TWO different decisions
 * wearing one word, so both are written down rather than left to be inferred
 * from a constant's name:
 *
 *   · The WRITES are deliberately unbudgeted, for the reason the events endpoint
 *     records and `shares/commands.ts` repeats: `withDbBudgetOrThrow` races a
 *     promise against a timer and rejects, which does not abort a Postgres
 *     transaction. Wrapping a write would produce a 503 for a mutation that then
 *     COMMITS — and on THIS surface that mutation is a change of ownership, so
 *     the client and the registry would disagree about who owns an animal,
 *     forever.
 *   · The reads each use-case does BEFORE its write — `findTransferByToken`,
 *     `findActiveOwnerOwnership`, the pet lookup — are unbudgeted too, and that
 *     one is a GAP rather than a decision. They happen inside the use-case call,
 *     which is shared with the web, so there is no seam in this file to bound
 *     them at; bounding them would mean changing a writer the browser also uses.
 *     Recorded here because an earlier version of this docblock claimed they
 *     were covered, and a promise a reader believes is worse than an absence
 *     they can see.
 */
const READ_BUDGET_MS = 8_000;

/** The 503 this endpoint answers for every degraded read. */
export function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

export type TransferCommandContext = {
  userId: string;
  /** From the VERIFIED session. Never from the body — see the header. */
  callerEmail: string;
  /**
   * GoTrue's `email_confirmed_at` for the same session (A09-1). Verified says
   * the TOKEN is genuine; this says somebody proved the ADDRESS.
   */
  callerEmailConfirmed: boolean;
  input: TransferCommandInput;
};

function ack(body: TransferCommandAckV1) {
  return apiV1Json(body, { status: 200 });
}

/**
 * The refusal table, in the order it is tested.
 *
 * ORDER MATTERS in exactly one place and it is called out where it happens:
 * `"La transferencia expiró."` and `"La transferencia ya está …"` are different
 * codes, and the second must not swallow the first.
 */
type Rule = { code: ApiV1ErrorCode; status: number; matches: (error: string) => boolean };

/** An exact sentence, taken from the domain function that owns it. */
function exact(sentence: string): (error: string) => boolean {
  return (error) => error === sentence;
}

/** A sentence this file cannot import, matched on its stable opening. */
function startsWith(prefix: string): (error: string) => boolean {
  return (error) => error.startsWith(prefix);
}

/**
 * Asks a domain validator for the sentence it returns, so the table cannot
 * drift from the rule it is translating.
 */
function domainRefusal(
  result: { ok: true; value: unknown } | { ok: false; error: string },
): string {
  if (result.ok) {
    // A validator that stopped refusing the input we hand it here means the rule
    // moved. Failing loudly at module load beats a table entry that silently
    // matches nothing and degrades every one of its refusals to a 500.
    throw new Error(
      "transfers/commands: a domain validator no longer refuses its own negative case; the refusal table is stale.",
    );
  }
  return result.error;
}

const DECEASED = domainRefusal(
  validatePetStatusForTransfer({ status: "deceased", inCustodyDispute: false }),
);
const LOST = domainRefusal(
  validatePetStatusForTransfer({ status: "lost", inCustodyDispute: false }),
);
const DISPUTED = domainRefusal(
  validatePetStatusForTransfer({ status: "active", inCustodyDispute: true }),
);
const SELF = domainRefusal(validateSelfTransfer("same-user", "same-user"));
const BAD_REASON = domainRefusal(validateOwnerTransferReason("not-a-reason"));

const RULES: readonly Rule[] = [
  // ---- the ANIMAL refuses (409) -------------------------------------------
  { code: "transfer_not_allowed", status: 409, matches: exact(DECEASED) },
  { code: "transfer_not_allowed", status: 409, matches: exact(LOST) },
  { code: "transfer_not_allowed", status: 409, matches: exact(DISPUTED) },
  { code: "transfer_not_allowed", status: 409, matches: exact(SPONSORED_PET_TRANSFER_ERROR) },

  // ---- the two parties are one account (400) ------------------------------
  { code: "transfer_self", status: 400, matches: exact(SELF) },
  {
    code: "transfer_self",
    status: 400,
    matches: exact("No podés aceptar tu propia transferencia."),
  },

  // ---- the CALLER is not this command's party (403) -----------------------
  //
  // THE MOST IMPORTANT THREE LINES IN THIS FILE. Each is a different rule (the
  // active-owner row, the addressee match, the sender check) collapsed into one
  // code because the client's move is identical and because naming which rule
  // refused would describe somebody else's proposal to a stranger.
  { code: "transfer_forbidden", status: 403, matches: startsWith("Solo el dueño actual") },
  { code: "transfer_forbidden", status: 403, matches: startsWith("Solo el emisor") },
  {
    code: "transfer_forbidden",
    status: 403,
    matches: exact("Esta propuesta no es para tu cuenta."),
  },
  {
    code: "transfer_forbidden",
    status: 403,
    matches: exact("Esta propuesta no es accesible desde tu cuenta."),
  },
  // The addressee arm matched the ADDRESS and refused the ACCOUNT (A09-1).
  // Same code as its three siblings on purpose: the sentence carries the remedy,
  // and a code of its own would let a client branch on "this address has an open
  // invitation", which is the oracle the 403 exists to avoid.
  {
    code: "transfer_forbidden",
    status: 403,
    matches: exact(UNCONFIRMED_EMAIL_TRANSFER_ERROR),
  },

  // ---- the seven days ran out (409) ---------------------------------------
  //
  // BEFORE the `ya está` rule below, and the order is load-bearing: both
  // sentences begin "La transferencia", and an expired proposal must not be
  // reported as one somebody answered.
  { code: "transfer_expired", status: 409, matches: startsWith("La transferencia expiró") },

  // ---- somebody already answered, or the world moved (409) ----------------
  {
    code: "transfer_already_resolved",
    status: 409,
    matches: startsWith("La transferencia ya está"),
  },
  {
    code: "transfer_already_resolved",
    status: 409,
    matches: exact("La transferencia ya no está pendiente."),
  },
  {
    code: "transfer_already_resolved",
    status: 409,
    matches: startsWith("La transferencia ya no es válida"),
  },
  { code: "transfer_pending_exists", status: 409, matches: startsWith("Ya hay una transferencia") },

  // ---- nothing to act on (404) --------------------------------------------
  //
  // A transfer that does not exist and one addressed to somebody else answer
  // DIFFERENTLY here, and that is deliberate rather than an oracle: the token is
  // a 12-character random string nobody guesses, and the web says the same two
  // things in the same two cases. What must never differ is the PET side, and
  // it does not — a pet the caller may not touch is `transfer_forbidden`, from
  // the active-owner rule, never a 404 that would confirm the token is real.
  { code: "not_found", status: 404, matches: exact("Transferencia no encontrada.") },
  { code: "not_found", status: 404, matches: exact("No encontramos la mascota.") },
  { code: "not_found", status: 404, matches: startsWith("La mascota ya no existe") },

  // ---- the body was wrong after all (400) ---------------------------------
  //
  // Reachable only from a client out of step with the contract: the schema
  // refuses both of these before the round trip.
  { code: "invalid_request", status: 400, matches: exact(BAD_REASON) },
  { code: "invalid_request", status: 400, matches: exact("Email inválido.") },
];

/**
 * One use-case refusal, as a response.
 *
 * The fall-through is `transfer_failed` / 500, which is the honest answer for a
 * sentence this file does not recognise: it means the mapping is out of step
 * with a use-case, which IS a server defect. It is also the safe direction —
 * an unmapped refusal is still a refusal, and nothing is granted by it.
 */
export function transferRefusal(error: string) {
  for (const rule of RULES) {
    if (rule.matches(error)) return apiV1Error(rule.code, rule.status);
  }
  return apiV1Error("transfer_failed", 500);
}

/** Exported for the route test, which pins every literal the use-cases return. */
export const TRANSFER_REFUSAL_RULES = RULES;

/**
 * Notifications and the audit row, post-tx, best-effort.
 *
 * BOTH RUN AFTER THE WRITE COMMITTED and neither may fail the request. A
 * notification is a CONSEQUENCE of a fact, not part of it, and an audit row that
 * failed to insert must not make a caller believe an ownership change did not
 * happen — they would retry, and the retry would be refused as already resolved
 * while the animal had in fact changed hands.
 *
 * The audit `action` names are the web's own, so a row written from a phone is
 * indistinguishable from one written from the browser — which is the entire
 * point of writing it here at all.
 */
async function flushSideEffects(args: {
  notifications: Parameters<typeof TransfersRepository.insertNotifications>[0];
  audit: { actorUserId: string; action: string; payload: Record<string, unknown> };
}): Promise<void> {
  try {
    await TransfersRepository.insertNotifications(args.notifications);
  } catch (e) {
    console.error("[api-v1-transfers] notifications insert failed (the command did succeed):", e);
  }
  await TransfersRepository.insertAuditLog(args.audit);
}

export async function runTransferCommand(ctx: TransferCommandContext) {
  try {
    switch (ctx.input.command) {
      case "initiate":
        return await initiate(ctx, ctx.input);
      case "accept":
        return await accept(ctx, ctx.input);
      case "reject":
        return await reject(ctx, ctx.input);
      case "cancel":
        return await cancel(ctx, ctx.input);
    }
  } catch (err) {
    // DEFENSIVE, AND UNREACHABLE TODAY — said out loud so nobody reads it as
    // evidence that this path is bounded. Nothing under the switch above is
    // wrapped in a budget (see `READ_BUDGET_MS`), and the one budgeted call the
    // POST makes — `requireLiveUser` — is caught in `route.ts:180-183`, before
    // control ever reaches here. It stays because the day a pre-read in this
    // file IS bounded, 503 is the right answer and a rethrow would turn a
    // timeout into a 500.
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
}

const deps = () => ({
  repo: TransfersRepository,
  transaction: TransfersRepository.transaction,
});

async function initiate(
  ctx: TransferCommandContext,
  input: Extract<TransferCommandInput, { command: "initiate" }>,
) {
  const result = await initiatePetTransfer(
    {
      petToken: input.petPublicToken,
      toEmail: input.toEmail,
      reason: input.reason,
      note: input.note,
      callerEmail: ctx.callerEmail,
    },
    { ...deps(), actor: { user: { id: ctx.userId } } },
  );
  if (!result.ok) return transferRefusal(result.error);

  await flushSideEffects({
    notifications: result.notifications as Parameters<
      typeof TransfersRepository.insertNotifications
    >[0],
    audit: {
      actorUserId: ctx.userId,
      action: "pet_transfer_initiated",
      payload: {
        transfer_public_token: result.value.transferToken,
        pet_id: result.value.petId,
        to_email: input.toEmail,
        to_user_known: !result.value.recipientNeedsInvite,
      },
    },
  });

  // THE INVITATION E-MAIL IS NOT SENT FROM HERE, and that is a documented gap
  // rather than an oversight. `initiatePetTransferAction` calls
  // `admin.auth.admin.inviteUserByEmail` with a `redirectTo` pointing at the WEB
  // page (`src/modules/transfers/actions.ts:165-181`) — a link into a browser
  // session, which is the
  // only thing that flow can currently produce. Firing it from a native write
  // would send somebody a web magic link on a phone that has this app installed,
  // landing them where they did not ask to be. `recipientNeedsInvite` is on the
  // wire instead, so the client can say plainly that the address has no account
  // and the person has to be told another way. Closing it properly needs the
  // verified App Link that app.config.ts is blocked on.
  return ack({
    command: "initiate",
    changed: true,
    transferToken: result.value.transferToken,
    petPublicToken: null,
    recipientNeedsInvite: result.value.recipientNeedsInvite,
  });
}

async function accept(
  ctx: TransferCommandContext,
  input: Extract<TransferCommandInput, { command: "accept" }>,
) {
  const result = await acceptPetTransfer(
    {
      transferToken: input.transferToken,
      callerEmail: ctx.callerEmail,
      callerEmailConfirmed: ctx.callerEmailConfirmed,
    },
    { ...deps(), actor: { user: { id: ctx.userId } } },
  );
  if (!result.ok) return transferRefusal(result.error);

  await flushSideEffects({
    notifications: result.notifications as Parameters<
      typeof TransfersRepository.insertNotifications
    >[0],
    audit: {
      actorUserId: ctx.userId,
      action: "pet_transfer_accepted",
      payload: {
        transfer_public_token: input.transferToken,
        pet_id: result.value.petId,
        from_user_id: result.value.fromOwnerId,
      },
    },
  });

  // The animal is the caller's now. `petPublicToken` is what lets the client go
  // straight to its credential, which is where the web navigates too. It can be
  // null when the use-case could not read it back inside the transaction; a
  // client that treats null as "go to the list" matches the web's fallback.
  return ack({
    command: "accept",
    changed: true,
    transferToken: input.transferToken,
    petPublicToken: result.value.petPublicToken,
    recipientNeedsInvite: null,
  });
}

async function reject(
  ctx: TransferCommandContext,
  input: Extract<TransferCommandInput, { command: "reject" }>,
) {
  const result = await rejectPetTransfer(
    {
      transferToken: input.transferToken,
      reason: input.reason,
      callerEmail: ctx.callerEmail,
      callerEmailConfirmed: ctx.callerEmailConfirmed,
    },
    { ...deps(), actor: { user: { id: ctx.userId } } },
  );
  if (!result.ok) return transferRefusal(result.error);

  await flushSideEffects({
    notifications: result.notifications as Parameters<
      typeof TransfersRepository.insertNotifications
    >[0],
    audit: {
      actorUserId: ctx.userId,
      action: "pet_transfer_rejected",
      payload: {
        transfer_public_token: input.transferToken,
        pet_id: result.value.petId,
        reason: input.reason,
      },
    },
  });

  return ack({
    command: "reject",
    changed: true,
    transferToken: input.transferToken,
    petPublicToken: null,
    recipientNeedsInvite: null,
  });
}

async function cancel(
  ctx: TransferCommandContext,
  input: Extract<TransferCommandInput, { command: "cancel" }>,
) {
  // NO `callerEmail` — and it is worth noticing rather than assuming a copy-paste
  // slip. Cancellation is the one command whose party is the SENDER, matched by
  // `fromOwnerId` alone; the e-mail is only ever used to recognise an addressee
  // who has no account yet, and a sender always has one.
  const result = await cancelPetTransfer(
    { transferToken: input.transferToken },
    { ...deps(), actor: { user: { id: ctx.userId } } },
  );
  if (!result.ok) return transferRefusal(result.error);

  await flushSideEffects({
    notifications: result.notifications as Parameters<
      typeof TransfersRepository.insertNotifications
    >[0],
    audit: {
      actorUserId: ctx.userId,
      action: "pet_transfer_cancelled",
      payload: {
        transfer_public_token: input.transferToken,
        pet_id: result.value.petId,
      },
    },
  });

  return ack({
    command: "cancel",
    changed: true,
    transferToken: input.transferToken,
    petPublicToken: null,
    recipientNeedsInvite: null,
  });
}

/**
 * The list read, budgeted. Exported so the route reads nothing itself.
 *
 * STATICALLY IMPORTED, deliberately. A per-call `await import()` of a module the
 * suite mocks silently drops one of two concurrent callers in vitest — a defect
 * this repo has already paid for once — and there is nothing here that a lazy
 * import would buy.
 */
export async function readTransfers(args: {
  userId: string;
  callerEmail: string;
  callerEmailConfirmed: boolean;
}) {
  return withDbBudgetOrThrow(
    listTransfersForUser(args, { repo: TransfersRepository }),
    READ_BUDGET_MS,
    "api-v1-me-transfers-list",
  );
}
