// Unit tests for organizations contact + capability use-cases (WU-4, tasks 4.2 + 4.3):
//   - submitOrgContact
//   - requestCapability
//   - decideCapability
//   - grantCapability
//
// Strategy: mock repo; test pure business logic only.
// Auth is NOT in use-cases — done at the action edge.
//
// TDD: tests written before use-case files exist (RED phase).

import { describe, expect, it, vi } from "vitest";

import { decideCapability } from "@/src/modules/organizations/application/decide-capability";
import { grantCapability } from "@/src/modules/organizations/application/grant-capability";
import { requestCapability } from "@/src/modules/organizations/application/request-capability";
import { submitOrgContact } from "@/src/modules/organizations/application/submit-org-contact";

// ---------------------------------------------------------------------------
// submitOrgContact
// ---------------------------------------------------------------------------

describe("submitOrgContact", () => {
  const validInput = {
    orgToken: "token-abc",
    kind: "contact" as const,
    name: "Pedro",
    email: "pedro@example.com",
    message: "Hola, quiero adoptar.",
    ip: "192.168.1.1",
  };

  function makeRepo(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      findOrgByToken: vi.fn().mockResolvedValue({ id: "org-1" }),
      insertContact: vi.fn().mockResolvedValue(undefined),
      adminRecipients: vi.fn().mockResolvedValue([{ userId: "admin-1" }, { userId: "admin-2" }]),
      ...overrides,
    };
  }

  const enforceRateLimit = vi.fn().mockResolvedValue(undefined);

  it("inserts contact message and returns ok", async () => {
    const repo = makeRepo();
    const result = await submitOrgContact(validInput, { repo, enforceRateLimit });
    expect(result.ok).toBe(true);
    expect(repo.insertContact).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        kind: "contact",
        inquirerEmail: "pedro@example.com",
        message: "Hola, quiero adoptar.",
        submitterIp: "192.168.1.1",
      }),
    );
  });

  it("returns error when org not found", async () => {
    const repo = makeRepo({ findOrgByToken: vi.fn().mockResolvedValue(null) });
    const result = await submitOrgContact(validInput, { repo, enforceRateLimit });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toBe("Refugio no encontrado.");
  });

  it("returns error for invalid email", async () => {
    const repo = makeRepo();
    const result = await submitOrgContact(
      { ...validInput, email: "not-an-email" },
      { repo, enforceRateLimit },
    );
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toBe(
      "Indicá un email válido para que puedan responderte.",
    );
  });

  it("returns error for message too short", async () => {
    const repo = makeRepo();
    const result = await submitOrgContact(
      { ...validInput, message: "Hola" },
      { repo, enforceRateLimit },
    );
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toBe(
      "El mensaje es muy corto (mínimo 10 caracteres).",
    );
  });

  it("returns error for message too long", async () => {
    const repo = makeRepo();
    const result = await submitOrgContact(
      { ...validInput, message: "A".repeat(501) },
      { repo, enforceRateLimit },
    );
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("500");
  });

  it("stores null IP when ip is 'unknown'", async () => {
    const repo = makeRepo();
    await submitOrgContact({ ...validInput, ip: "unknown" }, { repo, enforceRateLimit });
    expect(repo.insertContact).toHaveBeenCalledWith(expect.objectContaining({ submitterIp: null }));
  });

  it("re-throws rate-limit error as user-friendly message", async () => {
    const repo = makeRepo();
    const rateLimitErr = { isRateLimit: true };
    const throwingRL = vi.fn().mockRejectedValueOnce(rateLimitErr);
    const isRateLimitError = (e: unknown): e is { isRateLimit: true } =>
      typeof e === "object" && e !== null && (e as Record<string, unknown>).isRateLimit === true;
    const result = await submitOrgContact(validInput, {
      repo,
      enforceRateLimit: throwingRL,
      isRateLimitError,
    });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("Ya enviaste varios mensajes");
  });

  it("avisa a TODOS los admins de la org — sin esto el mensaje no lo lee nadie", async () => {
    const repo = makeRepo();
    const result = await submitOrgContact(validInput, { repo, enforceRateLimit });
    expect(result.ok).toBe(true);
    const notifs = (
      result as { ok: true; notifications: Array<{ userId: string; ctaUrl?: string | null }> }
    ).notifications;
    expect(notifs.map((n) => n.userId)).toEqual(["admin-1", "admin-2"]);
    expect(notifs[0].ctaUrl).toBe("/org/token-abc/mensajes");
  });

  it("distingue voluntariado de contacto en el aviso", async () => {
    const repo = makeRepo();
    const result = await submitOrgContact(
      { ...validInput, kind: "volunteer" },
      { repo, enforceRateLimit },
    );
    const notifs = (
      result as { ok: true; notifications: Array<{ notificationType: string; title: string }> }
    ).notifications;
    expect(notifs[0].notificationType).toBe("org_volunteer_message");
    expect(notifs[0].title).toMatch(/voluntario/i);
  });
});

