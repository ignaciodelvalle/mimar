// Unit tests for finalizeAdoption use-case.
// All DB interactions faked via repo spies — no real Postgres needed.
// TDD cycle: RED (this file) → GREEN (finalize-adoption.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdoptionRepository } from "../../infrastructure/adoption-repository";
import { finalizeAdoption } from "../finalize-adoption";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeEligiblePet(overrides: Record<string, unknown> = {}) {
  return {
    id: "pet-1",
    name: "Max",
    publicToken: "tok-1",
    adoptionEligible: true,
    adoptionIneligibleReason: null,
    status: "active",
    custodyOwnershipId: "own-custody-1",
    ...overrides,
  };
}

function makeFosterRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "own-foster-1",
    ownerUserId: "foster-user-1",
    ...overrides,
  };
}

function makeAdopterProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: "adopter-user-1",
    accountType: "personal",
    role: "owner",
    dniVerified: true,
    ...overrides,
  };
}

type Tx = unknown;

type DniAccount = {
  id: string;
  displayName: string;
  dniVerified: boolean;
  hasAuthAccount: boolean;
};

/** A registered account (auth.users row exists). dniVerified=true by default. */
function makeDniAccount(overrides: Partial<DniAccount> = {}): DniAccount {
  return {
    id: "existing-user-id",
    displayName: "Juan Pérez",
    dniVerified: true,
    hasAuthAccount: true,
    ...overrides,
  };
}

// Full fake repo with all methods needed by finalizeAdoption.
function makeFakeRepo(
  options: {
    pet?: Record<string, unknown> | null;
    foster?: Record<string, unknown> | null;
    /** Registered-account lookup result. Default: a registered account. */
    dniAccount?: DniAccount | null;
    adopterProfile?: Record<string, unknown> | null;
    approvedApplication?: { applicantUserId: string } | { error: string };
  } = {},
): typeof AdoptionRepository {
  const pet = options.pet !== undefined ? options.pet : makeEligiblePet();
  const foster = options.foster !== undefined ? options.foster : null;
  const dniAccount = options.dniAccount !== undefined ? options.dniAccount : makeDniAccount();

  return {
    findShelterPet: vi.fn().mockResolvedValue(pet),
    findActiveFoster: vi.fn().mockResolvedValue(foster),
    findAdopterAccountByDni: vi.fn().mockResolvedValue(dniAccount),
    findApplicantProfile: vi.fn().mockResolvedValue(options.adopterProfile ?? null),
    findApprovedApplicationForFinalize: vi
      .fn()
      .mockResolvedValue(
        options.approvedApplication ?? { error: "no approved application configured" },
      ),
    setEligibility: vi.fn().mockResolvedValue(undefined),
    setListingStatus: vi.fn().mockResolvedValue(undefined),
    updateListingContent: vi.fn().mockResolvedValue(undefined),
    insertApplication: vi.fn().mockResolvedValue({ eventId: "evt-1" }),
    resolveApplication: vi.fn().mockResolvedValue(undefined),
    findPetForApplication: vi.fn().mockResolvedValue(null),
    findExistingApplication: vi.fn().mockResolvedValue(null),
    findOrgMembersForNotify: vi.fn().mockResolvedValue([]),
    findApplicationForReview: vi.fn().mockResolvedValue({ error: "not used" }),
    findPendingApplicationsExcluding: vi.fn().mockResolvedValue([]),
    findOpenCustodyCase: vi.fn().mockResolvedValue(null),
    // The custody row, re-read FOR UPDATE at the top of the finalize
    // transaction (rehome-by-titular WU5 carry-forward 3). Live by default —
    // the race tests below override it with null.
    lockLiveCustodyRow: vi.fn().mockResolvedValue({ id: "own-custody-1" }),
    // The pet-scoped advisory lock every custody writer of rehome-by-titular
    // takes FIRST (WU5 review: lock-order deadlock with the titular's withdraw).
    acquirePetAdvisoryLock: vi.fn().mockResolvedValue(undefined),
    // `endedCaretakerGrants` is part of the return contract, not decoration: the
    // use-case reads its length to decide whether to notify a caretaker whose
    // arrangement the hand-off just ended. A double that omits it is a double
    // the real repository could never produce.
    insertAdoptionFinalized: vi
      .fn()
      .mockResolvedValue({ eventId: "evt-adoption-1", endedCaretakerGrants: [] }),
  } as unknown as typeof AdoptionRepository;
}

