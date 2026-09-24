// Unit tests for domain/capabilities.ts — pure, no DB, no Next.js.
// Written FIRST (RED phase, task 1.3) before creating capabilities.ts.

import { describe, expect, it } from "vitest";

import { ORGANIZATION_CAPABILITIES, type OrganizationCapability } from "@/db/schema";
import {
  CAPABILITY_CATALOG,
  COORDINATOR_IMPLICIT_CAPS,
  SHELTER_ONLY_CAPABILITIES,
  VET_INDIVIDUAL_IMPLICIT_CAPS,
  WELFARE_DECOMISO_EXECUTE_CAPABILITY,
  capabilityAppliesToOrgType,
  isValidCapability,
  resolveGrantedCaps,
} from "@/src/modules/organizations/domain/capabilities";

// ---------------------------------------------------------------------------
// Org-type specialization (#43 item 2)
// ---------------------------------------------------------------------------

describe("capabilityAppliesToOrgType", () => {
  const shelterOnly: OrganizationCapability[] = [
    "foster.assign",
    "foster.end",
    "adoption.review",
    "adoption.finalize",
    "custody.transfer",
    "adoption.listing.manage",
  ];

  it("SHELTER_ONLY_CAPABILITIES holds exactly the six pure-shelter caps", () => {
    expect([...SHELTER_ONLY_CAPABILITIES].sort()).toEqual([...shelterOnly].sort());
  });

  it("hides every shelter-only capability from a clinic", () => {
    for (const cap of shelterOnly) {
      expect(capabilityAppliesToOrgType(cap, "clinic"), cap).toBe(false);
    }
  });

  it("hides shelter-only capabilities from a sanitary_authority", () => {
    for (const cap of shelterOnly) {
      expect(capabilityAppliesToOrgType(cap, "sanitary_authority"), cap).toBe(false);
    }
  });

  it("keeps shelter-only capabilities for shelters and rescue networks", () => {
    for (const cap of shelterOnly) {
      expect(capabilityAppliesToOrgType(cap, "shelter"), cap).toBe(true);
      expect(capabilityAppliesToOrgType(cap, "rescue_network"), cap).toBe(true);
    }
  });

  it("keeps clinic-relevant capabilities visible for a clinic (event.write, appointments, bite)", () => {
    for (const cap of [
      "event.write",
      "appointment.manage",
      "service_offering.create",
      "bite.report",
      "pet.read_held",
      "intake.create",
    ] as OrganizationCapability[]) {
      expect(capabilityAppliesToOrgType(cap, "clinic"), cap).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// WELFARE_DECOMISO_EXECUTE_CAPABILITY
// ---------------------------------------------------------------------------

describe("WELFARE_DECOMISO_EXECUTE_CAPABILITY", () => {
  it("is the literal string 'welfare.decomiso.execute'", () => {
    expect(WELFARE_DECOMISO_EXECUTE_CAPABILITY).toBe("welfare.decomiso.execute");
  });

  it("is NOT in ORGANIZATION_CAPABILITIES (it is a profile-role level grant)", () => {
    expect(
      (ORGANIZATION_CAPABILITIES as readonly string[]).includes(
        WELFARE_DECOMISO_EXECUTE_CAPABILITY,
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isValidCapability
// ---------------------------------------------------------------------------

describe("isValidCapability", () => {
  it("returns true for a known capability (pet.read_held)", () => {
    expect(isValidCapability("pet.read_held")).toBe(true);
  });

  it("returns true for capability.grant", () => {
    expect(isValidCapability("capability.grant")).toBe(true);
  });

  it("returns true for org.transfer.propose", () => {
    expect(isValidCapability("org.transfer.propose")).toBe(true);
  });

  it("returns false for welfare.decomiso.execute (not in org caps)", () => {
    expect(isValidCapability("welfare.decomiso.execute")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isValidCapability("")).toBe(false);
  });

  it("returns false for unknown capability string", () => {
    expect(isValidCapability("foo.bar")).toBe(false);
  });

  it("is a type guard — validates every entry in ORGANIZATION_CAPABILITIES", () => {
    for (const cap of ORGANIZATION_CAPABILITIES) {
      expect(isValidCapability(cap)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// VET_INDIVIDUAL_IMPLICIT_CAPS
// ---------------------------------------------------------------------------

describe("VET_INDIVIDUAL_IMPLICIT_CAPS", () => {
  it("includes pet.read_held", () => {
    expect(VET_INDIVIDUAL_IMPLICIT_CAPS).toContain("pet.read_held");
  });

  it("includes event.write", () => {
    expect(VET_INDIVIDUAL_IMPLICIT_CAPS).toContain("event.write");
  });

  it("includes intake.create", () => {
    expect(VET_INDIVIDUAL_IMPLICIT_CAPS).toContain("intake.create");
  });

  it("has exactly 3 entries", () => {
    expect(VET_INDIVIDUAL_IMPLICIT_CAPS).toHaveLength(3);
  });

  it("does NOT include member.invite (coordinators only)", () => {
    expect(VET_INDIVIDUAL_IMPLICIT_CAPS).not.toContain("member.invite");
  });
});

// ---------------------------------------------------------------------------
// COORDINATOR_IMPLICIT_CAPS
// ---------------------------------------------------------------------------

describe("COORDINATOR_IMPLICIT_CAPS", () => {
  it("includes org.transfer.propose", () => {
    expect(COORDINATOR_IMPLICIT_CAPS).toContain("org.transfer.propose");
  });

  it("includes org.transfer.accept", () => {
    expect(COORDINATOR_IMPLICIT_CAPS).toContain("org.transfer.accept");
  });

  it("includes member.invite", () => {
    expect(COORDINATOR_IMPLICIT_CAPS).toContain("member.invite");
  });

  it("has exactly 3 entries", () => {
    expect(COORDINATOR_IMPLICIT_CAPS).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// CAPABILITY_CATALOG
// ---------------------------------------------------------------------------

describe("CAPABILITY_CATALOG", () => {
  it("has at least one entry for every ORGANIZATION_CAPABILITY that is in the catalog", () => {
    // Every catalog entry must reference a valid capability
    for (const entry of CAPABILITY_CATALOG) {
      expect(isValidCapability(entry.capability)).toBe(true);
    }
  });

  it("has entries with non-empty label and description", () => {
    for (const entry of CAPABILITY_CATALOG) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it("includes an entry for pet.read_held", () => {
    expect(CAPABILITY_CATALOG.some((e) => e.capability === "pet.read_held")).toBe(true);
  });

  it("includes an entry for event.write", () => {
    expect(CAPABILITY_CATALOG.some((e) => e.capability === "event.write")).toBe(true);
  });

  it("includes an entry for capability.grant", () => {
    expect(CAPABILITY_CATALOG.some((e) => e.capability === "capability.grant")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveGrantedCaps — pure baseline computation
// ---------------------------------------------------------------------------

describe("resolveGrantedCaps — admin", () => {
  it("admin gets ALL ORGANIZATION_CAPABILITIES regardless of approved rows", () => {
    const granted = resolveGrantedCaps("admin", []);
    for (const cap of ORGANIZATION_CAPABILITIES) {
      expect(granted.has(cap)).toBe(true);
    }
  });

  it("admin set size equals ORGANIZATION_CAPABILITIES length", () => {
    const granted = resolveGrantedCaps("admin", []);
    expect(granted.size).toBe(ORGANIZATION_CAPABILITIES.length);
  });

  it("admin gets all caps even when approved rows pass in unrelated caps (ignored, admin is universal)", () => {
    // Extra rows are irrelevant — admin is universal
    const granted = resolveGrantedCaps("admin", ["pet.read_held"]);
    expect(granted.size).toBe(ORGANIZATION_CAPABILITIES.length);
  });
});

describe("resolveGrantedCaps — vet_individual", () => {
  it("vet_individual gets VET_INDIVIDUAL_IMPLICIT_CAPS when no approved rows", () => {
    const granted = resolveGrantedCaps("vet_individual", []);
    for (const cap of VET_INDIVIDUAL_IMPLICIT_CAPS) {
      expect(granted.has(cap)).toBe(true);
    }
  });

  it("vet_individual with approved grant gets that grant PLUS the implicit caps", () => {
    const granted = resolveGrantedCaps("vet_individual", ["foster.assign"]);
    expect(granted.has("foster.assign")).toBe(true);
    expect(granted.has("pet.read_held")).toBe(true);
    expect(granted.has("event.write")).toBe(true);
    expect(granted.has("intake.create")).toBe(true);
  });

  it("vet_individual does NOT get capabilities outside implicit + approved", () => {
    const granted = resolveGrantedCaps("vet_individual", []);
    expect(granted.has("capability.grant")).toBe(false);
    expect(granted.has("member.invite")).toBe(false);
  });

  it("vet_individual filters out invalid capabilities from approved rows", () => {
    const granted = resolveGrantedCaps("vet_individual", ["bad.cap" as string]);
    expect(granted.has("bad.cap" as OrganizationCapability)).toBe(false);
    // implicit caps still present
    expect(granted.has("pet.read_held")).toBe(true);
  });
});

describe("resolveGrantedCaps — coordinator", () => {
  it("coordinator gets COORDINATOR_IMPLICIT_CAPS when no approved rows", () => {
    const granted = resolveGrantedCaps("coordinator", []);
    for (const cap of COORDINATOR_IMPLICIT_CAPS) {
      expect(granted.has(cap)).toBe(true);
    }
  });

  it("coordinator with approved grant gets that grant PLUS implicit caps", () => {
    const granted = resolveGrantedCaps("coordinator", ["foster.assign"]);
    expect(granted.has("foster.assign")).toBe(true);
    expect(granted.has("org.transfer.propose")).toBe(true);
    expect(granted.has("member.invite")).toBe(true);
  });

  it("coordinator does NOT implicitly get pet.read_held (not in COORDINATOR_IMPLICIT_CAPS)", () => {
    const granted = resolveGrantedCaps("coordinator", []);
    expect(granted.has("pet.read_held")).toBe(false);
  });
});

describe("resolveGrantedCaps — member/volunteer/foster", () => {
  it("member gets ONLY approved rows (no implicit caps)", () => {
    const granted = resolveGrantedCaps("member", ["pet.read_held", "event.write"]);
    expect(granted.has("pet.read_held")).toBe(true);
    expect(granted.has("event.write")).toBe(true);
    expect(granted.size).toBe(2);
  });

  it("member with no approved rows gets empty set", () => {
    const granted = resolveGrantedCaps("member", []);
    expect(granted.size).toBe(0);
  });

  it("volunteer with no approved rows gets empty set", () => {
    const granted = resolveGrantedCaps("volunteer", []);
    expect(granted.size).toBe(0);
  });

  it("foster with no approved rows gets empty set", () => {
    const granted = resolveGrantedCaps("foster", []);
    expect(granted.size).toBe(0);
  });

  it("member filters out invalid capability strings from approved rows", () => {
    const granted = resolveGrantedCaps("member", ["bad.cap" as string, "pet.read_held"]);
    expect(granted.has("bad.cap" as OrganizationCapability)).toBe(false);
    expect(granted.has("pet.read_held")).toBe(true);
    expect(granted.size).toBe(1);
  });

  it("grant precedence: approved rows union with implicit caps — no cap is dropped", () => {
    // vet_individual + explicit foster.assign grant
    const granted = resolveGrantedCaps("vet_individual", ["foster.assign", "adoption.review"]);
    // Has all implicit
    expect(granted.has("pet.read_held")).toBe(true);
    expect(granted.has("event.write")).toBe(true);
    expect(granted.has("intake.create")).toBe(true);
    // Plus the explicit approved grants
    expect(granted.has("foster.assign")).toBe(true);
    expect(granted.has("adoption.review")).toBe(true);
  });
});
