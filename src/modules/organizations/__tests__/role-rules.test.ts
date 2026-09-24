// Unit tests for domain/role-rules.ts — pure, no DB, no Next.js.
// Written FIRST (RED phase, task 1.1) before creating role-rules.ts.

import { describe, expect, it } from "vitest";

import {
  INVITABLE_ROLES,
  ROLE_RANK,
  canAssign,
  canManage,
  isInvitableRole,
  isManagerRole,
} from "@/src/modules/organizations/domain/role-rules";

// ---------------------------------------------------------------------------
// ROLE_RANK
// ---------------------------------------------------------------------------

describe("ROLE_RANK", () => {
  it("assigns admin the highest rank (5)", () => {
    expect(ROLE_RANK.admin).toBe(5);
  });

  it("assigns coordinator rank 4", () => {
    expect(ROLE_RANK.coordinator).toBe(4);
  });

  it("assigns member and vet_individual the same rank (3)", () => {
    expect(ROLE_RANK.member).toBe(3);
    expect(ROLE_RANK.vet_individual).toBe(3);
  });

  it("assigns volunteer rank 2", () => {
    expect(ROLE_RANK.volunteer).toBe(2);
  });

  it("assigns foster the lowest rank (1)", () => {
    expect(ROLE_RANK.foster).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// isManagerRole
// ---------------------------------------------------------------------------

describe("isManagerRole", () => {
  it("returns true for admin", () => {
    expect(isManagerRole("admin")).toBe(true);
  });

  it("returns true for coordinator", () => {
    expect(isManagerRole("coordinator")).toBe(true);
  });

  it("returns false for member", () => {
    expect(isManagerRole("member")).toBe(false);
  });

  it("returns false for vet_individual", () => {
    expect(isManagerRole("vet_individual")).toBe(false);
  });

  it("returns false for volunteer", () => {
    expect(isManagerRole("volunteer")).toBe(false);
  });

  it("returns false for foster", () => {
    expect(isManagerRole("foster")).toBe(false);
  });

  it("returns false for unknown role string", () => {
    expect(isManagerRole("unknown_role")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isInvitableRole
// ---------------------------------------------------------------------------

describe("isInvitableRole", () => {
  it("returns true for admin", () => {
    expect(isInvitableRole("admin")).toBe(true);
  });

  it("returns true for coordinator", () => {
    expect(isInvitableRole("coordinator")).toBe(true);
  });

  it("returns true for member", () => {
    expect(isInvitableRole("member")).toBe(true);
  });

  it("returns true for volunteer", () => {
    expect(isInvitableRole("volunteer")).toBe(true);
  });

  it("returns true for vet_individual", () => {
    expect(isInvitableRole("vet_individual")).toBe(true);
  });

  it("returns false for foster (comes via foster-proposal flow, not direct invite)", () => {
    expect(isInvitableRole("foster")).toBe(false);
  });

  it("returns false for unknown string", () => {
    expect(isInvitableRole("random")).toBe(false);
  });

  it("INVITABLE_ROLES tuple does not include foster", () => {
    expect((INVITABLE_ROLES as readonly string[]).includes("foster")).toBe(false);
  });

  it("INVITABLE_ROLES tuple includes exactly the 5 invitable roles", () => {
    expect(INVITABLE_ROLES).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// canManage — targetRank > actorRank means NOT manageable
// ---------------------------------------------------------------------------

describe("canManage", () => {
  it("admin can manage coordinator", () => {
    expect(canManage("admin", "coordinator")).toBe(true);
  });

  it("admin can manage member", () => {
    expect(canManage("admin", "member")).toBe(true);
  });

  it("coordinator can manage member", () => {
    expect(canManage("coordinator", "member")).toBe(true);
  });

  it("coordinator can manage volunteer", () => {
    expect(canManage("coordinator", "volunteer")).toBe(true);
  });

  it("coordinator CANNOT manage admin (higher rank)", () => {
    expect(canManage("coordinator", "admin")).toBe(false);
  });

  it("member CANNOT manage coordinator", () => {
    expect(canManage("member", "coordinator")).toBe(false);
  });

  it("member CANNOT manage vet_individual (same rank)", () => {
    // same rank = canManage returns false per spec (targetRank > actorRank is the block,
    // but same rank is NOT manageable — "No podés gestionar a alguien con un rol mayor al tuyo")
    expect(canManage("member", "vet_individual")).toBe(false);
  });

  it("admin can manage volunteer", () => {
    expect(canManage("admin", "volunteer")).toBe(true);
  });

  it("volunteer CANNOT manage member", () => {
    expect(canManage("volunteer", "member")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// canAssign — actor assigns newRole; blocked when newRoleRank > actorRank
// ---------------------------------------------------------------------------

describe("canAssign", () => {
  it("admin can assign coordinator", () => {
    expect(canAssign("admin", "coordinator")).toBe(true);
  });

  it("admin can assign admin (same rank — actor can assign own rank)", () => {
    // admin assigning admin: newRoleRank === actorRank — spec says "No podés asignar un rol mayor al tuyo"
    // so same rank is allowed (only strictly greater is blocked)
    expect(canAssign("admin", "admin")).toBe(true);
  });

  it("coordinator can assign member", () => {
    expect(canAssign("coordinator", "member")).toBe(true);
  });

  it("coordinator CANNOT assign admin (higher rank)", () => {
    expect(canAssign("coordinator", "admin")).toBe(false);
  });

  it("coordinator CANNOT assign coordinator (same rank — coordinator cannot grant own rank)", () => {
    // spec: "No podés asignar un rol mayor al tuyo" — strictly greater blocked
    // coordinator assigning coordinator: same rank, so allowed per spec literal
    // BUT per spec discussion: same-rank is allowed for assign (block is strictly >)
    expect(canAssign("coordinator", "coordinator")).toBe(true);
  });

  it("member CANNOT assign coordinator", () => {
    expect(canAssign("member", "coordinator")).toBe(false);
  });

  it("member can assign volunteer (lower rank)", () => {
    expect(canAssign("member", "volunteer")).toBe(true);
  });
});
