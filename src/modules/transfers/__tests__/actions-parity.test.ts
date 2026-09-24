// Parity smoke tests for the thin transfers actions layer (WU-4).
//
// Strategy: unit-level wiring verification. We cannot run the actual Next.js
// server actions in Vitest (no request context, no Supabase auth, no DB).
// Instead we verify:
//   1. Each action returns a domain error when auth denies.
//   2. Each action returns the use-case error when the use-case returns ok:false.
//   3. Each action returns the use-case value shape on ok:true.
//   4. Notifications flush is attempted post-tx (we assert db.insert is called).
//   5. CRITICAL (auth-scope): wrong-org or wrong-user principal is REJECTED
//      before the use-case is ever called.
//
// Mocking approach mirrors src/modules/adoption/__tests__/actions-parity.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted)
// ---------------------------------------------------------------------------

vi.mock("@/src/modules/organizations/infrastructure/authz-resolver", () => ({
  requireCapability: vi.fn(),
  requireCapabilityForOrgToken: vi.fn(),
}));

vi.mock("@/lib/infra/auth-guards", () => ({
  requireUserOrRedirect: vi.fn(),
}));

vi.mock("@/db", () => {
  // Factory: each db.insert() call returns a fresh { values } mock so callers
  // can be distinguished by their (table, values) pairs across calls.
  const insertFactory = vi.fn().mockImplementation(() => ({
    values: vi.fn().mockResolvedValue(undefined),
  }));

  return {
    db: {
      transaction: vi.fn().mockImplementation(async (cb: (tx: unknown) => unknown) => cb({})),
      insert: insertFactory,
    },
    notifications: {},
    auditLog: {},
  };
});

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        // `email_confirmed_at` IS LOAD-BEARING HERE, not scenery. The actions read
        // `sessionData?.user?.email_confirmed_at != null` and forward it as
        // `callerEmailConfirmed` (A09-1) — so a session without the field makes
        // every accept/reject case below exercise the REJECTION arm while the
        // assertions still read green, because `expect.objectContaining` ignores
        // a field it was not asked about. That is exactly what happened until
        // 2026-09-03. If you remove this, the "passes callerEmail…" tests go back
        // to testing the opposite of what their names say, silently.
        data: {
          user: { email: "caller@example.com", email_confirmed_at: "2026-09-01T10:00:00.000Z" },
        },
      }),
    },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn().mockReturnValue({
    auth: {
      admin: {
        inviteUserByEmail: vi.fn().mockResolvedValue({}),
        listUsers: vi.fn().mockResolvedValue({ data: { users: [] } }),
      },
    },
  }),
}));

// Use-case mocks
vi.mock("../application/initiate-pet-transfer", () => ({
  initiatePetTransfer: vi.fn(),
}));
vi.mock("../application/accept-pet-transfer", () => ({
  acceptPetTransfer: vi.fn(),
}));
vi.mock("../application/reject-pet-transfer", () => ({
  rejectPetTransfer: vi.fn(),
}));
vi.mock("../application/cancel-pet-transfer", () => ({
  cancelPetTransfer: vi.fn(),
}));
vi.mock("../application/get-transfer-for-viewer", () => ({
  getTransferForViewer: vi.fn(),
}));
vi.mock("../application/expire-pet-transfers", () => ({
  expirePetTransfers: vi.fn(),
}));
vi.mock("../application/propose-cross-org-transfer", () => ({
  proposeCrossOrgTransfer: vi.fn(),
}));
vi.mock("../application/accept-cross-org-transfer", () => ({
  acceptCrossOrgTransfer: vi.fn(),
}));
vi.mock("../application/reject-cross-org-transfer", () => ({
  rejectCrossOrgTransfer: vi.fn(),
}));
vi.mock("../application/cancel-cross-org-transfer", () => ({
  cancelCrossOrgTransfer: vi.fn(),
}));
vi.mock("../application/transfer-custody", () => ({
  transferCustody: vi.fn(),
}));