// ---------------------------------------------------------------------------
// requestCapability
// ---------------------------------------------------------------------------

describe("requestCapability", () => {
  const activeOrg = {
    organization: {
      id: "org-1",
      displayName: "Refugio Test",
      publicToken: "tok-org",
    },
    membership: {
      id: "mem-1",
      role: "member",
      organizationId: "org-1",
    },
  };

  function makeRepo(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      insertGrant: vi.fn().mockResolvedValue(undefined),
      adminRecipients: vi.fn().mockResolvedValue([{ userId: "admin-1" }]),
      findRequesterDisplayName: vi.fn().mockResolvedValue("María García"),
      ...overrides,
    };
  }

  const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    return cb({});
  });

  const isUniqueViolation = vi.fn().mockReturnValue(false);

  it("inserts grant and fans out notifications for a valid request", async () => {
    const repo = makeRepo();
    const result = await requestCapability(
      {
        userId: "user-1",
        capability: "foster.assign",
        reason: "Necesito asignar tránsitos",
        active: activeOrg,
      },
      { repo, transaction: txFn, isUniqueViolation },
    );
    expect(result.ok).toBe(true);
    expect(repo.insertGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        membershipId: "mem-1",
        organizationId: "org-1",
        capability: "foster.assign",
        status: "pending",
        requestedReason: "Necesito asignar tránsitos",
      }),
      expect.anything(),
    );
    expect(repo.adminRecipients).toHaveBeenCalledWith("org-1", expect.anything());
  });

  it("returns error when admin (already has all permissions)", async () => {
    const repo = makeRepo();
    const result = await requestCapability(
      {
        userId: "user-admin",
        capability: "foster.assign",
        reason: null,
        active: {
          ...activeOrg,
          membership: { ...activeOrg.membership, role: "admin" },
        },
      },
      { repo, transaction: txFn, isUniqueViolation },
    );
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toBe(
      "Como administrador ya tenés todos los permisos.",
    );
  });

  it("returns error when vet_individual requests implicit cap", async () => {
    const repo = makeRepo();
    const result = await requestCapability(
      {
        userId: "user-vet",
        capability: "event.write", // vet implicit
        reason: null,
        active: {
          ...activeOrg,
          membership: { ...activeOrg.membership, role: "vet_individual" },
        },
      },
      { repo, transaction: txFn, isUniqueViolation },
    );
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toBe(
      "Como veterinario/a ya tenés este permiso por defecto.",
    );
  });

  it("returns unique-violation error for duplicate open grant", async () => {
    const repo = makeRepo({ insertGrant: vi.fn().mockRejectedValue(new Error("txError")) });
    const isUniqueViolationTrue = vi.fn().mockReturnValue(true);
    const result = await requestCapability(
      {
        userId: "user-1",
        capability: "foster.assign",
        reason: null,
        active: activeOrg,
      },
      { repo, transaction: txFn, isUniqueViolation: isUniqueViolationTrue },
    );
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toBe(
      "Ya tenés una solicitud pendiente o un permiso concedido para esto.",
    );
  });

  it("does not notify when no admins exist", async () => {
    const repo = makeRepo({ adminRecipients: vi.fn().mockResolvedValue([]) });
    const result = await requestCapability(
      {
        userId: "user-1",
        capability: "foster.assign",
        reason: null,
        active: activeOrg,
      },
      { repo, transaction: txFn, isUniqueViolation },
    );
    expect(result.ok).toBe(true);
    expect(repo.findRequesterDisplayName).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// decideCapability
// ---------------------------------------------------------------------------

describe("decideCapability", () => {
  const activeOrg = {
    organization: {
      id: "org-1",
      displayName: "Refugio Test",
      publicToken: "tok-org",
    },
    membership: {
      id: "mem-admin",
      role: "admin",
      organizationId: "org-1",
    },
  };

  function makeGrant(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "grant-1",
      organizationId: "org-1",
      capability: "foster.assign",
      status: "pending",
      membershipId: "mem-1",
      requestedReason: null,
      decidedAt: null,
      decidedByUserId: null,
      decisionReason: null,
      ...overrides,
    };
  }

  function makeRepo(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      findGrant: vi.fn().mockResolvedValue(makeGrant()),
      updateGrant: vi.fn().mockResolvedValue(undefined),
      setGrantStatus: vi.fn().mockResolvedValue(undefined),
      findGrantMemberUserId: vi.fn().mockResolvedValue("user-requester"),
      insertAuditLog: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    return cb({});
  });

  const isUniqueViolation = vi.fn().mockReturnValue(false);

  it("approves a pending grant and queues notification", async () => {
    const repo = makeRepo();
    const result = await decideCapability(
      {
        deciderId: "admin-1",
        grantId: "grant-1",
        decision: "approved",
        reason: null,
        active: activeOrg,
        granted: new Set(["capability.grant"]),
      },
      { repo, transaction: txFn, isUniqueViolation },
    );
    expect(result.ok).toBe(true);
    expect(repo.updateGrant).toHaveBeenCalledWith(
      "grant-1",
      expect.objectContaining({ status: "approved" }),
      expect.anything(),
    );
  });

  it("revokes an approved grant", async () => {
    const repo = makeRepo({
      findGrant: vi.fn().mockResolvedValue(makeGrant({ status: "approved" })),
    });
    const result = await decideCapability(
      {
        deciderId: "admin-1",
        grantId: "grant-1",
        decision: "revoked",
        reason: null,
        active: activeOrg,
        granted: new Set(["capability.grant"]),
      },
      { repo, transaction: txFn, isUniqueViolation },
    );
    expect(result.ok).toBe(true);
  });

  // Lote B1 — revoke keeps the ORIGINAL approver on the grant row and records
  // the revocation (who/when + original provenance) in audit_log instead.
  it("B1: revoke does NOT overwrite the grant row — setGrantStatus, never updateGrant", async () => {
    const repo = makeRepo({
      findGrant: vi.fn().mockResolvedValue(
        makeGrant({
          status: "approved",
          decidedByUserId: "original-approver",
          decidedAt: new Date("2026-07-01T00:00:00Z"),
        }),
      ),
    });
    await decideCapability(
      {
        deciderId: "admin-1",
        grantId: "grant-1",
        decision: "revoked",
        reason: "ya no corresponde",
        active: activeOrg,
        granted: new Set(["capability.grant"]),
      },
      { repo, transaction: txFn, isUniqueViolation },
    );
    expect(repo.updateGrant).not.toHaveBeenCalled();
    expect(repo.setGrantStatus).toHaveBeenCalledWith("grant-1", "revoked", expect.anything());
    expect(repo.insertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "admin-1",
        action: "capability_revoked",
        payload: expect.objectContaining({
          grant_id: "grant-1",
          capability: "foster.assign",
          reason: "ya no corresponde",
          revoked_by_user_id: "admin-1",
          original_decided_by_user_id: "original-approver",
          original_decided_at: "2026-07-01T00:00:00.000Z",
        }),
      }),
      expect.anything(),
    );
  });

  it("B1: approve writes capability_granted to audit_log; deny writes capability_denied", async () => {
    for (const [decision, action] of [
      ["approved", "capability_granted"],
      ["denied", "capability_denied"],
    ] as const) {
      const repo = makeRepo();
      await decideCapability(
        {
          deciderId: "admin-1",
          grantId: "grant-1",
          decision,
          reason: null,
          active: activeOrg,
          granted: new Set(["capability.grant"]),
        },
        { repo, transaction: txFn, isUniqueViolation },
      );
      expect(repo.insertAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action }),
        expect.anything(),
      );
    }
  });

  it("returns error when grant not found", async () => {
    const repo = makeRepo({ findGrant: vi.fn().mockResolvedValue(null) });
    const result = await decideCapability(
      {
        deciderId: "admin-1",
        grantId: "grant-missing",
        decision: "approved",
        reason: null,
        active: activeOrg,
        granted: new Set(["capability.grant"]),
      },
      { repo, transaction: txFn, isUniqueViolation },
    );
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toBe("Solicitud no encontrada.");
  });

  it("returns error when grant belongs to different org (auth scope guard)", async () => {
    const repo = makeRepo({
      findGrant: vi.fn().mockResolvedValue(makeGrant({ organizationId: "org-OTHER" })),
    });
    const result = await decideCapability(
      {
        deciderId: "admin-1",
        grantId: "grant-1",
        decision: "approved",
        reason: null,
        active: activeOrg,
        granted: new Set(["capability.grant"]),
      },
      { repo, transaction: txFn, isUniqueViolation },
    );
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toBe(
      "Esa solicitud pertenece a otra organización.",
    );
  });

  it("returns error for terminal state (denied is terminal)", async () => {
    const repo = makeRepo({
      findGrant: vi.fn().mockResolvedValue(makeGrant({ status: "denied" })),
    });
    const result = await decideCapability(
      {
        deciderId: "admin-1",
        grantId: "grant-1",
        decision: "approved",
        reason: null,
        active: activeOrg,
        granted: new Set(["capability.grant"]),
      },
      { repo, transaction: txFn, isUniqueViolation },
    );
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toBe(
      "La solicitud ya está en un estado terminal.",
    );
  });

  it("returns error when actor lacks capability.grant", async () => {
    const repo = makeRepo();
    const result = await decideCapability(
      {
        deciderId: "user-1",
        grantId: "grant-1",
        decision: "approved",
        reason: null,
        active: activeOrg,
        granted: new Set<string>(["foster.assign"]), // no capability.grant
      },
      { repo, transaction: txFn, isUniqueViolation },
    );
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toBe(
      "No tenés permiso para decidir solicitudes.",
    );
  });

  it("returns race error on unique violation during approve", async () => {
    const repo = makeRepo({
      updateGrant: vi.fn().mockRejectedValue(new Error("race")),
    });
    const isUniqueViolationTrue = vi.fn().mockReturnValue(true);
    const result = await decideCapability(
      {
        deciderId: "admin-1",
        grantId: "grant-1",
        decision: "approved",
        reason: null,
        active: activeOrg,
        granted: new Set(["capability.grant"]),
      },
      { repo, transaction: txFn, isUniqueViolation: isUniqueViolationTrue },
    );
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toBe(
      "Otro permiso ya está activo para este miembro.",
    );
  });
});

