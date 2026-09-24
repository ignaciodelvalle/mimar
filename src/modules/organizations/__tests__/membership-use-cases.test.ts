// Unit tests for organizations membership use-cases (WU-3, task 3.1):
//   - update-organization
//   - remove-member
//   - change-member-role
//   - set-member-event-write
//   - leave-organization
//
// Strategy: mock OrgRepository methods; test pure business logic only.
// Auth is NOT in use-cases — it is done at the action edge.
//
// TDD: tests written before use-case files exist (RED phase).

import { describe, expect, it, vi } from "vitest";

import type { OrganizationMembership } from "@/db";
import { changeOrganizationMemberRole } from "@/src/modules/organizations/application/change-member-role";
import { leaveOrganization } from "@/src/modules/organizations/application/leave-organization";
import { removeMember } from "@/src/modules/organizations/application/remove-member";
import { setMemberEventWrite } from "@/src/modules/organizations/application/set-member-event-write";
import { updateOrganization } from "@/src/modules/organizations/application/update-organization";

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

function makeMembership(overrides: Partial<OrganizationMembership> = {}): OrganizationMembership {
  return {
    id: "mem-1",
    userId: "user-actor",
    organizationId: "org-1",
    role: "admin",
    title: null,
    leftAt: null,
    joinedAt: new Date("2024-01-01"),
    invitedByUserId: null,
    canWritePetEvents: false,
    receivesBroadcasts: true,
    ...overrides,
  };
}

