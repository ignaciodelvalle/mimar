// `MyCaretakerGrantsV1`, built from what `listCaretakerGrantsForUser` decided.
//
// THIS FILE DECIDES NOTHING. Which side of an arrangement a row is on, whether
// its period has passed, which of the four answers this caller may give — all of
// it was settled by the use-case, against the writers' own rules. What is left
// here is serialisation: `Date` to ISO, a flat row to the contract's nesting.
//
// The discipline is the same one `me/transfers/payload.ts` states, and it is the
// difference between this endpoint and the two web doors it stands in for: if
// this file recomputed even one capability from `status`, the surface would hold
// a SECOND copy of a rule whose first copy already exists in three places (the
// SQL predicate, the read model, the writers).
//
// NO CONTACT DETAIL CROSSES THIS BOUNDARY beyond the invited address, and there
// is nothing to filter: the use-case never reads a phone number and never reads
// the consent timestamp that would gate one. A caretaker's contact reaches an
// unauthenticated page only through the public credential, behind BOTH keys of
// the two-key model, and this payload is not a third door onto it.

import { apiV1Envelope } from "@/lib/infra/api-v1";
import type {
  CaretakerGrantListItem,
  CaretakerGrantsForUser,
} from "@/src/modules/caretakers/application/list-caretaker-grants-for-user";
import {
  MY_CARETAKER_GRANTS_PAYLOAD_VERSION,
  MY_CARETAKER_GRANTS_STALE_AFTER_MS,
  type MyCaretakerGrantV1,
  type MyCaretakerGrantsV1,
} from "@dim/contract/api";

function toGrantV1(item: CaretakerGrantListItem): MyCaretakerGrantV1 {
  return {
    grantToken: item.grantToken,
    status: item.status,
    direction: item.direction,
    pet: {
      publicToken: item.petToken,
      name: item.petName,
      species: item.petSpecies,
    },
    counterpartyName: item.counterpartyName,
    caretakerEmail: item.caretakerEmail,
    startsAt: item.startsAt.toISOString(),
    endsAt: item.endsAt.toISOString(),
    note: item.note,
    expired: item.expired,
    scopeSentence: item.scopeSentence,
    capabilities: {
      canAccept: item.canAccept,
      canReject: item.canReject,
      canCancel: item.canCancel,
      canRevoke: item.canRevoke,
    },
  };
}

export function buildMyCaretakerGrantsV1(input: {
  grants: CaretakerGrantsForUser;
  now: Date;
}): MyCaretakerGrantsV1 {
  return {
    // THE SHARED ENVELOPE, not three fields spelled out here. §6 requires
    // `payloadVersion` / `issuedAt` / `staleAfter` on every read, and a payload
    // that composed its own would be another place the shape could drift.
    ...apiV1Envelope({
      payloadVersion: MY_CARETAKER_GRANTS_PAYLOAD_VERSION,
      issuedAt: input.now,
      staleAfterMs: MY_CARETAKER_GRANTS_STALE_AFTER_MS,
    }),
    incoming: input.grants.incoming.map(toGrantV1),
    outgoing: input.grants.outgoing.map(toGrantV1),
  };
}