vi.mock("../infrastructure/transfers-repository", () => ({
  TransfersRepository: {
    findTransferViewByToken: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Lazy imports (AFTER vi.mock calls)
// ---------------------------------------------------------------------------

import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import {
  requireCapability,
  requireCapabilityForOrgToken,
} from "@/src/modules/organizations/infrastructure/authz-resolver";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockRequireCapability = requireCapability as ReturnType<typeof vi.fn>;
const mockRequireCapabilityForOrgToken = requireCapabilityForOrgToken as ReturnType<typeof vi.fn>;
const mockRequireUser = requireUserOrRedirect as ReturnType<typeof vi.fn>;

function makeUser(overrides: Record<string, unknown> = {}) {
  return { id: "user-1", email: "caller@example.com", ...overrides };
}

function makeAuth(overrides: Record<string, unknown> = {}) {
  return {
    error: null,
    user: makeUser(),
    organization: {
      id: "org-1",
      publicToken: "org-tok",
      verified: true,
      displayName: "Refugio Test",
    },
    ...overrides,
  };
}

function makeUserSession(overrides: Record<string, unknown> = {}) {
  return { user: makeUser(overrides) };
}

// ===========================================================================
// initiatePetTransferAction
// ===========================================================================

describe("initiatePetTransferAction — auth-scope: current owner USER", () => {
  let initiatePetTransferAction: (...args: any[]) => Promise<any>;
  let initiatePetTransferUc: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(makeUserSession());
    const actions = await import("../actions");
    initiatePetTransferAction = actions.initiatePetTransferAction;
    const ucModule = await import("../application/initiate-pet-transfer");
    initiatePetTransferUc = ucModule.initiatePetTransfer as ReturnType<typeof vi.fn>;
  });

  afterEach(() => vi.resetModules());

  it("returns error when requireUserOrRedirect throws (unauthenticated)", async () => {
    mockRequireUser.mockRejectedValue(new Error("redirect"));
    await expect(
      initiatePetTransferAction({ petToken: "tok", toEmail: "a@b.com", reason: "gift" }),
    ).rejects.toThrow();
    expect(initiatePetTransferUc).not.toHaveBeenCalled();
  });

  it("returns use-case error on ok:false", async () => {
    initiatePetTransferUc.mockResolvedValue({ ok: false, error: "Solo el dueño actual..." });
    const result = await initiatePetTransferAction({
      petToken: "tok",
      toEmail: "a@b.com",
      reason: "gift",
    });
    expect(result).toEqual({ error: "Solo el dueño actual..." });
  });

  it("returns transferToken on success and flushes notifications", async () => {
    const { db } = await import("@/db");
    initiatePetTransferUc.mockResolvedValue({
      ok: true,
      value: {
        transferToken: "PTR-xxx",
        petId: "pet-1",
        recipientNeedsInvite: false,
        petName: "Firulais",
      },
      notifications: [{ userId: "u-2", notificationType: "pet_transfer_received" }],
    });
    const result = await initiatePetTransferAction({
      petToken: "tok",
      toEmail: "a@b.com",
      reason: "gift",
    });
    expect(result).toEqual({ transferToken: "PTR-xxx" });
    expect(db.insert).toHaveBeenCalled();
  });

  it("calls inviteUserByEmail when recipientNeedsInvite=true (best-effort, non-fatal)", async () => {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = (createAdminClient as any)();
    initiatePetTransferUc.mockResolvedValue({
      ok: true,
      value: {
        transferToken: "PTR-yyy",
        petId: "pet-2",
        recipientNeedsInvite: true,
        petName: "Michi",
      },
      notifications: [],
    });
    await initiatePetTransferAction({
      petToken: "tok",
      toEmail: "new@user.com",
      reason: "gift",
    });
    expect(admin.auth.admin.inviteUserByEmail).toHaveBeenCalledWith(
      "new@user.com",
      expect.any(Object),
    );
  });

  it("CRITICAL: wrong-user principal — use-case must be called with correct userId, not an arbitrary user", async () => {
    // The action resolves the user from requireUserOrRedirect and passes it as actor.
    // We verify it passes the authenticated user (id=user-1), not any override.
    initiatePetTransferUc.mockResolvedValue({
      ok: true,
      value: {
        transferToken: "PTR-zzz",
        petId: "pet-3",
        recipientNeedsInvite: false,
        petName: "Rex",
      },
      notifications: [],
    });
    await initiatePetTransferAction({ petToken: "tok", toEmail: "a@b.com", reason: "gift" });
    expect(initiatePetTransferUc).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        actor: expect.objectContaining({ user: expect.objectContaining({ id: "user-1" }) }),
      }),
    );
  });
});

// ===========================================================================
// acceptPetTransferAction
// ===========================================================================

describe("acceptPetTransferAction — auth-scope: recipient USER (id-or-email match)", () => {
  let acceptPetTransferAction: (...args: any[]) => Promise<any>;
  let acceptPetTransferUc: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(makeUserSession());
    const actions = await import("../actions");
    acceptPetTransferAction = actions.acceptPetTransferAction;
    const ucModule = await import("../application/accept-pet-transfer");
    acceptPetTransferUc = ucModule.acceptPetTransfer as ReturnType<typeof vi.fn>;
  });

  afterEach(() => vi.resetModules());

  it("returns use-case error on ok:false (wrong recipient)", async () => {
    acceptPetTransferUc.mockResolvedValue({
      ok: false,
      error: "Esta propuesta no es para tu cuenta.",
    });
    const result = await acceptPetTransferAction("PTR-abc");
    expect(result).toEqual({ error: "Esta propuesta no es para tu cuenta." });
  });

  it("returns ok:true and revalidates on success", async () => {
    const { revalidatePath } = await import("next/cache");
    acceptPetTransferUc.mockResolvedValue({
      ok: true,
      value: { petId: "pet-1" },
      notifications: [{ userId: "u-1", notificationType: "pet_transfer_accepted" }],
    });
    const result = await acceptPetTransferAction("PTR-abc");
    expect(result).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/mis-mascotas");
  });

  it("CRITICAL: passes callerEmail resolved from supabase session to use-case", async () => {
    acceptPetTransferUc.mockResolvedValue({
      ok: true,
      value: { petId: "pet-1" },
      notifications: [],
    });
    await acceptPetTransferAction("PTR-abc");
    // BOTH halves of the addressee input, and the second one is named on purpose:
    // `callerEmailConfirmed` is what decides whether the e-mail arm is addressee
    // proof at all (A09-1), and asserting only `callerEmail` let this test pass
    // against `callerEmailConfirmed: false` — the refusal path — for a day.
    expect(acceptPetTransferUc).toHaveBeenCalledWith(
      expect.objectContaining({
        callerEmail: "caller@example.com",
        callerEmailConfirmed: true,
      }),
      expect.any(Object),
    );
  });

  it("CRITICAL: wrong-user — sender accepting own transfer must be rejected by use-case", async () => {
    // Sender tries to accept their own transfer. Use-case returns auth error (business rule).
    acceptPetTransferUc.mockResolvedValue({
      ok: false,
      error: "No podés aceptar tu propia transferencia.",
    });
    const result = await acceptPetTransferAction("PTR-self");
    expect(result).toEqual({ error: "No podés aceptar tu propia transferencia." });
    // Verify the action forwarded the userId correctly so use-case can check it.
    expect(acceptPetTransferUc).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        actor: expect.objectContaining({ user: expect.objectContaining({ id: "user-1" }) }),
      }),
    );
  });
});

// ===========================================================================
// rejectPetTransferAction
// ===========================================================================

