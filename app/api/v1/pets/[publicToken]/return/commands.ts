// The three commands behind `POST /api/v1/pets/{publicToken}/return`.
//
// Split out of `route.ts` the way editar, lost mode and compartir split theirs:
// that file asks "is this request well formed", this one asks "may this command
// run, and what exactly does it do".
//
// WHO MAY RUN EACH ONE — THE WRITERS' OWN RULES, RE-CHECKED HERE FIRST
// ---------------------------------------------------------------------------
// Every one of these three use-cases already re-resolves the pet by token and
// re-checks the caller's ownership row itself — they are called with a user id
// from `app/actions/return-to-owner.ts`, which is a five-line controller behind
// `requireUserOrRedirect`. So the authorization is theirs and this door does not
// re-derive it: `runPetReturnCommand` resolves the state through
// `readPetReturnState` and refuses what the writer would refuse ANYWAY, one
// round trip earlier and with a code a client can switch on.
//
// THE DUPLICATION IS DELIBERATE BELT-AND-BRACES, the same shape `profile/
// commands.ts` records for its contacts rule: checked here the refusal carries a
// 403 with a code, checked there it is true regardless of which door called.
// Without the first check a co-owner's refusal would arrive as the writer's
// es-AR prose folded into a 500.
//
// THE PERSON PATH ONLY, and that is copied rather than invented. The web's
// `/mis-mascotas/{token}/devolucion` resolves access with
// `eq(ownerships.ownerUserId, user.id)` and `notFound()`s anything else — an
// ORGANISATION member holding this animal through a membership does not reach
// that page and does not reach this door. The org side of a return lives behind
// `custody.transfer` at `/org/{token}`, and this app has no org surfaces at all.
//
// ART. 16 (Ley 25.326) IS INSIDE THE RESOLVER AND THIS FILE ADDS NO SECOND READ
// OF `pets`. `resolvePetHolderAccess` filters `isNull(pets.deletedAt)` on both
// of its paths, so an erased animal answers `{ kind: "none" }` here and this
// door 404s it. The writers each re-resolve through `unerasedPetByToken`, so the
// predicate holds twice over on the write path — which is why this door spells
// neither alias itself and opens no lookup for one to be forgotten in.
//
// NO `Idempotency-Key`, AND THAT IS A CONTRACT RATHER THAN AN OMISSION. None of
// the three writers takes a `clientIdempotencyKey`. What they have is stronger
// and different: each opens `pg_advisory_xact_lock(hashtext(petId))` and
// re-reads `hasPendingProposal` UNDER the lock, so a replay is REFUSED rather
// than absorbed — `return_no_proposal` for the two answers, `return_already_
// pending` for the proposal. After a timeout a refusal may mean this caller's
// own first attempt landed OR that the other side moved first, and the client's
// move is the same either way: re-read. Requiring a header the writers ignore
// would be a client believing it holds a guarantee nobody made.

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { reportError } from "@/lib/infra/report-error";
import {
  type PetReturnState,
  readPetReturnState,
} from "@/src/modules/return-to-owner/application/read-return-state";
import {
  ownerAcceptReturnWriter,
  ownerProposeReturnToOrgWriter,
  ownerRejectReturnWriter,
} from "@/src/modules/return-to-owner/application/writers";
import type { PetReturnCommandAckV1 } from "@dim/contract/api";
import type { PetReturnCommandInput } from "@dim/contract/input";

import { petReturnCapabilities } from "./payload";

/**
 * The pre-write read: the state resolution, which is four indexed queries.
 *
 * The WRITES are deliberately outside any budget, for the reason lost mode
 * records: `withDbBudgetOrThrow` races a promise against a timer and rejects,
 * which does not abort a Postgres transaction. Wrapping the write would produce
 * a 503 for a transaction that then COMMITS — and here that transaction can be
 * the one that hands an animal back, so the client would report a failure while
 * the registry has moved custody.
 */
const RESOLVE_BUDGET_MS = 8_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** The 503 this endpoint answers for every degraded pre-write read. */
export function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

export type ReturnCommandContext = {
  publicToken: string;
  userId: string;
  pet: { id: string; publicToken: string };
  holderRole: string | null;
  input: PetReturnCommandInput;
};