// ---------------------------------------------------------------------------
// grantCapability
// ---------------------------------------------------------------------------

describe("grantCapability", () => {
  const activeOrg = {
    organization: {
      id: "org-1",
      displayName: "Refugio Test",
      publicToken: "tok-org",
    },
    membership: {
      id: "mem-admin",
      role: "admin",
      organizationId: "org-1",
    },
  };

  function makeMembership(role = "member") {
    return {
      id: "mem-target",
      userId: "user-target",
      organizationId: "org-1",
      role: role as "member" | "admin" | "coordinator" | "volunteer" | "foster" | "vet_individual",
      title: null,
      canWritePetEvents: false,
      joinedAt: new Date(),
      leftAt: null,
      invitedByUserId: null,
      receivesBroadcasts: true,
    };
  }

  function makeGrantRow() {
    return {
      id: "grant-new",
      membershipId: "mem-target",
      organizationId: "org-1",
      capability: "foster.assign",
      status: "approved" as const,
      requestedAt: new Date(),
      requestedReason: null,
      decidedAt: null,
      decidedByUserId: null,
      decisionReason: null,
    };
  }

  function makeRepo(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      findActiveMembership: vi.fn().mockResolvedValue(makeMembership()),
      insertGrant: vi.fn().mockResolvedValue(makeGrantRow()),
      updateGrant: vi.fn().mockResolvedValue(undefined),
      findGrantMemberUserId: vi.fn().mockResolvedValue("user-target"),
      insertAuditLog: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    return cb({});
  });

  const isUniqueViolation = vi.fn().mockReturnValue(false);

  const baseInput = {
    granterId: "admin-1",
    membershipId: "mem-target",
    capability: "foster.assign",
    active: activeOrg,
    granted: new Set(["capability.grant"]),
  };

  it("B1: a direct grant writes capability_granted to audit_log", async () => {
    const repo = makeRepo();
    await grantCapability(baseInput, { repo, transaction: txFn, isUniqueViolation });
    expect(repo.insertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "admin-1",
        action: "capability_granted",
        payload: expect.objectContaining({
          grant_id: "grant-new",
          capability: "foster.assign",
        }),
      }),
      expect.anything(),
    );
  });

  it("inserts an approved grant and queues notification for the recipient", async () => {
    const repo = makeRepo();
    const result = await grantCapability(baseInput, { repo, transaction: txFn, isUniqueViolation });

    expect(result.ok).toBe(true);
    expect(repo.insertGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        membershipId: "mem-target",
        organizationId: "org-1",
        capability: "foster.assign",
        status: "approved",
        requestedReason: null,
      }),
      expect.anything(),
    );
    expect(repo.updateGrant).toHaveBeenCalledWith(
      "grant-new",
      expect.objectContaining({ status: "approved", decidedByUserId: "admin-1" }),
      expect.anything(),
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].userId).toBe("user-target");
    expect(result.notifications[0].severity).toBe("success");
  });

  it("returns error when caller lacks capability.grant", async () => {
    const repo = makeRepo();
    const result = await grantCapability(
      { ...baseInput, granted: new Set(["foster.assign"]) },
      { repo, transaction: txFn, isUniqueViolation },
    );
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toBe(
      "No tenés permiso para conceder capacidades.",
    );
  });

  it("returns error for unknown capability", async () => {
    const repo = makeRepo();
    const result = await grantCapability(
      { ...baseInput, capability: "nonexistent.cap" },
      { repo, transaction: txFn, isUniqueViolation },
    );
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toBe("Permiso no reconocido.");
  });

  it("returns error when target membership not found or not in org", async () => {
    const repo = makeRepo({ findActiveMembership: vi.fn().mockResolvedValue(null) });
    const result = await grantCapability(baseInput, { repo, transaction: txFn, isUniqueViolation });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/no pertenece/i);
  });

  it("returns error when target is admin role (already has all caps)", async () => {
    const repo = makeRepo({
      findActiveMembership: vi.fn().mockResolvedValue(makeMembership("admin")),
    });
    const result = await grantCapability(baseInput, { repo, transaction: txFn, isUniqueViolation });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/administradores/i);
  });

  it("returns error when vet_individual tries to get an implicit cap", async () => {
    const repo = makeRepo({
      findActiveMembership: vi.fn().mockResolvedValue(makeMembership("vet_individual")),
    });
    const result = await grantCapability(
      { ...baseInput, capability: "event.write" }, // vet implicit cap
      { repo, transaction: txFn, isUniqueViolation },
    );
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/impl/i);
  });

  it("returns error when coordinator tries to get an implicit cap", async () => {
    const repo = makeRepo({
      findActiveMembership: vi.fn().mockResolvedValue(makeMembership("coordinator")),
    });
    const result = await grantCapability(
      { ...baseInput, capability: "member.invite" }, // coordinator implicit cap
      { repo, transaction: txFn, isUniqueViolation },
    );
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/impl/i);
  });

  it("returns idempotent unique-violation error for duplicate active grant", async () => {
    const repo = makeRepo({
      insertGrant: vi.fn().mockRejectedValue(new Error("unique_violation")),
    });
    const isUniqueViolationTrue = vi.fn().mockReturnValue(true);
    const result = await grantCapability(baseInput, {
      repo,
      transaction: txFn,
      isUniqueViolation: isUniqueViolationTrue,
    });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/activo o pendiente/i);
  });

  it("does not queue notification when recipient userId not found", async () => {
    const repo = makeRepo({ findGrantMemberUserId: vi.fn().mockResolvedValue(null) });
    const result = await grantCapability(baseInput, { repo, transaction: txFn, isUniqueViolation });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.notifications).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// H2 (top-10 review 2026-08-22) — nobody may hand themselves a permission.
//
// `capability.grant` exists to DELEGATE: a shelter coordinator clears the
// team's permission requests without being an admin. Neither use case compared
// the beneficiary against the actor, so that coordinator could request
// `custody.transfer` or `adoption.finalize` for themselves, open the permissions
// screen, see their OWN request with a working Approve button, and take it — or
// skip the request and grant it directly.
//
// The evidence that this is a boundary bug and not a missing hardening idea:
// the control ALREADY EXISTS in the product, on the wrong side of the trust
// boundary. CapabilityMatrix.tsx renders a dash titled "No podés concederte
// permisos a vos mismo" for the caller's own row. The browser enforced it; the
// server never asked. Three sibling use cases in this same module DO ask
// ("No podés cambiar tu propio rol", "No podés quitarte a vos mismo").
//
// The comparison is on USER, not on membership id — the skeptics' refinement.
// Leaving an org and rejoining mints a new membership row, so one person can
// hold two in the same org; a membership-id comparison lets them approve their
// own request from their other seat and calls it four eyes.
// ---------------------------------------------------------------------------

describe("H2 — self-grant is refused on the server, not only in the browser", () => {
  const activeOrg = {
    organization: { id: "org-1", displayName: "Refugio Test", publicToken: "tok-org" },
    membership: { id: "mem-actor", role: "coordinator", organizationId: "org-1" },
  };

  const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));
  const isUniqueViolation = vi.fn().mockReturnValue(false);

  function decideRepo(memberUserId: string) {
    return {
      findGrant: vi.fn().mockResolvedValue({
        id: "grant-1",
        organizationId: "org-1",
        capability: "custody.transfer",
        status: "pending",
        membershipId: "mem-requester",
        requestedReason: "hace falta",
        decidedAt: null,
        decidedByUserId: null,
        decisionReason: null,
      }),
      updateGrant: vi.fn().mockResolvedValue(undefined),
      setGrantStatus: vi.fn().mockResolvedValue(undefined),
      findGrantMemberUserId: vi.fn().mockResolvedValue(memberUserId),
      insertAuditLog: vi.fn().mockResolvedValue(undefined),
    };
  }

  function grantRepo(targetUserId: string) {
    return {
      findActiveMembership: vi.fn().mockResolvedValue({
        id: "mem-target",
        userId: targetUserId,
        organizationId: "org-1",
        role: "member" as const,
        title: null,
        canWritePetEvents: false,
        joinedAt: new Date(),
        leftAt: null,
        invitedByUserId: null,
        receivesBroadcasts: true,
      }),
      insertGrant: vi.fn().mockResolvedValue({
        id: "grant-new",
        membershipId: "mem-target",
        organizationId: "org-1",
        capability: "custody.transfer",
        status: "approved" as const,
        requestedAt: new Date(),
        requestedReason: null,
        decidedAt: null,
        decidedByUserId: null,
        decisionReason: null,
      }),
      updateGrant: vi.fn().mockResolvedValue(undefined),
      findGrantMemberUserId: vi.fn().mockResolvedValue(targetUserId),
      insertAuditLog: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("refuses approving your OWN pending request", async () => {
    const repo = decideRepo("user-coordinator");
    const result = await decideCapability(
      {
        deciderId: "user-coordinator",
        grantId: "grant-1",
        decision: "approved",
        reason: null,
        active: activeOrg,
        granted: new Set(["capability.grant"]),
      },
      { repo, transaction: txFn, isUniqueViolation },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/vos mismo/i);
    // Refused BEFORE the write — no status change, no audit row claiming it.
    expect(repo.updateGrant).not.toHaveBeenCalled();
    expect(repo.setGrantStatus).not.toHaveBeenCalled();
    expect(repo.insertAuditLog).not.toHaveBeenCalled();
  });

  it("refuses granting a capability directly to YOURSELF", async () => {
    const repo = grantRepo("user-coordinator");
    const result = await grantCapability(
      {
        granterId: "user-coordinator",
        membershipId: "mem-target",
        capability: "custody.transfer",
        active: activeOrg,
        granted: new Set(["capability.grant"]),
      },
      { repo, transaction: txFn, isUniqueViolation },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/vos mismo/i);
    expect(repo.insertGrant).not.toHaveBeenCalled();
  });

  it("refuses even when the beneficiary is a SECOND membership of the same person", async () => {
    // The membership ids differ (`mem-actor` vs `mem-target`) — a comparison on
    // membership id waves this through and calls it four eyes. The person is the
    // same, so it is not. `capability.grant` itself is the capability asked for,
    // which is how a one-time delegation becomes a permanent one.
    const repo = grantRepo("user-coordinator");
    const result = await grantCapability(
      {
        granterId: "user-coordinator",
        membershipId: "mem-target",
        capability: "capability.grant",
        active: activeOrg,
        granted: new Set(["capability.grant"]),
      },
      { repo, transaction: txFn, isUniqueViolation },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(repo.insertGrant).not.toHaveBeenCalled();
  });

  it("CONTROL: granting to somebody else still works", async () => {
    const repo = grantRepo("user-somebody-else");
    const result = await grantCapability(
      {
        granterId: "user-coordinator",
        membershipId: "mem-target",
        capability: "custody.transfer",
        active: activeOrg,
        granted: new Set(["capability.grant"]),
      },
      { repo, transaction: txFn, isUniqueViolation },
    );
    expect(result.ok).toBe(true);
    expect(repo.insertGrant).toHaveBeenCalled();
  });

  it("CONTROL: deciding a request that belongs to somebody else still works", async () => {
    const repo = decideRepo("user-somebody-else");
    const result = await decideCapability(
      {
        deciderId: "user-coordinator",
        grantId: "grant-1",
        decision: "approved",
        reason: null,
        active: activeOrg,
        granted: new Set(["capability.grant"]),
      },
      { repo, transaction: txFn, isUniqueViolation },
    );
    expect(result.ok).toBe(true);
    expect(repo.updateGrant).toHaveBeenCalled();
  });

  it("the grant notification does not claim an administrator decided", async () => {
    // It read "Un administrador de {org} te concedió el permiso". The granter
    // may be a coordinator holding `capability.grant`, not an admin — and while
    // self-grant was possible the sentence was also a cover story for the
    // recipient having granted it to themselves.
    const repo = grantRepo("user-somebody-else");
    const result = await grantCapability(
      {
        granterId: "user-coordinator",
        membershipId: "mem-target",
        capability: "custody.transfer",
        active: activeOrg,
        granted: new Set(["capability.grant"]),
      },
      { repo, transaction: txFn, isUniqueViolation },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notifications[0].body).not.toMatch(/administrador/i);
  });
});
