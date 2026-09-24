// Read model: where the titular's adoption sponsorship stands, as ONE of
// three states (rehome-by-titular WU5, task 5.8).
//
//   none    → nothing asked, nothing running: the page offers the org picker
//   pending → a rehome_request is open: who was asked, and the cancel lever
//   active  → an unmatched rehome_sponsorship_started is on the spine: who
//             accompanies, the listing expediente, and the withdraw lever
//
// DERIVED FROM THE SPINE, not from the ownership shape. The owner +
// shelter_custody pair also describes a decomiso or an org intake; an
// unmatched `rehome_sponsorship_started` describes exactly one thing. The
// request case is the consent record; it closes in the transaction that
// opens the sponsorship, so pending and active never coexist — if they ever
// did (drift), active wins: a running arrangement is what the titular must
// see first, and lint:spine names the drift separately.
//
// The org's display name degrades to "la organización" when the row cannot
// be read (an org deleted under an open case); the STATE never degrades.

import type { RehomeStatePort } from "./ports";

export type RehomeState =
  | { kind: "none" }
  | { kind: "pending"; orgId: string; orgDisplayName: string; casePublicCode: string }
  | {
      kind: "active";
      orgId: string;
      orgDisplayName: string;
      orgPublicToken: string | null;
      /** The open `adoption_listing` case (the sponsorship's expediente), if any. */
      listingCasePublicCode: string | null;
    };

const ORG_FALLBACK_NAME = "la organización";

export async function getRehomeStateForPet(
  petId: string,
  deps: { repo: RehomeStatePort },
): Promise<RehomeState> {
  const { repo } = deps;

  const open = await repo.findOpenSponsorshipForPet(petId);
  if (open) {
    const [org, listing] = await Promise.all([
      repo.findOrgById(open.sponsoringOrganizationId),
      repo.findOpenListingCase(petId, open.sponsoringOrganizationId),
    ]);
    return {
      kind: "active",
      orgId: open.sponsoringOrganizationId,
      orgDisplayName: org?.displayName ?? ORG_FALLBACK_NAME,
      orgPublicToken: org?.publicToken ?? null,
      listingCasePublicCode: listing?.publicCode ?? null,
    };
  }

  const request = await repo.findOpenRequestForPet(petId);
  if (request?.receiverOrganizationId) {
    const org = await repo.findOrgById(request.receiverOrganizationId);
    return {
      kind: "pending",
      orgId: request.receiverOrganizationId,
      orgDisplayName: org?.displayName ?? ORG_FALLBACK_NAME,
      casePublicCode: request.publicCode,
    };
  }

  return { kind: "none" };
}
