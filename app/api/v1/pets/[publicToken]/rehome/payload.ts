// The `GET /api/v1/pets/{publicToken}/rehome` body — the titular's surface for
// the acompañamiento de adopción, and the capabilities the write shares.
//
// THE CAPABILITIES ARE DERIVED HERE, ONCE, and both the read and `./commands.ts`
// use them, so a screen can never be offered a lever this door refuses. Two
// facts feed them and neither is recomputed from the other:
//
//   · WHO IS READING. Every rehome act is the LEGAL OWNER's alone —
//     `requireTitularAccess` PLUS `holderRole === "owner"`, the asymmetry
//     `src/modules/rehome/actions.ts` names as its "AUTH-SCOPE CONTRACT" (spec
//     REQ-1, REQ-14). That is NARROWER than `isTitularHolder`, which admits a
//     co-owner, a foster and the org path; here every one of them holds the
//     animal and holds none of these decisions. Written in the positive form
//     (`kind === "owner" && holderRole === "owner"`), like `profile/payload.ts`
//     writes the emergency-contacts rule, because this rule genuinely IS one
//     role.
//   · WHAT IS RUNNING. `RehomeState` from `getRehomeStateForPet` — the spine's
//     answer, not the face's banner — and, for the ask, the domain's own
//     `validateRequestOpen`, so "may I ask" is the SAME predicate the use-case
//     refuses on (lost, deceased, REQ-16) and not a copy of it.

import { apiV1Envelope } from "@/lib/infra/api-v1";
import type { PetHolderAccess } from "@/lib/infra/pet-access";
import type { RehomeState } from "@/src/modules/rehome/application/get-rehome-state-for-pet";
import type { CoveringOrg } from "@/src/modules/rehome/application/list-covering-orgs";
import { validateRequestOpen } from "@/src/modules/rehome/domain/rehome-rules";
import {
  PET_REHOME_PAYLOAD_VERSION,
  PET_REHOME_STALE_AFTER_MS,
  type PetRehomeCapabilitiesV1,
  type PetRehomeStateV1,
  type PetRehomeV1,
} from "@dim/contract/api";

/** The `pets` columns this payload reads. Structural — the row satisfies it. */
export type RehomePetRow = {
  id: string;
  publicToken: string;
  name: string;
  status: string;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
};

/** The access record, minus the `none` arm the caller has already turned into a 404. */
export type ResolvedRehomeAccess = Exclude<PetHolderAccess, { kind: "none" }>;

/** The one rule every rehome act is gated on: the live `role='owner'` row. */
export function isLegalOwner(access: ResolvedRehomeAccess): boolean {
  return access.kind === "owner" && access.holderRole === "owner";
}

export function petRehomeCapabilities(
  access: ResolvedRehomeAccess,
  state: RehomeState,
  petStatus: string,
): PetRehomeCapabilitiesV1 {
  const owner = isLegalOwner(access);
  const mayAsk = validateRequestOpen({
    petStatus,
    hasOpenRequest: state.kind === "pending",
    hasOpenSponsorship: state.kind === "active",
  }).ok;
  return {
    canRequest: owner && mayAsk,
    canWithdrawRequest: owner && state.kind === "pending",
    canWithdrawSponsorship: owner && state.kind === "active",
  };
}

/** The reader's state, narrowed to what the wire carries — no ids. */
export function toWireState(state: RehomeState): PetRehomeStateV1 {
  if (state.kind === "none") return { kind: "none" };
  if (state.kind === "pending") {
    return {
      kind: "pending",
      orgDisplayName: state.orgDisplayName,
      requestCasePublicCode: state.casePublicCode,
    };
  }
  return {
    kind: "active",
    orgDisplayName: state.orgDisplayName,
    listingCasePublicCode: state.listingCasePublicCode,
  };
}

export type BuildPetRehomeInput = {
  pet: RehomePetRow;
  access: ResolvedRehomeAccess;
  state: RehomeState;
  orgs: CoveringOrg[];
  now: Date;
};

export function buildPetRehomeV1({
  pet,
  access,
  state,
  orgs,
  now,
}: BuildPetRehomeInput): PetRehomeV1 {
  return {
    ...apiV1Envelope({
      payloadVersion: PET_REHOME_PAYLOAD_VERSION,
      issuedAt: now,
      staleAfterMs: PET_REHOME_STALE_AFTER_MS,
    }),
    publicToken: pet.publicToken,
    petName: pet.name,
    zone: { province: pet.jurisdictionProvince, locality: pet.jurisdictionLocality },
    state: toWireState(state),
    // NO INTERNAL IDs: the picker names an org by its public token.
    orgs: orgs.map((o) => ({
      publicToken: o.publicToken,
      displayName: o.displayName,
      orgType: o.orgType,
      locality: o.locality,
    })),
    capabilities: petRehomeCapabilities(access, state, pet.status),
  };
}
