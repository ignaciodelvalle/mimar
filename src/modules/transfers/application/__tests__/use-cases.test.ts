// Unit tests for all WU-3 transfers use-cases.
// TDD: RED → GREEN — tests written first, then implementations.
//
// Uses a fake TransfersRepository (vi.fn() stubs) — no DB, no Next.js.
// Each describe block covers one use-case; guards are tested per spec R1-R11.

import { validateEventPayload } from "@/lib/events/event-schemas";
import { notifyCaretakersOfHandoff } from "@/lib/infra/end-pet-ownerships";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SPONSORED_CUSTODY_TRANSFER_ERROR } from "../../domain/cross-org-rules";
import type { TransfersRepository } from "../../infrastructure/transfers-repository";

import { acceptCrossOrgTransfer } from "../accept-cross-org-transfer";
import { acceptPetTransfer } from "../accept-pet-transfer";
import { cancelCrossOrgTransfer } from "../cancel-cross-org-transfer";
import { cancelPetTransfer } from "../cancel-pet-transfer";
import { expireCrossOrgTransfers } from "../expire-cross-org-transfers";
import { expirePetTransfers } from "../expire-pet-transfers";
import { getTransferForViewer } from "../get-transfer-for-viewer";
// ---------------------------------------------------------------------------
// Imports — these will fail (RED) until implementation files exist
// ---------------------------------------------------------------------------
import { initiatePetTransfer } from "../initiate-pet-transfer";
import { proposeCrossOrgTransfer } from "../propose-cross-org-transfer";
import { rejectCrossOrgTransfer } from "../reject-cross-org-transfer";
import { rejectPetTransfer } from "../reject-pet-transfer";
import { transferCustody } from "../transfer-custody";

// The post-commit caretaker notice (A09-2) is the only runtime import from the
// hand-off primitive; the real one writes notifications through the DB.
vi.mock("@/lib/infra/end-pet-ownerships", () => ({ notifyCaretakersOfHandoff: vi.fn() }));

// ---------------------------------------------------------------------------
// Fake repo builder
// ---------------------------------------------------------------------------

function makePet(overrides: Record<string, unknown> = {}) {
  return {
    id: "pet-1",
    publicToken: "PT-tok",
    name: "Luna",
    status: "found",
    inCustodyDispute: false,
    jurisdictionProvince: null,
    jurisdictionLocality: null,
    ...overrides,
  };
}

function makeTransfer(overrides: Record<string, unknown> = {}) {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return {
    id: "tr-1",
    publicToken: "PTR-tok",
    petId: "pet-1",
    fromOwnerId: "user-sender",
    toOwnerId: "user-recipient",
    toOwnerEmail: "recipient@example.com",
    status: "pending",
    reason: "gift",
    note: null,
    expiresAt,
    respondedAt: null,
    rejectionReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeCase(overrides: Record<string, unknown> = {}) {
  return {
    id: "case-1",
    publicCode: "CASE-001",
    caseKind: "custody_transfer_handshake",
    status: "open",
    primaryPetId: "pet-1",
    openedByOrganizationId: "org-sender",
    receiverOrganizationId: "org-receiver",
    openedAt: new Date(),
    ...overrides,
  };
}

function makeOrg(overrides: Record<string, unknown> = {}) {
  return {
    id: "org-receiver",
    displayName: "Refugio Receptor",
    verified: true,
    status: "active",
    ...overrides,
  };
}

function makeProposalEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    petId: "pet-1",
    eventType: "custody_transfer_proposed",
    caseId: "case-1",
    payload: {
      from_organization_id: "org-sender",
      to_organization_id: "org-receiver",
      reason: "space_constraint",
    },
    recordedAt: new Date(),
    ...overrides,
  };
}

