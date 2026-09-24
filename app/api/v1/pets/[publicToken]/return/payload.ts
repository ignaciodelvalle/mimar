// The devolución payload, and the ONE derivation the read and the write share.
//
// `petReturnCapabilities` is why this file exists rather than the shapes living
// in `payload.ts` as a formatter. Both the GET and the POST call it, so a screen
// can never be offered a control this endpoint refuses — the arrangement
// `pets/{token}/profile` uses for its own two booleans, and the reason its
// header gives: "the two booleans are derived in `./payload.ts` and used by BOTH
// the read and this file, so a screen can never be offered a control this file
// refuses."
//
// THE CAPABILITIES ARE A FUNCTION OF THE STATE AND OF NOTHING ELSE, which is
// what makes one derivation possible at all. `readPetReturnState` has already
// done the work a client cannot: it compared the pending proposal's `to_user_id`
// against the caller, resolved the target organisation out of an
// `adoption_finalized` payload or an open custody row, and decided which of the
// two person-path roles the caller holds.
//
// WHAT IT DELIBERATELY DOES NOT DO is re-check anything. A capability derived
// twice from two different reads is two rules; this one reads the state the
// route already resolved, and the WRITE re-resolves the state rather than
// trusting a flag off the wire.

import type {
  PetReturnCapabilitiesV1,
  PetReturnStateV1,
  PetReturnV1,
  ReturnCallerRoleV1,
} from "@dim/contract/api";
import { PET_RETURN_PAYLOAD_VERSION, PET_RETURN_STALE_AFTER_MS } from "@dim/contract/api";

import type { PetReturnState } from "@/src/modules/return-to-owner/application/read-return-state";

/**
 * WHICH COMMANDS THIS CALLER MAY SEND.
 *
 * ACCEPT AND REJECT TRAVEL TOGETHER and are true only for `inbound_pending`,
 * which is the arm that already established the proposal is ADDRESSED to the
 * caller. `awaiting_org` — the caller's own outgoing proposal — gets neither,
 * which is the whole correction this door makes over the web's page.
 *
 * They are not split because no writer splits them: `ownerAcceptReturnUseCase`
 * and `ownerRejectReturnUseCase` run the identical ownership check and the
 * identical `to_user_id` comparison. A pair of booleans that can never disagree
 * is still two booleans on the wire on purpose — a client renders two controls,
 * and the day a rule does split them the payload does not have to change shape.
 */
export function petReturnCapabilities(state: PetReturnState): PetReturnCapabilitiesV1 {
  const inbound = state.kind === "inbound_pending";
  return {
    canAccept: inbound,
    canReject: inbound,
    canPropose: state.kind === "can_propose",
  };
}

/** The read's state, on the wire. A straight mapping — no rule lives here. */
export function toWireState(state: PetReturnState): PetReturnStateV1 {
  switch (state.kind) {
    case "inbound_pending":
      return {
        kind: "inbound_pending",
        actorName: state.actorName,
        proposedAt: state.proposedAt,
        notes: state.notes,
      };
    case "awaiting_org":
      return { kind: "awaiting_org" };
    case "can_propose":
      return {
        kind: "can_propose",
        callerRole: state.callerRole as ReturnCallerRoleV1,
        orgDisplayName: state.orgDisplayName,
      };
    case "not_titular":
      return { kind: "not_titular", holderRole: state.holderRole };
    case "no_source_org":
      return { kind: "no_source_org", callerRole: state.callerRole as ReturnCallerRoleV1 };
    case "not_the_adopter":
      return { kind: "not_the_adopter" };
    default: {
      const unhandled: never = state;
      throw new Error(`Unhandled return state: ${JSON.stringify(unhandled)}`);
    }
  }
}

export function buildPetReturnV1(args: {
  publicToken: string;
  petName: string;
  state: PetReturnState;
  now: Date;
}): PetReturnV1 {
  return {
    payloadVersion: PET_RETURN_PAYLOAD_VERSION,
    issuedAt: args.now.toISOString(),
    staleAfter: new Date(args.now.getTime() + PET_RETURN_STALE_AFTER_MS).toISOString(),
    publicToken: args.publicToken,
    petName: args.petName,
    state: toWireState(args.state),
    capabilities: petReturnCapabilities(args.state),
  };
}
