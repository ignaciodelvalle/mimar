// getRehomeStateForPet — the titular's view of the sponsorship, as ONE of
// three states (rehome-by-titular WU5, task 5.8). Layer: Unit (fake port).
//
// The state is derived from the SPINE (an unmatched rehome_sponsorship_started)
// and the open request case, never from the owner+shelter_custody shape,
// which also describes a decomiso or an intake. Pending and active never
// coexist (the accept closes the request in the transaction that opens the
// listing), so the loader reports at most one — and says so when both would
// somehow match: active wins, because a running arrangement is what the
// titular needs to see first.

import { describe, expect, it } from "vitest";

import { getRehomeStateForPet } from "../application/get-rehome-state-for-pet";
import type { RehomeStatePort } from "../application/ports";

function fakePort(
  overrides: Partial<{
    request: { id: string; publicCode: string; receiverOrganizationId: string | null } | null;
    sponsorship: { ownershipId: string; sponsoringOrganizationId: string } | null;
    listing: { id: string; publicCode: string } | null;
    orgs: Record<string, { displayName: string; publicToken: string }>;
  }> = {},
): RehomeStatePort {
  const orgs = overrides.orgs ?? {
    "org-a": { displayName: "Refugio Padrino", publicToken: "DIM-ORG-A" },
  };
  return {
    findOpenRequestForPet: async () =>
      overrides.request === undefined
        ? null
        : overrides.request && {
            id: overrides.request.id,
            publicCode: overrides.request.publicCode,
            caseKind: "rehome_request",
            status: "open",
            primaryPetId: "pet-1",
            receiverOrganizationId: overrides.request.receiverOrganizationId,
            openedByUserId: "titular",
          },
    findOpenSponsorshipForPet: async () => overrides.sponsorship ?? null,
    findOpenListingCase: async () => overrides.listing ?? null,
    findOrgById: async (id: string) => {
      const o = orgs[id];
      return o
        ? {
            id,
            displayName: o.displayName,
            publicToken: o.publicToken,
            orgType: "shelter",
            verified: true,
          }
        : null;
    },
  };
}

describe("getRehomeStateForPet", () => {
  it("nothing open → kind none", async () => {
    const state = await getRehomeStateForPet("pet-1", { repo: fakePort() });
    expect(state).toEqual({ kind: "none" });
  });

  it("an open request → pending, naming the org and the case", async () => {
    const state = await getRehomeStateForPet("pet-1", {
      repo: fakePort({
        request: { id: "c1", publicCode: "CAS-REQ-0001", receiverOrganizationId: "org-a" },
      }),
    });
    expect(state).toEqual({
      kind: "pending",
      orgId: "org-a",
      orgDisplayName: "Refugio Padrino",
      casePublicCode: "CAS-REQ-0001",
    });
  });

  it("an unmatched started event → active, with the listing case when it is open", async () => {
    const state = await getRehomeStateForPet("pet-1", {
      repo: fakePort({
        sponsorship: { ownershipId: "own-1", sponsoringOrganizationId: "org-a" },
        listing: { id: "l1", publicCode: "CAS-LIST-0001" },
      }),
    });
    expect(state).toEqual({
      kind: "active",
      orgId: "org-a",
      orgDisplayName: "Refugio Padrino",
      orgPublicToken: "DIM-ORG-A",
      listingCasePublicCode: "CAS-LIST-0001",
    });
  });

  it("active with no open listing case still reports active (the spine decides, not the case)", async () => {
    const state = await getRehomeStateForPet("pet-1", {
      repo: fakePort({ sponsorship: { ownershipId: "own-1", sponsoringOrganizationId: "org-a" } }),
    });
    expect(state).toMatchObject({ kind: "active", listingCasePublicCode: null });
  });

  it("an org that cannot be resolved degrades the name, never the state", async () => {
    const state = await getRehomeStateForPet("pet-1", {
      repo: fakePort({
        request: { id: "c1", publicCode: "CAS-REQ-0001", receiverOrganizationId: "org-gone" },
      }),
    });
    expect(state).toMatchObject({ kind: "pending", orgDisplayName: "la organización" });
  });

  it("if both somehow match, active wins", async () => {
    const state = await getRehomeStateForPet("pet-1", {
      repo: fakePort({
        request: { id: "c1", publicCode: "CAS-REQ-0001", receiverOrganizationId: "org-a" },
        sponsorship: { ownershipId: "own-1", sponsoringOrganizationId: "org-a" },
      }),
    });
    expect(state.kind).toBe("active");
  });
});