describe("rejectPetTransferAction — auth-scope: recipient USER (id-or-email)", () => {
  let rejectPetTransferAction: (...args: any[]) => Promise<any>;
  let rejectPetTransferUc: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(makeUserSession());
    const actions = await import("../actions");
    rejectPetTransferAction = actions.rejectPetTransferAction;
    const ucModule = await import("../application/reject-pet-transfer");
    rejectPetTransferUc = ucModule.rejectPetTransfer as ReturnType<typeof vi.fn>;
  });

  afterEach(() => vi.resetModules());

  it("CRITICAL: wrong-user — non-recipient gets 'Esta propuesta no es para tu cuenta.'", async () => {
    rejectPetTransferUc.mockResolvedValue({
      ok: false,
      error: "Esta propuesta no es para tu cuenta.",
    });
    const result = await rejectPetTransferAction({ transferToken: "PTR-abc" });
    expect(result).toEqual({ error: "Esta propuesta no es para tu cuenta." });
  });

  it("returns ok:true on success", async () => {
    rejectPetTransferUc.mockResolvedValue({
      ok: true,
      value: { petId: "pet-r" },
      notifications: [],
    });
    const result = await rejectPetTransferAction({ transferToken: "PTR-abc", reason: "no quiero" });
    expect(result).toEqual({ ok: true });
  });

  it("passes callerEmail from session to use-case", async () => {
    rejectPetTransferUc.mockResolvedValue({
      ok: true,
      value: { petId: "pet-r2" },
      notifications: [],
    });
    await rejectPetTransferAction({ transferToken: "PTR-abc" });
    // Same pair as the accept case above — see the comment there for why the
    // confirmation bit is named rather than left to `objectContaining`.
    expect(rejectPetTransferUc).toHaveBeenCalledWith(
      expect.objectContaining({
        callerEmail: "caller@example.com",
        callerEmailConfirmed: true,
      }),
      expect.any(Object),
    );
  });
});

// ===========================================================================
// cancelPetTransferAction
// ===========================================================================

describe("cancelPetTransferAction — auth-scope: SENDER USER only", () => {
  let cancelPetTransferAction: (...args: any[]) => Promise<any>;
  let cancelPetTransferUc: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(makeUserSession());
    const actions = await import("../actions");
    cancelPetTransferAction = actions.cancelPetTransferAction;
    const ucModule = await import("../application/cancel-pet-transfer");
    cancelPetTransferUc = ucModule.cancelPetTransfer as ReturnType<typeof vi.fn>;
  });

  afterEach(() => vi.resetModules());

  it("CRITICAL: wrong-user — non-sender gets 'Solo el emisor puede cancelar'", async () => {
    cancelPetTransferUc.mockResolvedValue({
      ok: false,
      error: "Solo el emisor puede cancelar la propuesta.",
    });
    const result = await cancelPetTransferAction("PTR-abc");
    expect(result).toEqual({ error: "Solo el emisor puede cancelar la propuesta." });
  });

  it("returns ok:true and flushes notifications on success", async () => {
    const { db } = await import("@/db");
    cancelPetTransferUc.mockResolvedValue({
      ok: true,
      value: { petId: "pet-c" },
      notifications: [{ userId: "u-2", notificationType: "pet_transfer_cancelled" }],
    });
    const result = await cancelPetTransferAction("PTR-abc");
    expect(result).toEqual({ ok: true });
    expect(db.insert).toHaveBeenCalled();
  });

  it("passes the authenticated user id to the use-case as actor", async () => {
    cancelPetTransferUc.mockResolvedValue({
      ok: true,
      value: { petId: "pet-c2" },
      notifications: [],
    });
    await cancelPetTransferAction("PTR-abc");
    expect(cancelPetTransferUc).toHaveBeenCalledWith(
      expect.objectContaining({ transferToken: "PTR-abc" }),
      expect.objectContaining({
        actor: expect.objectContaining({ user: expect.objectContaining({ id: "user-1" }) }),
      }),
    );
  });
});

// ===========================================================================
// getTransferForViewerAction
// ===========================================================================

describe("getTransferForViewerAction — auth-scope: sender OR recipient USER", () => {
  let getTransferForViewerAction: (...args: any[]) => Promise<any>;
  let getTransferForViewerUc: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(makeUserSession());
    const actions = await import("../actions");
    getTransferForViewerAction = actions.getTransferForViewerAction;
    const ucModule = await import("../application/get-transfer-for-viewer");
    getTransferForViewerUc = ucModule.getTransferForViewer as ReturnType<typeof vi.fn>;
  });

  afterEach(() => vi.resetModules());

  it("CRITICAL: third-party — non-sender non-recipient gets 'Esta propuesta no es accesible'", async () => {
    getTransferForViewerUc.mockResolvedValue({
      ok: false,
      error: "Esta propuesta no es accesible desde tu cuenta.",
    });
    const result = await getTransferForViewerAction("PTR-abc");
    expect(result).toEqual({ ok: false, error: "Esta propuesta no es accesible desde tu cuenta." });
  });

  it("returns the DTO on success", async () => {
    getTransferForViewerUc.mockResolvedValue({
      ok: true,
      value: {
        publicToken: "PTR-abc",
        status: "pending",
        isSender: true,
        isRecipient: false,
      },
      notifications: [],
    });
    const { TransfersRepository } = await import("../infrastructure/transfers-repository");
    (TransfersRepository.findTransferViewByToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      transfer: { toOwnerEmail: "to@example.com" },
      petName: "Firulais",
      petToken: "PET-1",
      fromDisplayName: "Sender Name",
    });
    const result = await getTransferForViewerAction("PTR-abc");
    expect(result).toMatchObject({ ok: true });
  });
});

// ===========================================================================
// expirePetTransfersAction (cron)
// ===========================================================================

describe("expirePetTransfersAction — auth-scope: NONE (CRON_SECRET at route)", () => {
  let expirePetTransfersAction: (...args: any[]) => Promise<any>;
  let expirePetTransfersUc: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const actions = await import("../actions");
    expirePetTransfersAction = actions.expirePetTransfersAction;
    const ucModule = await import("../application/expire-pet-transfers");
    expirePetTransfersUc = ucModule.expirePetTransfers as ReturnType<typeof vi.fn>;
  });

  afterEach(() => vi.resetModules());

  it("throws when use-case returns ok:false (cron logs the error)", async () => {
    expirePetTransfersUc.mockResolvedValue({ ok: false, error: "DB unavailable." });
    await expect(expirePetTransfersAction()).rejects.toThrow("DB unavailable.");
  });

  it("returns stats on success", async () => {
    expirePetTransfersUc.mockResolvedValue({
      ok: true,
      value: { expired: 3, errors: 0, auditEntries: [] },
      notifications: [],
    });
    const result = await expirePetTransfersAction();
    // errors is now surfaced (was discarded) so the cron route can 500 on
    // partial failure (review 23 fleet extension).
    expect(result).toEqual({ expired: 3, errors: 0 });
  });
});

// ===========================================================================
// proposeCrossOrgTransferAction
// ===========================================================================