/** Everything from the capability gate to the command. */
export async function runPetReturnCommand(ctx: ReturnCommandContext) {
  let state: PetReturnState;
  try {
    state = await withDbBudgetOrThrow(
      readPetReturnState({
        pet: { id: ctx.pet.id },
        userId: ctx.userId,
        holderRole: ctx.holderRole,
      }),
      RESOLVE_BUDGET_MS,
      "api-v1-return-state",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  const capabilities = petReturnCapabilities(state);

  if (ctx.input.command === "accept_return") {
    if (!capabilities.canAccept) return refusalFor(state, "answer");
    return acceptReturn(ctx);
  }

  if (ctx.input.command === "reject_return") {
    if (!capabilities.canReject) return refusalFor(state, "answer");
    return rejectReturn(ctx, ctx.input.reason);
  }

  if (!capabilities.canPropose) return refusalFor(state, "propose");
  return proposeReturn(ctx, ctx.input);
}

/**
 * WHY A REFUSED COMMAND DOES NOT ALWAYS ANSWER 403.
 *
 * The capability being false has SIX possible causes and they are not the same
 * kind of "no". Two are about the caller (`not_titular`, `not_the_adopter`) and
 * belong on a 403; three are about the animal's situation right now
 * (`awaiting_org`, `can_propose` when an answer was asked for, `inbound_pending`
 * when a proposal was) and are 409s a client fixes by re-reading; one
 * (`no_source_org`) is structural and says so.
 *
 * Collapsing them all onto 403 would tell somebody they lack a permission when
 * what actually happened is that the proposal they were answering had already
 * been cancelled — and they would go looking for the permission.
 */
function refusalFor(state: PetReturnState, wanted: "answer" | "propose") {
  switch (state.kind) {
    case "not_titular":
      return apiV1Error("return_forbidden", 403);
    case "not_the_adopter":
      return apiV1Error("return_forbidden", 403);
    case "no_source_org":
      return apiV1Error("return_no_source_org", 409);
    case "awaiting_org":
      // An answer was asked for and the pending proposal is this caller's own
      // outgoing one — the case the web's page shows an "Aceptar" button for.
      // A propose was asked for and one is already in flight.
      return wanted === "answer"
        ? apiV1Error("return_no_proposal", 409)
        : apiV1Error("return_already_pending", 409);
    case "can_propose":
      // An answer was asked for and there is nothing to answer.
      return apiV1Error("return_no_proposal", 409);
    case "inbound_pending":
      // A propose was asked for while somebody is trying to hand the animal
      // back. Both propose writers refuse exactly this.
      return apiV1Error("return_already_pending", 409);
    default: {
      const unhandled: never = state;
      throw new Error(`Unhandled return refusal: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * ACEPTAR — the one write on this surface that takes an animal back.
 *
 * `autoCancelled` IS A SUCCESS AND IT IS NOT "listo, la tenés". The use-case has
 * a documented arm in which the proposal's preconditions no longer hold — the
 * proposer lost custody, or the animal is no longer `lost` — and it then appends
 * `custody_transfer_cancelled`, notifies the proposer, and answers
 * `{ ok: true, autoCancelled: true, reason }`. The reason is one of four es-AR
 * sentences `autoCancelBody` composes, already user-facing on the web, and it
 * crosses the wire for that reason: it is the only thing that says WHICH
 * precondition failed, and a client that rendered a plain success here would
 * tell somebody their animal came back when it did not.
 */
async function acceptReturn(ctx: ReturnCommandContext) {
  const result = await ownerAcceptReturnWriter({
    userId: ctx.userId,
    petPublicToken: ctx.publicToken,
  });

  if ("error" in result) {
    // The use-case's message is es-AR prose written for a form. It is NOT
    // echoed: this surface answers with a code from the contract's vocabulary
    // and nothing else, so a client cannot come to depend on a sentence.
    reportError("api-v1-return/accept_return", result.error);
    return apiV1Error("return_failed", 500);
  }

  const autoCancelled = "autoCancelled" in result && result.autoCancelled === true;
  return ack({
    command: "accept_return",
    autoCancelled,
    reason: autoCancelled ? result.reason : null,
  });
}

/** RECHAZAR — nothing about the animal changes; the proposer is told why. */
async function rejectReturn(ctx: ReturnCommandContext, reason: string) {
  const result = await ownerRejectReturnWriter({
    userId: ctx.userId,
    petPublicToken: ctx.publicToken,
    reason,
  });

  if ("error" in result) {
    reportError("api-v1-return/reject_return", result.error);
    return apiV1Error("return_failed", 500);
  }
  return ack({ command: "reject_return", autoCancelled: false, reason: null });
}

/**
 * PROPONER — ask the organisation of origin to take the animal back.
 *
 * `proposedAt` IS THE SERVER'S CLOCK AND NOT A REQUEST FIELD. The web's form
 * offers a date input defaulting to today; there is no reader that treats
 * `proposed_at` as anything but "when this was proposed", so a phone offering to
 * back-date one would be offering a way to describe a conversation as having
 * happened when it did not. `@dim/contract/input`'s `pet-return.ts` records the
 * omission.
 *
 * THE ORGANISATION IS NOT A REQUEST FIELD EITHER, and that one is load-bearing:
 * `resolveReturnTargetOrg` derives it from the animal's own spine. A
 * client-supplied org id would be a `where` behind nothing but a session, which
 * is the shape `submit-claim-dispute.ts` records as having made a writer "a
 * national denial-of-rescue button".
 */
async function proposeReturn(
  ctx: ReturnCommandContext,
  input: Extract<PetReturnCommandInput, { command: "propose_return" }>,
) {
  const result = await ownerProposeReturnToOrgWriter({
    userId: ctx.userId,
    petPublicToken: ctx.publicToken,
    reason: input.reason,
    notes: input.notes,
    proposedAt: new Date().toISOString(),
    // The role the ACCESS GUARD resolved, not one derived here. The web's action
    // re-queries for it with an unordered `.limit(1)`, which is a coin flip for
    // somebody who holds one animal in two roles; `resolvePetHolderAccess` ranks
    // explicitly (owner before co_owner before foster before caretaker) and this
    // door carries that answer through.
    callerRole: ctx.holderRole === "foster" ? "foster" : "owner",
  });

  if ("error" in result) {
    reportError("api-v1-return/propose_return", result.error);
    return apiV1Error("return_failed", 500);
  }
  return ack({ command: "propose_return", autoCancelled: false, reason: null });
}

function ack(body: PetReturnCommandAckV1) {
  return apiV1Json(body, { status: 200 });
}
