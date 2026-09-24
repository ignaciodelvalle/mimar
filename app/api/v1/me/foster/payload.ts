// `MyFosterV1`, built from what `listFosterHubForVolunteer` decided.
//
// THIS FILE DECIDES NOTHING. Whether a proposal is expired, whether a foster
// is active — all of it was settled by the use-case, against the writers'
// own rules. What is left here is serialisation: `Date` to ISO, a flat DTO to
// the contract's nesting. Same discipline `me/caretaker-grants/payload.ts`
// states.

import { apiV1Envelope } from "@/lib/infra/api-v1";
import type {
  FosterHubForVolunteer,
  FosterHubOwnership,
  FosterHubProposal,
} from "@/src/modules/foster/application/list-foster-hub-for-volunteer";
import {
  MY_FOSTER_PAYLOAD_VERSION,
  MY_FOSTER_STALE_AFTER_MS,
  type MyFosterOwnershipV1,
  type MyFosterProposalV1,
  type MyFosterV1,
} from "@dim/contract/api";

function toProposalV1(item: FosterHubProposal): MyFosterProposalV1 {
  return {
    proposalToken: item.proposalToken,
    pet: item.pet,
    organizationName: item.organizationName,
    proposedDurationWeeks: item.proposedDurationWeeks,
    proposedNotes: item.proposedNotes,
    proposedAt: item.proposedAt.toISOString(),
    expiresAt: item.expiresAt.toISOString(),
    expired: item.expired,
  };
}

function toOwnershipV1(item: FosterHubOwnership): MyFosterOwnershipV1 {
  return {
    fosterOwnershipId: item.fosterOwnershipId,
    pet: item.pet,
    organizationName: item.organizationName,
    startedAt: item.startedAt.toISOString(),
    endedAt: item.endedAt ? item.endedAt.toISOString() : null,
    active: item.active,
    proposedDurationWeeks: item.proposedDurationWeeks,
  };
}

export function buildMyFosterV1(input: { hub: FosterHubForVolunteer; now: Date }): MyFosterV1 {
  return {
    // THE SHARED ENVELOPE, not three fields spelled out here — §6 requires
    // `payloadVersion` / `issuedAt` / `staleAfter` on every read.
    ...apiV1Envelope({
      payloadVersion: MY_FOSTER_PAYLOAD_VERSION,
      issuedAt: input.now,
      staleAfterMs: MY_FOSTER_STALE_AFTER_MS,
    }),
    proposals: input.hub.proposals.map(toProposalV1),
    fosters: input.hub.fosters.map(toOwnershipV1),
  };
}
