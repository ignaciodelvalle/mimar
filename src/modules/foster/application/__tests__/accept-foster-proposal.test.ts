// Unit tests for acceptFosterProposal use-case.
// Tests D18 cascade, authorVerified asymmetry, and slot decrement.
// TDD: RED → GREEN (accept-foster-proposal.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FosterRepository } from "../../infrastructure/foster-repository";
import { acceptFosterProposal } from "../accept-foster-proposal";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeProposal(overrides: Record<string, unknown> = {}) {
  return {
    id: "prop-1",
    publicToken: "FP-test",
    organizationId: "org-1",
    volunteerUserId: "vol-user-1",
    petId: "pet-1",
    status: "pending",
    caseId: "case-1",
    proposedDurationWeeks: null,
    ...overrides,
  };
}

function makeVolunteer(overrides: Record<string, unknown> = {}) {
  return {
    id: "vol-row-1",
    userId: "vol-user-1",
    status: "active",
    availableSlots: 2,
    ...overrides,
  };
}

function makePet(overrides: Record<string, unknown> = {}) {
  return {
    id: "pet-1",
    name: "Luna",
    ...overrides,
  };
}

function makeFakeRepo(
  overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {},
): typeof FosterRepository {
  return {
    findProposalByToken: vi.fn().mockResolvedValue(makeProposal()),
    findOrgCustodyByPetId: vi.fn().mockResolvedValue({ id: "cust-1" }),
    findShelterPetByToken: vi.fn().mockResolvedValue(makePet()),
    findActiveFosterRows: vi.fn().mockResolvedValue([]),
    findVolunteerByUserId: vi.fn().mockResolvedValue(makeVolunteer()),
    insertAcceptFosterProposal: vi.fn().mockResolvedValue({
      ownershipId: "own-1",
      newSlots: 1,
      cascadeCancelledTokens: [],
      cascadeOrgNotifyTargets: [],
      acceptingOrgCoordinatorIds: ["coord-1"],
      actorDisplayName: "Test User",
    }),
    // composite stubs
    insertAssignFoster: vi.fn().mockResolvedValue({ ownershipId: "own-1", caseId: "case-1" }),
    insertEndFoster: vi.fn().mockResolvedValue({ caseId: null, volunteerAvailableSlots: null }),
    insertProposeFoster: vi.fn().mockResolvedValue({ proposalId: "prop-1", caseId: "case-1" }),
    insertRejectFosterProposal: vi.fn().mockResolvedValue({ orgCoordinatorIds: [] }),
    insertCancelFosterProposal: vi.fn().mockResolvedValue({ volunteerUserId: "vol-user-1" }),
    insertSetCoFosterAllowed: vi.fn().mockResolvedValue(undefined),
    findActiveFosterOwnershipById: vi.fn().mockResolvedValue(null),
    findProfileById: vi.fn().mockResolvedValue(null),
    findActiveMembership: vi.fn().mockResolvedValue(null),
    insertFosterOwnership: vi.fn().mockResolvedValue({ id: "own-1" }),
    endFosterOwnership: vi.fn().mockResolvedValue(undefined),
    findDuplicatePending: vi.fn().mockResolvedValue(false),
    pendingProposalsForVolunteer: vi.fn().mockResolvedValue([]),
    insertProposal: vi.fn().mockResolvedValue({ id: "prop-1" }),
    updateProposalStatus: vi.fn().mockResolvedValue(undefined),
    orgFosterCoordinatorUserIds: vi.fn().mockResolvedValue([]),
    orgPublicTokenById: vi.fn().mockResolvedValue("org-token-1"),
    expirablePending: vi.fn().mockResolvedValue([]),
    expirePendingProposals: vi.fn().mockResolvedValue({ candidates: 0, expired: 0, errors: 0 }),
    upsertVolunteer: vi.fn().mockResolvedValue({ id: "vol-1", availableSlots: 1 }),
    setVolunteerSlots: vi.fn().mockResolvedValue(undefined),
    withdrawVolunteer: vi.fn().mockResolvedValue(undefined),
    searchVolunteers: vi.fn().mockResolvedValue([]),
    acceptedCountsByVolunteer: vi.fn().mockResolvedValue(new Map()),
    ...overrides,
  } as unknown as typeof FosterRepository;
}

const fakeTx = "fake-tx" as unknown;
const fakeTransaction = vi
  .fn()
  .mockImplementation(async (cb: (tx: unknown) => unknown) => cb(fakeTx));

// actor is the volunteer (session user)
const actor = { user: { id: "vol-user-1" } };

const baseInput = {
  proposalPublicToken: "FP-test",
  allowCoFoster: false,
  responseNotes: null as string | null,
};

// ---------------------------------------------------------------------------
// Tests — acceptFosterProposal
// ---------------------------------------------------------------------------

