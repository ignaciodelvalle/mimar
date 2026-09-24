// Unit tests for organizations invite use-cases (WU-3, task 3.2):
//   - invite-member
//   - revoke-invitation
//   - accept-invitation
//
// Strategy: mock OrgRepository methods; test pure business logic only.
// Auth is NOT in use-cases — handled at the action edge.
//
// TDD: tests written before use-case files exist (RED phase).

import { describe, expect, it, vi } from "vitest";

import type { OrganizationInvitation } from "@/db";
import { acceptInvitation } from "@/src/modules/organizations/application/accept-invitation";
import { inviteMember } from "@/src/modules/organizations/application/invite-member";
import { revokeInvitation } from "@/src/modules/organizations/application/revoke-invitation";

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

function makeInvite(overrides: Partial<OrganizationInvitation> = {}): OrganizationInvitation {
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // +14 days
  return {
    id: "inv-1",
    organizationId: "org-1",
    email: "test@example.com",
    invitedRole: "member",
    canWritePetEvents: false,
    invitationToken: "INV-TOKEN-1",
    invitedByUserId: "user-inviter",
    acceptedAt: null,
    acceptedByUserId: null,
    revokedAt: null,
    expiresAt,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeOrg() {
  return {
    id: "org-1",
    publicToken: "ORG-TOKEN",
    displayName: "Test Org",
  };
}

// ---------------------------------------------------------------------------
// invite-member
// ---------------------------------------------------------------------------

describe("inviteMember", () => {
  const baseRepo = () => ({
    findActiveInvite: vi.fn().mockResolvedValue(null),
    setInviteRevoked: vi.fn().mockResolvedValue(undefined),
    insertInvite: vi.fn().mockResolvedValue(makeInvite()),
    adminRecipients: vi.fn().mockResolvedValue([{ userId: "admin-1" }]),
  });

  it("returns error for invalid role", async () => {
    const result = await inviteMember(
      {
        organizationId: "org-1",
        email: "user@test.com",
        invitedRole: "superuser",
        actor: { userId: "user-actor", role: "admin", membershipId: "mem-actor" },
        organization: makeOrg(),
        generateToken: vi.fn(),
      },
      { repo: baseRepo(), isUniqueViolation: vi.fn() },
    );
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/Rol inválido/);
  });

  it("returns error when invited role outranks actor", async () => {
    const result = await inviteMember(
      {
        organizationId: "org-1",
        email: "user@test.com",
        invitedRole: "admin",
        actor: { userId: "user-actor", role: "coordinator", membershipId: "mem-actor" },
        organization: makeOrg(),
        generateToken: vi.fn(),
      },
      { repo: baseRepo(), isUniqueViolation: vi.fn() },
    );
    expect(result).toEqual({
      ok: false,
      error: "No podés invitar a alguien con un rol mayor al tuyo.",
    });
  });

  it("returns error for invalid email (no @)", async () => {
    const result = await inviteMember(
      {
        organizationId: "org-1",
        email: "not-an-email",
        invitedRole: "member",
        actor: { userId: "user-actor", role: "admin", membershipId: "mem-actor" },
        organization: makeOrg(),
        generateToken: vi.fn(),
      },
      { repo: baseRepo(), isUniqueViolation: vi.fn() },
    );
    expect(result).toEqual({ ok: false, error: "Email inválido." });
  });

  it("blocks when active invite already exists for (org, email)", async () => {
    const repo = {
      ...baseRepo(),
      findActiveInvite: vi.fn().mockResolvedValue(makeInvite()), // active, not expired
    };
    const result = await inviteMember(
      {
        organizationId: "org-1",
        email: "test@example.com",
        invitedRole: "member",
        actor: { userId: "user-actor", role: "admin", membershipId: "mem-actor" },
        organization: makeOrg(),
        generateToken: vi.fn(),
      },
      { repo, isUniqueViolation: vi.fn() },
    );
    expect(result).toEqual({
      ok: false,
      error:
        "Ya existe una invitación activa para ese email en esta organización. Revocarla primero para re-invitar.",
    });
  });

  it("auto-revokes expired invite and proceeds", async () => {
    const expiredInvite = makeInvite({
      expiresAt: new Date(Date.now() - 1000), // expired
    });
    const repo = {
      ...baseRepo(),
      findActiveInvite: vi.fn().mockResolvedValue(expiredInvite),
      setInviteRevoked: vi.fn().mockResolvedValue(undefined),
      insertInvite: vi.fn().mockResolvedValue(makeInvite({ invitationToken: "NEW-TOKEN" })),
    };
    const result = await inviteMember(
      {
        organizationId: "org-1",
        email: "test@example.com",
        invitedRole: "member",
        actor: { userId: "user-actor", role: "admin", membershipId: "mem-actor" },
        organization: makeOrg(),
        generateToken: vi.fn().mockResolvedValue("NEW-TOKEN"),
      },
      { repo, isUniqueViolation: vi.fn() },
    );
    expect(repo.setInviteRevoked).toHaveBeenCalledWith("inv-1");
    expect(result.ok).toBe(true);
  });

  it("inserts invite and returns inviteUrl on success", async () => {
    const repo = { ...baseRepo() };
    const result = await inviteMember(
      {
        organizationId: "org-1",
        email: "newuser@example.com",
        invitedRole: "member",
        actor: { userId: "user-actor", role: "admin", membershipId: "mem-actor" },
        organization: makeOrg(),
        generateToken: vi.fn().mockResolvedValue("INV-TOKEN-1"),
        appBase: "https://example.com",
      },
      { repo, isUniqueViolation: vi.fn() },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.inviteUrl).toContain("INV-TOKEN-1");
    }
  });

  it("wrong-org: actor scoped to wrong org — action gate prevents this; use-case passes orgId from actor", async () => {
    // The action layer calls requireCapability("member.invite", organizationId)
    // with the CORRECT orgId from the form. Use-case just uses whatever orgId
    // is passed in. This test verifies the use-case uses organizationId correctly.
    const repo = { ...baseRepo() };
    await inviteMember(
      {
        organizationId: "org-CORRECT",
        email: "user@test.com",
        invitedRole: "member",
        actor: { userId: "user-actor", role: "admin", membershipId: "mem-actor" },
        organization: { ...makeOrg(), id: "org-CORRECT" },
        generateToken: vi.fn().mockResolvedValue("T1"),
      },
      { repo, isUniqueViolation: vi.fn() },
    );
    expect(repo.findActiveInvite).toHaveBeenCalledWith("org-CORRECT", "user@test.com");
  });
});