function makeOrg() {
  return {
    id: "org-1",
    publicToken: "ORG-TOKEN",
    displayName: "Test Org",
    legalName: null,
    email: null,
    phone: null,
    website: null,
    description: null,
    personeriaJuridicaNumber: null,
    tier0ShowOriginOrg: false,
    orgType: "refugio",
    verified: true,
    status: "active",
    jurisdictionProvince: null,
    jurisdictionLocality: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// update-organization
// ---------------------------------------------------------------------------

describe("updateOrganization", () => {
  it("returns error when displayName is too short", async () => {
    const result = await updateOrganization(
      {
        userId: "user-1",
        orgToken: "TKN",
        fields: { displayName: "A" },
      },
      {
        repo: { findMembershipByUserAndOrgToken: vi.fn(), updateOrgProfile: vi.fn() },
      },
    );
    expect(result).toEqual({ ok: false, error: "El nombre debe tener entre 2 y 100 caracteres." });
  });

  it("returns error when displayName is too long", async () => {
    const result = await updateOrganization(
      {
        userId: "user-1",
        orgToken: "TKN",
        fields: { displayName: "A".repeat(101) },
      },
      {
        repo: { findMembershipByUserAndOrgToken: vi.fn(), updateOrgProfile: vi.fn() },
      },
    );
    expect(result).toEqual({ ok: false, error: "El nombre debe tener entre 2 y 100 caracteres." });
  });

  it("returns error when legalName is provided but empty", async () => {
    const result = await updateOrganization(
      {
        userId: "user-1",
        orgToken: "TKN",
        fields: { displayName: "Valid Name", legalName: "   " },
      },
      {
        repo: { findMembershipByUserAndOrgToken: vi.fn(), updateOrgProfile: vi.fn() },
      },
    );
    expect(result).toEqual({ ok: false, error: "El nombre legal no puede quedar vacío." });
  });

  it("returns error when email format is invalid", async () => {
    const result = await updateOrganization(
      {
        userId: "user-1",
        orgToken: "TKN",
        fields: { displayName: "Valid Name", email: "not-an-email" },
      },
      {
        repo: { findMembershipByUserAndOrgToken: vi.fn(), updateOrgProfile: vi.fn() },
      },
    );
    expect(result).toEqual({ ok: false, error: "El correo electrónico es inválido." });
  });

  it("returns error when membership not found", async () => {
    const repo = {
      findMembershipByUserAndOrgToken: vi.fn().mockResolvedValue(null),
      updateOrgProfile: vi.fn(),
    };
    const result = await updateOrganization(
      {
        userId: "user-1",
        orgToken: "TKN",
        fields: { displayName: "Valid Name" },
      },
      { repo },
    );
    expect(result).toEqual({ ok: false, error: "No tenés acceso a esta organización." });
  });

  it("returns error when role is not admin", async () => {
    const repo = {
      findMembershipByUserAndOrgToken: vi.fn().mockResolvedValue({
        org: makeOrg(),
        membership: makeMembership({ role: "coordinator" }),
      }),
      updateOrgProfile: vi.fn(),
    };
    const result = await updateOrganization(
      {
        userId: "user-1",
        orgToken: "TKN",
        fields: { displayName: "Valid Name" },
      },
      { repo },
    );
    expect(result).toEqual({
      ok: false,
      error: "Solo los administradores de la organización pueden editar el perfil.",
    });
  });

  it("updates profile when admin with valid input", async () => {
    const repo = {
      findMembershipByUserAndOrgToken: vi.fn().mockResolvedValue({
        org: { ...makeOrg(), publicToken: "TKN" },
        membership: makeMembership({ role: "admin" }),
      }),
      updateOrgProfile: vi.fn().mockResolvedValue(undefined),
    };
    const result = await updateOrganization(
      {
        userId: "user-1",
        orgToken: "TKN",
        fields: { displayName: "New Name" },
      },
      { repo },
    );
    expect(result.ok).toBe(true);
    expect(repo.updateOrgProfile).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// remove-member
// ---------------------------------------------------------------------------

describe("removeMember", () => {
  const baseRepo = () => ({
    findActiveMembership: vi.fn(),
    lockActiveAdmins: vi.fn(),
    softLeave: vi.fn().mockResolvedValue(undefined),
    insertAuditLog: vi.fn().mockResolvedValue(undefined),
  });

  it("returns error when target membership not found", async () => {
    const repo = { ...baseRepo(), findActiveMembership: vi.fn().mockResolvedValue(null) };
    const result = await removeMember(
      {
        organizationId: "org-1",
        membershipId: "mem-target",
        actor: { userId: "user-actor", role: "admin", membershipId: "mem-actor" },
        organization: { publicToken: "TKN", displayName: "Org" },
      },
      { repo, transaction: vi.fn() },
    );
    expect(result).toEqual({ ok: false, error: "Membresía no encontrada o ya inactiva." });
  });

  it("returns self-error for non-admin when removing self", async () => {
    const repo = {
      ...baseRepo(),
      findActiveMembership: vi
        .fn()
        .mockResolvedValue(
          makeMembership({ id: "mem-target", userId: "user-actor", role: "coordinator" }),
        ),
    };
    const result = await removeMember(
      {
        organizationId: "org-1",
        membershipId: "mem-target",
        actor: { userId: "user-actor", role: "admin", membershipId: "mem-actor" },
        organization: { publicToken: "TKN", displayName: "Org" },
      },
      { repo, transaction: vi.fn() },
    );
    expect(result).toEqual({
      ok: false,
      error:
        "No podés quitarte a vos mismo por esta vía. Usá la opción 'Salir de la organización'.",
    });
  });

  it("returns rank error when target outranks actor", async () => {
    const repo = {
      ...baseRepo(),
      findActiveMembership: vi
        .fn()
        .mockResolvedValue(
          makeMembership({ id: "mem-target", userId: "user-target", role: "admin" }),
        ),
      // 2 admins so last-admin doesn't block; rank check will fail
      lockActiveAdmins: vi.fn().mockResolvedValue([{ id: "mem-actor" }, { id: "mem-target" }]),
    };
    const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({});
    });
    const result = await removeMember(
      {
        organizationId: "org-1",
        membershipId: "mem-target",
        // coordinator (rank 4) trying to remove admin (rank 5) — should fail
        actor: { userId: "user-actor", role: "coordinator", membershipId: "mem-actor" },
        organization: { publicToken: "TKN", displayName: "Org" },
      },
      { repo, transaction: txFn },
    );
    expect(result).toEqual({
      ok: false,
      error: "No podés gestionar a alguien con un rol mayor al tuyo.",
    });
  });

  it("LAST-ADMIN: blocks remove even when actor is the last admin targeting themselves", async () => {
    const repo = {
      ...baseRepo(),
      findActiveMembership: vi
        .fn()
        .mockResolvedValue(
          makeMembership({ id: "mem-target", userId: "user-other", role: "admin" }),
        ),
      lockActiveAdmins: vi.fn().mockResolvedValue([{ id: "mem-target" }]), // only 1 admin
      softLeave: vi.fn(),
    };
    const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({});
    });
    const result = await removeMember(
      {
        organizationId: "org-1",
        membershipId: "mem-target",
        actor: { userId: "user-actor", role: "admin", membershipId: "mem-actor" },
        organization: { publicToken: "TKN", displayName: "Org" },
      },
      { repo, transaction: txFn },
    );
    expect(result).toEqual({
      ok: false,
      error: "La organización debe tener al menos un administrador.",
    });
    expect(repo.softLeave).not.toHaveBeenCalled();
  });

  it("removes non-admin member successfully", async () => {
    const repo = {
      ...baseRepo(),
      findActiveMembership: vi
        .fn()
        .mockResolvedValue(
          makeMembership({ id: "mem-target", userId: "user-target", role: "member" }),
        ),
    };
    const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({});
    });
    const result = await removeMember(
      {
        organizationId: "org-1",
        membershipId: "mem-target",
        actor: { userId: "user-actor", role: "admin", membershipId: "mem-actor" },
        organization: { publicToken: "TKN", displayName: "Org" },
      },
      { repo, transaction: txFn },
    );
    expect(result.ok).toBe(true);
    // Non-admin path uses a tx for atomicity with audit write.
    expect(repo.softLeave).toHaveBeenCalledWith("mem-target", {});
  });

  it("removes admin member when 2+ admins exist", async () => {
    const repo = {
      ...baseRepo(),
      findActiveMembership: vi
        .fn()
        .mockResolvedValue(
          makeMembership({ id: "mem-target", userId: "user-target", role: "admin" }),
        ),
      lockActiveAdmins: vi.fn().mockResolvedValue([{ id: "mem-actor" }, { id: "mem-target" }]),
      softLeave: vi.fn().mockResolvedValue(undefined),
    };
    const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({});
    });
    const result = await removeMember(
      {
        organizationId: "org-1",
        membershipId: "mem-target",
        actor: { userId: "user-actor", role: "admin", membershipId: "mem-actor" },
        organization: { publicToken: "TKN", displayName: "Org" },
      },
      { repo, transaction: txFn },
    );
    expect(result.ok).toBe(true);
    expect(repo.softLeave).toHaveBeenCalledWith("mem-target", expect.anything());
  });

  it("wrong-org: actor from different org is rejected", async () => {
    // The action layer gates with requireCapability(cap, orgId) SCOPED to the org.
    // At the use-case level, the actor is already resolved; we test that the
    // findActiveMembership (using organizationId) returns null when the membership
    // doesn't belong to that org.
    const repo = {
      ...baseRepo(),
      // Simulates DB returning null because (membershipId, orgId) pair doesn't match
      findActiveMembership: vi.fn().mockResolvedValue(null),
    };
    const result = await removeMember(
      {
        organizationId: "org-WRONG",
        membershipId: "mem-target",
        actor: { userId: "user-actor", role: "admin", membershipId: "mem-actor" },
        organization: { publicToken: "TKN-WRONG", displayName: "Wrong Org" },
      },
      { repo, transaction: vi.fn() },
    );
    expect(result).toEqual({ ok: false, error: "Membresía no encontrada o ya inactiva." });
  });
});

