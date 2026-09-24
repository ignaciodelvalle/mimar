// Unit tests for pet-rules.ts — pure, no DB.
// Written FIRST (RED phase, task 1.5) before creating pet-rules.ts.

import { describe, expect, it } from "vitest";

import {
  custodyKindToOwnershipRole,
  custodyKindToRegisteredPayloadKind,
  isBecamePPP,
  isChipNewlyAdded,
  isFlagOnlyChange,
  isNoOp,
} from "../pet-rules";

// ---------------------------------------------------------------------------
// custodyKindToOwnershipRole
// ---------------------------------------------------------------------------

describe("custodyKindToOwnershipRole", () => {
  it("maps foster_in_transit to shelter_custody", () => {
    expect(custodyKindToOwnershipRole("foster_in_transit")).toBe("shelter_custody");
  });

  it("maps owner to owner", () => {
    expect(custodyKindToOwnershipRole("owner")).toBe("owner");
  });
});

// ---------------------------------------------------------------------------
// custodyKindToRegisteredPayloadKind
// ---------------------------------------------------------------------------

describe("custodyKindToRegisteredPayloadKind", () => {
  it("maps foster_in_transit to shelter_custody_by_citizen", () => {
    expect(custodyKindToRegisteredPayloadKind("foster_in_transit")).toBe(
      "shelter_custody_by_citizen",
    );
  });

  it("maps owner to owner", () => {
    expect(custodyKindToRegisteredPayloadKind("owner")).toBe("owner");
  });
});

// chipImplantSiteFromLocation moved to lib/domain/microchip-implant-site.ts —
// its tests moved with it (see lib/domain/microchip-implant-site.test.ts).

// ---------------------------------------------------------------------------
// isNoOp predicate
// ---------------------------------------------------------------------------

describe("isNoOp", () => {
  it("returns true when no content changes, no photo, no flag change", () => {
    expect(isNoOp({ hasContentChanges: false, hasPhoto: false, flagChanged: false })).toBe(true);
  });

  it("returns false when there are content changes", () => {
    expect(isNoOp({ hasContentChanges: true, hasPhoto: false, flagChanged: false })).toBe(false);
  });

  it("returns false when a photo is uploaded", () => {
    expect(isNoOp({ hasContentChanges: false, hasPhoto: true, flagChanged: false })).toBe(false);
  });

  it("returns false when a flag changed", () => {
    expect(isNoOp({ hasContentChanges: false, hasPhoto: false, flagChanged: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isFlagOnlyChange predicate
// ---------------------------------------------------------------------------

describe("isFlagOnlyChange", () => {
  it("returns true when only the flag changed (no content, no photo)", () => {
    expect(isFlagOnlyChange({ hasContentChanges: false, hasPhoto: false, flagChanged: true })).toBe(
      true,
    );
  });

  it("returns false when there is also content changed", () => {
    expect(isFlagOnlyChange({ hasContentChanges: true, hasPhoto: false, flagChanged: true })).toBe(
      false,
    );
  });

  it("returns false when there is also a photo", () => {
    expect(isFlagOnlyChange({ hasContentChanges: false, hasPhoto: true, flagChanged: true })).toBe(
      false,
    );
  });

  it("returns false when flag did not change", () => {
    expect(
      isFlagOnlyChange({ hasContentChanges: false, hasPhoto: false, flagChanged: false }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isChipNewlyAdded predicate
// ---------------------------------------------------------------------------

describe("isChipNewlyAdded", () => {
  it("returns true when chip was absent and is now present", () => {
    expect(isChipNewlyAdded({ existingChipId: null, parsedChipId: "982000411234567" })).toBe(true);
  });

  it("returns false when chip was already present", () => {
    expect(
      isChipNewlyAdded({ existingChipId: "982000411234567", parsedChipId: "982000411234567" }),
    ).toBe(false);
  });

  it("returns false when chip is absent in both existing and parsed", () => {
    expect(isChipNewlyAdded({ existingChipId: null, parsedChipId: null })).toBe(false);
  });

  it("returns false when chip is being cleared (was present, now null)", () => {
    // This case: had chip, now removing. Not 'newly added'.
    expect(isChipNewlyAdded({ existingChipId: "982000411234567", parsedChipId: null })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isBecamePPP predicate
// ---------------------------------------------------------------------------

describe("isBecamePPP", () => {
  it("returns true when pet was not PPP and now is", () => {
    expect(isBecamePPP({ existingPPP: false, newPPP: true })).toBe(true);
  });

  it("returns false when pet was already PPP", () => {
    expect(isBecamePPP({ existingPPP: true, newPPP: true })).toBe(false);
  });

  it("returns false when pet is not PPP in either state", () => {
    expect(isBecamePPP({ existingPPP: false, newPPP: false })).toBe(false);
  });

  it("returns false when PPP status drops from true to false", () => {
    expect(isBecamePPP({ existingPPP: true, newPPP: false })).toBe(false);
  });
});