// ---------------------------------------------------------------------------
// revoke-invitation
// ---------------------------------------------------------------------------

describe("revokeInvitation", () => {
  const baseRepo = () => ({
    findInviteByToken: vi.fn(),
    setInviteRevoked: vi.fn().mockResolvedValue(undefined),
  });

  it("returns error when invite not found", async () => {
    const repo = { ...baseRepo(), findInviteByToken: vi.fn().mockResolvedValue(null) };
    const result = await revokeInvitation(
      {
        organizationId: "org-1",
        invitationToken: "INV-TKN",
        organization: { publicToken: "ORG-TKN" },
      },
      { repo },
    );
    expect(result).toEqual({ ok: false, error: "Invitación no encontrada." });
  });

  it("is idempotent when invite already accepted", async () => {
    const repo = {
      ...baseRepo(),
      findInviteByToken: vi
        .fn()
        .mockResolvedValue(makeInvite({ acceptedAt: new Date(), organizationId: "org-1" })),
    };
    const result = await revokeInvitation(
      {
        organizationId: "org-1",
        invitationToken: "INV-TKN",
        organization: { publicToken: "ORG-TKN" },
      },
      { repo },
    );
    expect(result).toEqual({ ok: true, value: undefined, notifications: [] });
    expect(repo.setInviteRevoked).not.toHaveBeenCalled();
  });

  it("is idempotent when invite already revoked", async () => {
    const repo = {
      ...baseRepo(),
      findInviteByToken: vi
        .fn()
        .mockResolvedValue(makeInvite({ revokedAt: new Date(), organizationId: "org-1" })),
    };
    const result = await revokeInvitation(
      {
        organizationId: "org-1",
        invitationToken: "INV-TKN",
        organization: { publicToken: "ORG-TKN" },
      },
      { repo },
    );
    expect(result).toEqual({ ok: true, value: undefined, notifications: [] });
    expect(repo.setInviteRevoked).not.toHaveBeenCalled();
  });

  it("revokes open invite successfully", async () => {
    const repo = {
      ...baseRepo(),
      findInviteByToken: vi.fn().mockResolvedValue(makeInvite({ organizationId: "org-1" })),
    };
    const result = await revokeInvitation(
      {
        organizationId: "org-1",
        invitationToken: "INV-TKN",
        organization: { publicToken: "ORG-TKN" },
      },
      { repo },
    );
    expect(result).toEqual({ ok: true, value: undefined, notifications: [] });
    expect(repo.setInviteRevoked).toHaveBeenCalledWith("inv-1");
  });
});