describe("proposeCrossOrgTransferAction — auth-scope: SENDER ORG (org.transfer.propose) scoped to senderOrgToken", () => {
  let proposeCrossOrgTransferAction: (...args: any[]) => Promise<any>;
  let proposeCrossOrgTransferUc: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const actions = await import("../actions");
    proposeCrossOrgTransferAction = actions.proposeCrossOrgTransferAction;
    const ucModule = await import("../application/propose-cross-org-transfer");
    proposeCrossOrgTransferUc = ucModule.proposeCrossOrgTransfer as ReturnType<typeof vi.fn>;
  });

  afterEach(() => vi.resetModules());

  it("returns capability error when auth fails", async () => {
    mockRequireCapabilityForOrgToken.mockResolvedValue({ error: "No tenés permiso." });
    const result = await proposeCrossOrgTransferAction({
      senderOrgToken: "org-tok",
      petPublicToken: "pet-tok",
      receiverOrgId: "org-2",
      reason: "space_constraint",
    });
    expect(result).toEqual({ error: "No tenés permiso." });
    expect(proposeCrossOrgTransferUc).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Regression (sibling of the QA 2026-07-08 accept bug): a multi-org member
  // proposing from the sender org URL must be authorized against THAT org, not
  // the session-default (most-recently-joined) membership.
  // -------------------------------------------------------------------------
  it("CRITICAL: resolves the acting org from the senderOrgToken (not the session-default membership)", async () => {
    mockRequireCapabilityForOrgToken.mockResolvedValue(makeAuth());
    proposeCrossOrgTransferUc.mockResolvedValue({
      ok: true,
      value: {
        publicCode: "CASE-001",
        caseId: "case-1",
        petId: "pet-1",
        senderOrgId: "org-1",
        receiverOrgId: "org-2",
      },
      notifications: [],
    });
    const result = await proposeCrossOrgTransferAction({
      senderOrgToken: "SENDER-TOK",
      petPublicToken: "pet-tok",
      receiverOrgId: "org-2",
      reason: "space_constraint",
    });
    expect(result).toEqual({ ok: true, publicCode: "CASE-001" });
    expect(mockRequireCapabilityForOrgToken).toHaveBeenCalledWith(
      "org.transfer.propose",
      "SENDER-TOK",
    );
    // The bare (last-membership-wins) resolver is NOT used for this action.
    expect(mockRequireCapability).not.toHaveBeenCalled();
  });

  it("CRITICAL: wrong-org — member of a different org gets the standard no-access failure, use-case NOT called", async () => {
    // The URL-pinned resolver returns the standard failure when the caller has
    // no qualifying membership in the URL org (indistinguishable from
    // "org does not exist" — org existence is never leaked).
    mockRequireCapabilityForOrgToken.mockResolvedValue({
      error: "No pertenecés a ninguna organización activa.",
    });
    const result = await proposeCrossOrgTransferAction({
      senderOrgToken: "other-org",
      petPublicToken: "pet-tok",
      receiverOrgId: "org-2",
      reason: "space_constraint",
    });
    expect(result).toEqual({ error: "No pertenecés a ninguna organización activa." });
    expect(proposeCrossOrgTransferUc).not.toHaveBeenCalled();
  });

  it("returns ok:true with publicCode on success", async () => {
    mockRequireCapabilityForOrgToken.mockResolvedValue(makeAuth());
    proposeCrossOrgTransferUc.mockResolvedValue({
      ok: true,
      value: { publicCode: "CASE-001" },
      notifications: [],
    });
    const result = await proposeCrossOrgTransferAction({
      senderOrgToken: "org-tok",
      petPublicToken: "pet-tok",
      receiverOrgId: "org-2",
      reason: "space_constraint",
    });
    expect(result).toEqual({ ok: true, publicCode: "CASE-001" });
  });
});

// ===========================================================================
// acceptCrossOrgTransferAction
// ===========================================================================

describe("acceptCrossOrgTransferAction — auth-scope: RECEIVER ORG scoped to case.receiverOrganizationId", () => {
  let acceptCrossOrgTransferAction: (...args: any[]) => Promise<any>;
  let acceptCrossOrgTransferUc: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const actions = await import("../actions");
    acceptCrossOrgTransferAction = actions.acceptCrossOrgTransferAction;
    const ucModule = await import("../application/accept-cross-org-transfer");
    acceptCrossOrgTransferUc = ucModule.acceptCrossOrgTransfer as ReturnType<typeof vi.fn>;
  });

  afterEach(() => vi.resetModules());

  it("returns capability error when auth fails", async () => {
    mockRequireCapabilityForOrgToken.mockResolvedValue({ error: "Sin permiso." });
    const result = await acceptCrossOrgTransferAction({
      receiverOrgToken: "org-tok",
      casePublicCode: "CASE-001",
    });
    expect(result).toEqual({ error: "Sin permiso." });
  });

  // -------------------------------------------------------------------------
  // Regression (QA 2026-07-08): a multi-org member operating from the receiver
  // org URL was rejected with "operando desde una organización distinta a la
  // receiver" because the action resolved the acting org via bare
  // requireCapability (most-recently-joined membership), not the URL token.
  // The fix resolves the org FROM the receiverOrgToken.
  // -------------------------------------------------------------------------
  it("CRITICAL: resolves the acting org from the receiverOrgToken (not the session-default membership)", async () => {
    mockRequireCapabilityForOrgToken.mockResolvedValue(makeAuth());
    acceptCrossOrgTransferUc.mockResolvedValue({
      ok: true,
      value: { publicCode: "CASE-001" },
      notifications: [],
    });
    await acceptCrossOrgTransferAction({
      receiverOrgToken: "RECEIVER-TOK",
      casePublicCode: "CASE-001",
    });
    // The URL token drives org resolution — a member of several orgs is
    // authorized against the receiver org, not whichever org they joined last.
    expect(mockRequireCapabilityForOrgToken).toHaveBeenCalledWith(
      "org.transfer.accept",
      "RECEIVER-TOK",
    );
    // And the bare (last-membership-wins) resolver is NOT used for this action.
    expect(mockRequireCapability).not.toHaveBeenCalled();
  });

  it("CRITICAL: wrong-org receiver — use-case returns 'La propuesta no fue dirigida a tu organización.'", async () => {
    // This tests the receiver scope: org.id must match case.receiverOrganizationId.
    // The use-case (not the action) enforces this. We verify the action passes
    // the correct org to the use-case so it can enforce it.
    mockRequireCapabilityForOrgToken.mockResolvedValue(makeAuth());
    acceptCrossOrgTransferUc.mockResolvedValue({
      ok: false,
      error: "La propuesta no fue dirigida a tu organización.",
    });
    const result = await acceptCrossOrgTransferAction({
      receiverOrgToken: "org-tok",
      casePublicCode: "CASE-001",
    });
    expect(result).toEqual({ error: "La propuesta no fue dirigida a tu organización." });
    // Verify the action passed the correct organization to the use-case.
    expect(acceptCrossOrgTransferUc).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        actor: expect.objectContaining({
          organization: expect.objectContaining({ id: "org-1" }),
        }),
      }),
    );
  });

  it("returns ok:true with publicCode on success", async () => {
    mockRequireCapabilityForOrgToken.mockResolvedValue(makeAuth());
    acceptCrossOrgTransferUc.mockResolvedValue({
      ok: true,
      value: { publicCode: "CASE-001" },
      notifications: [],
    });
    const result = await acceptCrossOrgTransferAction({
      receiverOrgToken: "org-tok",
      casePublicCode: "CASE-001",
    });
    expect(result).toEqual({ ok: true, publicCode: "CASE-001" });
  });
});

