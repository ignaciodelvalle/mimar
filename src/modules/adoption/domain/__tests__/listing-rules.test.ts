// Unit tests for listing-rules.ts — pure, no DB.
// Written FIRST (RED phase) before creating listing-rules.ts.

import { describe, expect, it } from "vitest";

// Will be created in GREEN phase (task 2.6).
import {
  isListable,
  livesWithFamilyUnder,
  validatePause,
  validatePublish,
  validateUnpause,
  validateUnpublish,
} from "../listing-rules";

// rehome-by-titular, spec REQ-12 / design R5 (WU6/7 review, L-1): the public
// ficha and the catalog card used two different predicates for "the animal
// lives with its family". One helper, the STRICTER semantics: the open
// sponsorship must belong to the org that answers for the listing.
describe("livesWithFamilyUnder", () => {
  const open = { ownershipId: "own-1", sponsoringOrganizationId: "org-a" };

  it("true only when the custodian IS the sponsor", () => {
    expect(livesWithFamilyUnder(open, "org-a")).toBe(true);
  });

  it("false for another custodian — a stale started event over a row another org now holds", () => {
    expect(livesWithFamilyUnder(open, "org-b")).toBe(false);
  });

  it("false with no open sponsorship, and false with no custodian at all", () => {
    expect(livesWithFamilyUnder(null, "org-a")).toBe(false);
    expect(livesWithFamilyUnder(undefined, "org-a")).toBe(false);
    expect(livesWithFamilyUnder(open, null)).toBe(false);
    expect(livesWithFamilyUnder(open, undefined)).toBe(false);
  });
});