function makeFakeRepo(
  overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {},
): typeof TransfersRepository {
  return {
    // shared reads
    findPetByToken: vi.fn().mockResolvedValue(makePet()),
    findPetPublicTokenById: vi.fn().mockResolvedValue("PET-pub-tok"),
    orgPublicTokenById: vi.fn().mockResolvedValue("receiver-tok"),
    findActiveOwnerOwnership: vi
      .fn()
      .mockResolvedValue({ id: "own-1", ownerUserId: "user-sender" }),
    findPetStatusById: vi
      .fn()
      .mockResolvedValue({ status: "found", inCustodyDispute: false, name: "Luna" }),
    findUserIdByEmail: vi.fn().mockResolvedValue(null),
    // owner-flow writes
    insertPetTransfer: vi.fn().mockResolvedValue(undefined),
    findTransferByToken: vi.fn().mockResolvedValue(makeTransfer()),
    findTransferByIdForUpdate: vi.fn().mockResolvedValue(makeTransfer()),
    updateTransferStatus: vi.fn().mockResolvedValue(1),
    expirablePetTransfers: vi.fn().mockResolvedValue([]),
    closeOwnerOwnerships: vi.fn().mockResolvedValue({ endedCaretakerGrants: [] }),
    insertOwnerOwnership: vi.fn().mockResolvedValue({ id: "own-new" }),
    insertPetEvent: vi.fn().mockResolvedValue({ id: "evt-new" }),
    // cross-org reads
    findActiveShelterCustody: vi.fn().mockResolvedValue({ id: "cust-1" }),
    findActiveOwnerOwnershipForOrg: vi.fn().mockResolvedValue({ id: "own-src" }),
    findLiveOrgShelterCustody: vi.fn().mockResolvedValue(null),
    findOpenSponsorship: vi.fn().mockResolvedValue(null),
    findReceiverOrg: vi.fn().mockResolvedValue(makeOrg()),
    findOpenHandshakeCase: vi.fn().mockResolvedValue(null),
    findOpenDispute: vi.fn().mockResolvedValue(null),
    openHandshakeCase: vi.fn().mockResolvedValue(makeCase()),
    proposalEventsForCase: vi.fn().mockResolvedValue([makeProposalEvent()]),
    endShelterCustody: vi.fn().mockResolvedValue(undefined),
    endOwnerOwnershipForOrg: vi.fn().mockResolvedValue(undefined),
    insertShelterCustody: vi.fn().mockResolvedValue({ id: "cust-new" }),
    orgCoordinatorAdminUserIds: vi.fn().mockResolvedValue([{ userId: "coord-1" }]),
    closeCase: vi.fn().mockResolvedValue(undefined),
    findOpenCustodyEpisode: vi.fn().mockResolvedValue(null),
    // direct-transfer reads
    findPetUnderOrg: vi.fn().mockResolvedValue({
      pet: makePet(),
      ownershipId: "own-src",
      ownershipRole: "shelter_custody",
    }),
    findActiveFosterRow: vi.fn().mockResolvedValue(null),
    orgAdminUserIds: vi.fn().mockResolvedValue([{ userId: "admin-1" }]),
    // direct-transfer writes
    closeOwnershipById: vi.fn().mockResolvedValue(undefined),
    closeFosterOwnership: vi.fn().mockResolvedValue(undefined),
    // notifications
    insertNotifications: vi.fn().mockResolvedValue(undefined),
    // cross-org case lookup by publicCode (for accept/reject/cancel)
    findCaseByPublicCode: vi.fn().mockResolvedValue(makeCase()),
    // cross-org concurrency guard (advisory lock + in-tx case status re-check)
    acquirePetAdvisoryLock: vi.fn().mockResolvedValue(undefined),
    caseStatusById: vi.fn().mockResolvedValue("open"),
    // cross-org expiry (repo-level helpers pulled from lib)
    findExpirableCrossOrgCases: vi.fn().mockResolvedValue([]),
    expireOneCrossOrgCase: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as typeof TransfersRepository;
}

const fakeTx = "fake-tx" as unknown;
// fakeTransaction is a module-level let so each beforeEach can re-set the
// implementation after mockClear, avoiding a vitest 4.x timing issue where
// mockClear() across multiple describe blocks drops the implementation.
let fakeTransaction = vi
  .fn()
  .mockImplementation(async (cb: (tx: unknown) => unknown) => cb(fakeTx));

// ---------------------------------------------------------------------------
// R1 — initiatePetTransfer
// ---------------------------------------------------------------------------

describe("initiatePetTransfer", () => {
  const actor = { user: { id: "user-sender" } };
  const baseInput = {
    petToken: "PT-tok",
    toEmail: "recipient@example.com",
    reason: "gift",
    note: null as string | null,
    callerEmail: "sender@example.com",
  };

  beforeEach(() => {
    fakeTransaction = vi
      .fn()
      .mockImplementation(async (cb: (tx: unknown) => unknown) => cb(fakeTx));
  });

  it("returns error for invalid email", async () => {
    const repo = makeFakeRepo();
    const result = await initiatePetTransfer(
      { ...baseInput, toEmail: "not-an-email" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/email/i);
  });

  it("returns error for invalid reason", async () => {
    const repo = makeFakeRepo();
    const result = await initiatePetTransfer(
      { ...baseInput, reason: "random" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/motivo/i);
  });

  it("returns error when pet not found", async () => {
    const repo = makeFakeRepo({ findPetByToken: vi.fn().mockResolvedValue(null) });
    const result = await initiatePetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("returns error when pet is deceased", async () => {
    const repo = makeFakeRepo({
      findPetByToken: vi.fn().mockResolvedValue(makePet({ status: "deceased" })),
    });
    const result = await initiatePetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/fallecida/i);
  });

  it("returns error when pet is lost", async () => {
    const repo = makeFakeRepo({
      findPetByToken: vi.fn().mockResolvedValue(makePet({ status: "lost" })),
    });
    const result = await initiatePetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/perdida/i);
  });

  it("returns error when pet is in custody dispute", async () => {
    const repo = makeFakeRepo({
      findPetByToken: vi.fn().mockResolvedValue(makePet({ inCustodyDispute: true })),
    });
    const result = await initiatePetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/disputa/i);
  });

  it("returns error when caller is not the active owner", async () => {
    const repo = makeFakeRepo({
      findActiveOwnerOwnership: vi.fn().mockResolvedValue(null),
    });
    const result = await initiatePetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/dueño actual/i);
  });

  it("returns error when caller owns and tries self-transfer", async () => {
    const repo = makeFakeRepo({
      findUserIdByEmail: vi.fn().mockResolvedValue("user-sender"),
    });
    const result = await initiatePetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/mismo/i);
  });

  it("succeeds and calls insertPetTransfer", async () => {
    const repo = makeFakeRepo();
    const result = await initiatePetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: true });
    expect(repo.insertPetTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ petId: "pet-1", fromOwnerId: "user-sender" }),
      fakeTx,
    );
  });

  it("returns transferToken with PTR- prefix", async () => {
    const repo = makeFakeRepo();
    const result = await initiatePetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    const r = result as { ok: true; value: { transferToken: string } };
    expect(r.value.transferToken).toMatch(/^PTR-/);
  });

  it("returns sender notification", async () => {
    const repo = makeFakeRepo();
    const result = await initiatePetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    const r = result as { ok: true; notifications: { notificationType: string; userId: string }[] };
    const n = r.notifications.find((n) => n.notificationType === "pet_transfer_initiated");
    expect(n).toBeDefined();
    expect(n?.userId).toBe("user-sender");
  });

  it("returns recipient notification when recipient known", async () => {
    const repo = makeFakeRepo({
      findUserIdByEmail: vi.fn().mockResolvedValue("user-recipient"),
    });
    const result = await initiatePetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    const r = result as { ok: true; notifications: { notificationType: string; userId: string }[] };
    const n = r.notifications.find((n) => n.notificationType === "pet_transfer_received");
    expect(n).toBeDefined();
    expect(n?.userId).toBe("user-recipient");
  });

  it("does not return recipient notification when recipient unknown (invite path)", async () => {
    const repo = makeFakeRepo();
    const result = await initiatePetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    const r = result as { ok: true; notifications: { notificationType: string }[] };
    const n = r.notifications.find((n) => n.notificationType === "pet_transfer_received");
    expect(n).toBeUndefined();
  });

  // H-1: a P2P transfer closes the titular's owner row and leaves an org's
  // rehome sponsorship untouched — the catalogue keeps saying "vive con su
  // familia" about someone else's animal and the shelter keeps the power to
  // finalise an adoption over the new owner's head. Same REQ-15 refusal the
  // cross-org twin already gives, aimed at the titular instead of the org.
  it("refuses to open a transfer while a rehome sponsorship is running (REQ-15)", async () => {
    const repo = makeFakeRepo({
      findOpenSponsorship: vi.fn().mockResolvedValue({ ownershipId: "cust-1" }),
    });
    const result = await initiatePetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/acompañamiento/i);
    expect((result as { ok: false; error: string }).error).toMatch(/dar de baja/i);
    expect(repo.findOpenSponsorship).toHaveBeenCalledWith("pet-1");
    expect(repo.insertPetTransfer).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// R2 — acceptPetTransfer
// ---------------------------------------------------------------------------

describe("acceptPetTransfer", () => {
  const actor = { user: { id: "user-recipient" } };
  const baseInput = {
    transferToken: "PTR-tok",
    callerEmail: "recipient@example.com",
    // The ordinary case: GoTrue holds a non-null `email_confirmed_at`. The
    // A09-1 block below flips it.
    callerEmailConfirmed: true,
  };

  beforeEach(() => {
    fakeTransaction = vi
      .fn()
      .mockImplementation(async (cb: (tx: unknown) => unknown) => cb(fakeTx));
  });

  it("takes the pet advisory lock as the FIRST statement of the transaction (audit K, W4)", async () => {
    // Before the transfer-row lock and before every read that decides the
    // hand-off (pet status/dispute, current owner, open sponsorship): each of
    // those is only a guard if no other custody writer can commit between it
    // and the write, and they all serialise on this one key.
    const calls: string[] = [];
    const track =
      (name: string, value: unknown) =>
      async (..._args: unknown[]) => {
        calls.push(name);
        return value;
      };
    const repo = makeFakeRepo({
      acquirePetAdvisoryLock: vi.fn().mockImplementation(track("lock", undefined)),
      findTransferByIdForUpdate: vi
        .fn()
        .mockImplementation(track("transfer-for-update", makeTransfer())),
      findPetStatusById: vi.fn().mockImplementation(
        track("pet-status", {
          status: "active",
          inCustodyDispute: false,
          name: "Max",
          deletedAt: null,
        }),
      ),
      findActiveOwnerOwnership: vi
        .fn()
        .mockImplementation(track("current-owner", { id: "own-1", ownerUserId: "user-sender" })),
      findOpenSponsorship: vi.fn().mockImplementation(track("sponsorship", null)),
    });

    const result = await acceptPetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: true });
    expect(repo.acquirePetAdvisoryLock).toHaveBeenCalledWith("pet-1", fakeTx);
    expect(calls.slice(0, 5)).toEqual([
      "lock",
      "transfer-for-update",
      "pet-status",
      "current-owner",
      "sponsorship",
    ]);
  });

  it("returns error when transfer not found", async () => {
    const repo = makeFakeRepo({ findTransferByToken: vi.fn().mockResolvedValue(null) });
    const result = await acceptPetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/no encontrada/i);
  });

  it("returns error when transfer is not pending", async () => {
    const repo = makeFakeRepo({
      findTransferByToken: vi.fn().mockResolvedValue(makeTransfer({ status: "accepted" })),
    });
    const result = await acceptPetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/accepted|aceptada/i);
  });

  it("returns error when transfer is expired", async () => {
    const repo = makeFakeRepo({
      findTransferByToken: vi
        .fn()
        .mockResolvedValue(makeTransfer({ expiresAt: new Date(Date.now() - 1000) })),
    });
    const result = await acceptPetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/expir/i);
  });

  it("returns error when caller is not the recipient (id mismatch)", async () => {
    const repo = makeFakeRepo({
      findTransferByToken: vi.fn().mockResolvedValue(makeTransfer({ toOwnerId: "other-user" })),
    });
    const result = await acceptPetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/propuesta no es para/i);
  });

  it("returns error when caller is the sender (own transfer)", async () => {
    const repo = makeFakeRepo({
      findTransferByToken: vi
        .fn()
        .mockResolvedValue(
          makeTransfer({ fromOwnerId: "user-recipient", toOwnerId: "user-recipient" }),
        ),
    });
    const result = await acceptPetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/propia/i);
  });

  it("accepts by email when toOwnerId is null and email matches", async () => {
    const repo = makeFakeRepo({
      findTransferByToken: vi
        .fn()
        .mockResolvedValue(
          makeTransfer({ toOwnerId: null, toOwnerEmail: "recipient@example.com" }),
        ),
      findPetByToken: vi.fn().mockResolvedValue(makePet()),
    });
    const result = await acceptPetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: true });
  });

  // -------------------------------------------------------------------------
  // A09-1: an UNCONFIRMED address is not addressee proof.
  //
  // The exploit these two close: `to_owner_id` is NULL when the invited address
  // had no account, so the e-mail arm is the whole of the proof. Somebody who
  // merely KNOWS the address could register it and accept — and the write here
  // is a change of who owns an animal in the national registry, so "nothing was
  // written" is the assertion that matters, not just the refusal sentence.
  // -------------------------------------------------------------------------

  it("A09-1: refuses an e-mail-arm accept when the caller's address is unconfirmed", async () => {
    const repo = makeFakeRepo({
      findTransferByToken: vi
        .fn()
        .mockResolvedValue(
          makeTransfer({ toOwnerId: null, toOwnerEmail: "recipient@example.com" }),
        ),
      findPetByToken: vi.fn().mockResolvedValue(makePet()),
    });
    const result = await acceptPetTransfer(
      { ...baseInput, callerEmailConfirmed: false },
      { repo, actor, transaction: fakeTransaction },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "Confirmá tu correo electrónico para aceptar esta transferencia.",
    });
  });

  it("A09-1: that refusal writes NOTHING — no ownership row, no event, no status flip", async () => {
    const repo = makeFakeRepo({
      findTransferByToken: vi
        .fn()
        .mockResolvedValue(
          makeTransfer({ toOwnerId: null, toOwnerEmail: "recipient@example.com" }),
        ),
      findPetByToken: vi.fn().mockResolvedValue(makePet()),
    });
    await acceptPetTransfer(
      { ...baseInput, callerEmailConfirmed: false },
      { repo, actor, transaction: fakeTransaction },
    );

    expect(fakeTransaction).not.toHaveBeenCalled();
    expect(repo.closeOwnerOwnerships).not.toHaveBeenCalled();
    expect(repo.insertOwnerOwnership).not.toHaveBeenCalled();
    expect(repo.insertPetEvent).not.toHaveBeenCalled();
    expect(repo.updateTransferStatus).not.toHaveBeenCalled();
  });

  it("A09-1: the ID arm still accepts with an unconfirmed address", async () => {
    // Non-vacuity control for the two cases above: they must refuse because the
    // ADDRESS was unproved, not because `callerEmailConfirmed: false` refuses
    // everything. A recipient the sender resolved by id at initiate time is
    // unaffected by the new term.
    const repo = makeFakeRepo({
      findTransferByToken: vi.fn().mockResolvedValue(makeTransfer({ toOwnerId: "user-recipient" })),
    });
    const result = await acceptPetTransfer(
      { ...baseInput, callerEmailConfirmed: false },
      { repo, actor, transaction: fakeTransaction },
    );

    expect(result).toMatchObject({ ok: true });
    expect(repo.insertOwnerOwnership).toHaveBeenCalledTimes(1);
  });

  it("calls closeOwnerOwnerships then insertOwnerOwnership inside tx", async () => {
    const repo = makeFakeRepo();
    await acceptPetTransfer(baseInput, { repo, actor, transaction: fakeTransaction });
    // A09-2: the accepting user signs the caretaker_ended facts the close emits.
    expect(repo.closeOwnerOwnerships).toHaveBeenCalledWith("pet-1", fakeTx, {
      actorUserId: "user-recipient",
      now: expect.any(Date),
    });
    expect(repo.insertOwnerOwnership).toHaveBeenCalledWith(
      expect.objectContaining({ petId: "pet-1", ownerUserId: "user-recipient" }),
      fakeTx,
    );
  });

  // A09-2: the P2P hand-off ends every caretaker arrangement on the pet (the
  // repo's close does that); the caretaker — who may be holding the animal —
  // must be told, after commit, exactly as finalize-adoption does.
  it("A09-2: notifies the caretakers the hand-off ended, after commit", async () => {
    const ended = [
      {
        grantId: "grant-1",
        petId: "pet-1",
        caretakerUserId: "user-caretaker",
        grantedByUserId: "user-sender",
        endsAt: new Date("2026-12-01T00:00:00Z"),
      },
    ];
    const notify = vi.mocked(notifyCaretakersOfHandoff);
    notify.mockClear();
    let committed = false;
    const tx = vi.fn().mockImplementation(async (cb: (t: unknown) => unknown) => {
      const r = await cb(fakeTx);
      committed = true;
      return r;
    });
    notify.mockImplementation(async () => {
      expect(committed).toBe(true);
    });
    const repo = makeFakeRepo({
      closeOwnerOwnerships: vi.fn().mockResolvedValue({ endedCaretakerGrants: ended }),
    });

    const result = await acceptPetTransfer(baseInput, { repo, actor, transaction: tx });

    expect(result).toMatchObject({ ok: true });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(ended, { name: "Luna", publicToken: "PET-pub-tok" });
  });

  it("A09-2: a rolled-back accept notifies nobody", async () => {
    const notify = vi.mocked(notifyCaretakersOfHandoff);
    notify.mockClear();
    const repo = makeFakeRepo({
      closeOwnerOwnerships: vi.fn().mockResolvedValue({
        endedCaretakerGrants: [
          {
            grantId: "grant-1",
            petId: "pet-1",
            caretakerUserId: "user-caretaker",
            grantedByUserId: "user-sender",
            endsAt: new Date(),
          },
        ],
      }),
      updateTransferStatus: vi.fn().mockResolvedValue(0),
    });

    const result = await acceptPetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });

    expect(result).toMatchObject({ ok: false });
    expect(notify).not.toHaveBeenCalled();
  });

  it("emits custody_transferred event inside tx", async () => {
    const repo = makeFakeRepo();
    await acceptPetTransfer(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(repo.insertPetEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "custody_transferred", authorRole: "owner" }),
      fakeTx,
    );
  });

  it("returns sender notification on success", async () => {
    const repo = makeFakeRepo();
    const result = await acceptPetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    const r = result as { ok: true; notifications: { notificationType: string; userId: string }[] };
    const n = r.notifications.find((n) => n.notificationType === "pet_transfer_accepted");
    expect(n).toBeDefined();
    expect(n?.userId).toBe("user-sender");
  });

  // -------------------------------------------------------------------------
  // Event-integrity regression (staging bug, PTR-8M3K-2K43): the emitted
  // custody_transferred payload MUST pass the REAL event schema. The other
  // tests here mock insertPetEvent, so they never exercised validation — which
  // is exactly why the malformed P2P payload reached staging.
  // -------------------------------------------------------------------------

  // UUID-shaped ids — the P2P schema requires from_user_id/to_user_id to be uuids.
  const SENDER_UUID = "11111111-1111-4111-8111-111111111111";
  const RECIPIENT_UUID = "22222222-2222-4222-8222-222222222222";
  const uuidActor = { user: { id: RECIPIENT_UUID } };

  it("emits a custody_transferred payload that passes the real event schema (P2P variant)", async () => {
    const repo = makeFakeRepo({
      findTransferByToken: vi
        .fn()
        .mockResolvedValue(
          makeTransfer({ fromOwnerId: SENDER_UUID, toOwnerId: RECIPIENT_UUID, reason: "gift" }),
        ),
      findTransferByIdForUpdate: vi
        .fn()
        .mockResolvedValue(
          makeTransfer({ fromOwnerId: SENDER_UUID, toOwnerId: RECIPIENT_UUID, reason: "gift" }),
        ),
      // The sender is still the single active owner (TR-C1 custody guard).
      findActiveOwnerOwnership: vi
        .fn()
        .mockResolvedValue({ id: "own-1", ownerUserId: SENDER_UUID }),
    });
    const result = await acceptPetTransfer(baseInput, {
      repo,
      actor: uuidActor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: true });

    const eventArg = (repo.insertPetEvent as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      eventType: string;
      payload: Record<string, unknown>;
    };
    expect(eventArg.eventType).toBe("custody_transferred");
    expect(eventArg.payload).toMatchObject({
      from_user_id: SENDER_UUID,
      to_user_id: RECIPIENT_UUID,
      from_role: "owner",
      to_role: "owner",
      reason: "gift",
      transfer_token: "PTR-tok",
    });
    // The exact boundary that threw the raw zod error in staging.
    expect(() => validateEventPayload("custody_transferred", eventArg.payload)).not.toThrow();
  });

  it("coalesces a null transfer reason to 'other' and stays schema-valid", async () => {
    const repo = makeFakeRepo({
      findTransferByToken: vi
        .fn()
        .mockResolvedValue(
          makeTransfer({ fromOwnerId: SENDER_UUID, toOwnerId: RECIPIENT_UUID, reason: null }),
        ),
      findTransferByIdForUpdate: vi
        .fn()
        .mockResolvedValue(
          makeTransfer({ fromOwnerId: SENDER_UUID, toOwnerId: RECIPIENT_UUID, reason: null }),
        ),
      // The sender is still the single active owner (TR-C1 custody guard).
      findActiveOwnerOwnership: vi
        .fn()
        .mockResolvedValue({ id: "own-1", ownerUserId: SENDER_UUID }),
    });
    await acceptPetTransfer(baseInput, { repo, actor: uuidActor, transaction: fakeTransaction });
    const eventArg = (repo.insertPetEvent as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      payload: { reason: string };
    };
    expect(eventArg.payload.reason).toBe("other");
    expect(() => validateEventPayload("custody_transferred", eventArg.payload)).not.toThrow();
  });

  it("moves ownership to the acceptor: closes prior ownerships BEFORE opening the acceptor's", async () => {
    const repo = makeFakeRepo();
    await acceptPetTransfer(baseInput, { repo, actor, transaction: fakeTransaction });
    const closeOrder = (repo.closeOwnerOwnerships as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const insertOrder = (repo.insertOwnerOwnership as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    expect(closeOrder).toBeLessThan(insertOrder);
    // The new active-owner row is the acceptor (projection reflects new owner).
    expect(repo.insertOwnerOwnership).toHaveBeenCalledWith(
      expect.objectContaining({ petId: "pet-1", ownerUserId: "user-recipient" }),
      fakeTx,
    );
  });

  it("surfaces a friendly message (not the raw zod error) when the event payload is invalid", async () => {
    // Force the real validation boundary to reject by making insertPetEvent run
    // the actual validator against a deliberately malformed payload.
    const repo = makeFakeRepo({
      findTransferByToken: vi
        .fn()
        .mockResolvedValue(
          makeTransfer({ fromOwnerId: SENDER_UUID, toOwnerId: RECIPIENT_UUID, reason: "gift" }),
        ),
      findTransferByIdForUpdate: vi
        .fn()
        .mockResolvedValue(
          makeTransfer({ fromOwnerId: SENDER_UUID, toOwnerId: RECIPIENT_UUID, reason: "gift" }),
        ),
      insertPetEvent: vi.fn().mockImplementation(() => {
        validateEventPayload("custody_transferred", { bogus: true });
      }),
      // The sender is still the single active owner (TR-C1 custody guard) — the
      // failure under test is the event payload, not the custody re-check.
      findActiveOwnerOwnership: vi
        .fn()
        .mockResolvedValue({ id: "own-1", ownerUserId: SENDER_UUID }),
    });
    const result = await acceptPetTransfer(baseInput, {
      repo,
      actor: uuidActor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    const err = (result as { ok: false; error: string }).error;
    // Friendly Spanish message, and NONE of the raw zod leakage.
    expect(err).toMatch(/No pudimos completar la transferencia/i);
    expect(err).not.toMatch(/unrecognized_keys|Invalid payload|zod|from_role/i);
  });

  // -------------------------------------------------------------------------
  // Fix A — concurrency: in-tx lock + re-check, not the unique-index side effect
  // -------------------------------------------------------------------------

  it("locks the transfer row FOR UPDATE inside the tx before mutating ownerships", async () => {
    const repo = makeFakeRepo();
    await acceptPetTransfer(baseInput, { repo, actor, transaction: fakeTransaction });
    // The row lock runs with the tx client, before the ownership close/insert.
    expect(repo.findTransferByIdForUpdate).toHaveBeenCalledWith("tr-1", fakeTx);
    const lockOrder = (repo.findTransferByIdForUpdate as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const closeOrder = (repo.closeOwnerOwnerships as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(closeOrder);
  });

  it("flips status conditionally with expectedStatus=pending", async () => {
    const repo = makeFakeRepo();
    await acceptPetTransfer(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(repo.updateTransferStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "accepted", expectedStatus: "pending" }),
      fakeTx,
    );
  });

  it("aborts in-tx when the locked row is no longer pending (concurrent accept already won)", async () => {
    // The pre-tx read still says pending (stale), but the FOR UPDATE re-read
    // under the lock sees the row already accepted by a racing writer.
    const repo = makeFakeRepo({
      findTransferByToken: vi.fn().mockResolvedValue(makeTransfer({ status: "pending" })),
      findTransferByIdForUpdate: vi.fn().mockResolvedValue(makeTransfer({ status: "accepted" })),
    });
    const result = await acceptPetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/accepted|aceptada/i);
    // The guard fired BEFORE any ownership mutation — integrity is not held by
    // the unique-active-owner index side effect.
    expect(repo.closeOwnerOwnerships).not.toHaveBeenCalled();
    expect(repo.insertOwnerOwnership).not.toHaveBeenCalled();
    expect(repo.insertPetEvent).not.toHaveBeenCalled();
  });

  it("aborts when the conditional status flip updates zero rows (lost race under the lock)", async () => {
    // Lock re-read passes (still pending), but the conditional UPDATE matches
    // no row — another writer flipped it between the lock read and the update.
    const repo = makeFakeRepo({
      findTransferByIdForUpdate: vi.fn().mockResolvedValue(makeTransfer({ status: "pending" })),
      updateTransferStatus: vi.fn().mockResolvedValue(0),
    });
    const result = await acceptPetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/ya está/i);
  });

  // -------------------------------------------------------------------------
  // TR-C1 (CRITICAL): accept must RE-VALIDATE the PET under the lock, not just
  // the transfer row. closeOwnerOwnerships ends the CURRENT active owner, so a
  // stale transfer accepted after custody moved elsewhere is custody theft.
  // -------------------------------------------------------------------------

  it("rejects a stale A→B accept after a dispute moved custody A→C (C keeps the pet)", async () => {
    // transfer.fromOwnerId is "user-sender" (A). A govt dispute already moved
    // custody to C, so the current active owner is "user-C" ≠ A. Accepting the
    // stale A→B transfer must be REJECTED — and NO ownership row may be touched,
    // so C keeps custody.
    const repo = makeFakeRepo({
      findActiveOwnerOwnership: vi.fn().mockResolvedValue({ id: "own-C", ownerUserId: "user-C" }),
    });
    const result = await acceptPetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/titularidad cambió/i);
    // Custody untouched — C's ownership survives; no new owner minted.
    expect(repo.closeOwnerOwnerships).not.toHaveBeenCalled();
    expect(repo.insertOwnerOwnership).not.toHaveBeenCalled();
    expect(repo.insertPetEvent).not.toHaveBeenCalled();
  });

  it("rejects accept while the pet is in an open custody dispute", async () => {
    const repo = makeFakeRepo({
      findPetStatusById: vi.fn().mockResolvedValue({ status: "found", inCustodyDispute: true }),
    });
    const result = await acceptPetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/disputa/i);
    expect(repo.closeOwnerOwnerships).not.toHaveBeenCalled();
  });

  it("rejects accept of a pet that is now reported lost", async () => {
    const repo = makeFakeRepo({
      findPetStatusById: vi.fn().mockResolvedValue({ status: "lost", inCustodyDispute: false }),
    });
    const result = await acceptPetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/perdida/i);
    expect(repo.closeOwnerOwnerships).not.toHaveBeenCalled();
  });

  // H-1: the initiate-time refusal is a stale read — a sponsorship can start
  // during the 7-day window. The check that HOLDS is this one, under the
  // transfer lock, before any destructive custody write. Mirrors the cross-org
  // twin's `refuseIfSponsoredCustody` (REQ-15).
  it("refuses under the lock when a rehome sponsorship is running — nothing is written (REQ-15)", async () => {
    const repo = makeFakeRepo({
      findOpenSponsorship: vi.fn().mockResolvedValue({ ownershipId: "cust-1" }),
    });
    const result = await acceptPetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/acompañamiento/i);
    expect(repo.findOpenSponsorship).toHaveBeenCalledWith("pet-1", fakeTx);
    expect(repo.closeOwnerOwnerships).not.toHaveBeenCalled();
    expect(repo.insertOwnerOwnership).not.toHaveBeenCalled();
    expect(repo.insertPetEvent).not.toHaveBeenCalled();
    expect(repo.updateTransferStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// R3 — rejectPetTransfer
// ---------------------------------------------------------------------------

describe("rejectPetTransfer", () => {
  const actor = { user: { id: "user-recipient" } };
  const baseInput = {
    transferToken: "PTR-tok",
    callerEmail: "recipient@example.com",
    callerEmailConfirmed: true,
    reason: null as string | null,
  };

  beforeEach(() => {
    fakeTransaction = vi
      .fn()
      .mockImplementation(async (cb: (tx: unknown) => unknown) => cb(fakeTx));
  });

  it("returns error when transfer not found", async () => {
    const repo = makeFakeRepo({ findTransferByToken: vi.fn().mockResolvedValue(null) });
    const result = await rejectPetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("returns error when status is not pending", async () => {
    const repo = makeFakeRepo({
      findTransferByToken: vi.fn().mockResolvedValue(makeTransfer({ status: "cancelled" })),
    });
    const result = await rejectPetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/cancelled|cancelada/i);
  });

  it("returns error when caller is not recipient", async () => {
    const repo = makeFakeRepo({
      findTransferByToken: vi.fn().mockResolvedValue(makeTransfer({ toOwnerId: "other-user" })),
    });
    const result = await rejectPetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/propuesta no es para/i);
  });

  it("calls updateTransferStatus with rejected inside tx", async () => {
    const repo = makeFakeRepo();
    await rejectPetTransfer(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(repo.updateTransferStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "rejected" }),
      fakeTx,
    );
  });

  it("returns sender notification with reason included when present", async () => {
    const repo = makeFakeRepo();
    const result = await rejectPetTransfer(
      { ...baseInput, reason: "Me arrepentí" },
      { repo, actor, transaction: fakeTransaction },
    );
    const r = result as { ok: true; notifications: { body: string; userId: string }[] };
    const n = r.notifications.find((n) => n.userId === "user-sender");
    expect(n?.body).toContain("Me arrepentí");
  });

  it("returns ok on success", async () => {
    const repo = makeFakeRepo();
    const result = await rejectPetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// R4 — cancelPetTransfer
// ---------------------------------------------------------------------------

describe("cancelPetTransfer", () => {
  const actor = { user: { id: "user-sender" } };
  const baseInput = { transferToken: "PTR-tok" };

  beforeEach(() => {
    fakeTransaction = vi
      .fn()
      .mockImplementation(async (cb: (tx: unknown) => unknown) => cb(fakeTx));
  });

  it("returns error when transfer not found", async () => {
    const repo = makeFakeRepo({ findTransferByToken: vi.fn().mockResolvedValue(null) });
    const result = await cancelPetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("returns error when caller is not the sender", async () => {
    const repo = makeFakeRepo({
      findTransferByToken: vi.fn().mockResolvedValue(makeTransfer({ fromOwnerId: "other-user" })),
    });
    const result = await cancelPetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/emisor/i);
  });

  it("returns error when status is not pending", async () => {
    const repo = makeFakeRepo({
      findTransferByToken: vi.fn().mockResolvedValue(makeTransfer({ status: "rejected" })),
    });
    const result = await cancelPetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/rejected|rechazada/i);
  });

  it("calls updateTransferStatus with cancelled inside tx", async () => {
    const repo = makeFakeRepo();
    await cancelPetTransfer(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(repo.updateTransferStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled" }),
      fakeTx,
    );
  });

  it("returns recipient notification when toOwnerId is set", async () => {
    const repo = makeFakeRepo();
    const result = await cancelPetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    const r = result as { ok: true; notifications: { notificationType: string; userId: string }[] };
    const n = r.notifications.find((n) => n.notificationType === "pet_transfer_cancelled");
    expect(n).toBeDefined();
    expect(n?.userId).toBe("user-recipient");
  });

  it("does not return notification when toOwnerId is null", async () => {
    const repo = makeFakeRepo({
      findTransferByToken: vi.fn().mockResolvedValue(makeTransfer({ toOwnerId: null })),
    });
    const result = await cancelPetTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    const r = result as { ok: true; notifications: { notificationType: string }[] };
    const n = r.notifications.find((n) => n.notificationType === "pet_transfer_cancelled");
    expect(n).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R5 — getTransferForViewer
// ---------------------------------------------------------------------------

describe("getTransferForViewer", () => {
  const actor = { user: { id: "user-sender" } };
  const baseInput = {
    transferToken: "PTR-tok",
    callerEmail: "sender@example.com",
    callerEmailConfirmed: true,
  };

  it("returns error when transfer not found", async () => {
    const repo = makeFakeRepo({ findTransferByToken: vi.fn().mockResolvedValue(null) });
    const result = await getTransferForViewer(baseInput, { repo, actor });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/no encontrada/i);
  });

  it("returns error when caller is neither sender nor recipient", async () => {
    const repo = makeFakeRepo({
      findTransferByToken: vi
        .fn()
        .mockResolvedValue(makeTransfer({ fromOwnerId: "other-user", toOwnerId: "yet-another" })),
    });
    const result = await getTransferForViewer(baseInput, { repo, actor });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/accesible/i);
  });

  it("returns isSender=true when caller is sender", async () => {
    const repo = makeFakeRepo();
    const result = await getTransferForViewer(baseInput, { repo, actor });
    const r = result as { ok: true; value: { isSender: boolean } };
    expect(r.value.isSender).toBe(true);
  });

  it("returns isRecipient=true when caller is recipient by id", async () => {
    const repo = makeFakeRepo({
      findTransferByToken: vi
        .fn()
        .mockResolvedValue(makeTransfer({ fromOwnerId: "other-user", toOwnerId: "user-sender" })),
    });
    const result = await getTransferForViewer(baseInput, { repo, actor });
    const r = result as { ok: true; value: { isRecipient: boolean } };
    expect(r.value.isRecipient).toBe(true);
  });

  it("returns isRecipient=true when caller matches by email (open invite)", async () => {
    const repo = makeFakeRepo({
      findTransferByToken: vi.fn().mockResolvedValue(
        makeTransfer({
          fromOwnerId: "other-user",
          toOwnerId: null,
          toOwnerEmail: "sender@example.com",
        }),
      ),
    });
    const result = await getTransferForViewer(baseInput, { repo, actor });
    const r = result as { ok: true; value: { isRecipient: boolean } };
    expect(r.value.isRecipient).toBe(true);
  });

  // A09-1. THE ONLY PLACE A REAL PERSON IS TOLD WHAT TO DO ABOUT IT. This read
  // is where the invitation link lands, so the `email_unconfirmed` arm exists to
  // separate "this is not yours" from "this IS yours and your address is not
  // proved" — two refusals for authorization, two different sentences for a
  // human. Every other case in this describe pins `callerEmailConfirmed: true`
  // through `baseInput`, so without this one the arm ships untested.
  //
  // NON-VACUITY: delete the `match === "email_unconfirmed"` branch from
  // get-transfer-for-viewer.ts and this goes red — the caller falls through to
  // "Esta propuesta no es accesible desde tu cuenta.", which sends a legitimate
  // invitee to support instead of to their inbox. The test above is the control:
  // same row, same address, confirmed, and it resolves as recipient.
  it("names the remedy when the address matches but was never confirmed", async () => {
    const repo = makeFakeRepo({
      findTransferByToken: vi.fn().mockResolvedValue(
        makeTransfer({
          fromOwnerId: "other-user",
          toOwnerId: null,
          toOwnerEmail: "sender@example.com",
        }),
      ),
    });
    const result = await getTransferForViewer(
      { ...baseInput, callerEmailConfirmed: false },
      { repo, actor },
    );

    // The literal, not the imported constant: this assertion has to fail if the
    // sentence itself drifts, and a symbol compared against itself never would.
    expect(result).toMatchObject({
      ok: false,
      error: "Confirmá tu correo electrónico para aceptar esta transferencia.",
    });
  });

  it("still refuses a stranger with the generic sentence, confirmed or not", async () => {
    // The other half of the pair: `email_unconfirmed` must not widen into "any
    // refusal now names the remedy". A caller whose address does NOT match the
    // row learns nothing about whose proposal it is.
    const repo = makeFakeRepo({
      findTransferByToken: vi.fn().mockResolvedValue(
        makeTransfer({
          fromOwnerId: "other-user",
          toOwnerId: null,
          toOwnerEmail: "somebody-else@example.com",
        }),
      ),
    });
    const result = await getTransferForViewer(
      { ...baseInput, callerEmailConfirmed: false },
      { repo, actor },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "Esta propuesta no es accesible desde tu cuenta.",
    });
  });
});

// ---------------------------------------------------------------------------
// R6 — expirePetTransfers
// ---------------------------------------------------------------------------

describe("expirePetTransfers", () => {
  it("returns expired count of 0 when no stale transfers", async () => {
    const repo = makeFakeRepo({ expirablePetTransfers: vi.fn().mockResolvedValue([]) });
    const result = await expirePetTransfers({ repo });
    expect(result).toMatchObject({ ok: true, value: { expired: 0 } });
  });

  it("expires each stale transfer per-row (not single tx)", async () => {
    const rows = [
      { id: "tr-1", petId: "pet-1", fromOwnerId: "user-sender", publicToken: "PTR-1" },
      { id: "tr-2", petId: "pet-2", fromOwnerId: "user-sender2", publicToken: "PTR-2" },
    ];
    const repo = makeFakeRepo({ expirablePetTransfers: vi.fn().mockResolvedValue(rows) });
    const result = await expirePetTransfers({ repo });
    const r = result as { ok: true; value: { expired: number } };
    expect(r.value.expired).toBe(2);
    expect(repo.updateTransferStatus).toHaveBeenCalledTimes(2);
  });

  it("continues loop on per-row failure", async () => {
    const rows = [
      { id: "tr-1", petId: "pet-1", fromOwnerId: "user-sender", publicToken: "PTR-1" },
      { id: "tr-2", petId: "pet-2", fromOwnerId: "user-sender2", publicToken: "PTR-2" },
    ];
    const repo = makeFakeRepo({
      expirablePetTransfers: vi.fn().mockResolvedValue(rows),
      updateTransferStatus: vi
        .fn()
        .mockRejectedValueOnce(new Error("db hiccup"))
        .mockResolvedValue(undefined),
    });
    const result = await expirePetTransfers({ repo });
    const r = result as { ok: true; value: { expired: number } };
    // Only the second row succeeded
    expect(r.value.expired).toBe(1);
  });

  it("sends fromOwnerId notification per row", async () => {
    const rows = [{ id: "tr-1", petId: "pet-1", fromOwnerId: "user-sender", publicToken: "PTR-1" }];
    const repo = makeFakeRepo({ expirablePetTransfers: vi.fn().mockResolvedValue(rows) });
    const result = await expirePetTransfers({ repo });
    const r = result as { ok: true; notifications: { notificationType: string; userId: string }[] };
    const n = r.notifications.find((n) => n.notificationType === "pet_transfer_expired");
    expect(n?.userId).toBe("user-sender");
  });

  // -------------------------------------------------------------------------
  // Concurrency: guarded expiry must NOT stomp a transfer another writer
  // already resolved between the scan and the UPDATE (expectedStatus=pending).
  // -------------------------------------------------------------------------

  it("passes expectedStatus=pending so the UPDATE is guarded against a concurrent flip", async () => {
    const rows = [{ id: "tr-1", petId: "pet-1", fromOwnerId: "user-sender", publicToken: "PTR-1" }];
    const repo = makeFakeRepo({ expirablePetTransfers: vi.fn().mockResolvedValue(rows) });
    await expirePetTransfers({ repo });
    expect(repo.updateTransferStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "expired", expectedStatus: "pending" }),
    );
  });

  it("does not expire (skips row, no notification) when the transfer was concurrently resolved (zero rows updated)", async () => {
    const rows = [
      { id: "tr-1", petId: "pet-1", fromOwnerId: "user-sender", publicToken: "PTR-1" },
      { id: "tr-2", petId: "pet-2", fromOwnerId: "user-sender2", publicToken: "PTR-2" },
    ];
    const repo = makeFakeRepo({
      expirablePetTransfers: vi.fn().mockResolvedValue(rows),
      // tr-1 was accepted/rejected/cancelled by a concurrent writer between the
      // scan and this UPDATE → guarded UPDATE matches zero rows. tr-2 still pending.
      updateTransferStatus: vi.fn().mockResolvedValueOnce(0).mockResolvedValue(1),
    });
    const result = await expirePetTransfers({ repo });
    const r = result as {
      ok: true;
      value: { expired: number };
      notifications: { relatedPetId: string }[];
    };
    // Only the still-pending row was expired.
    expect(r.value.expired).toBe(1);
    // No expiry notification for the stomped row.
    expect(r.notifications.find((n) => n.relatedPetId === "pet-1")).toBeUndefined();
    expect(r.notifications.find((n) => n.relatedPetId === "pet-2")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// R7 — proposeCrossOrgTransfer
// ---------------------------------------------------------------------------

describe("proposeCrossOrgTransfer", () => {
  const actor = {
    user: { id: "org-user-1" },
    organization: {
      id: "org-sender",
      publicToken: "sender-tok",
      verified: true,
      displayName: "Sender Org",
    },
  };
  const baseInput = {
    senderOrgToken: "sender-tok",
    petPublicToken: "PT-tok",
    receiverOrgId: "org-receiver",
    reason: "space_constraint",
    notes: null as string | null,
  };

  beforeEach(() => {
    fakeTransaction = vi
      .fn()
      .mockImplementation(async (cb: (tx: unknown) => unknown) => cb(fakeTx));
  });

  it("returns error when senderOrgToken does not match actor org", async () => {
    const repo = makeFakeRepo();
    const result = await proposeCrossOrgTransfer(
      { ...baseInput, senderOrgToken: "wrong-tok" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/distinta a la sender/i);
  });

  it("returns error for invalid reason", async () => {
    const repo = makeFakeRepo();
    const result = await proposeCrossOrgTransfer(
      { ...baseInput, reason: "bad-reason" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/motivo/i);
  });

  it("returns error when other reason without notes", async () => {
    const repo = makeFakeRepo();
    const result = await proposeCrossOrgTransfer(
      { ...baseInput, reason: "other", notes: null },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/nota/i);
  });

  it("returns error when pet not found", async () => {
    const repo = makeFakeRepo({ findPetByToken: vi.fn().mockResolvedValue(null) });
    const result = await proposeCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("returns error when sender has no active custody", async () => {
    const repo = makeFakeRepo({ findActiveShelterCustody: vi.fn().mockResolvedValue(null) });
    const result = await proposeCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/custodia activa/i);
  });

  it("refuses when the sender's custody row is a rehome sponsorship — only the titular may end it (REQ-15)", async () => {
    // The sender holds live shelter_custody, so the plain custody check passes.
    // But that row was opened by a titular's consent (rehome-by-titular): the
    // animal lives with its family, and handing the row to another org would
    // end the arrangement by an org's act and leave the titular with nothing
    // to withdraw. Refused before a receiver is even bothered.
    const repo = makeFakeRepo({
      findOpenSponsorship: vi
        .fn()
        .mockResolvedValue({ ownershipId: "cust-1", sponsoringOrganizationId: "org-sender" }),
    });
    const result = await proposeCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/acompañamiento de adopción/);
    expect(repo.openHandshakeCase).not.toHaveBeenCalled();
    expect(repo.insertPetEvent).not.toHaveBeenCalled();
  });

  it("proceeds when the pet's open sponsorship points at a DIFFERENT custody row than the sender's", async () => {
    // A sponsorship whose custody row is not the sender's live one is drift for
    // lint:spine to report, not a reason to block an unrelated transfer.
    const repo = makeFakeRepo({
      findOpenSponsorship: vi
        .fn()
        .mockResolvedValue({ ownershipId: "cust-old", sponsoringOrganizationId: "org-x" }),
    });
    const result = await proposeCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: true });
    expect(repo.openHandshakeCase).toHaveBeenCalled();
  });

  it("returns error when receiver equals sender", async () => {
    const repo = makeFakeRepo();
    const result = await proposeCrossOrgTransfer(
      { ...baseInput, receiverOrgId: "org-sender" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/propia organización/i);
  });

  it("returns error when receiver org not found", async () => {
    const repo = makeFakeRepo({ findReceiverOrg: vi.fn().mockResolvedValue(null) });
    const result = await proposeCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/destinataria no encontrada/i);
  });

  it("returns error when receiver org not verified", async () => {
    const repo = makeFakeRepo({
      findReceiverOrg: vi.fn().mockResolvedValue(makeOrg({ verified: false })),
    });
    const result = await proposeCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/verificada/i);
  });

  it("returns error when open handshake exists", async () => {
    const repo = makeFakeRepo({
      findOpenHandshakeCase: vi.fn().mockResolvedValue({ id: "existing-case" }),
    });
    const result = await proposeCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/pendiente/i);
  });

  it("returns error when custody dispute exists", async () => {
    const repo = makeFakeRepo({
      findOpenDispute: vi.fn().mockResolvedValue({ id: "dispute-1" }),
    });
    const result = await proposeCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/disputa/i);
  });

  it("succeeds and calls openHandshakeCase inside tx", async () => {
    const repo = makeFakeRepo();
    const result = await proposeCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: true });
    expect(repo.openHandshakeCase).toHaveBeenCalledWith(
      expect.objectContaining({ receiverOrganizationId: "org-receiver" }),
      fakeTx,
    );
  });

  it("returns publicCode from case", async () => {
    const repo = makeFakeRepo();
    const result = await proposeCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    const r = result as { ok: true; value: { publicCode: string } };
    expect(r.value.publicCode).toBe("CASE-001");
  });

  it("returns receiver coordinator notifications", async () => {
    const repo = makeFakeRepo();
    const result = await proposeCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    const r = result as { ok: true; notifications: { notificationType: string; userId: string }[] };
    const n = r.notifications.find(
      (n) => n.notificationType === "cross_org_transfer_proposed_receiver",
    );
    expect(n?.userId).toBe("coord-1");
  });

  it("returns sender user notification", async () => {
    const repo = makeFakeRepo();
    const result = await proposeCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    const r = result as { ok: true; notifications: { notificationType: string; userId: string }[] };
    const n = r.notifications.find(
      (n) => n.notificationType === "cross_org_transfer_proposed_sender",
    );
    expect(n?.userId).toBe("org-user-1");
  });
});

// ---------------------------------------------------------------------------
// R8 — acceptCrossOrgTransfer
// ---------------------------------------------------------------------------

describe("acceptCrossOrgTransfer", () => {
  const actor = {
    user: { id: "recv-user-1" },
    organization: {
      id: "org-receiver",
      publicToken: "receiver-tok",
      verified: true,
      displayName: "Receiver Org",
    },
  };
  const baseInput = {
    receiverOrgToken: "receiver-tok",
    casePublicCode: "CASE-001",
  };

  beforeEach(() => {
    fakeTransaction = vi
      .fn()
      .mockImplementation(async (cb: (tx: unknown) => unknown) => cb(fakeTx));
  });

  it("returns error when receiverOrgToken does not match", async () => {
    const repo = makeFakeRepo();
    const result = await acceptCrossOrgTransfer(
      { ...baseInput, receiverOrgToken: "wrong-tok" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/distinta a la receiver/i);
  });

  it("returns error when case not found", async () => {
    const repo = makeFakeRepo({
      findTransferByToken: vi.fn().mockResolvedValue(null),
      // acceptCrossOrgTransfer loads case by public code via a repo method
      findCaseByPublicCode: vi.fn().mockResolvedValue(null),
    });
    // We simulate case-not-found by having no case method return null
    // The use-case implementation will use a repo.findCaseByPublicCode call
    const repoWithNoCase = makeFakeRepo({
      findCaseByPublicCode: vi.fn().mockResolvedValue(null),
    });
    const result = await acceptCrossOrgTransfer(baseInput, {
      repo: repoWithNoCase,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/no encontrado/i);
  });

  it("returns error when duplicate proposal events detected", async () => {
    const repo = makeFakeRepo({
      proposalEventsForCase: vi.fn().mockResolvedValue([makeProposalEvent(), makeProposalEvent()]),
    });
    const result = await acceptCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/duplicadas/i);
  });

  it("returns error when canonical receiver does not match caller org", async () => {
    // Use null in both case col and payload to force canonical resolution to "different-org"
    // (payload-only fallback). This avoids triggering drift.
    const repo = makeFakeRepo({
      findCaseByPublicCode: vi.fn().mockResolvedValue(makeCase({ receiverOrganizationId: null })),
      proposalEventsForCase: vi.fn().mockResolvedValue([
        makeProposalEvent({
          payload: {
            from_organization_id: "org-sender",
            to_organization_id: "different-org",
            reason: "x",
          },
        }),
      ]),
    });
    const result = await acceptCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/dirigida a tu organización/i);
  });

  it("returns error when drift detected between case and payload sender", async () => {
    const repo = makeFakeRepo({
      proposalEventsForCase: vi.fn().mockResolvedValue([
        makeProposalEvent({
          payload: {
            from_organization_id: "wrong-sender",
            to_organization_id: "org-receiver",
            reason: "x",
          },
        }),
      ]),
    });
    const result = await acceptCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/inconsistencia/i);
  });

  it("succeeds: emits custody_transferred + flips ownerships inside tx", async () => {
    const repo = makeFakeRepo();
    const result = await acceptCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: true });
    expect(repo.insertPetEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "custody_transferred", authorRole: "shelter" }),
      fakeTx,
    );
    expect(repo.endShelterCustody).toHaveBeenCalledWith("pet-1", "org-sender", fakeTx);
    expect(repo.insertShelterCustody).toHaveBeenCalledWith(
      expect.objectContaining({ ownerOrganizationId: "org-receiver" }),
      fakeTx,
    );
  });

  it("closes handshake case inside tx", async () => {
    const repo = makeFakeRepo();
    await acceptCrossOrgTransfer(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(repo.closeCase).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: "case-1", reason: "resolved" }),
      fakeTx,
    );
  });

  it("refuses under the lock when the source custody row is a rehome sponsorship — nothing is written (REQ-15)", async () => {
    // The proposal may predate the sponsorship, or slip past the propose-time
    // check; the accept is where custody actually moves, so the refusal has to
    // hold HERE, inside the transaction, on the row re-read under the lock.
    const repo = makeFakeRepo({
      findOpenSponsorship: vi
        .fn()
        .mockResolvedValue({ ownershipId: "cust-1", sponsoringOrganizationId: "org-sender" }),
    });
    const result = await acceptCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/acompañamiento de adopción/);
    expect(repo.findOpenSponsorship).toHaveBeenCalledWith("pet-1", fakeTx);
    expect(repo.endShelterCustody).not.toHaveBeenCalled();
    expect(repo.insertShelterCustody).not.toHaveBeenCalled();
    expect(repo.insertPetEvent).not.toHaveBeenCalled();
    expect(repo.closeCase).not.toHaveBeenCalled();
  });

  // M-10: propose checks for an open custody dispute; accept never did, and
  // between them sits a 30-day window. A dispute opened in the middle let the
  // animal move anyway, and the dispute's resolution then names as "previous
  // holder" an institution that was never party to the case — misattribution in
  // a spine that cannot be corrected. The read is the pet snapshot the P2P twin
  // already re-runs under ITS lock; the sentence is propose's, word for word.
  it("refuses under the lock when a custody dispute is open — nothing is written (M-10)", async () => {
    const repo = makeFakeRepo({
      findPetStatusById: vi.fn().mockResolvedValue({ status: "found", inCustodyDispute: true }),
    });
    const result = await acceptCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/disputa de custodia en curso/);
    expect(repo.findPetStatusById).toHaveBeenCalledWith("pet-1", fakeTx);
    expect(repo.endShelterCustody).not.toHaveBeenCalled();
    expect(repo.insertShelterCustody).not.toHaveBeenCalled();
    expect(repo.insertPetEvent).not.toHaveBeenCalled();
    expect(repo.closeCase).not.toHaveBeenCalled();
  });

  // The report is explicit that `validatePetStatusForTransfer` must NOT be
  // reused here: its `lost` arm would refuse legitimate org-to-org hand-offs
  // (a shelter handing a still-unclaimed found animal to another shelter is
  // the normal case, not an error).
  it("still accepts a pet reported lost — the P2P status validator is deliberately NOT reused (M-10)", async () => {
    const repo = makeFakeRepo({
      findPetStatusById: vi.fn().mockResolvedValue({ status: "lost", inCustodyDispute: false }),
    });
    const result = await acceptCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: true });
    expect(repo.endShelterCustody).toHaveBeenCalledWith("pet-1", "org-sender", fakeTx);
  });

  it("proceeds when the open sponsorship is NOT the source row — an unrelated arrangement does not block the hand-off", async () => {
    const repo = makeFakeRepo({
      findOpenSponsorship: vi
        .fn()
        .mockResolvedValue({ ownershipId: "cust-old", sponsoringOrganizationId: "org-x" }),
    });
    const result = await acceptCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: true });
    expect(repo.endShelterCustody).toHaveBeenCalledWith("pet-1", "org-sender", fakeTx);
  });

  // -------------------------------------------------------------------------
  // TR-H1: the source org must STILL HOLD custody under the lock. A concurrent
  // return-to-owner that ended the source's shelter_custody would otherwise
  // leave insertShelterCustody(receiver) landing anyway → phantom custodian.
  // -------------------------------------------------------------------------

  it("rejects when the source org no longer holds custody (concurrent release), writing no phantom row", async () => {
    const repo = makeFakeRepo({
      findActiveShelterCustody: vi.fn().mockResolvedValue(null),
    });
    const result = await acceptCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/ya no tiene la custodia/i);
    // No custody mutation happened — no phantom shelter_custody for the receiver.
    expect(repo.insertShelterCustody).not.toHaveBeenCalled();
    expect(repo.endShelterCustody).not.toHaveBeenCalled();
    expect(repo.closeCase).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Role honoring: proposals carry from_role / to_role (direct-custody handoff).
  // -------------------------------------------------------------------------

  it("honors to_role=owner: opens receiver ownership as owner + records to_role", async () => {
    const repo = makeFakeRepo({
      proposalEventsForCase: vi.fn().mockResolvedValue([
        makeProposalEvent({
          payload: {
            from_organization_id: "org-sender",
            to_organization_id: "org-receiver",
            reason: "org_to_org_handoff",
            from_role: "shelter_custody",
            to_role: "owner",
          },
        }),
      ]),
    });
    await acceptCrossOrgTransfer(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(repo.insertShelterCustody).toHaveBeenCalledWith(
      expect.objectContaining({ ownerOrganizationId: "org-receiver", role: "owner" }),
      fakeTx,
    );
    expect(repo.insertPetEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "custody_transferred",
        payload: expect.objectContaining({ to_role: "owner" }),
      }),
      fakeTx,
    );
  });

  it("honors from_role=owner: ends the source owner ownership (not shelter_custody)", async () => {
    const repo = makeFakeRepo({
      proposalEventsForCase: vi.fn().mockResolvedValue([
        makeProposalEvent({
          payload: {
            from_organization_id: "org-sender",
            to_organization_id: "org-receiver",
            reason: "org_to_org_handoff",
            from_role: "owner",
            to_role: "shelter_custody",
          },
        }),
      ]),
    });
    await acceptCrossOrgTransfer(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(repo.endOwnerOwnershipForOrg).toHaveBeenCalledWith("pet-1", "org-sender", fakeTx);
    expect(repo.endShelterCustody).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // One live ORGANISATION shelter_custody per pet (0195). The owner-source
  // branch closes the sender's `owner` row and opens the receiver's
  // shelter_custody — nothing in it closes a THIRD org's live custody (a
  // found-pet intake, say), so the receiver's insert would hit the index.
  // -------------------------------------------------------------------------

  it("owner-source: refuses when a third org holds live custody, writing nothing", async () => {
    const repo = makeFakeRepo({
      proposalEventsForCase: vi.fn().mockResolvedValue([
        makeProposalEvent({
          payload: {
            from_organization_id: "org-sender",
            to_organization_id: "org-receiver",
            reason: "org_to_org_handoff",
            from_role: "owner",
            to_role: "shelter_custody",
          },
        }),
      ]),
      findLiveOrgShelterCustody: vi
        .fn()
        .mockResolvedValue({ id: "cust-third", ownerOrganizationId: "org-third" }),
    });
    const result = await acceptCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/custodia de una organización/);
    expect(repo.insertPetEvent).not.toHaveBeenCalled();
    expect(repo.endOwnerOwnershipForOrg).not.toHaveBeenCalled();
    expect(repo.insertShelterCustody).not.toHaveBeenCalled();
    expect(repo.closeCase).not.toHaveBeenCalled();
  });

  it("maps a collision on the 0195 index to the same refusal, not a raw query error", async () => {
    const collision = new Error('Failed query: insert into "ownerships" ...');
    (collision as Error & { cause?: unknown }).cause = {
      code: "23505",
      constraint_name: "ownerships_one_active_org_shelter_custody_per_pet",
      message:
        'duplicate key value violates unique constraint "ownerships_one_active_org_shelter_custody_per_pet"',
    };
    const repo = makeFakeRepo({
      proposalEventsForCase: vi.fn().mockResolvedValue([
        makeProposalEvent({
          payload: {
            from_organization_id: "org-sender",
            to_organization_id: "org-receiver",
            reason: "org_to_org_handoff",
            from_role: "owner",
            to_role: "shelter_custody",
          },
        }),
      ]),
      insertShelterCustody: vi.fn().mockRejectedValue(collision),
    });
    const result = await acceptCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    const error = (result as { ok: false; error: string }).error;
    expect(error).toMatch(/custodia de una organización/);
    expect(error).not.toMatch(/Failed query/);
  });

  it("defaults to shelter_custody when the proposal omits roles (legacy/return-to-owner)", async () => {
    const repo = makeFakeRepo();
    await acceptCrossOrgTransfer(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(repo.endShelterCustody).toHaveBeenCalledWith("pet-1", "org-sender", fakeTx);
    expect(repo.endOwnerOwnershipForOrg).not.toHaveBeenCalled();
    expect(repo.insertShelterCustody).toHaveBeenCalledWith(
      expect.objectContaining({ role: "shelter_custody" }),
      fakeTx,
    );
  });

  // -------------------------------------------------------------------------
  // Foster cascade fires at ACCEPT (not at propose) — the direct-custody handoff
  // used to close an active foster at flip time; that cascade now lands here.
  // -------------------------------------------------------------------------

  it("closes the active foster and emits foster_ended BEFORE custody_transferred", async () => {
    const repo = makeFakeRepo({
      findActiveFosterRow: vi
        .fn()
        .mockResolvedValue({ id: "foster-own", ownerUserId: "foster-user" }),
    });
    await acceptCrossOrgTransfer(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(repo.closeFosterOwnership).toHaveBeenCalledWith("foster-own", expect.any(Date), fakeTx);
    const eventCalls = (repo.insertPetEvent as ReturnType<typeof vi.fn>).mock.calls;
    const fosterEndedIdx = eventCalls.findIndex(
      (c: unknown[]) => (c[0] as { eventType: string }).eventType === "foster_ended",
    );
    const custodyTransferredIdx = eventCalls.findIndex(
      (c: unknown[]) => (c[0] as { eventType: string }).eventType === "custody_transferred",
    );
    expect(fosterEndedIdx).toBeGreaterThanOrEqual(0);
    expect(fosterEndedIdx).toBeLessThan(custodyTransferredIdx);
    // custody_transferred references the foster_ended event id.
    const transferredCall = eventCalls[custodyTransferredIdx][0] as {
      payload: { foster_ended_event_id: string | null };
    };
    expect(transferredCall.payload.foster_ended_event_id).toBeTruthy();
  });

  it("notifies the foster user when a foster was closed by the accepted handoff", async () => {
    const repo = makeFakeRepo({
      findActiveFosterRow: vi
        .fn()
        .mockResolvedValue({ id: "foster-own", ownerUserId: "foster-user" }),
    });
    const result = await acceptCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    const r = result as { ok: true; notifications: { notificationType: string; userId: string }[] };
    const n = r.notifications.find((n) => n.notificationType === "foster_ended_by_transfer");
    expect(n?.userId).toBe("foster-user");
  });

  it("does NOT run the foster cascade when there is no active foster", async () => {
    const repo = makeFakeRepo();
    await acceptCrossOrgTransfer(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(repo.closeFosterOwnership).not.toHaveBeenCalled();
    const eventCalls = (repo.insertPetEvent as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      eventCalls.some(
        (c: unknown[]) => (c[0] as { eventType: string }).eventType === "foster_ended",
      ),
    ).toBe(false);
  });

  it("returns sender coordinator notifications", async () => {
    const repo = makeFakeRepo();
    const result = await acceptCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    const r = result as { ok: true; notifications: { notificationType: string; userId: string }[] };
    const n = r.notifications.find(
      (n) => n.notificationType === "cross_org_transfer_accepted_sender",
    );
    expect(n?.userId).toBe("coord-1");
  });

  // -------------------------------------------------------------------------
  // Concurrency: advisory lock + in-tx case-status re-check BEFORE the
  // destructive custody writes (the pre-tx status check is a stale read).
  // -------------------------------------------------------------------------

  it("acquires the pet advisory lock and re-checks case status before any destructive write", async () => {
    const repo = makeFakeRepo();
    await acceptCrossOrgTransfer(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(repo.acquirePetAdvisoryLock).toHaveBeenCalledWith("pet-1", fakeTx);
    expect(repo.caseStatusById).toHaveBeenCalledWith("case-1", fakeTx);
    const lockOrder = (repo.acquirePetAdvisoryLock as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const statusOrder = (repo.caseStatusById as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const insertOrder = (repo.insertPetEvent as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    // lock → status re-check → destructive event insert.
    expect(lockOrder).toBeLessThan(statusOrder);
    expect(statusOrder).toBeLessThan(insertOrder);
  });

  it("aborts in-tx when the case was concurrently closed (no custody flip)", async () => {
    // Pre-tx read still says open (stale), but the in-tx re-check under the lock
    // sees the case already closed by a racing reject/cancel/expire.
    const repo = makeFakeRepo({
      findCaseByPublicCode: vi.fn().mockResolvedValue(makeCase({ status: "open" })),
      caseStatusById: vi.fn().mockResolvedValue("cancelled"),
    });
    const result = await acceptCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/abierto/i);
    // The guard fired BEFORE any destructive custody write.
    expect(repo.insertPetEvent).not.toHaveBeenCalled();
    expect(repo.endShelterCustody).not.toHaveBeenCalled();
    expect(repo.insertShelterCustody).not.toHaveBeenCalled();
    expect(repo.closeCase).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// R9 — rejectCrossOrgTransfer
// ---------------------------------------------------------------------------

describe("rejectCrossOrgTransfer", () => {
  const actor = {
    user: { id: "recv-user-1" },
    organization: {
      id: "org-receiver",
      publicToken: "receiver-tok",
      verified: true,
      displayName: "Receiver Org",
    },
  };
  const baseInput = {
    receiverOrgToken: "receiver-tok",
    casePublicCode: "CASE-001",
    reason: null as string | null,
    message: null as string | null,
  };

  beforeEach(() => {
    fakeTransaction = vi
      .fn()
      .mockImplementation(async (cb: (tx: unknown) => unknown) => cb(fakeTx));
  });

  it("returns error when receiverOrgToken does not match", async () => {
    const repo = makeFakeRepo();
    const result = await rejectCrossOrgTransfer(
      { ...baseInput, receiverOrgToken: "wrong-tok" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/distinta a la receiver/i);
  });

  it("returns error when case not found", async () => {
    const repo = makeFakeRepo({ findCaseByPublicCode: vi.fn().mockResolvedValue(null) });
    const result = await rejectCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("returns error when canonical receiver does not match caller", async () => {
    // Case has no receiverOrganizationId (legacy row) — payload fallback resolves to "other-org"
    // This produces the "not directed to your org" error, not drift.
    const repo = makeFakeRepo({
      findCaseByPublicCode: vi.fn().mockResolvedValue(makeCase({ receiverOrganizationId: null })),
      proposalEventsForCase: vi.fn().mockResolvedValue([
        makeProposalEvent({
          payload: {
            from_organization_id: "org-sender",
            to_organization_id: "other-org",
            reason: "x",
          },
        }),
      ]),
    });
    const result = await rejectCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/dirigida a tu organización/i);
  });

  it("emits note_added and closes case inside tx", async () => {
    const repo = makeFakeRepo();
    const result = await rejectCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: true });
    expect(repo.insertPetEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "note_added" }),
      fakeTx,
    );
    expect(repo.closeCase).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "cancelled" }),
      fakeTx,
    );
  });

  it("returns sender coordinator notification", async () => {
    const repo = makeFakeRepo();
    const result = await rejectCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    const r = result as { ok: true; notifications: { notificationType: string; userId: string }[] };
    const n = r.notifications.find(
      (n) => n.notificationType === "cross_org_transfer_rejected_sender",
    );
    expect(n?.userId).toBe("coord-1");
  });
});

// ---------------------------------------------------------------------------
// R10 — cancelCrossOrgTransfer
// ---------------------------------------------------------------------------

describe("cancelCrossOrgTransfer", () => {
  const actor = {
    user: { id: "sender-user-1" },
    organization: {
      id: "org-sender",
      publicToken: "sender-tok",
      verified: true,
      displayName: "Sender Org",
    },
  };
  const baseInput = {
    senderOrgToken: "sender-tok",
    casePublicCode: "CASE-001",
    reason: null as string | null,
    message: null as string | null,
  };

  beforeEach(() => {
    fakeTransaction = vi
      .fn()
      .mockImplementation(async (cb: (tx: unknown) => unknown) => cb(fakeTx));
  });

  it("returns error when senderOrgToken does not match", async () => {
    const repo = makeFakeRepo();
    const result = await cancelCrossOrgTransfer(
      { ...baseInput, senderOrgToken: "wrong-tok" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/distinta a la sender/i);
  });

  it("returns error when case not found", async () => {
    const repo = makeFakeRepo({ findCaseByPublicCode: vi.fn().mockResolvedValue(null) });
    const result = await cancelCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("returns error when case is not open", async () => {
    const repo = makeFakeRepo({
      findCaseByPublicCode: vi.fn().mockResolvedValue(makeCase({ status: "cancelled" })),
    });
    const result = await cancelCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/abierto/i);
  });

  it("returns error when caller org is not the opener", async () => {
    const repo = makeFakeRepo({
      findCaseByPublicCode: vi
        .fn()
        .mockResolvedValue(makeCase({ openedByOrganizationId: "other-org" })),
    });
    const result = await cancelCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/propuso/i);
  });

  it("emits note_added and closes case inside tx", async () => {
    const repo = makeFakeRepo();
    const result = await cancelCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: true });
    expect(repo.insertPetEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "note_added" }),
      fakeTx,
    );
    expect(repo.closeCase).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "cancelled" }),
      fakeTx,
    );
  });

  it("returns receiver coordinator notification when receiverOrgId known", async () => {
    const repo = makeFakeRepo();
    const result = await cancelCrossOrgTransfer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    const r = result as { ok: true; notifications: { notificationType: string; userId: string }[] };
    const n = r.notifications.find(
      (n) => n.notificationType === "cross_org_transfer_cancelled_receiver",
    );
    expect(n?.userId).toBe("coord-1");
  });
});