const fakeTransaction = vi
  .fn()
  .mockImplementation(async (cb: (tx: Tx) => unknown) => cb("fake-tx"));

const actor = {
  user: { id: "org-user-1" },
  organization: {
    id: "org-1",
    publicToken: "org-tok",
    verified: true,
    displayName: "Refugio Test",
  },
};

const baseInput = {
  petPublicToken: "tok-1",
  applicationEventId: null,
  adopterUserId: null,
  adopterDni: "12345678",
  adopterDisplayName: "Juan Pérez",
  adopterPhone: null,
  followupMonths: null,
  notes: null,
  contractAttachmentId: null,
  contractStoragePath: null,
  contractMimeType: null,
  contractFileSize: null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("finalizeAdoption", () => {
  beforeEach(() => {
    fakeTransaction.mockClear();
  });

  // ---- Input validation (domain rules via use-case) ----------------------

  it("returns error when DNI missing in manual flow", async () => {
    const repo = makeFakeRepo();
    const result = await finalizeAdoption(
      { ...baseInput, adopterDni: "" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/DNI/i);
  });

  it("returns error when DNI format invalid (10 digits)", async () => {
    const repo = makeFakeRepo();
    const result = await finalizeAdoption(
      { ...baseInput, adopterDni: "1234567890" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/7 a 9 dígitos/i);
  });

  it("returns error when pet not found in org shelter custody", async () => {
    const repo = makeFakeRepo({ pet: null });
    const result = await finalizeAdoption(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/no encontrada/i);
  });

  // ---- Eligibility gate -------------------------------------------------

  it("returns error when pet has eligibility=false with reason", async () => {
    const repo = makeFakeRepo({
      pet: makeEligiblePet({ adoptionEligible: false, adoptionIneligibleReason: "age" }),
    });
    const result = await finalizeAdoption(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/no apta/i);
    expect((result as { ok: false; error: string }).error).toMatch(/age/i);
  });

  it("returns error when pet eligibility is null (not evaluated)", async () => {
    const repo = makeFakeRepo({
      pet: makeEligiblePet({ adoptionEligible: null }),
    });
    const result = await finalizeAdoption(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/evaluada/i);
  });

  // ---- Foster-shortcut path --------------------------------------------

  it("returns error when adopterUserId is supplied but is not the active foster", async () => {
    const repo = makeFakeRepo({
      foster: makeFosterRow({ ownerUserId: "foster-user-1" }),
    });
    const result = await finalizeAdoption(
      { ...baseInput, adopterUserId: "some-other-user", adopterDni: null },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/tránsito activo/i);
  });

  it("returns error when adopterUserId is the foster but profile not personal+dniVerified", async () => {
    const repo = makeFakeRepo({
      foster: makeFosterRow({ ownerUserId: "foster-user-1" }),
      adopterProfile: makeAdopterProfile({ dniVerified: false }),
    });
    const result = await finalizeAdoption(
      { ...baseInput, adopterUserId: "foster-user-1", adopterDni: null },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/verificado/i);
  });

  it("returns error when adopterProfile not found for foster-shortcut", async () => {
    const repo = makeFakeRepo({
      foster: makeFosterRow({ ownerUserId: "foster-user-1" }),
      adopterProfile: null,
    });
    const result = await finalizeAdoption(
      { ...baseInput, adopterUserId: "foster-user-1", adopterDni: null },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/perfil/i);
  });

  // ---- Successful atomic write -----------------------------------------

  it("calls insertAdoptionFinalized inside a transaction on valid DNI input", async () => {
    const repo = makeFakeRepo();
    const result = await finalizeAdoption(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: true });
    expect(fakeTransaction).toHaveBeenCalledOnce();
    expect(repo.insertAdoptionFinalized).toHaveBeenCalledWith(
      expect.objectContaining({
        petId: "pet-1",
        orgId: "org-1",
        userId: "org-user-1",
      }),
      "fake-tx",
    );
  });

  it("uses the registered account's real userId when DNI matches", async () => {
    const repo = makeFakeRepo({ dniAccount: makeDniAccount({ id: "existing-user-id" }) });
    await finalizeAdoption(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(repo.insertAdoptionFinalized).toHaveBeenCalledWith(
      expect.objectContaining({
        adopterUserId: "existing-user-id",
      }),
      "fake-tx",
    );
  });

  // ---- Registered-adopter refusal branches (org-pilot-pack) --------------
  // Reconciliation contract: match = dniHash match + auth.users row EXISTS.
  // No dniVerified requirement. Legacy stubs (no auth row) refuse.

  it("refuses when no profiles row matches the DNI (no stub is ever created)", async () => {
    const repo = makeFakeRepo({ dniAccount: null });
    const result = await finalizeAdoption(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/cuenta miMAR/i);
    expect(repo.insertAdoptionFinalized).not.toHaveBeenCalled();
    expect(fakeTransaction).not.toHaveBeenCalled();
  });

  it("refuses a legacy stub profile (matching hash but NO auth.users row)", async () => {
    const repo = makeFakeRepo({
      dniAccount: makeDniAccount({ id: "stub-user-id", hasAuthAccount: false }),
    });
    const result = await finalizeAdoption(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/cuenta miMAR/i);
    expect(repo.insertAdoptionFinalized).not.toHaveBeenCalled();
  });

  it("proceeds for a registered account even when dniVerified=false (reconciliation contract)", async () => {
    // A walk-in adopter who registered on the spot: auth account exists,
    // DNI captured at signup but not yet verified. MUST match.
    const repo = makeFakeRepo({
      dniAccount: makeDniAccount({ id: "fresh-signup-id", dniVerified: false }),
    });
    const result = await finalizeAdoption(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: true });
    expect(repo.insertAdoptionFinalized).toHaveBeenCalledWith(
      expect.objectContaining({
        adopterUserId: "fresh-signup-id",
      }),
      "fake-tx",
    );
  });

  // ---- Foster-shortcut happy path --------------------------------------

  it("uses adopterUserId directly when foster-shortcut path is valid", async () => {
    const repo = makeFakeRepo({
      foster: makeFosterRow({ ownerUserId: "foster-user-1" }),
      adopterProfile: makeAdopterProfile({ id: "foster-user-1" }),
    });
    const result = await finalizeAdoption(
      { ...baseInput, adopterUserId: "foster-user-1", adopterDni: null },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: true });
    expect(repo.insertAdoptionFinalized).toHaveBeenCalledWith(
      expect.objectContaining({
        adopterUserId: "foster-user-1",
      }),
      "fake-tx",
    );
  });

  // ---- Approved-application path ---------------------------------------

  it("transfers ownership to the applicant's account when finalizing from an approved application", async () => {
    const repo = makeFakeRepo({
      approvedApplication: { applicantUserId: "applicant-user-1" },
    });
    const result = await finalizeAdoption(
      { ...baseInput, applicationEventId: "app-evt-1", adopterDni: null, adopterDisplayName: "" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: true });
    // Ownership lands on the applicant's REAL account, not a stub.
    expect(repo.insertAdoptionFinalized).toHaveBeenCalledWith(
      expect.objectContaining({
        adopterUserId: "applicant-user-1",
        adoptedFromApplicationId: "app-evt-1",
      }),
      "fake-tx",
    );
    // The approved application was resolved against the event log, org-scoped.
    expect(repo.findApprovedApplicationForFinalize).toHaveBeenCalledWith(
      "app-evt-1",
      "org-1",
      "pet-1",
    );
  });

  it("emits an adoption_finalized notification to the applicant on the application path", async () => {
    const repo = makeFakeRepo({
      approvedApplication: { applicantUserId: "applicant-user-1" },
    });
    const result = await finalizeAdoption(
      { ...baseInput, applicationEventId: "app-evt-1", adopterDni: null, adopterDisplayName: "" },
      { repo, actor, transaction: fakeTransaction },
    );
    const r = result as {
      ok: true;
      notifications: { notificationType: string; userId: string; ctaUrl?: string | null }[];
    };
    const finalized = r.notifications.find((n) => n.notificationType === "adoption_finalized");
    expect(finalized).toBeDefined();
    expect(finalized?.userId).toBe("applicant-user-1");
    expect(finalized?.ctaUrl).toBe("/mis-mascotas");
  });

  it("returns the repository error when the selected application is not approved", async () => {
    const repo = makeFakeRepo({
      approvedApplication: { error: "La postulación seleccionada no está aprobada." },
    });
    const result = await finalizeAdoption(
      { ...baseInput, applicationEventId: "app-evt-1", adopterDni: null, adopterDisplayName: "" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/no está aprobada/i);
    expect(repo.insertAdoptionFinalized).not.toHaveBeenCalled();
  });

  // ---- Notifications best-effort (returned, not flushed) ---------------

  it("returns notifications in result array (not flushed inside use-case)", async () => {
    const repo = makeFakeRepo();
    const result = await finalizeAdoption(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: true });
    const r = result as { ok: true; notifications: unknown[] };
    expect(Array.isArray(r.notifications)).toBe(true);
  });

  it("returns adoption_finalized notification for the registered adopter", async () => {
    const repo = makeFakeRepo({ dniAccount: makeDniAccount({ id: "existing-user-id" }) });
    const result = await finalizeAdoption(baseInput, { repo, actor, transaction: fakeTransaction });
    const r = result as { ok: true; notifications: { notificationType: string }[] };
    expect(r.notifications.some((n) => n.notificationType === "adoption_finalized")).toBe(true);
  });

  it("every finalize notification carries category 'adoption' (UI-6)", async () => {
    // Foster path produces the broadest set: adoption_finalized + foster_ended_by_adoption.
    const repo = makeFakeRepo({
      foster: makeFosterRow({ ownerUserId: "foster-user-1" }),
      dniAccount: makeDniAccount({ id: "different-user-id" }),
    });
    const result = await finalizeAdoption(baseInput, { repo, actor, transaction: fakeTransaction });
    const r = result as { ok: true; notifications: { category?: string | null }[] };
    expect(r.notifications.length).toBeGreaterThan(0);
    expect(r.notifications.every((n) => n.category === "adoption")).toBe(true);
  });

  it("returns NO notifications on the refusal branch (nothing happened)", async () => {
    const repo = makeFakeRepo({ dniAccount: null });
    const result = await finalizeAdoption(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { notifications?: unknown[] }).notifications ?? []).toHaveLength(0);
  });

  it("returns foster_ended_by_adoption notification when foster is different from adopter", async () => {
    const repo = makeFakeRepo({
      foster: makeFosterRow({ ownerUserId: "foster-user-1" }),
      dniAccount: makeDniAccount({ id: "different-user-id" }),
    });
    const result = await finalizeAdoption(baseInput, { repo, actor, transaction: fakeTransaction });
    const r = result as { ok: true; notifications: { notificationType: string; userId: string }[] };
    const fosterNotif = r.notifications.find(
      (n) => n.notificationType === "foster_ended_by_adoption",
    );
    expect(fosterNotif).toBeDefined();
    expect(fosterNotif?.userId).toBe("foster-user-1");
  });

  it("does NOT return foster notification when foster IS the adopter", async () => {
    // Foster adopts via DNI path (foster-user-id matches a registered account)
    const repo = makeFakeRepo({
      foster: makeFosterRow({ ownerUserId: "foster-user-1" }),
      dniAccount: makeDniAccount({ id: "foster-user-1" }),
    });
    const result = await finalizeAdoption(baseInput, { repo, actor, transaction: fakeTransaction });
    const r = result as { ok: true; notifications: { notificationType: string }[] };
    expect(r.notifications.some((n) => n.notificationType === "foster_ended_by_adoption")).toBe(
      false,
    );
  });

  // ---- Atomicity / rollback: transaction is what prevents partial state ----

  it("propagates error from insertAdoptionFinalized (simulates tx rollback)", async () => {
    const repo = makeFakeRepo();
    (
      repo as unknown as { insertAdoptionFinalized: ReturnType<typeof vi.fn> }
    ).insertAdoptionFinalized.mockRejectedValue(new Error("DB constraint violation"));

    // fakeTransaction propagates errors from the callback
    const throwingTx = vi.fn().mockImplementation(async (cb: (tx: Tx) => unknown) => cb("fake-tx"));

    const result = await finalizeAdoption(baseInput, { repo, actor, transaction: throwingTx });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/finalizar/i);
  });

  // ---- The custody row is locked INSIDE the transaction ------------------
  //
  // rehome-by-titular, WU5 carry-forward 3. `findShelterPet` runs before the
  // transaction; nothing re-asserted custody inside it. A titular's withdraw
  // committing in between completed an adoption against a custody row that was
  // already closed — or wrote two contradictory `rehome_sponsorship_ended`
  // events (adopted + withdrawn_by_titular). The lock is what the spec's
  // "the titular's unpublish outranks the org's" (REQ-8) means at the row.

  it("refuses cleanly when the custody row is gone by the time the transaction locks it", async () => {
    const repo = makeFakeRepo();
    (repo as unknown as { lockLiveCustodyRow: ReturnType<typeof vi.fn> }).lockLiveCustodyRow = vi
      .fn()
      .mockResolvedValue(null);

    const result = await finalizeAdoption(baseInput, { repo, actor, transaction: fakeTransaction });

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/custodia/i);
    // The refusal is a sentence, not a wrapped Postgres message.
    expect((result as { ok: false; error: string }).error).not.toMatch(/No se pudo finalizar/);
    expect(repo.insertAdoptionFinalized).not.toHaveBeenCalled();
    expect(repo.resolveApplication).not.toHaveBeenCalled();
  });

  it("locks the custody row by id, inside the transaction, before any write", async () => {
    const repo = makeFakeRepo();
    const order: string[] = [];
    (repo as unknown as { lockLiveCustodyRow: ReturnType<typeof vi.fn> }).lockLiveCustodyRow = vi
      .fn()
      .mockImplementation(async () => {
        order.push("lock");
        return { id: "own-custody-1" };
      });
    (
      repo as unknown as { insertAdoptionFinalized: ReturnType<typeof vi.fn> }
    ).insertAdoptionFinalized = vi.fn().mockImplementation(async () => {
      order.push("write");
      return { eventId: "evt-adoption-1", endedCaretakerGrants: [] };
    });

    const result = await finalizeAdoption(baseInput, { repo, actor, transaction: fakeTransaction });

    expect(result.ok).toBe(true);
    expect(repo.lockLiveCustodyRow).toHaveBeenCalledWith("own-custody-1", "fake-tx");
    expect(order).toEqual(["lock", "write"]);
  });

  // ---- The pet advisory lock comes before the custody-row lock -----------
  //
  // WU5 review (LOW). Finalize locked the custody row and then closed the
  // owner row; the withdraw locked the owner row and then closed the custody
  // row — two transactions taking the same two row locks in opposite orders,
  // which Postgres resolves by killing one with 40P01. Both now take
  // `pg_advisory_xact_lock(hashtext(petId))` first; the row locks after it
  // cannot form a cycle.

  it("takes the pet advisory lock inside the transaction, before the custody-row lock", async () => {
    const repo = makeFakeRepo();
    const order: string[] = [];
    (
      repo as unknown as { acquirePetAdvisoryLock: ReturnType<typeof vi.fn> }
    ).acquirePetAdvisoryLock = vi.fn().mockImplementation(async () => {
      order.push("advisory");
    });
    (repo as unknown as { lockLiveCustodyRow: ReturnType<typeof vi.fn> }).lockLiveCustodyRow = vi
      .fn()
      .mockImplementation(async () => {
        order.push("row");
        return { id: "own-custody-1" };
      });

    const result = await finalizeAdoption(baseInput, { repo, actor, transaction: fakeTransaction });

    expect(result.ok).toBe(true);
    expect(repo.acquirePetAdvisoryLock).toHaveBeenCalledWith("pet-1", "fake-tx");
    expect(order).toEqual(["advisory", "row"]);
  });

  // ---- Follow-up reminders pass through for registered adopters ---------

  it("passes followupMonths through for a registered adopter (reminders enabled)", async () => {
    const repo = makeFakeRepo({ dniAccount: makeDniAccount({ id: "existing-user-id" }) });
    await finalizeAdoption(
      { ...baseInput, followupMonths: 6 },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(repo.insertAdoptionFinalized).toHaveBeenCalledWith(
      expect.objectContaining({ adopterUserId: "existing-user-id", followupMonths: 6 }),
      "fake-tx",
    );
  });
});