// Helpers to build pet snapshots.
function makeListablePet(
  overrides: Partial<{
    status: string;
    adoptionEligible: boolean | null;
    inCustodyDispute: boolean | null;
    rabiesObservationStatus: string | null;
    adoptionListedAt: Date | null;
    adoptionListingPausedAt: Date | null;
  }> = {},
) {
  return {
    status: "active",
    adoptionEligible: true,
    inCustodyDispute: null,
    rabiesObservationStatus: null,
    adoptionListedAt: null,
    adoptionListingPausedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validatePublish
// ---------------------------------------------------------------------------

describe("validatePublish", () => {
  it("returns error when pet status is lost", () => {
    const pet = makeListablePet({ status: "lost" });
    expect(validatePublish(pet)).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("returns error when pet status is deceased", () => {
    const pet = makeListablePet({ status: "deceased" });
    expect(validatePublish(pet)).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("returns error when adoptionEligible is not true (null)", () => {
    const pet = makeListablePet({ adoptionEligible: null });
    expect(validatePublish(pet)).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("returns error when adoptionEligible is false", () => {
    const pet = makeListablePet({ adoptionEligible: false });
    expect(validatePublish(pet)).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("returns error when pet is in custody dispute", () => {
    const pet = makeListablePet({ inCustodyDispute: true });
    expect(validatePublish(pet)).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("returns error when rabiesObservationStatus is in_progress", () => {
    const pet = makeListablePet({ rabiesObservationStatus: "in_progress" });
    expect(validatePublish(pet)).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("returns ok when all guards pass", () => {
    const pet = makeListablePet();
    expect(validatePublish(pet)).toEqual({ ok: true });
  });

  // Triangulation — other rabies statuses don't block
  it("does not block when rabiesObservationStatus is completed", () => {
    const pet = makeListablePet({ rabiesObservationStatus: "completed" });
    expect(validatePublish(pet)).toEqual({ ok: true });
  });

  it("does not block when inCustodyDispute is false", () => {
    const pet = makeListablePet({ inCustodyDispute: false });
    expect(validatePublish(pet)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// validatePause
// ---------------------------------------------------------------------------

describe("validatePause", () => {
  it("returns error when pet is not published (adoptionListedAt is null)", () => {
    const pet = makeListablePet({ adoptionListedAt: null });
    expect(validatePause(pet)).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("returns ok when pet is published", () => {
    const pet = makeListablePet({ adoptionListedAt: new Date("2024-01-01") });
    expect(validatePause(pet)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// validateUnpause
// ---------------------------------------------------------------------------

describe("validateUnpause", () => {
  it("returns error when pet is not eligible (fell out of eligibility while paused)", () => {
    const pet = makeListablePet({ adoptionEligible: false });
    expect(validateUnpause(pet)).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("returns error when pet fell into custody dispute while paused", () => {
    const pet = makeListablePet({ inCustodyDispute: true });
    expect(validateUnpause(pet)).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("returns error when rabies observation started while paused", () => {
    const pet = makeListablePet({ rabiesObservationStatus: "in_progress" });
    expect(validateUnpause(pet)).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("returns ok when all cross-spec guards still pass", () => {
    const pet = makeListablePet({ adoptionListedAt: new Date("2024-01-01") });
    expect(validateUnpause(pet)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// validateUnpublish
// ---------------------------------------------------------------------------

describe("validateUnpublish", () => {
  it("returns ok regardless of current state (unpublish always valid)", () => {
    const pet = makeListablePet({ adoptionListedAt: new Date() });
    expect(validateUnpublish(pet)).toEqual({ ok: true });
  });

  it("returns ok even when already unpublished", () => {
    const pet = makeListablePet({ adoptionListedAt: null });
    expect(validateUnpublish(pet)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// isListable
// ---------------------------------------------------------------------------

function makeFullPet(
  overrides: Partial<{
    adoptionListedAt: Date | null;
    adoptionListingPausedAt: Date | null;
    status: string;
    adoptionEligible: boolean | null;
    inCustodyDispute: boolean | null;
    rabiesObservationStatus: string | null;
  }> = {},
) {
  return {
    adoptionListedAt: new Date("2024-01-01"),
    adoptionListingPausedAt: null,
    status: "active",
    adoptionEligible: true as boolean | null,
    inCustodyDispute: null as boolean | null,
    rabiesObservationStatus: null as string | null,
    ...overrides,
  };
}

function makeOrg(overrides: Partial<{ verified: boolean; orgType: string }> = {}) {
  return { verified: true, orgType: "shelter", ...overrides };
}

describe("isListable", () => {
  it("returns true for a fully eligible pet under a verified shelter", () => {
    expect(isListable(makeFullPet(), makeOrg())).toBe(true);
  });

  it("returns false when adoptionListedAt is null", () => {
    expect(isListable(makeFullPet({ adoptionListedAt: null }), makeOrg())).toBe(false);
  });

  it("returns false when adoptionListingPausedAt is set", () => {
    expect(isListable(makeFullPet({ adoptionListingPausedAt: new Date() }), makeOrg())).toBe(false);
  });

  it("returns false when status is deceased", () => {
    expect(isListable(makeFullPet({ status: "deceased" }), makeOrg())).toBe(false);
  });

  it("returns false when status is lost", () => {
    expect(isListable(makeFullPet({ status: "lost" }), makeOrg())).toBe(false);
  });

  it("returns false when adoptionEligible is not true (null)", () => {
    expect(isListable(makeFullPet({ adoptionEligible: null }), makeOrg())).toBe(false);
  });

  it("returns false when adoptionEligible is false", () => {
    expect(isListable(makeFullPet({ adoptionEligible: false }), makeOrg())).toBe(false);
  });

  it("returns false when pet is in custody dispute", () => {
    expect(isListable(makeFullPet({ inCustodyDispute: true }), makeOrg())).toBe(false);
  });

  it("returns false when rabiesObservationStatus is in_progress", () => {
    expect(isListable(makeFullPet({ rabiesObservationStatus: "in_progress" }), makeOrg())).toBe(
      false,
    );
  });

  it("returns false when org is not verified", () => {
    expect(isListable(makeFullPet(), makeOrg({ verified: false }))).toBe(false);
  });

  it("returns false when orgType is not shelter or rescue_network", () => {
    expect(isListable(makeFullPet(), makeOrg({ orgType: "clinic" }))).toBe(false);
  });

  it("returns true for rescue_network org type", () => {
    expect(isListable(makeFullPet(), makeOrg({ orgType: "rescue_network" }))).toBe(true);
  });

  it("returns true when inCustodyDispute is false (not just null)", () => {
    expect(isListable(makeFullPet({ inCustodyDispute: false }), makeOrg())).toBe(true);
  });

  it("returns true when rabiesObservationStatus is completed (not in_progress)", () => {
    expect(
      isListable(makeFullPet({ rabiesObservationStatus: "completed_negative" }), makeOrg()),
    ).toBe(true);
  });
});