describe("acceptFosterProposal", () => {
  beforeEach(() => {
    fakeTransaction.mockClear();
  });

  it("returns error when proposal not found", async () => {
    const repo = makeFakeRepo({ findProposalByToken: vi.fn().mockResolvedValue(null) });
    const result = await acceptFosterProposal(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/no encontrada/i);
  });

  it("returns error when proposal does not belong to the actor", async () => {
    const repo = makeFakeRepo({
      findProposalByToken: vi
        .fn()
        .mockResolvedValue(makeProposal({ volunteerUserId: "other-user" })),
    });
    const result = await acceptFosterProposal(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/para vos/i);
  });

  it("returns error when proposal is not pending", async () => {
    const repo = makeFakeRepo({
      findProposalByToken: vi.fn().mockResolvedValue(makeProposal({ status: "accepted" })),
    });
    const result = await acceptFosterProposal(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/activa/i);
  });

  it("returns error when org lost custody of the pet", async () => {
    const repo = makeFakeRepo({ findOrgCustodyByPetId: vi.fn().mockResolvedValue(null) });
    const result = await acceptFosterProposal(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/custodia/i);
  });

  it("returns error when co-foster state changed since proposal (D17 re-check)", async () => {
    const repo = makeFakeRepo({
      findActiveFosterRows: vi
        .fn()
        .mockResolvedValue([{ id: "own-x", ownerUserId: "other", allowCoFoster: false }]),
    });
    const result = await acceptFosterProposal(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/co-foster/i);
  });

  it("returns error when volunteer not enrolled", async () => {
    const repo = makeFakeRepo({ findVolunteerByUserId: vi.fn().mockResolvedValue(null) });
    const result = await acceptFosterProposal(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/inscripto/i);
  });

  it("returns error when volunteer not active", async () => {
    const repo = makeFakeRepo({
      findVolunteerByUserId: vi.fn().mockResolvedValue(makeVolunteer({ status: "withdrawn" })),
    });
    const result = await acceptFosterProposal(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/activa/i);
  });

  it("returns error when volunteer has 0 slots", async () => {
    const repo = makeFakeRepo({
      findVolunteerByUserId: vi.fn().mockResolvedValue(makeVolunteer({ availableSlots: 0 })),
    });
    const result = await acceptFosterProposal(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/slots/i);
  });

  it("calls insertAcceptFosterProposal inside tx on success", async () => {
    const repo = makeFakeRepo();
    const result = await acceptFosterProposal(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: true });
    expect(fakeTransaction).toHaveBeenCalledOnce();
    expect(repo.insertAcceptFosterProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        proposal: expect.objectContaining({ id: "prop-1" }),
        volunteerUserId: "vol-user-1",
        allowCoFoster: false,
      }),
      fakeTx,
    );
  });

  it("returns fosterOwnershipId, remainingSlots, cascadeCancelledProposals", async () => {
    const repo = makeFakeRepo({
      insertAcceptFosterProposal: vi.fn().mockResolvedValue({
        ownershipId: "own-accepted",
        newSlots: 1,
        cascadeCancelledTokens: ["FP-other"],
        cascadeOrgNotifyTargets: [],
        acceptingOrgCoordinatorIds: [],
        actorDisplayName: null,
      }),
    });
    const result = await acceptFosterProposal(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    const r = result as {
      ok: true;
      value: {
        fosterOwnershipId: string;
        remainingSlots: number;
        cascadeCancelledProposals: string[];
      };
    };
    expect(r.value.fosterOwnershipId).toBe("own-accepted");
    expect(r.value.remainingSlots).toBe(1);
    expect(r.value.cascadeCancelledProposals).toEqual(["FP-other"]);
  });

  it("emits foster_proposal_accepted_org notification for accepting org coordinators", async () => {
    const repo = makeFakeRepo({
      insertAcceptFosterProposal: vi.fn().mockResolvedValue({
        ownershipId: "own-1",
        newSlots: 1,
        cascadeCancelledTokens: [],
        cascadeOrgNotifyTargets: [],
        acceptingOrgCoordinatorIds: ["coord-1", "coord-2"],
        actorDisplayName: "Test User",
      }),
    });
    const result = await acceptFosterProposal(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    const r = result as { ok: true; notifications: { notificationType: string; userId: string }[] };
    const notifs = r.notifications.filter(
      (n) => n.notificationType === "foster_proposal_accepted_org",
    );
    expect(notifs.length).toBe(2);
    expect(notifs.map((n) => n.userId).sort()).toEqual(["coord-1", "coord-2"]);
  });

  it("emits foster_proposal_auto_cancelled_org notifications for D18 cascade", async () => {
    const repo = makeFakeRepo({
      insertAcceptFosterProposal: vi.fn().mockResolvedValue({
        ownershipId: "own-1",
        newSlots: 0,
        cascadeCancelledTokens: ["FP-cascade"],
        cascadeOrgNotifyTargets: [{ orgId: "org-cascade", petId: "pet-cascade" }],
        acceptingOrgCoordinatorIds: [],
        actorDisplayName: "Test User",
      }),
      orgFosterCoordinatorUserIds: vi.fn().mockResolvedValue(["cascade-coord-1"]),
    });
    const result = await acceptFosterProposal(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    const r = result as { ok: true; notifications: { notificationType: string; userId: string }[] };
    const cascadeNotifs = r.notifications.filter(
      (n) => n.notificationType === "foster_proposal_auto_cancelled_org",
    );
    expect(cascadeNotifs.length).toBe(1);
    expect(cascadeNotifs[0].userId).toBe("cascade-coord-1");
  });

  it("propagates tx error as ok:false", async () => {
    const repo = makeFakeRepo({
      insertAcceptFosterProposal: vi.fn().mockRejectedValue(new Error("DB error")),
    });
    const result = await acceptFosterProposal(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
  });
});