// ===========================================================================
// rejectCrossOrgTransferAction
// ===========================================================================

describe("rejectCrossOrgTransferAction — auth-scope: RECEIVER ORG scoped to case.receiverOrganizationId", () => {
  let rejectCrossOrgTransferAction: (...args: any[]) => Promise<any>;
  let rejectCrossOrgTransferUc: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const actions = await import("../actions");
    rejectCrossOrgTransferAction = actions.rejectCrossOrgTransferAction;
    const ucModule = await import("../application/reject-cross-org-transfer");
    rejectCrossOrgTransferUc = ucModule.rejectCrossOrgTransfer as ReturnType<typeof vi.fn>;
  });

  afterEach(() => vi.resetModules());

  it("CRITICAL: resolves the acting org from the receiverOrgToken (not the session-default membership)", async () => {
    mockRequireCapabilityForOrgToken.mockResolvedValue(makeAuth());
    rejectCrossOrgTransferUc.mockResolvedValue({
      ok: true,
      value: { publicCode: "CASE-001" },
      notifications: [],
    });
    await rejectCrossOrgTransferAction({
      receiverOrgToken: "RECEIVER-TOK",
      casePublicCode: "CASE-001",
    });
    expect(mockRequireCapabilityForOrgToken).toHaveBeenCalledWith(
      "org.transfer.accept",
      "RECEIVER-TOK",
    );
    expect(mockRequireCapability).not.toHaveBeenCalled();
  });

  it("CRITICAL: wrong-org — non-receiver org gets 'La propuesta no fue dirigida a tu organización.'", async () => {
    mockRequireCapabilityForOrgToken.mockResolvedValue(makeAuth());
    rejectCrossOrgTransferUc.mockResolvedValue({
      ok: false,
      error: "La propuesta no fue dirigida a tu organización.",
    });
    const result = await rejectCrossOrgTransferAction({
      receiverOrgToken: "org-tok",
      casePublicCode: "CASE-001",
    });
    expect(result).toEqual({ error: "La propuesta no fue dirigida a tu organización." });
    // Verify org id is passed so the use-case can enforce the scope.
    expect(rejectCrossOrgTransferUc).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        actor: expect.objectContaining({
          organization: expect.objectContaining({ id: "org-1" }),
        }),
      }),
    );
  });

  it("returns ok:true on success", async () => {
    mockRequireCapabilityForOrgToken.mockResolvedValue(makeAuth());
    rejectCrossOrgTransferUc.mockResolvedValue({
      ok: true,
      value: { publicCode: "CASE-001" },
      notifications: [],
    });
    const result = await rejectCrossOrgTransferAction({
      receiverOrgToken: "org-tok",
      casePublicCode: "CASE-001",
      reason: "no capacity",
    });
    expect(result).toEqual({ ok: true, publicCode: "CASE-001" });
  });
});

// ===========================================================================
// cancelCrossOrgTransferAction
// ===========================================================================

describe("cancelCrossOrgTransferAction — auth-scope: SENDER ORG scoped to case.openedByOrganizationId", () => {
  let cancelCrossOrgTransferAction: (...args: any[]) => Promise<any>;
  let cancelCrossOrgTransferUc: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const actions = await import("../actions");
    cancelCrossOrgTransferAction = actions.cancelCrossOrgTransferAction;
    const ucModule = await import("../application/cancel-cross-org-transfer");
    cancelCrossOrgTransferUc = ucModule.cancelCrossOrgTransfer as ReturnType<typeof vi.fn>;
  });

  afterEach(() => vi.resetModules());

  it("CRITICAL: resolves the acting org from the senderOrgToken (not the session-default membership)", async () => {
    mockRequireCapabilityForOrgToken.mockResolvedValue(makeAuth());
    cancelCrossOrgTransferUc.mockResolvedValue({
      ok: true,
      value: { publicCode: "CASE-001" },
      notifications: [],
    });
    await cancelCrossOrgTransferAction({
      senderOrgToken: "SENDER-TOK",
      casePublicCode: "CASE-001",
    });
    expect(mockRequireCapabilityForOrgToken).toHaveBeenCalledWith(
      "org.transfer.propose",
      "SENDER-TOK",
    );
    expect(mockRequireCapability).not.toHaveBeenCalled();
  });

  it("CRITICAL: wrong-org — non-sender gets 'Solo la organización que propuso puede cancelar.'", async () => {
    mockRequireCapabilityForOrgToken.mockResolvedValue(makeAuth());
    cancelCrossOrgTransferUc.mockResolvedValue({
      ok: false,
      error: "Solo la organización que propuso puede cancelar.",
    });
    const result = await cancelCrossOrgTransferAction({
      senderOrgToken: "org-tok",
      casePublicCode: "CASE-001",
    });
    expect(result).toEqual({ error: "Solo la organización que propuso puede cancelar." });
    // Verify org id is passed to use-case for the openedByOrganizationId check.
    expect(cancelCrossOrgTransferUc).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        actor: expect.objectContaining({
          organization: expect.objectContaining({ id: "org-1" }),
        }),
      }),
    );
  });

  it("returns ok:true with publicCode on success", async () => {
    mockRequireCapabilityForOrgToken.mockResolvedValue(makeAuth());
    cancelCrossOrgTransferUc.mockResolvedValue({
      ok: true,
      value: { publicCode: "CASE-001" },
      notifications: [],
    });
    const result = await cancelCrossOrgTransferAction({
      senderOrgToken: "org-tok",
      casePublicCode: "CASE-001",
    });
    expect(result).toEqual({ ok: true, publicCode: "CASE-001" });
  });
});

