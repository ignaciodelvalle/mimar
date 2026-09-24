// Unit tests for welfare report classification logic.
// Covers: MALTREATMENT_KINDS set, bridgeEventTypeFor, derivePrimarySubjectKind,
// and reporterRole / authorRole derivation.

import { describe, expect, it } from "vitest";

import {
  MALTREATMENT_KINDS,
  bridgeEventTypeFor,
  deriveAuthorRole,
  derivePrimarySubjectKind,
  deriveReporterRole,
} from "./report-classification";

// ---------------------------------------------------------------------------
// MALTREATMENT_KINDS
// ---------------------------------------------------------------------------

describe("MALTREATMENT_KINDS", () => {
  it("contains the physical_abuse kind", () => {
    expect(MALTREATMENT_KINDS.has("physical_abuse")).toBe(true);
  });

  it("contains neglect", () => {
    expect(MALTREATMENT_KINDS.has("neglect")).toBe(true);
  });

  it("contains chained, no_shelter, hoarding, dog_fighting, trafficking", () => {
    expect(MALTREATMENT_KINDS.has("chained")).toBe(true);
    expect(MALTREATMENT_KINDS.has("no_shelter")).toBe(true);
    expect(MALTREATMENT_KINDS.has("hoarding")).toBe(true);
    expect(MALTREATMENT_KINDS.has("dog_fighting")).toBe(true);
    expect(MALTREATMENT_KINDS.has("trafficking")).toBe(true);
  });

  it("does NOT contain abandonment (abandonment is its own event type)", () => {
    expect(MALTREATMENT_KINDS.has("abandonment")).toBe(false);
  });

  it("does NOT contain other", () => {
    expect(MALTREATMENT_KINDS.has("other")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// bridgeEventTypeFor
// ---------------------------------------------------------------------------

describe("bridgeEventTypeFor", () => {
  it("returns abandonment_reported for kind=abandonment", () => {
    expect(bridgeEventTypeFor("abandonment")).toBe("abandonment_reported");
  });

  it("returns maltreatment_reported for kinds in MALTREATMENT_KINDS", () => {
    expect(bridgeEventTypeFor("physical_abuse")).toBe("maltreatment_reported");
    expect(bridgeEventTypeFor("neglect")).toBe("maltreatment_reported");
    expect(bridgeEventTypeFor("chained")).toBe("maltreatment_reported");
    expect(bridgeEventTypeFor("hoarding")).toBe("maltreatment_reported");
    expect(bridgeEventTypeFor("dog_fighting")).toBe("maltreatment_reported");
    expect(bridgeEventTypeFor("trafficking")).toBe("maltreatment_reported");
  });

  it("returns null for kind=other (no pet_event emitted)", () => {
    expect(bridgeEventTypeFor("other")).toBeNull();
  });

  it("returns null for unknown kinds", () => {
    expect(bridgeEventTypeFor("unknown_kind")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// derivePrimarySubjectKind
// ---------------------------------------------------------------------------

describe("derivePrimarySubjectKind", () => {
  it("returns registered_pet when subjectKind=registered_pet and petId is set", () => {
    expect(derivePrimarySubjectKind("registered_pet", "some-pet-id", null, null)).toBe(
      "registered_pet",
    );
  });

  it("returns unowned_animal when subjectKind=unowned_animal", () => {
    expect(derivePrimarySubjectKind("unowned_animal", null, null, null)).toBe("unowned_animal");
  });

  it("returns location when subjectKind=location AND coordinates are present", () => {
    expect(derivePrimarySubjectKind("location", null, -34.6, -58.4)).toBe("location");
  });

  it("returns general when subjectKind=location but coordinates are missing", () => {
    expect(derivePrimarySubjectKind("location", null, null, null)).toBe("general");
  });

  it("returns general for subjectKind=general", () => {
    expect(derivePrimarySubjectKind("general", null, null, null)).toBe("general");
  });

  it("returns general when registered_pet but petId is null (pet not resolved)", () => {
    expect(derivePrimarySubjectKind("registered_pet", null, null, null)).toBe("general");
  });
});

// ---------------------------------------------------------------------------
// deriveReporterRole
// ---------------------------------------------------------------------------

describe("deriveReporterRole", () => {
  it("returns owner when user owns the subject pet", () => {
    expect(deriveReporterRole(true)).toBe("owner");
  });

  it("returns witness when user does not own the subject pet", () => {
    expect(deriveReporterRole(false)).toBe("witness");
  });
});

// ---------------------------------------------------------------------------
// deriveAuthorRole
// ---------------------------------------------------------------------------

describe("deriveAuthorRole", () => {
  it("returns owner when user owns the subject pet", () => {
    expect(deriveAuthorRole(true)).toBe("owner");
  });

  it("returns scanner when user does not own the subject pet", () => {
    expect(deriveAuthorRole(false)).toBe("scanner");
  });
});