// ---------------------------------------------------------------------------
// change-member-role
// ---------------------------------------------------------------------------

describe("changeOrganizationMemberRole", () => {
  const baseRepo = () => ({
    findActiveMembership: vi.fn(),
    lockActiveAdmins: vi.fn(),
    setRole: vi.fn().mockResolvedValue(undefined),
    insertAuditLog: vi.fn().mockResolvedValue(undefined),
  });

  it("returns error for invalid new role", async () => {
    const result = await changeOrganizationMemberRole(
      {
        organizationId: "org-1",
        membershipId: "mem-target",
        newRole: "superadmin",
        actor: { userId: "user-actor", role: "admin", membershipId: "mem-actor" },
        organization: { publicToken: "TKN" },
      },
      { repo: baseRepo(), transaction: vi.fn() },
    );
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/Rol inválido/);
  });

  it("returns error when new role outranks actor", async () => {
    const result = await changeOrganizationMemberRole(
      {
        organizationId: "org-1",
        membershipId: "mem-target",
        newRole: "admin",
        actor: { userId: "user-actor", role: "coordinator", membershipId: "mem-actor" },
        organization: { publicToken: "TKN" },
      },
      { repo: baseRepo(), transaction: vi.fn() },
    );
    expect(result).toEqual({ ok: false, error: "No podés asignar un rol mayor al tuyo." });
  });

  it("returns error when target not found", async () => {
    const repo = { ...baseRepo(), findActiveMembership: vi.fn().mockResolvedValue(null) };
    const result = await changeOrganizationMemberRole(
      {
        organizationId: "org-1",
        membershipId: "mem-target",
        newRole: "member",
        actor: { userId: "user-actor", role: "admin", membershipId: "mem-actor" },
        organization: { publicToken: "TKN" },
      },
      { repo, transaction: vi.fn() },
    );
    expect(result).toEqual({ ok: false, error: "Membresía no encontrada o ya inactiva." });
  });

  it("returns self-error when changing own role", async () => {
    const repo = {
      ...baseRepo(),
      findActiveMembership: vi
        .fn()
        .mockResolvedValue(
          makeMembership({ id: "mem-target", userId: "user-actor", role: "member" }),
        ),
    };
    const result = await changeOrganizationMemberRole(
      {
        organizationId: "org-1",
        membershipId: "mem-target",
        newRole: "coordinator",
        actor: { userId: "user-actor", role: "admin", membershipId: "mem-actor" },
        organization: { publicToken: "TKN" },
      },
      { repo, transaction: vi.fn() },
    );
    expect(result).toEqual({ ok: false, error: "No podés cambiar tu propio rol." });
  });

  it("returns rank error when target outranks actor", async () => {
    const repo = {
      ...baseRepo(),
      findActiveMembership: vi
        .fn()
        .mockResolvedValue(
          makeMembership({ id: "mem-target", userId: "user-target", role: "admin" }),
        ),
      // 2 admins so last-admin doesn't block; rank check will fail
      lockActiveAdmins: vi.fn().mockResolvedValue([{ id: "mem-actor" }, { id: "mem-target" }]),
    };
    const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({});
    });
    const result = await changeOrganizationMemberRole(
      {
        organizationId: "org-1",
        membershipId: "mem-target",
        // coordinator (rank 4) can't manage admin (rank 5)
        newRole: "member",
        actor: { userId: "user-actor", role: "coordinator", membershipId: "mem-actor" },
        organization: { publicToken: "TKN" },
      },
      { repo, transaction: txFn },
    );
    expect(result).toEqual({
      ok: false,
      error: "No podés gestionar a alguien con un rol mayor al tuyo.",
    });
  });

  it("LAST-ADMIN: blocks demotion of last admin", async () => {
    const repo = {
      ...baseRepo(),
      findActiveMembership: vi
        .fn()
        .mockResolvedValue(
          makeMembership({ id: "mem-target", userId: "user-target", role: "admin" }),
        ),
      lockActiveAdmins: vi.fn().mockResolvedValue([{ id: "mem-target" }]),
      setRole: vi.fn(),
    };
    const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({});
    });
    const result = await changeOrganizationMemberRole(
      {
        organizationId: "org-1",
        membershipId: "mem-target",
        newRole: "member",
        actor: { userId: "user-actor", role: "admin", membershipId: "mem-actor" },
        organization: { publicToken: "TKN" },
      },
      { repo, transaction: txFn },
    );
    expect(result).toEqual({
      ok: false,
      error: "La organización debe tener al menos un administrador.",
    });
    expect(repo.setRole).not.toHaveBeenCalled();
  });

  it("changes role successfully when valid", async () => {
    const repo = {
      ...baseRepo(),
      findActiveMembership: vi
        .fn()
        .mockResolvedValue(
          makeMembership({ id: "mem-target", userId: "user-target", role: "member" }),
        ),
      setRole: vi.fn().mockResolvedValue(undefined),
    };
    const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({});
    });
    const result = await changeOrganizationMemberRole(
      {
        organizationId: "org-1",
        membershipId: "mem-target",
        newRole: "coordinator",
        actor: { userId: "user-actor", role: "admin", membershipId: "mem-actor" },
        organization: { publicToken: "TKN" },
      },
      { repo, transaction: txFn },
    );
    expect(result.ok).toBe(true);
    // Non-admin target path uses a tx for atomicity with audit write.
    expect(repo.setRole).toHaveBeenCalledWith("mem-target", "coordinator", {});
  });
});