// ---------------------------------------------------------------------------
// accept-invitation
// ---------------------------------------------------------------------------

describe("acceptInvitation", () => {
  const baseRepo = () => ({
    lockInviteByToken: vi.fn(),
    findOrgById: vi.fn(),
    findExistingActiveMembership: vi.fn().mockResolvedValue(null),
    markInviteAccepted: vi.fn().mockResolvedValue(undefined),
    insertMembership: vi.fn().mockResolvedValue("mem-new"),
    insertGrant: vi.fn().mockResolvedValue({ id: "grant-new" }),
    findAccepterDisplayName: vi.fn().mockResolvedValue("Test User"),
    insertAuditLog: vi.fn().mockResolvedValue(undefined),
  });

  it("returns error when invite not found (inside tx)", async () => {
    const repo = { ...baseRepo(), lockInviteByToken: vi.fn().mockResolvedValue(null) };
    const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({});
    });
    const result = await acceptInvitation(
      {
        invitationToken: "BAD-TOKEN",
        userId: "user-1",
        userEmail: "user@test.com",
      },
      { repo, transaction: txFn, isUniqueViolation: vi.fn().mockReturnValue(false) },
    );
    expect(result).toEqual({ ok: false, error: "Invitación no encontrada." });
  });

  it("returns error when invite already accepted", async () => {
    const repo = {
      ...baseRepo(),
      lockInviteByToken: vi.fn().mockResolvedValue(makeInvite({ acceptedAt: new Date() })),
    };
    const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({});
    });
    const result = await acceptInvitation(
      { invitationToken: "TKN", userId: "user-1", userEmail: "test@example.com" },
      { repo, transaction: txFn, isUniqueViolation: vi.fn().mockReturnValue(false) },
    );
    expect(result).toEqual({ ok: false, error: "Esta invitación ya fue aceptada." });
  });

  it("returns error when invite revoked", async () => {
    const repo = {
      ...baseRepo(),
      lockInviteByToken: vi.fn().mockResolvedValue(makeInvite({ revokedAt: new Date() })),
    };
    const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({});
    });
    const result = await acceptInvitation(
      { invitationToken: "TKN", userId: "user-1", userEmail: "test@example.com" },
      { repo, transaction: txFn, isUniqueViolation: vi.fn().mockReturnValue(false) },
    );
    expect(result).toEqual({ ok: false, error: "Esta invitación fue revocada." });
  });

  it("returns error when invite expired", async () => {
    const repo = {
      ...baseRepo(),
      lockInviteByToken: vi
        .fn()
        .mockResolvedValue(makeInvite({ expiresAt: new Date(Date.now() - 1000) })),
    };
    const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({});
    });
    const result = await acceptInvitation(
      { invitationToken: "TKN", userId: "user-1", userEmail: "test@example.com" },
      { repo, transaction: txFn, isUniqueViolation: vi.fn().mockReturnValue(false) },
    );
    expect(result).toEqual({ ok: false, error: "Esta invitación ya expiró." });
  });

  it("returns error when email mismatch (case-insensitive)", async () => {
    const repo = {
      ...baseRepo(),
      lockInviteByToken: vi.fn().mockResolvedValue(makeInvite({ email: "other@example.com" })),
    };
    const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({});
    });
    const result = await acceptInvitation(
      { invitationToken: "TKN", userId: "user-1", userEmail: "DIFFERENT@example.com" },
      { repo, transaction: txFn, isUniqueViolation: vi.fn().mockReturnValue(false) },
    );
    expect(result).toEqual({
      ok: false,
      error: "Esta invitación no es para tu cuenta. Iniciá sesión con el email al que fue enviada.",
    });
  });

  it("returns error when org not found inside tx", async () => {
    const repo = {
      ...baseRepo(),
      lockInviteByToken: vi.fn().mockResolvedValue(makeInvite()),
      findOrgById: vi.fn().mockResolvedValue(null),
    };
    const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({});
    });
    const result = await acceptInvitation(
      { invitationToken: "TKN", userId: "user-1", userEmail: "test@example.com" },
      { repo, transaction: txFn, isUniqueViolation: vi.fn().mockReturnValue(false) },
    );
    expect(result).toEqual({ ok: false, error: "Organización no encontrada." });
  });

  it("idempotent: marks invite accepted and returns orgToken when already member", async () => {
    const org = { id: "org-1", publicToken: "ORG-TKN", displayName: "Test Org" };
    const repo = {
      ...baseRepo(),
      lockInviteByToken: vi.fn().mockResolvedValue(makeInvite()),
      findOrgById: vi.fn().mockResolvedValue(org),
      findExistingActiveMembership: vi.fn().mockResolvedValue({ id: "mem-existing" }),
      markInviteAccepted: vi.fn().mockResolvedValue(undefined),
    };
    const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({});
    });
    const result = await acceptInvitation(
      { invitationToken: "TKN", userId: "user-1", userEmail: "test@example.com" },
      { repo, transaction: txFn, isUniqueViolation: vi.fn().mockReturnValue(false) },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.orgToken).toBe("ORG-TKN");
    }
    expect(repo.insertMembership).not.toHaveBeenCalled();
    expect(repo.markInviteAccepted).toHaveBeenCalled();
  });

  it("happy path: inserts membership, marks invite, queues notification", async () => {
    const org = { id: "org-1", publicToken: "ORG-TKN", displayName: "Test Org" };
    const repo = {
      ...baseRepo(),
      lockInviteByToken: vi.fn().mockResolvedValue(makeInvite({ invitedByUserId: "user-inviter" })),
      findOrgById: vi.fn().mockResolvedValue(org),
      findExistingActiveMembership: vi.fn().mockResolvedValue(null),
      insertMembership: vi.fn().mockResolvedValue("mem-new"),
      markInviteAccepted: vi.fn().mockResolvedValue(undefined),
      findAccepterDisplayName: vi.fn().mockResolvedValue("Alice"),
    };
    const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({});
    });
    const result = await acceptInvitation(
      { invitationToken: "TKN", userId: "user-accepter", userEmail: "test@example.com" },
      { repo, transaction: txFn, isUniqueViolation: vi.fn().mockReturnValue(false) },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.orgToken).toBe("ORG-TKN");
      expect(result.notifications).toHaveLength(1);
      expect(result.notifications[0].userId).toBe("user-inviter");
      expect(result.notifications[0].notificationType).toBe("org_invitation_accepted");
    }
    expect(repo.insertMembership).toHaveBeenCalled();
    expect(repo.markInviteAccepted).toHaveBeenCalled();
  });

  it("inserts approved event.write grant for coordinator role when canWritePetEvents=true", async () => {
    const org = { id: "org-1", publicToken: "ORG-TKN", displayName: "Test Org" };
    const repo = {
      ...baseRepo(),
      lockInviteByToken: vi.fn().mockResolvedValue(
        makeInvite({
          invitedRole: "coordinator",
          canWritePetEvents: true,
          invitedByUserId: "user-inviter",
        }),
      ),
      findOrgById: vi.fn().mockResolvedValue(org),
      insertMembership: vi.fn().mockResolvedValue("mem-coordinator"),
      insertGrant: vi.fn().mockResolvedValue({ id: "grant-coordinator" }),
    };
    const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({});
    });
    const result = await acceptInvitation(
      { invitationToken: "TKN", userId: "user-accepter", userEmail: "test@example.com" },
      { repo, transaction: txFn, isUniqueViolation: vi.fn().mockReturnValue(false) },
    );
    expect(result.ok).toBe(true);
    expect(repo.insertGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        membershipId: "mem-coordinator",
        capability: "event.write",
        status: "approved",
        decisionReason: "invitation",
      }),
      expect.anything(),
    );
  });

  it("does NOT insert event.write grant for admin role even when canWritePetEvents=true", async () => {
    const org = { id: "org-1", publicToken: "ORG-TKN", displayName: "Test Org" };
    const repo = {
      ...baseRepo(),
      lockInviteByToken: vi
        .fn()
        .mockResolvedValue(makeInvite({ invitedRole: "admin", canWritePetEvents: true })),
      findOrgById: vi.fn().mockResolvedValue(org),
      insertMembership: vi.fn().mockResolvedValue("mem-admin"),
      insertGrant: vi.fn(),
    };
    const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({});
    });
    const result = await acceptInvitation(
      { invitationToken: "TKN", userId: "user-accepter", userEmail: "test@example.com" },
      { repo, transaction: txFn, isUniqueViolation: vi.fn().mockReturnValue(false) },
    );
    expect(result.ok).toBe(true);
    // admin gets event.write implicitly — no grant row needed.
    expect(repo.insertGrant).not.toHaveBeenCalled();
  });

  it("does NOT insert event.write grant when canWritePetEvents=false", async () => {
    const org = { id: "org-1", publicToken: "ORG-TKN", displayName: "Test Org" };
    const repo = {
      ...baseRepo(),
      lockInviteByToken: vi
        .fn()
        .mockResolvedValue(makeInvite({ invitedRole: "member", canWritePetEvents: false })),
      findOrgById: vi.fn().mockResolvedValue(org),
      insertMembership: vi.fn().mockResolvedValue("mem-member"),
      insertGrant: vi.fn(),
    };
    const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({});
    });
    const result = await acceptInvitation(
      { invitationToken: "TKN", userId: "user-accepter", userEmail: "test@example.com" },
      { repo, transaction: txFn, isUniqueViolation: vi.fn().mockReturnValue(false) },
    );
    expect(result.ok).toBe(true);
    expect(repo.insertGrant).not.toHaveBeenCalled();
  });

  it("accept-invite idempotency: unique violation caught → 'Ya sos miembro activo'", async () => {
    const org = { id: "org-1", publicToken: "ORG-TKN", displayName: "Test Org" };
    const uniqueErr = new Error("unique violation") as unknown as { code: string };
    (uniqueErr as unknown as { code: string }).code = "23505";

    const repo = {
      ...baseRepo(),
      lockInviteByToken: vi.fn().mockResolvedValue(makeInvite()),
      findOrgById: vi.fn().mockResolvedValue(org),
      findExistingActiveMembership: vi.fn().mockResolvedValue(null),
      insertMembership: vi.fn().mockRejectedValue(uniqueErr),
      markInviteAccepted: vi.fn(),
    };
    const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({});
    });
    const result = await acceptInvitation(
      { invitationToken: "TKN", userId: "user-accepter", userEmail: "test@example.com" },
      {
        repo,
        transaction: txFn,
        isUniqueViolation: (err) => (err as { code?: string }).code === "23505",
      },
    );
    expect(result).toEqual({ ok: false, error: "Ya sos miembro activo de esta organización." });
  });
});