// ===========================================================================
// transferCustodyAction
// ===========================================================================

describe("transferCustodyAction — auth-scope: SOURCE ORG (custody.transfer) URL-token pinned", () => {
  let transferCustodyAction: (...args: any[]) => Promise<any>;
  let transferCustodyUc: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const actions = await import("../actions");
    transferCustodyAction = actions.transferCustodyAction;
    const ucModule = await import("../application/transfer-custody");
    transferCustodyUc = ucModule.transferCustody as ReturnType<typeof vi.fn>;
  });

  afterEach(() => vi.resetModules());

  it("returns capability error when auth fails", async () => {
    mockRequireCapabilityForOrgToken.mockResolvedValue({ error: "Sin permiso." });
    const formData = new FormData();
    formData.append("destinationOrgId", "org-2");
    const result = await transferCustodyAction("org-tok", "pet-tok", { error: null }, formData);
    expect(result).toEqual({ error: "Sin permiso." });
    expect(transferCustodyUc).not.toHaveBeenCalled();
  });

  it("CONFUSED-DEPUTY GUARD: pins the capability check to the URL org token, not the session-default membership", async () => {
    // R11 fix: transferCustodyAction resolves the acting org FROM the URL
    // orgToken via requireCapabilityForOrgToken — never bare requireCapability
    // (which would resolve the most-recently-joined membership).
    mockRequireCapabilityForOrgToken.mockResolvedValue(makeAuth());
    transferCustodyUc.mockResolvedValue({
      ok: false,
      error: "Mascota no encontrada o no está bajo custodia de tu organización.",
    });
    const formData = new FormData();
    formData.append("destinationOrgId", "org-2");
    await transferCustodyAction("org-tok", "pet-tok", { error: null }, formData);
    expect(mockRequireCapabilityForOrgToken).toHaveBeenCalledWith("custody.transfer", "org-tok");
    expect(mockRequireCapability).not.toHaveBeenCalled();
  });

  it("CRITICAL: wrong-org — pet not under caller org returns 'Mascota no encontrada o no está bajo custodia de tu organización.'", async () => {
    // Auth is URL-token pinned; the repo query is scoped to organization.id.
    // Use-case returns this error when findPetUnderOrg finds nothing.
    mockRequireCapabilityForOrgToken.mockResolvedValue(makeAuth());
    transferCustodyUc.mockResolvedValue({
      ok: false,
      error: "Mascota no encontrada o no está bajo custodia de tu organización.",
    });
    const formData = new FormData();
    formData.append("destinationOrgId", "org-2");
    const result = await transferCustodyAction("org-tok", "pet-tok", { error: null }, formData);
    expect(result).toEqual({
      error: "Mascota no encontrada o no está bajo custodia de tu organización.",
    });
    // Verify org id is passed so repo query is scoped correctly.
    expect(transferCustodyUc).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        actor: expect.objectContaining({
          organization: expect.objectContaining({ id: "org-1" }),
        }),
      }),
    );
  });

  it("returns the transfers hub on success (proposal opened, not an immediate flip)", async () => {
    const { redirect } = await import("next/navigation");
    mockRequireCapabilityForOrgToken.mockResolvedValue(makeAuth());
    transferCustodyUc.mockResolvedValue({
      ok: true,
      value: {
        publicCode: "CASE-001",
        caseId: "case-1",
        petId: "pet-1",
        senderOrgId: "org-1",
        receiverOrgId: "org-2",
      },
      notifications: [],
    });
    const formData = new FormData();
    formData.append("destinationOrgId", "org-2");
    // N3 (B.2): the action RETURNS the hub and the form navigates. A server
    // action's own redirect() is dropped by the App Router in production — the
    // transfer proposal would open and the operator would see nothing.
    const state = await transferCustodyAction("org-tok", "pet-tok", { error: null }, formData);
    expect(state.redirectTo).toBe("/org/org-tok/transferencias");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("returns error (no redirect) on use-case failure", async () => {
    mockRequireCapabilityForOrgToken.mockResolvedValue(makeAuth());
    transferCustodyUc.mockResolvedValue({
      ok: false,
      error: "No se pudo proponer la transferencia: error desconocido",
    });
    const formData = new FormData();
    formData.append("destinationOrgId", "org-2");
    const result = await transferCustodyAction("org-tok", "pet-tok", { error: null }, formData);
    expect(result).toEqual({ error: "No se pudo proponer la transferencia: error desconocido" });
  });
});

// ===========================================================================
// AUDIT LOG PARITY (C-1) — 9 operations must insert auditLog rows
// ===========================================================================
//
// Strategy: assert db.insert is called with the auditLog table sentinel AND
// that .values() receives the correct action string + key payload fields.
// We use the mock sentinel `auditLog: {}` exported from the @/db mock; the
// actual identity-equality check uses `toHaveBeenCalledWith(auditLog)`.

