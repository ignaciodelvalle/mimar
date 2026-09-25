// The four claim commands, and the translation of their refusals.
//
// THERE IS NO PET-ACCESS GUARD IN THIS FILE, AND ITS ABSENCE IS THE DESIGN
// ---------------------------------------------------------------------------
// Every other pet-scoped write on this surface opens with
// `resolvePetHolderAccess` and refuses `kind === "none"`. That guard answers
// "may this caller act on this animal", and here the answer is NO by
// construction — a claim is asked BY somebody who holds nothing ABOUT an animal
// that is not theirs. Requiring an access row would refuse every legitimate
// claim there is.
//
// What stands in its place is the PRIVATE IDENTIFIER, and it stands there in
// both use-cases rather than here: they resolve the animal FROM the 15-digit
// chip or the tattoo code against `pet_identifications` and consult no
// caller-supplied token anywhere. `submit-free-claim.ts` calls that "the
// evidence" and explains why the public token is not: `DIM-XXXX-XXXX` is printed
// on the physical tag, resolvable by anyone who scans the QR, and listed for
// every lost animal on `/perdidas` with no login. A token-addressed claim would
// be a claim anybody could aim at any animal in the country.
//
// So this file neither re-implements that rule nor loosens it. The wire shape it
// accepts has no pet token at all (`@dim/contract/input`'s `pet-claim.ts`), which
// makes a token/animal mismatch unrepresentable rather than merely rejected.
//
// NO PROSE TABLE, AND THAT IS THE DIFFERENCE FROM ITS SIBLINGS
// ---------------------------------------------------------------------------
// `me/appointments/commands.ts` carries a table mapping each es-AR SENTENCE its
// writer can return to a status code, and states its own failure mode: "a
// reworded sentence falls through to `appointment_failed`, which is a 500 for
// something that is not a server failure". This file has no such table because
// the claim writers now answer a `ClaimFailureCode` alongside the sentence — the
// same repair `AmendEventFailureCode` is. A copy edit in the use-case cannot
// change an HTTP status here, and the `switch` below is exhaustive, so a sixth
// code added there is a COMPILE error rather than a silent 500.
//
// THE ONE THING THE LOOKUP NEVER ANSWERS IS 404
// ---------------------------------------------------------------------------
// "No animal has that chip" is `variant: "not_found"` with status 200. The
// question was asked and answered; a 404 would make a client unable to tell an
// answered question from a route that does not exist, and it would put the
// art. 16 promise — an erased animal must be indistinguishable from one that
// never existed — into the status line, where a caller can tell it apart from a
// transport failure only by guessing.
//
// THAT REASONING IS SOUND AND THE PROMISE IT PROTECTS IS ONLY HALF KEPT, which
// the original of this paragraph did not say. Keeping 404 off the lookup buys
// art. 16 nothing while the CLAIM arm leaks the same fact: `submitFreeClaimFor
// User` resolves the pet without the `isNull(pets.deletedAt)` filter its lookup
// sibling has, so an erased animal's chip comes back `not_claimable` (409) where
// an unregistered one comes back `not_found` (404) — the distinction this
// paragraph refuses to put in the status line, put in the status line one
// command over. Worse, with no active custody on the erased pet the claim goes
// through. Measured 2026-08-30; PRE-EXISTING, the web's wizard has it too, and
// argued in full in `claim/types.ts` next to the code table that promises it.
// Do not read this header as evidence the invariant holds end to end.

import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import { DbBudgetExceededError } from "@/lib/infra/db-budget";
import {
  loadStagedWelfareEvidence,
  mintWelfareEvidenceTicket,
  removeStagedWelfareEvidence,
} from "@/lib/infra/welfare-evidence-staging";
import { lookupForClaimForUser } from "@/src/modules/pets/application/claim/lookup-for-claim";
import { submitClaimDisputeForUser } from "@/src/modules/pets/application/claim/submit-claim-dispute";
import { submitFreeClaimForUser } from "@/src/modules/pets/application/claim/submit-free-claim";
import type { ClaimFailureCode } from "@/src/modules/pets/application/claim/types";
import type { PetClaimCommandAckV1 } from "@dim/contract/api";
import type {
  ClaimEvidenceContentType,
  PetClaimCommandInput,
  PetClaimDisputeInput,
} from "@dim/contract/input";