// ---------------------------------------------------------------------------
// expireCrossOrgTransfers (cron)
// ---------------------------------------------------------------------------

describe("expireCrossOrgTransfers", () => {
  it("returns stats with zero when no expired cases", async () => {
    const repo = makeFakeRepo({ findExpirableCrossOrgCases: vi.fn().mockResolvedValue([]) });
    const result = await expireCrossOrgTransfers({ repo });
    expect(result).toMatchObject({ ok: true, value: { expired: 0 } });
  });

  it("calls expireOneCrossOrgCase for each candidate", async () => {
    const candidates = [
      {
        id: "c1",
        publicCode: "C1",
        primaryPetId: "p1",
        openedByOrganizationId: "o1",
        receiverOrganizationId: "o2",
      },
      {
        id: "c2",
        publicCode: "C2",
        primaryPetId: "p2",
        openedByOrganizationId: "o1",
        receiverOrganizationId: "o2",
      },
    ];
    const repo = makeFakeRepo({
      findExpirableCrossOrgCases: vi.fn().mockResolvedValue(candidates),
    });
    await expireCrossOrgTransfers({ repo });
    expect(repo.expireOneCrossOrgCase).toHaveBeenCalledTimes(2);
  });

  it("continues loop on per-case failure", async () => {
    const candidates = [
      {
        id: "c1",
        publicCode: "C1",
        primaryPetId: "p1",
        openedByOrganizationId: "o1",
        receiverOrganizationId: "o2",
      },
      {
        id: "c2",
        publicCode: "C2",
        primaryPetId: "p2",
        openedByOrganizationId: "o1",
        receiverOrganizationId: "o2",
      },
    ];
    const repo = makeFakeRepo({
      findExpirableCrossOrgCases: vi.fn().mockResolvedValue(candidates),
      expireOneCrossOrgCase: vi
        .fn()
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValue(undefined),
    });
    const result = await expireCrossOrgTransfers({ repo });
    const r = result as { ok: true; value: { expired: number } };
    expect(r.value.expired).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// R11 — transferCustody
// ---------------------------------------------------------------------------

describe("transferCustody", () => {
  const actor = {
    user: { id: "src-user-1" },
    organization: {
      id: "org-source",
      publicToken: "src-tok",
      verified: true,
      displayName: "Source Org",
    },
  };
  const baseInput = {
    petPublicToken: "PT-tok",
    destinationOrgId: "dest-org",
    newRoleRaw: "shelter_custody",
    notes: null as string | null,
  };

  beforeEach(() => {
    fakeTransaction = vi
      .fn()
      .mockImplementation(async (cb: (tx: unknown) => unknown) => cb(fakeTx));
  });

  it("returns error when destinationOrgId is missing", async () => {
    const repo = makeFakeRepo();
    const result = await transferCustody(
      { ...baseInput, destinationOrgId: "" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/destino/i);
  });

  it("returns error when dest equals source org", async () => {
    const repo = makeFakeRepo();
    const result = await transferCustody(
      { ...baseInput, destinationOrgId: "org-source" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/misma/i);
  });

  it("returns error when pet not under caller org", async () => {
    const repo = makeFakeRepo({ findPetUnderOrg: vi.fn().mockResolvedValue(null) });
    const result = await transferCustody(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/custodia de tu organización/i);
  });

  it("returns error when source role is not transferable", async () => {
    const repo = makeFakeRepo({
      findPetUnderOrg: vi.fn().mockResolvedValue({
        pet: makePet(),
        ownershipId: "own-src",
        ownershipRole: "foster",
      }),
    });
    const result = await transferCustody(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/rol/i);
  });

  // -------------------------------------------------------------------------
  // Sponsored custody (REQ-15) — the guard this door was missing until
  // 2026-08-25. proposeCrossOrgTransfer had it; this use-case is the OTHER
  // org-to-org hand-off door, and it is the one that ran on staging (pet
  // DIM-JRSF-9775, case CAS-NBGE-CS3C, opened_reason_code
  // custody_handoff_direct).
  // -------------------------------------------------------------------------

  it("refuses when the source custody row is the one a titular's consent opened", async () => {
    const repo = makeFakeRepo({
      findOpenSponsorship: vi.fn().mockResolvedValue({ ownershipId: "own-src" }),
    });
    const result = await transferCustody(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toEqual({ ok: false, error: SPONSORED_CUSTODY_TRANSFER_ERROR });
    // Refused where the twin refuses: before a receiver is bothered and before
    // anything is written.
    expect(repo.findReceiverOrg).not.toHaveBeenCalled();
    expect(repo.openHandshakeCase).not.toHaveBeenCalled();
    expect(repo.insertPetEvent).not.toHaveBeenCalled();
  });

  it("says exactly what proposeCrossOrgTransfer says — one sentence, two doors", async () => {
    const direct = await transferCustody(baseInput, {
      repo: makeFakeRepo({
        findOpenSponsorship: vi.fn().mockResolvedValue({ ownershipId: "own-src" }),
      }),
      actor,
      transaction: fakeTransaction,
    });
    const proposed = await proposeCrossOrgTransfer(
      {
        petPublicToken: "PT-tok",
        senderOrgToken: "src-tok",
        receiverOrgId: "dest-org",
        reason: "space_constraint",
        notes: null,
      },
      {
        repo: makeFakeRepo({
          findActiveShelterCustody: vi.fn().mockResolvedValue({ id: "cust-1" }),
          findOpenSponsorship: vi.fn().mockResolvedValue({ ownershipId: "cust-1" }),
        }),
        actor,
        transaction: fakeTransaction,
      },
    );
    expect(direct).toMatchObject({ ok: false });
    expect(proposed).toMatchObject({ ok: false });
    expect((direct as { ok: false; error: string }).error).toBe(
      (proposed as { ok: false; error: string }).error,
    );
  });

  // The rule is keyed on the spine's `ownership_id`, never on the
  // owner+shelter_custody SHAPE: a sponsorship naming a different row than the
  // sender's live one is drift for lint:spine to report, not a reason to block
  // an unrelated hand-off.
  it("allows the hand-off when the open sponsorship names a different ownership row", async () => {
    const repo = makeFakeRepo({
      findOpenSponsorship: vi.fn().mockResolvedValue({ ownershipId: "own-somewhere-else" }),
    });
    const result = await transferCustody(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: true });
  });

  // An `owner`-role source is the santuario / decomiso org holding permanent
  // title. That row is never a sponsorship, so the query is not even asked —
  // the same early return accept-cross-org-transfer's refuseIfSponsoredCustody
  // takes.
  it("does not query the sponsorship spine for an owner-role source", async () => {
    const repo = makeFakeRepo({
      findPetUnderOrg: vi.fn().mockResolvedValue({
        pet: makePet(),
        ownershipId: "own-src",
        ownershipRole: "owner",
      }),
    });
    const result = await transferCustody(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: true });
    expect(repo.findOpenSponsorship).not.toHaveBeenCalled();
  });

  it("returns error when destination org not found", async () => {
    const repo = makeFakeRepo({ findReceiverOrg: vi.fn().mockResolvedValue(null) });
    const result = await transferCustody(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/destino no encontrada/i);
  });

  it("returns error when destination org not verified", async () => {
    const repo = makeFakeRepo({
      findReceiverOrg: vi.fn().mockResolvedValue(makeOrg({ verified: false })),
    });
    const result = await transferCustody(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/verificada/i);
  });

  // -------------------------------------------------------------------------
  // Consent handshake: transferCustody OPENS a proposal (custody_transfer_proposed)
  // and never flips ownership unilaterally. The flip happens at ACCEPT time.
  // -------------------------------------------------------------------------

  it("returns error when an open handshake already exists for the pet", async () => {
    const repo = makeFakeRepo({
      findOpenHandshakeCase: vi.fn().mockResolvedValue({ id: "hs-1" }),
    });
    const result = await transferCustody(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/pendiente/i);
  });

  it("returns error when an open custody dispute exists for the pet", async () => {
    const repo = makeFakeRepo({
      findOpenDispute: vi.fn().mockResolvedValue({ id: "dispute-1" }),
    });
    const result = await transferCustody(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/disputa/i);
  });

  it("opens the handshake case inside tx (does NOT flip ownership)", async () => {
    const repo = makeFakeRepo();
    const result = await transferCustody(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: true });
    expect(repo.openHandshakeCase).toHaveBeenCalledWith(
      expect.objectContaining({
        receiverOrganizationId: "org-receiver",
        openedByOrganizationId: "org-source",
      }),
      fakeTx,
    );
    // No unilateral flip: source is not closed, no receiver ownership opened,
    // no custody_transferred emitted.
    expect(repo.closeOwnershipById).not.toHaveBeenCalled();
    expect(repo.insertShelterCustody).not.toHaveBeenCalled();
    const eventCalls = (repo.insertPetEvent as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      eventCalls.some(
        (c: unknown[]) => (c[0] as { eventType: string }).eventType === "custody_transferred",
      ),
    ).toBe(false);
  });

  it("emits custody_transfer_proposed carrying from_role + to_role", async () => {
    const repo = makeFakeRepo();
    await transferCustody(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(repo.insertPetEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "custody_transfer_proposed",
        authorRole: "shelter",
        payload: expect.objectContaining({
          from_organization_id: "org-source",
          to_organization_id: "org-receiver",
          from_role: "shelter_custody",
          to_role: "shelter_custody",
        }),
      }),
      fakeTx,
    );
  });

  it("carries to_role=owner when the permanent-owner outcome is requested", async () => {
    const repo = makeFakeRepo();
    await transferCustody(
      { ...baseInput, newRoleRaw: "owner" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(repo.insertPetEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "custody_transfer_proposed",
        payload: expect.objectContaining({ to_role: "owner" }),
      }),
      fakeTx,
    );
  });

  it("carries from_role=owner when the source holds the pet as permanent owner", async () => {
    const repo = makeFakeRepo({
      findPetUnderOrg: vi.fn().mockResolvedValue({
        pet: makePet(),
        ownershipId: "own-src",
        ownershipRole: "owner",
      }),
    });
    await transferCustody(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(repo.insertPetEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "custody_transfer_proposed",
        payload: expect.objectContaining({ from_role: "owner" }),
      }),
      fakeTx,
    );
  });

  it("silently coerces invalid newRole to shelter_custody in the proposal", async () => {
    const repo = makeFakeRepo();
    const result = await transferCustody(
      { ...baseInput, newRoleRaw: "invalid-role" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: true });
    expect(repo.insertPetEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "custody_transfer_proposed",
        payload: expect.objectContaining({ to_role: "shelter_custody" }),
      }),
      fakeTx,
    );
  });

  it("notifies receiver coordinators/admins of the incoming proposal", async () => {
    const repo = makeFakeRepo({
      orgCoordinatorAdminUserIds: vi.fn().mockResolvedValue([{ userId: "coord-dest" }]),
    });
    const result = await transferCustody(baseInput, { repo, actor, transaction: fakeTransaction });
    const r = result as { ok: true; notifications: { notificationType: string; userId: string }[] };
    const n = r.notifications.find(
      (n) => n.notificationType === "cross_org_transfer_proposed_receiver",
    );
    expect(n?.userId).toBe("coord-dest");
  });

  it("returns a sender confirmation notification", async () => {
    const repo = makeFakeRepo();
    const result = await transferCustody(baseInput, { repo, actor, transaction: fakeTransaction });
    const r = result as { ok: true; notifications: { notificationType: string; userId: string }[] };
    const n = r.notifications.find(
      (n) => n.notificationType === "cross_org_transfer_proposed_sender",
    );
    expect(n?.userId).toBe("src-user-1");
  });

  it("returns the created handshake publicCode", async () => {
    const repo = makeFakeRepo();
    const result = await transferCustody(baseInput, { repo, actor, transaction: fakeTransaction });
    const r = result as { ok: true; value: { publicCode: string } };
    expect(r.value.publicCode).toBe("CASE-001");
  });
});
