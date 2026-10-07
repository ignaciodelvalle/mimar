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
import { CREDENTIAL_GATED_GRANT_REFUSAL_COPY } from "@/src/modules/organizations/domain/capabilities";

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

/** Runs the use case's transaction inline, handing it a recognisable tx. */
const TX = { tx: true };
const runTx = <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb(TX);

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
    publicDirectoryOptIn: false,
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
        repo: {
          findMembershipByUserAndOrgToken: vi.fn(),
          updateOrgProfile: vi.fn(),
          insertAuditLog: vi.fn(),
        },
        transaction: runTx,
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
        repo: {
          findMembershipByUserAndOrgToken: vi.fn(),
          updateOrgProfile: vi.fn(),
          insertAuditLog: vi.fn(),
        },
        transaction: runTx,
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
        repo: {
          findMembershipByUserAndOrgToken: vi.fn(),
          updateOrgProfile: vi.fn(),
          insertAuditLog: vi.fn(),
        },
        transaction: runTx,
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
        repo: {
          findMembershipByUserAndOrgToken: vi.fn(),
          updateOrgProfile: vi.fn(),
          insertAuditLog: vi.fn(),
        },
        transaction: runTx,
      },
    );
    expect(result).toEqual({ ok: false, error: "El correo electrónico es inválido." });
  });

  it("returns error when membership not found", async () => {
    const repo = {
      findMembershipByUserAndOrgToken: vi.fn().mockResolvedValue(null),
      updateOrgProfile: vi.fn(),
      insertAuditLog: vi.fn().mockResolvedValue(undefined),
    };
    const result = await updateOrganization(
      {
        userId: "user-1",
        orgToken: "TKN",
        fields: { displayName: "Valid Name" },
      },
      { repo, transaction: runTx },
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
      insertAuditLog: vi.fn().mockResolvedValue(undefined),
    };
    const result = await updateOrganization(
      {
        userId: "user-1",
        orgToken: "TKN",
        fields: { displayName: "Valid Name" },
      },
      { repo, transaction: runTx },
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
      insertAuditLog: vi.fn().mockResolvedValue(undefined),
    };
    const result = await updateOrganization(
      {
        userId: "user-1",
        orgToken: "TKN",
        fields: { displayName: "New Name" },
      },
      { repo, transaction: runTx },
    );
    expect(result.ok).toBe(true);
    expect(repo.updateOrgProfile).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// update-organization — the public directory listing (migration 0283)
// ---------------------------------------------------------------------------

describe("updateOrganization — publicDirectoryOptIn", () => {
  function repoFor(orgType: string, role: OrganizationMembership["role"]) {
    return {
      findMembershipByUserAndOrgToken: vi.fn().mockResolvedValue({
        org: { ...makeOrg(), orgType, publicToken: "TKN" },
        membership: makeMembership({ role }),
      }),
      updateOrgProfile: vi.fn().mockResolvedValue(undefined),
      insertAuditLog: vi.fn().mockResolvedValue(undefined),
    };
  }

  const optIn = (value: boolean) => ({
    userId: "user-1",
    orgToken: "TKN",
    fields: { displayName: "Veterinaria Sur", publicDirectoryOptIn: value },
  });

  it("refuses a non-admin member of the clinic, and writes nothing", async () => {
    for (const role of ["coordinator", "member", "vet_individual"] as const) {
      const repo = repoFor("clinic", role);
      const result = await updateOrganization(optIn(true), { repo, transaction: runTx });
      expect(result).toEqual({
        ok: false,
        error: "Solo los administradores de la organización pueden editar el perfil.",
      });
      expect(repo.updateOrgProfile).not.toHaveBeenCalled();
    }
  });

  it("refuses a caller with no membership, and writes nothing", async () => {
    const repo = {
      findMembershipByUserAndOrgToken: vi.fn().mockResolvedValue(null),
      updateOrgProfile: vi.fn(),
      insertAuditLog: vi.fn().mockResolvedValue(undefined),
    };
    const result = await updateOrganization(optIn(true), { repo, transaction: runTx });
    expect(result).toEqual({ ok: false, error: "No tenés acceso a esta organización." });
    expect(repo.updateOrgProfile).not.toHaveBeenCalled();
  });

  it("writes the opt-in for the admin of a clinic, both ways", async () => {
    for (const value of [true, false]) {
      const repo = repoFor("clinic", "admin");
      const result = await updateOrganization(optIn(value), { repo, transaction: runTx });
      expect(result.ok).toBe(true);
      expect(repo.updateOrgProfile).toHaveBeenCalledWith(
        "org-1",
        expect.objectContaining({ publicDirectoryOptIn: value }),
        TX,
      );
    }
  });

  it("refuses the setting for a shelter or a rescue network — they are listed on verification alone", async () => {
    for (const orgType of ["shelter", "rescue_network", "sanitary_authority", "other"]) {
      const repo = repoFor(orgType, "admin");
      const result = await updateOrganization(optIn(false), { repo, transaction: runTx });
      expect(result).toEqual({
        ok: false,
        error: "Solo las veterinarias eligen si aparecen en el directorio público.",
      });
      expect(repo.updateOrgProfile).not.toHaveBeenCalled();
    }
  });

  it("leaves the column alone when the form did not carry the setting", async () => {
    const repo = repoFor("shelter", "admin");
    const result = await updateOrganization(
      { userId: "user-1", orgToken: "TKN", fields: { displayName: "Refugio Norte" } },
      { repo, transaction: runTx },
    );
    expect(result.ok).toBe(true);
    expect(repo.updateOrgProfile.mock.calls[0]?.[1]).not.toHaveProperty("publicDirectoryOptIn");
  });

  // Migration 0283: switching the listing publishes or withdraws the clinic's
  // name and contact, so it is audited — who, when, before → after — in the
  // transaction that writes the column.
  it("audits a switch of the listing, in the column's transaction, both ways", async () => {
    for (const [before, after] of [
      [false, true],
      [true, false],
    ] as const) {
      const repo = repoFor("clinic", "admin");
      repo.findMembershipByUserAndOrgToken.mockResolvedValue({
        org: { ...makeOrg(), orgType: "clinic", publicToken: "TKN", publicDirectoryOptIn: before },
        membership: makeMembership({ role: "admin" }),
      });
      const result = await updateOrganization(optIn(after), { repo, transaction: runTx });
      expect(result.ok).toBe(true);
      expect(repo.updateOrgProfile.mock.calls[0]?.[2]).toBe(TX);
      expect(repo.insertAuditLog).toHaveBeenCalledOnce();
      expect(repo.insertAuditLog).toHaveBeenCalledWith(
        {
          actorUserId: "user-1",
          action: "org_public_directory_opt_in_changed",
          targetOrganizationId: "org-1",
          payload: {
            org_id: "org-1",
            before_values: { public_directory_opt_in: before },
            after_values: { public_directory_opt_in: after },
          },
        },
        TX,
      );
    }
  });

  it("writes no audit row when the clinic re-saves the same value", async () => {
    const repo = repoFor("clinic", "admin"); // makeOrg(): publicDirectoryOptIn false
    const result = await updateOrganization(optIn(false), { repo, transaction: runTx });
    expect(result.ok).toBe(true);
    expect(repo.updateOrgProfile).toHaveBeenCalledOnce();
    expect(repo.insertAuditLog).not.toHaveBeenCalled();
  });

  it("writes no audit row when the form did not carry the setting", async () => {
    const repo = repoFor("shelter", "admin");
    await updateOrganization(
      { userId: "user-1", orgToken: "TKN", fields: { displayName: "Refugio Norte" } },
      { repo, transaction: runTx },
    );
    expect(repo.insertAuditLog).not.toHaveBeenCalled();
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
    // The legacy-column mirror reads the derived state (set-member-event-write.ts).
    readEventWriteState: vi.fn().mockResolvedValue({
      role: "member",
      approvedCapabilities: ["event.write"],
      vetCredentialValid: false,
      active: true,
    }),
    setEventWrite: vi.fn().mockResolvedValue(undefined),
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
    // The legacy-column mirror reads the derived state (set-member-event-write.ts).
    readEventWriteState: vi.fn().mockResolvedValue({
      role: "member",
      approvedCapabilities: ["event.write"],
      vetCredentialValid: false,
      active: true,
    }),
    setEventWrite: vi.fn().mockResolvedValue(undefined),
  });

  it("returns error for invalid new role", async () => {
    const result = await changeOrganizationMemberRole(
      {
        organizationId: "org-1",
        membershipId: "mem-target",
        newRole: "superadmin",
        actor: { userId: "user-actor", role: "admin", membershipId: "mem-actor" },
        organization: { publicToken: "TKN", orgType: "shelter" },
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
        organization: { publicToken: "TKN", orgType: "shelter" },
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
        organization: { publicToken: "TKN", orgType: "shelter" },
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
        organization: { publicToken: "TKN", orgType: "shelter" },
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
        organization: { publicToken: "TKN", orgType: "shelter" },
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
        organization: { publicToken: "TKN", orgType: "shelter" },
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
        organization: { publicToken: "TKN", orgType: "shelter" },
      },
      { repo, transaction: txFn },
    );
    expect(result.ok).toBe(true);
    // Non-admin target path uses a tx for atomicity with audit write.
    expect(repo.setRole).toHaveBeenCalledWith("mem-target", "coordinator", {});
  });

  // portal-vet-p0 D13 — coordinator and volunteer are shelter roles.
  describe("org-type fit", () => {
    const txFn = () =>
      vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
        await cb({});
      });
    const repoWithTarget = (role: "member" | "volunteer" | "coordinator") => ({
      ...baseRepo(),
      findActiveMembership: vi
        .fn()
        .mockResolvedValue(makeMembership({ id: "mem-target", userId: "user-target", role })),
      setRole: vi.fn().mockResolvedValue(undefined),
    });
    const change = async (newRole: string, orgType: string, repo = repoWithTarget("member")) => {
      const result = await changeOrganizationMemberRole(
        {
          organizationId: "org-1",
          membershipId: "mem-target",
          newRole,
          actor: { userId: "user-actor", role: "admin", membershipId: "mem-actor" },
          organization: { publicToken: "TKN", orgType },
        },
        { repo, transaction: txFn() },
      );
      return { result, repo };
    };

    for (const newRole of ["coordinator", "volunteer"]) {
      for (const orgType of ["clinic", "sanitary_authority", "other"]) {
        it(`refuses assigning ${newRole} in a ${orgType}, and writes nothing`, async () => {
          const { result, repo } = await change(newRole, orgType);
          expect(result).toEqual({
            ok: false,
            error: "Ese rol es de refugios y redes de rescate. En esta organización no se usa.",
          });
          expect(repo.setRole).not.toHaveBeenCalled();
        });
      }
      for (const orgType of ["shelter", "rescue_network"]) {
        it(`still assigns ${newRole} in a ${orgType} (shelter regression)`, async () => {
          const { result, repo } = await change(newRole, orgType);
          expect(result.ok).toBe(true);
          expect(repo.setRole).toHaveBeenCalledWith("mem-target", newRole, {});
        });
      }
    }

    it("lets a clinic move a LEGACY volunteer to a role that fits", async () => {
      const { result, repo } = await change("member", "clinic", repoWithTarget("volunteer"));
      expect(result.ok).toBe(true);
      expect(repo.setRole).toHaveBeenCalledWith("mem-target", "member", {});
    });
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
    // The legacy-column mirror reads the derived state (set-member-event-write.ts).
    readEventWriteState: vi.fn().mockResolvedValue({
      role: "member",
      approvedCapabilities: ["event.write"],
      vetCredentialValid: false,
      active: true,
    }),
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

  // portal-vet-p0 D10: a vet_individual's event.write comes from their own
  // matrícula, so the toggle may not write a grant row for them.
  it("refuses to turn event.write ON for a vet_individual and writes nothing", async () => {
    const repo = {
      ...baseRepo(),
      findActiveMembership: vi
        .fn()
        .mockResolvedValue(
          makeMembership({ id: "mem-target", userId: "user-target", role: "vet_individual" }),
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
    expect(result).toEqual({
      ok: false,
      error: CREDENTIAL_GATED_GRANT_REFUSAL_COPY.derives_from_matricula,
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(repo.insertGrant).not.toHaveBeenCalled();
    expect(repo.insertAuditLog).not.toHaveBeenCalled();
  });

  it("still lets an admin turn event.write OFF for a vet_individual (revokes a legacy row)", async () => {
    const repo = {
      ...baseRepo(),
      findActiveMembership: vi
        .fn()
        .mockResolvedValue(
          makeMembership({ id: "mem-target", userId: "user-target", role: "vet_individual" }),
        ),
      findApprovedGrant: vi.fn().mockResolvedValue({
        id: "grant-legacy",
        decidedByUserId: "user-old-admin",
        decidedAt: new Date("2026-01-01T00:00:00Z"),
      }),
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
    expect(repo.setGrantStatus).toHaveBeenCalledWith("grant-legacy", "revoked", expect.anything());
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
    // The legacy-column mirror reads the derived state (set-member-event-write.ts).
    readEventWriteState: vi.fn().mockResolvedValue({
      role: "member",
      approvedCapabilities: ["event.write"],
      vetCredentialValid: false,
      active: true,
    }),
    setEventWrite: vi.fn().mockResolvedValue(undefined),
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