import {
  buildPetClaimDisputeAck,
  buildPetClaimEvidenceTicketAck,
  buildPetClaimLookupAck,
} from "./payload";

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** The 503 this endpoint answers for a degraded read. */
export function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

export type PetClaimCommandContext = {
  userId: string;
  input: PetClaimCommandInput;
};

function ack(body: PetClaimCommandAckV1) {
  return apiV1Json(body, { status: 200 });
}

/**
 * One use-case refusal, as a response.
 *
 * EXHAUSTIVE OVER `ClaimFailureCode` WITH NO `default`, which is what makes the
 * absence of a prose table safe: a sixth code added to the use-cases fails to
 * compile here instead of falling through to a 500.
 *
 * `identifier_invalid` IS A 400 AND NOT A 422, and it is reachable even though
 * the route validates the same rule against the contract schema first. The two
 * checks are not redundant in the way that looks: the schema is what a CLIENT
 * can also run before the round trip, and the use-case's copy is the rule. If
 * they ever disagree, this arm is what the caller sees, and `invalid_request` is
 * the honest name for it — the body was refused by the server's own reading.
 */
export function petClaimRefusal(code: ClaimFailureCode) {
  switch (code) {
    case "rate_limited":
      // The SHARED `claim_lookup` budget, which the web spends too. Not the
      // route's per-IP bucket — that one is refused in the handler, before the
      // use-case is ever called.
      return apiV1Error("rate_limited", 429);
    case "identifier_invalid":
      return apiV1Error("invalid_request", 400);
    case "not_found":
      // Only reachable from `claim_free`: the LOOKUP answers this as a variant
      // with status 200. See the header.
      return apiV1Error("not_found", 404);
    case "not_claimable":
      return apiV1Error("claim_not_claimable", 409);
    case "failed":
      return apiV1Error("claim_failed", 500);
    // The two DISPUTE-ONLY codes. Neither lookup nor claim_free produces them;
    // they are mapped here because the switch is exhaustive over the whole
    // vocabulary, and a mapping is safer than a throw on a path somebody may
    // one day reach.
    case "reason_invalid":
      return apiV1Error("invalid_request", 400);
    case "evidence_refused":
      return apiV1Error("claim_evidence_refused", 422);
    default: {
      const unhandled: never = code;
      throw new Error(`Unhandled claim failure code: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * A DISPUTE refusal, as a response — its own table for one reason: the claim's
 * `not_claimable` and `failed` carry copy about claiming a FREE animal, and a
 * person refused a dispute must not read that (`claim_not_disputable` and
 * `claim_dispute_failed` in `@dim/contract/api`'s errors). Exhaustive with no
 * `default`, like `petClaimRefusal`.
 */
export function petClaimDisputeRefusal(code: ClaimFailureCode) {
  switch (code) {
    case "rate_limited":
      // The SHARED `claim_lookup` budget: a dispute spends it exactly as the
      // web's does, together with every lookup the same person ran.
      return apiV1Error("rate_limited", 429);
    case "identifier_invalid":
    case "reason_invalid":
      // Both are rules the contract's schema already checked; reaching this arm
      // means the two copies disagree, and the server's reading governs.
      return apiV1Error("invalid_request", 400);
    case "not_found":
      return apiV1Error("not_found", 404);
    case "not_claimable":
      return apiV1Error("claim_not_disputable", 409);
    case "evidence_refused":
      return apiV1Error("claim_evidence_refused", 422);
    case "failed":
      return apiV1Error("claim_dispute_failed", 500);
    default: {
      const unhandled: never = code;
      throw new Error(`Unhandled claim failure code: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * One upload URL for one evidence photo — the denuncia's ticket, minted by the
 * same function into the same private staging bucket.
 *
 * THE BUDGET IS NOT SPENT HERE. The per-user media ceiling is spent by the
 * route, in the handler body, where `api-v1-rate-limit-families.test.ts` can
 * read it; this function only mints.
 */
async function mintEvidenceTicket(contentType: ClaimEvidenceContentType) {
  const ticket = await mintWelfareEvidenceTicket(contentType);
  if (ticket === null) return unavailable();
  return ack(buildPetClaimEvidenceTicketAck(ticket));
}

/**
 * Raise the dispute — the WEB'S use-case, over the staged photos.
 *
 * THE ORDER, AND WHAT EACH STEP OWES THE NEXT:
 *
 *   1. CLAIM every staged key (a move, so each photo is used by one request and
 *      one only) and download it as a `File` — `loadStagedWelfareEvidence`, the
 *      denuncia's loader. A missing, already-used, empty or oversized object
 *      refuses the WHOLE dispute: the authority either sees every photo the
 *      person chose or nothing is filed, never a silent subset.
 *   2. Hand those files to `submitClaimDisputeForUser` — the exact function the
 *      web's `submitClaimDisputeAction` calls, with the exact `files` argument it
 *      takes. Every rule is the use-case's: the 20–2000 reason, the evidence
 *      requirement, the `claim_lookup` budget, the identifier as the only
 *      authorization, the holder refusals, and `uploadWelfareEvidence` — the
 *      web's evidence gate, EXIF/GPS strip included, failing closed — before the
 *      transaction, with its own rollback.
 *   3. DISCARD the claimed copies in EVERY outcome. On success the use-case has
 *      stored its own stripped copies under `claims/{id}` in `welfare-evidence`;
 *      on a refusal nothing references them. `finally`, so a throw from the
 *      use-case cannot strand them either.
 *
 * No device location reaches the record: the phone's adapter re-encodes and
 * drops EXIF before the PUT, and the server's strip is the guarantee.
 */
async function raiseDispute(userId: string, input: PetClaimDisputeInput) {
  const loaded = await loadStagedWelfareEvidence(input.evidence);
  if (!loaded.ok) {
    await removeStagedWelfareEvidence([...input.evidence, ...loaded.claimed]);
    return apiV1Error("claim_evidence_refused", 422);
  }

  let result: Awaited<ReturnType<typeof submitClaimDisputeForUser>>;
  try {
    result = await submitClaimDisputeForUser(
      userId,
      {
        identifierKind: input.identifierKind,
        identifierValue: input.identifierValue,
        reason: input.reason,
      },
      loaded.files,
    );
  } finally {
    await removeStagedWelfareEvidence(loaded.claimed);
  }

  if ("code" in result) return petClaimDisputeRefusal(result.code);
  return ack(buildPetClaimDisputeAck(result.disputeToken));
}

export async function runPetClaimCommand(ctx: PetClaimCommandContext) {
  try {
    switch (ctx.input.command) {
      case "lookup": {
        const result = await lookupForClaimForUser(ctx.userId, {
          kind: ctx.input.identifierKind,
          value: ctx.input.identifierValue,
        });
        if ("code" in result) return petClaimRefusal(result.code);
        return ack(buildPetClaimLookupAck(result));
      }
      case "claim_free": {
        const result = await submitFreeClaimForUser(ctx.userId, {
          identifierKind: ctx.input.identifierKind,
          identifierValue: ctx.input.identifierValue,
        });
        if ("code" in result) return petClaimRefusal(result.code);

        // `changed` is always true on this arm: the writer REFUSES a replay
        // rather than absorbing one — a second call finds the caller's own
        // ownership row as an active custody and comes back above as
        // `not_claimable`. The contract says so where a client reads it.
        return ack({
          command: "claim_free",
          changed: true,
          petToken: result.petToken,
          petName: result.petName,
        });
      }
      case "request_evidence_ticket":
        return mintEvidenceTicket(ctx.input.contentType);
      case "dispute":
        return raiseDispute(ctx.userId, ctx.input);
      default: {
        const unhandled: never = ctx.input;
        throw new Error(`Unhandled claim command: ${JSON.stringify(unhandled)}`);
      }
    }
  } catch (err) {
    // DEFENSIVE, AND UNREACHABLE TODAY — said out loud so nobody reads it as
    // evidence that these calls are bounded. Neither use-case runs inside a
    // budget: `submitFreeClaimForUser` opens a Postgres transaction, and
    // `withDbBudgetOrThrow` races a promise against a timer without aborting
    // one, so wrapping it would answer 503 for a claim that then COMMITS —
    // client sees failure, registry sees a new owner, and the two disagree
    // about who owns an animal forever. The one budgeted call this endpoint
    // makes is `requireLiveUser`, caught in the route before control reaches
    // here. This arm stays so that the day a bounded pre-read lands in this
    // file, a timeout answers 503 instead of becoming a 500.
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }
}
