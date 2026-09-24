// Unit tests for splitOwnershipAddressees.
//
// THE DEFECT THIS PINS (verified 2026-08-17, PO fix list item 2d)
// ---------------------------------------------------------------------------
// executeDecomiso terminates EVERY active ownership on the seized animal, but
// its notification pass collected only `ownerUserId`. An `ownerships` row holds
// either a user or an organization — so an animal owned by a refugio, a rescue
// network or a clinic had its ownership ended and produced NO addressee at all.
// Nobody was told, and the action returned `ok: true` exactly as it does when
// three people are notified.

import { describe, expect, it } from "vitest";

import { splitOwnershipAddressees } from "./seizure-rules";

describe("splitOwnershipAddressees", () => {
  it("an ORGANISATION-held ownership produces a recipient (the old loop produced none)", () => {
    const result = splitOwnershipAddressees([
      { ownerUserId: null, ownerOrganizationId: "org-refugio-1" },
    ]);
    expect(result.organizationIds).toEqual(["org-refugio-1"]);
    expect(result.userIds).toEqual([]);
    // The whole point: this seizure is no longer addressee-less.
    expect(result.userIds.length + result.organizationIds.length).toBe(1);
  });

  it("a user-held ownership still produces the user (no regression)", () => {
    const result = splitOwnershipAddressees([{ ownerUserId: "user-1", ownerOrganizationId: null }]);
    expect(result.userIds).toEqual(["user-1"]);
    expect(result.organizationIds).toEqual([]);
  });

  it("mixed ownerships split into both buckets, order preserved", () => {
    const result = splitOwnershipAddressees([
      { ownerUserId: "user-1", ownerOrganizationId: null },
      { ownerUserId: null, ownerOrganizationId: "org-1" },
      { ownerUserId: "user-2", ownerOrganizationId: null },
      { ownerUserId: null, ownerOrganizationId: "org-2" },
    ]);
    expect(result.userIds).toEqual(["user-1", "user-2"]);
    expect(result.organizationIds).toEqual(["org-1", "org-2"]);
  });

  it("a row carrying BOTH counts once, as the user (the human is the addressee)", () => {
    const result = splitOwnershipAddressees([
      { ownerUserId: "user-1", ownerOrganizationId: "org-1" },
    ]);
    expect(result.userIds).toEqual(["user-1"]);
    expect(result.organizationIds).toEqual([]);
  });

  it("an empty ownership set yields no addressees (unowned-animal path)", () => {
    expect(splitOwnershipAddressees([])).toEqual({ userIds: [], organizationIds: [] });
  });
});