// ---------------------------------------------------------------------------
// set-member-event-write
// ---------------------------------------------------------------------------

describe("setMemberEventWrite", () => {
  const baseRepo = () => ({
    findActiveMembership: vi.fn(),
    setEventWrite: vi.fn().mockResolvedValue(undefined),
    insertAuditLog: vi.fn().mockResolvedValue(undefined),
    insertGrant: vi.fn().mockResolvedValue({ id: "grant-1" }),
    findApprovedGrant: vi.fn().mockResolvedValue(null),
    setGrantStatus: vi.fn().mockResolvedValue(undefined),
  });

  // Transparent transaction mock: immediately invokes the callback with a fake tx.
  const makeTx = () =>
    vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));

  it("returns error when target not found", async () => {
    const repo = { ...baseRepo(), findActiveMembership: vi.fn().mockResolvedValue(null) };
    const result = await setMemberEventWrite(
      {
        organizationId: "org-1",
        membershipId: "mem-target",
        canWrite: true,
        actor: { userId: "user-actor", role: "admin", membershipId: "mem-actor" },
        organization: { publicToken: "TKN" },
      },
      { repo, transaction: makeTx() },
    );
    expect(result).toEqual({ ok: false, error: "Membresía no encontrada o ya inactiva." });
  });

  it("returns self-error when actor modifies own event-write", async () => {
    const repo = {
      ...baseRepo(),
      findActiveMembership: vi
        .fn()
        .mockResolvedValue(
          makeMembership({ id: "mem-target", userId: "user-actor", role: "member" }),
        ),
    };
    const result = await setMemberEventWrite(
      {
        organizationId: "org-1",
        membershipId: "mem-target",
        canWrite: true,
        actor: { userId: "user-actor", role: "admin", membershipId: "mem-actor" },
        organization: { publicToken: "TKN" },
      },
      { repo, transaction: makeTx() },
    );
    expect(result).toEqual({
      ok: false,
      error: "No podés modificar tu propio permiso de escritura por esta vía.",
    });
  });

  it("returns rank error when target outranks actor", async () => {
    const repo = {
      ...baseRepo(),
      findActiveMembership: vi
        .fn()
        .mockResolvedValue(
          makeMembership({ id: "mem-target", userId: "user-target", role: "admin" }),
        ),
    };
    const result = await setMemberEventWrite(
      {
        organizationId: "org-1",
        membershipId: "mem-target",
        canWrite: false,
        actor: { userId: "user-actor", role: "coordinator", membershipId: "mem-actor" },
        organization: { publicToken: "TKN" },
      },
      { repo, transaction: makeTx() },
    );
    expect(result).toEqual({
      ok: false,
      error: "No podés gestionar a alguien con un rol mayor al tuyo.",
    });
  });

  it("updates event-write and writes audit_log in one tx", async () => {
    const repo = {
      ...baseRepo(),
      findActiveMembership: vi.fn().mockResolvedValue(
        makeMembership({
          id: "mem-target",
          userId: "user-target",
          role: "member",
          canWritePetEvents: false,
        }),
      ),
    };
    const transaction = makeTx();
    const result = await setMemberEventWrite(
      {
        organizationId: "org-1",
        membershipId: "mem-target",
        canWrite: true,
        actor: { userId: "user-actor", role: "admin", membershipId: "mem-actor" },
        organization: { publicToken: "TKN" },
      },
      { repo, transaction },
    );
    expect(result.ok).toBe(true);
    // Both writes must happen inside the same transaction callback.
    expect(transaction).toHaveBeenCalledOnce();
    expect(repo.setEventWrite).toHaveBeenCalledWith("mem-target", true, expect.anything());
    expect(repo.insertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "org_member_event_write_changed",
        actorUserId: "user-actor",
        targetUserId: "user-target",
        targetOrganizationId: "org-1",
        payload: expect.objectContaining({
          can_write_pet_events_before: false,
          can_write_pet_events_after: true,
        }),
      }),
      expect.anything(),
    );
  });

  it("grants event.write capability with a single complete insertGrant when canWrite=true and no existing grant", async () => {
    const repo = {
      ...baseRepo(),
      findActiveMembership: vi
        .fn()
        .mockResolvedValue(
          makeMembership({ id: "mem-target", userId: "user-target", role: "member" }),
        ),
      // No existing approved grant — should proceed to insert.
      findApprovedGrant: vi.fn().mockResolvedValue(null),
      insertGrant: vi.fn().mockResolvedValue({ id: "grant-new" }),
    };
    const result = await setMemberEventWrite(
      {
        organizationId: "org-1",
        membershipId: "mem-target",
        canWrite: true,
        actor: { userId: "user-actor", role: "admin", membershipId: "mem-actor" },
        organization: { publicToken: "TKN" },
      },
      { repo, transaction: makeTx() },
    );
    expect(result.ok).toBe(true);
    expect(repo.insertGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        membershipId: "mem-target",
        organizationId: "org-1",
        capability: "event.write",
        status: "approved",
        decidedByUserId: "user-actor",
        decisionReason: "toggle",
      }),
      expect.anything(),
    );
    // updateGrant must NOT be called — grant is complete on insert.
    expect(repo).not.toHaveProperty("updateGrant");
  });

  it("is idempotent: skips insertGrant when an approved grant already exists (canWrite=true)", async () => {
    const existingGrant = { id: "grant-existing" };
    const repo = {
      ...baseRepo(),
      findActiveMembership: vi
        .fn()
        .mockResolvedValue(
          makeMembership({ id: "mem-target", userId: "user-target", role: "member" }),
        ),
      findApprovedGrant: vi.fn().mockResolvedValue(existingGrant),
      insertGrant: vi.fn(),
    };
    const result = await setMemberEventWrite(
      {
        organizationId: "org-1",
        membershipId: "mem-target",
        canWrite: true,
        actor: { userId: "user-actor", role: "admin", membershipId: "mem-actor" },
        organization: { publicToken: "TKN" },
      },
      { repo, transaction: makeTx() },
    );
    expect(result.ok).toBe(true);
    // Already approved — no new grant row.
    expect(repo.insertGrant).not.toHaveBeenCalled();
  });

  it("revokes event.write capability when canWrite=false and grant exists — status-only, provenance in audit payload (B1)", async () => {
    const existingGrant = {
      id: "grant-existing",
      decidedByUserId: "original-approver",
      decidedAt: new Date("2026-07-01T00:00:00Z"),
    };
    const repo = {
      ...baseRepo(),
      findActiveMembership: vi
        .fn()
        .mockResolvedValue(
          makeMembership({ id: "mem-target", userId: "user-target", role: "member" }),
        ),
      findApprovedGrant: vi.fn().mockResolvedValue(existingGrant),
    };
    const result = await setMemberEventWrite(
      {
        organizationId: "org-1",
        membershipId: "mem-target",
        canWrite: false,
        actor: { userId: "user-actor", role: "admin", membershipId: "mem-actor" },
        organization: { publicToken: "TKN" },
      },
      { repo, transaction: makeTx() },
    );
    expect(result.ok).toBe(true);
    expect(repo.findApprovedGrant).toHaveBeenCalledWith(
      "mem-target",
      "event.write",
      expect.anything(),
    );
    // B1 — the grant row keeps who originally granted it: status-only update…
    expect(repo.setGrantStatus).toHaveBeenCalledWith(
      "grant-existing",
      "revoked",
      expect.anything(),
    );
    // …and the audit payload carries the revocation + original provenance.
    expect(repo.insertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "org_member_event_write_changed",
        payload: expect.objectContaining({
          grant_id: "grant-existing",
          original_decided_by_user_id: "original-approver",
          original_decided_at: "2026-07-01T00:00:00.000Z",
        }),
      }),
      expect.anything(),
    );
    expect(repo.insertGrant).not.toHaveBeenCalled();
  });

  it("skips the revoke when canWrite=false and no active grant exists", async () => {
    const repo = {
      ...baseRepo(),
      findActiveMembership: vi
        .fn()
        .mockResolvedValue(
          makeMembership({ id: "mem-target", userId: "user-target", role: "member" }),
        ),
      findApprovedGrant: vi.fn().mockResolvedValue(null),
    };
    const result = await setMemberEventWrite(
      {
        organizationId: "org-1",
        membershipId: "mem-target",
        canWrite: false,
        actor: { userId: "user-actor", role: "admin", membershipId: "mem-actor" },
        organization: { publicToken: "TKN" },
      },
      { repo, transaction: makeTx() },
    );
    expect(result.ok).toBe(true);
    expect(repo.findApprovedGrant).toHaveBeenCalled();
    // No grant to revoke — the status update must NOT be called.
    expect(repo.setGrantStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// leave-organization (self-leave)
// ---------------------------------------------------------------------------

describe("leaveOrganization", () => {
  const baseRepo = () => ({
    findOwnActiveMembership: vi.fn(),
    lockActiveAdmins: vi.fn(),
    softLeave: vi.fn().mockResolvedValue(undefined),
    insertAuditLog: vi.fn().mockResolvedValue(undefined),
  });

  it("returns error when user is not active member", async () => {
    const repo = { ...baseRepo(), findOwnActiveMembership: vi.fn().mockResolvedValue(null) };
    const result = await leaveOrganization(
      {
        userId: "user-1",
        organizationId: "org-1",
        organization: { publicToken: "TKN" },
      },
      { repo, transaction: vi.fn() },
    );
    expect(result).toEqual({ ok: false, error: "No sos miembro activo de esta organización." });
  });

  it("LAST-ADMIN: blocks admin self-leave when only 1 admin", async () => {
    const repo = {
      ...baseRepo(),
      findOwnActiveMembership: vi
        .fn()
        .mockResolvedValue(makeMembership({ id: "mem-1", userId: "user-1", role: "admin" })),
      lockActiveAdmins: vi.fn().mockResolvedValue([{ id: "mem-1" }]),
      softLeave: vi.fn(),
    };
    const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({});
    });
    const result = await leaveOrganization(
      {
        userId: "user-1",
        organizationId: "org-1",
        organization: { publicToken: "TKN" },
      },
      { repo, transaction: txFn },
    );
    expect(result).toEqual({
      ok: false,
      error: "No podés salir porque sos el único administrador. Asigná otro administrador primero.",
    });
    expect(repo.softLeave).not.toHaveBeenCalled();
  });

  it("allows admin self-leave when multiple admins exist", async () => {
    const repo = {
      ...baseRepo(),
      findOwnActiveMembership: vi
        .fn()
        .mockResolvedValue(makeMembership({ id: "mem-1", userId: "user-1", role: "admin" })),
      lockActiveAdmins: vi.fn().mockResolvedValue([{ id: "mem-1" }, { id: "mem-2" }]),
      softLeave: vi.fn().mockResolvedValue(undefined),
    };
    const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({});
    });
    const result = await leaveOrganization(
      {
        userId: "user-1",
        organizationId: "org-1",
        organization: { publicToken: "TKN" },
      },
      { repo, transaction: txFn },
    );
    expect(result.ok).toBe(true);
    expect(repo.softLeave).toHaveBeenCalledWith("mem-1", expect.anything());
  });

  it("LAST-ADMIN multi-org: the same user is blocked per-org where sole admin, allowed where another admin exists", async () => {
    // QA C1 shape: one user is the SOLE admin of org-a/org-b/org-c and one of
    // TWO admins in org-d. The block must be evaluated per organizationId —
    // this pins that leaveOrganization passes the org being left to
    // lockActiveAdmins instead of leaking a global admin count.
    const adminsByOrg: Record<string, { id: string }[]> = {
      "org-a": [{ id: "mem-a" }],
      "org-b": [{ id: "mem-b" }],
      "org-c": [{ id: "mem-c" }],
      "org-d": [{ id: "mem-d" }, { id: "mem-d2" }],
    };
    const membershipByOrg: Record<string, string> = {
      "org-a": "mem-a",
      "org-b": "mem-b",
      "org-c": "mem-c",
      "org-d": "mem-d",
    };
    const repo = {
      ...baseRepo(),
      findOwnActiveMembership: vi
        .fn()
        .mockImplementation(async (_userId: string, organizationId: string) =>
          makeMembership({
            id: membershipByOrg[organizationId],
            userId: "user-1",
            role: "admin",
          }),
        ),
      lockActiveAdmins: vi
        .fn()
        .mockImplementation(async (orgId: string) => adminsByOrg[orgId] ?? []),
      softLeave: vi.fn().mockResolvedValue(undefined),
    };
    const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({});
    });

    for (const orgId of ["org-a", "org-b", "org-c"]) {
      const result = await leaveOrganization(
        { userId: "user-1", organizationId: orgId, organization: { publicToken: "TKN" } },
        { repo, transaction: txFn },
      );
      expect(result).toEqual({
        ok: false,
        error:
          "No podés salir porque sos el único administrador. Asigná otro administrador primero.",
      });
      expect(repo.lockActiveAdmins).toHaveBeenCalledWith(orgId, expect.anything());
    }
    expect(repo.softLeave).not.toHaveBeenCalled();

    const result = await leaveOrganization(
      { userId: "user-1", organizationId: "org-d", organization: { publicToken: "TKN" } },
      { repo, transaction: txFn },
    );
    expect(result.ok).toBe(true);
    expect(repo.lockActiveAdmins).toHaveBeenCalledWith("org-d", expect.anything());
    expect(repo.softLeave).toHaveBeenCalledWith("mem-d", expect.anything());
  });

  it("allows non-admin self-leave (wrapped in tx for atomicity with audit)", async () => {
    const repo = {
      ...baseRepo(),
      findOwnActiveMembership: vi
        .fn()
        .mockResolvedValue(makeMembership({ id: "mem-1", userId: "user-1", role: "member" })),
      softLeave: vi.fn().mockResolvedValue(undefined),
    };
    const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({});
    });
    const result = await leaveOrganization(
      {
        userId: "user-1",
        organizationId: "org-1",
        organization: { publicToken: "TKN" },
      },
      { repo, transaction: txFn },
    );
    expect(result.ok).toBe(true);
    // Non-admin path uses tx for atomicity with audit write.
    expect(repo.softLeave).toHaveBeenCalledWith("mem-1", {});
  });
});