describe("AUDIT LOG PARITY — C-1: all 9 operations insert auditLog rows", () => {
  let db: { insert: ReturnType<typeof vi.fn> };
  let auditLog: object;

  beforeEach(async () => {
    vi.clearAllMocks();
    const dbModule = await import("@/db");
    db = dbModule.db as unknown as { insert: ReturnType<typeof vi.fn> };
    auditLog = dbModule.auditLog;
  });

  afterEach(() => vi.resetModules());

  // Get all .values() arguments from db.insert(auditLog).values(...) calls.
  function getAuditInserts(): unknown[] {
    const results: unknown[] = [];
    for (let i = 0; i < db.insert.mock.calls.length; i++) {
      const [table] = db.insert.mock.calls[i] as [unknown];
      if (table === auditLog) {
        const valuesCall = db.insert.mock.results[i].value as {
          values: ReturnType<typeof vi.fn>;
        };
        if (valuesCall?.values?.mock?.calls?.length) {
          results.push(...valuesCall.values.mock.calls.map((args: unknown[]) => args[0]));
        }
      }
    }
    return results;
  }

  // --------------------------------------------------------------------------
  // R1 — initiatePetTransferAction → pet_transfer_initiated
  // --------------------------------------------------------------------------
  it("R1: initiatePetTransferAction inserts auditLog with action=pet_transfer_initiated", async () => {
    mockRequireUser.mockResolvedValue(makeUserSession());
    const { initiatePetTransferAction } = await import("../actions");
    const { initiatePetTransfer } = await import("../application/initiate-pet-transfer");
    (initiatePetTransfer as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: {
        transferToken: "PTR-r1",
        petId: "pet-1",
        recipientNeedsInvite: false,
        petName: "Rex",
      },
      notifications: [],
    });
    await initiatePetTransferAction({ petToken: "tok", toEmail: "a@b.com", reason: "gift" });
    const audits = getAuditInserts();
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits).toContainEqual(
      expect.objectContaining({
        actorUserId: "user-1",
        action: "pet_transfer_initiated",
        payload: expect.objectContaining({
          transfer_public_token: "PTR-r1",
          pet_id: "pet-1",
          to_email: "a@b.com",
        }),
      }),
    );
  });

  // --------------------------------------------------------------------------
  // R2 — acceptPetTransferAction → pet_transfer_accepted
  // --------------------------------------------------------------------------
  it("R2: acceptPetTransferAction inserts auditLog with action=pet_transfer_accepted", async () => {
    mockRequireUser.mockResolvedValue(makeUserSession());
    const { acceptPetTransferAction } = await import("../actions");
    const { acceptPetTransfer } = await import("../application/accept-pet-transfer");
    (acceptPetTransfer as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: { petId: "pet-2", fromOwnerId: "sender-user" },
      notifications: [],
    });
    await acceptPetTransferAction("PTR-r2");
    const audits = getAuditInserts();
    expect(audits).toContainEqual(
      expect.objectContaining({
        actorUserId: "user-1",
        action: "pet_transfer_accepted",
        payload: expect.objectContaining({
          transfer_public_token: "PTR-r2",
          pet_id: "pet-2",
          from_user_id: "sender-user",
        }),
      }),
    );
  });

  // --------------------------------------------------------------------------
  // R3 — rejectPetTransferAction → pet_transfer_rejected
  // --------------------------------------------------------------------------
  it("R3: rejectPetTransferAction inserts auditLog with action=pet_transfer_rejected", async () => {
    mockRequireUser.mockResolvedValue(makeUserSession());
    const { rejectPetTransferAction } = await import("../actions");
    const { rejectPetTransfer } = await import("../application/reject-pet-transfer");
    (rejectPetTransfer as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: { petId: "pet-3" },
      notifications: [],
    });
    await rejectPetTransferAction({ transferToken: "PTR-r3", reason: "no quiero" });
    const audits = getAuditInserts();
    expect(audits).toContainEqual(
      expect.objectContaining({
        actorUserId: "user-1",
        action: "pet_transfer_rejected",
        payload: expect.objectContaining({
          transfer_public_token: "PTR-r3",
          pet_id: "pet-3",
          reason: "no quiero",
        }),
      }),
    );
  });

  // --------------------------------------------------------------------------
  // R4 — cancelPetTransferAction → pet_transfer_cancelled
  // --------------------------------------------------------------------------
  it("R4: cancelPetTransferAction inserts auditLog with action=pet_transfer_cancelled", async () => {
    mockRequireUser.mockResolvedValue(makeUserSession());
    const { cancelPetTransferAction } = await import("../actions");
    const { cancelPetTransfer } = await import("../application/cancel-pet-transfer");
    (cancelPetTransfer as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: { petId: "pet-4" },
      notifications: [],
    });
    await cancelPetTransferAction("PTR-r4");
    const audits = getAuditInserts();
    expect(audits).toContainEqual(
      expect.objectContaining({
        actorUserId: "user-1",
        action: "pet_transfer_cancelled",
        payload: expect.objectContaining({
          transfer_public_token: "PTR-r4",
          pet_id: "pet-4",
        }),
      }),
    );
  });

  // --------------------------------------------------------------------------
  // R6 — expirePetTransfersAction → pet_transfer_expired, actor=fromOwnerId per row
  // --------------------------------------------------------------------------
  it("R6: expirePetTransfersAction inserts auditLog per expired row with actor=fromOwnerId", async () => {
    const { expirePetTransfersAction } = await import("../actions");
    const { expirePetTransfers } = await import("../application/expire-pet-transfers");
    (expirePetTransfers as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: {
        expired: 2,
        errors: 0,
        auditEntries: [
          { actorUserId: "owner-a", transferToken: "PTR-e1", petId: "pet-e1" },
          { actorUserId: "owner-b", transferToken: "PTR-e2", petId: "pet-e2" },
        ],
      },
      notifications: [],
    });
    await expirePetTransfersAction();
    const audits = getAuditInserts();
    expect(audits).toContainEqual(
      expect.objectContaining({
        actorUserId: "owner-a",
        action: "pet_transfer_expired",
        payload: expect.objectContaining({ transfer_public_token: "PTR-e1", pet_id: "pet-e1" }),
      }),
    );
    expect(audits).toContainEqual(
      expect.objectContaining({
        actorUserId: "owner-b",
        action: "pet_transfer_expired",
        payload: expect.objectContaining({ transfer_public_token: "PTR-e2", pet_id: "pet-e2" }),
      }),
    );
  });

  // --------------------------------------------------------------------------
  // R7 — proposeCrossOrgTransferAction → cross_org_transfer_proposed
  // --------------------------------------------------------------------------
  it("R7: proposeCrossOrgTransferAction inserts auditLog with action=cross_org_transfer_proposed", async () => {
    mockRequireCapabilityForOrgToken.mockResolvedValue(makeAuth());
    const { proposeCrossOrgTransferAction } = await import("../actions");
    const { proposeCrossOrgTransfer } = await import("../application/propose-cross-org-transfer");
    (proposeCrossOrgTransfer as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: {
        publicCode: "CASE-r7",
        caseId: "case-r7",
        petId: "pet-r7",
        senderOrgId: "org-1",
        receiverOrgId: "org-2",
      },
      notifications: [],
    });
    await proposeCrossOrgTransferAction({
      senderOrgToken: "org-tok",
      petPublicToken: "pet-tok",
      receiverOrgId: "org-2",
      reason: "space_constraint",
    });
    const audits = getAuditInserts();
    expect(audits).toContainEqual(
      expect.objectContaining({
        actorUserId: "user-1",
        action: "cross_org_transfer_proposed",
        payload: expect.objectContaining({
          case_id: "case-r7",
          pet_id: "pet-r7",
          sender_org_id: "org-1",
          receiver_org_id: "org-2",
        }),
      }),
    );
  });

  // --------------------------------------------------------------------------
  // R8 — acceptCrossOrgTransferAction → cross_org_transfer_accepted
  // --------------------------------------------------------------------------
  it("R8: acceptCrossOrgTransferAction inserts auditLog with action=cross_org_transfer_accepted", async () => {
    mockRequireCapabilityForOrgToken.mockResolvedValue(makeAuth());
    const { acceptCrossOrgTransferAction } = await import("../actions");
    const { acceptCrossOrgTransfer } = await import("../application/accept-cross-org-transfer");
    (acceptCrossOrgTransfer as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: {
        publicCode: "CASE-r8",
        caseId: "case-r8",
        petId: "pet-r8",
        senderOrgId: "org-sender",
        receiverOrgId: "org-1",
      },
      notifications: [],
    });
    await acceptCrossOrgTransferAction({ receiverOrgToken: "org-tok", casePublicCode: "CASE-r8" });
    const audits = getAuditInserts();
    expect(audits).toContainEqual(
      expect.objectContaining({
        actorUserId: "user-1",
        action: "cross_org_transfer_accepted",
        payload: expect.objectContaining({
          case_id: "case-r8",
          pet_id: "pet-r8",
          sender_org_id: "org-sender",
          receiver_org_id: "org-1",
        }),
      }),
    );
  });

  // --------------------------------------------------------------------------
  // R9 — rejectCrossOrgTransferAction → cross_org_transfer_rejected
  // --------------------------------------------------------------------------
  it("R9: rejectCrossOrgTransferAction inserts auditLog with action=cross_org_transfer_rejected", async () => {
    mockRequireCapabilityForOrgToken.mockResolvedValue(makeAuth());
    const { rejectCrossOrgTransferAction } = await import("../actions");
    const { rejectCrossOrgTransfer } = await import("../application/reject-cross-org-transfer");
    (rejectCrossOrgTransfer as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: {
        publicCode: "CASE-r9",
        caseId: "case-r9",
        petId: "pet-r9",
        senderOrgId: "org-sender",
        receiverOrgId: "org-1",
      },
      notifications: [],
    });
    await rejectCrossOrgTransferAction({
      receiverOrgToken: "org-tok",
      casePublicCode: "CASE-r9",
      reason: "no capacity",
    });
    const audits = getAuditInserts();
    expect(audits).toContainEqual(
      expect.objectContaining({
        actorUserId: "user-1",
        action: "cross_org_transfer_rejected",
        payload: expect.objectContaining({
          case_id: "case-r9",
          pet_id: "pet-r9",
          sender_org_id: "org-sender",
          receiver_org_id: "org-1",
        }),
      }),
    );
  });

  // --------------------------------------------------------------------------
  // R10 — cancelCrossOrgTransferAction → cross_org_transfer_cancelled_by_sender
  // --------------------------------------------------------------------------
  it("R10: cancelCrossOrgTransferAction inserts auditLog with action=cross_org_transfer_cancelled_by_sender", async () => {
    mockRequireCapabilityForOrgToken.mockResolvedValue(makeAuth());
    const { cancelCrossOrgTransferAction } = await import("../actions");
    const { cancelCrossOrgTransfer } = await import("../application/cancel-cross-org-transfer");
    (cancelCrossOrgTransfer as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: {
        publicCode: "CASE-r10",
        caseId: "case-r10",
        petId: "pet-r10",
        senderOrgId: "org-1",
        receiverOrgId: "org-receiver",
      },
      notifications: [],
    });
    await cancelCrossOrgTransferAction({
      senderOrgToken: "org-tok",
      casePublicCode: "CASE-r10",
      reason: "changed plans",
    });
    const audits = getAuditInserts();
    expect(audits).toContainEqual(
      expect.objectContaining({
        actorUserId: "user-1",
        action: "cross_org_transfer_cancelled_by_sender",
        payload: expect.objectContaining({
          case_id: "case-r10",
          pet_id: "pet-r10",
          sender_org_id: "org-1",
          receiver_org_id: "org-receiver",
        }),
      }),
    );
  });
});

// ===========================================================================
// W-2: acceptPetTransferAction — specific-path revalidation
// ===========================================================================

describe("W-2: acceptPetTransferAction — specific petPublicToken revalidation", () => {
  let acceptPetTransferAction: (...args: any[]) => Promise<any>;
  let acceptPetTransferUc: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(makeUserSession());
    const actions = await import("../actions");
    acceptPetTransferAction = actions.acceptPetTransferAction;
    const ucModule = await import("../application/accept-pet-transfer");
    acceptPetTransferUc = ucModule.acceptPetTransfer as ReturnType<typeof vi.fn>;
  });

  afterEach(() => vi.resetModules());

  it("W-2: calls revalidatePath on specific pet page when use-case returns petPublicToken", async () => {
    const { revalidatePath } = await import("next/cache");
    acceptPetTransferUc.mockResolvedValue({
      ok: true,
      value: { petId: "pet-1", fromOwnerId: "sender-user", petPublicToken: "PET-tok-123" },
      notifications: [],
    });
    await acceptPetTransferAction("PTR-w2");
    expect(revalidatePath).toHaveBeenCalledWith("/mis-mascotas/PET-tok-123");
  });
});
