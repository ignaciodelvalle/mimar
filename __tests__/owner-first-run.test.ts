// Unit tests for deriveOwnerFirstRunState (task #19, owner-process-clarity
// Lens 1). Pure function — no DB, no fixtures.

import { describe, expect, it } from "vitest";

import { deriveOwnerFirstRunState } from "@/lib/domain/owner-first-run";

describe("deriveOwnerFirstRunState", () => {
  it("returns null when the owner has at least one active pet", () => {
    expect(deriveOwnerFirstRunState([{ status: "active" }])).toBeNull();
  });

  it("returns null when the owner has a lost pet (lost is still manageable)", () => {
    expect(deriveOwnerFirstRunState([{ status: "lost" }])).toBeNull();
  });

  it("returns null when at least one pet is manageable among deceased ones", () => {
    expect(deriveOwnerFirstRunState([{ status: "deceased" }, { status: "active" }])).toBeNull();
  });

  it("returns 'fresh' when the owner has no pets at all", () => {
    expect(deriveOwnerFirstRunState([])).toBe("fresh");
  });

  it("returns 'returning' when every pet is deceased (in memoriam only)", () => {
    expect(deriveOwnerFirstRunState([{ status: "deceased" }, { status: "deceased" }])).toBe(
      "returning",
    );
  });
});
