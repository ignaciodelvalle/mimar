// Unit tests for rejectFosterProposal use-case.
// TDD: RED → GREEN (reject-foster-proposal.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FosterRepository } from "../../infrastructure/foster-repository";
import { rejectFosterProposal } from "../reject-foster-proposal";

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
    ...overrides,
  };
}

function makeFakeRepo(
  overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {},
): typeof FosterRepository {
  return {
    findProposalByToken: vi.fn().mockResolvedValue(makeProposal()),
    insertRejectFosterProposal: vi.fn().mockResolvedValue({ orgCoordinatorIds: ["coord-1"] }),
    // composite stubs
    insertAssignFoster: vi.fn().mockResolvedValue({ ownershipId: "own-1", caseId: "case-1" }),
    insertEndFoster: vi.fn().mockResolvedValue({ caseId: null, volunteerAvailableSlots: null }),
    insertProposeFoster: vi.fn().mockResolvedValue({ proposalId: "prop-1", caseId: "case-1" }),
    insertAcceptFosterProposal: vi.fn().mockResolvedValue({
      ownershipId: "own-1",
      newSlots: 0,
      cascadeCancelledTokens: [],
      cascadeOrgNotifyTargets: [],
      acceptingOrgCoordinatorIds: [],
      actorDisplayName: null,
    }),
    insertCancelFosterProposal: vi.fn().mockResolvedValue({ volunteerUserId: "vol-user-1" }),
    insertSetCoFosterAllowed: vi.fn().mockResolvedValue(undefined),
    findActiveFosterOwnershipById: vi.fn().mockResolvedValue(null),
    findOrgCustodyByPetId: vi.fn().mockResolvedValue({ id: "cust-1" }),
    findProfileById: vi.fn().mockResolvedValue(null),
    findShelterPetByToken: vi.fn().mockResolvedValue(null),
    findActiveFosterRows: vi.fn().mockResolvedValue([]),
    findActiveMembership: vi.fn().mockResolvedValue(null),
    insertFosterOwnership: vi.fn().mockResolvedValue({ id: "own-1" }),
    endFosterOwnership: vi.fn().mockResolvedValue(undefined),
    findDuplicatePending: vi.fn().mockResolvedValue(false),
    pendingProposalsForVolunteer: vi.fn().mockResolvedValue([]),
    insertProposal: vi.fn().mockResolvedValue({ id: "prop-1" }),
    updateProposalStatus: vi.fn().mockResolvedValue(undefined),
    findVolunteerByUserId: vi.fn().mockResolvedValue(null),
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

const actor = { user: { id: "vol-user-1" } };

const baseInput = {
  proposalPublicToken: "FP-test",
  rejectionReason: "capacity",
  responseNotes: null as string | null,
};

// ---------------------------------------------------------------------------
// Tests — rejectFosterProposal
// ---------------------------------------------------------------------------

describe("rejectFosterProposal", () => {
  beforeEach(() => {
    fakeTransaction.mockClear();
  });

  it("returns error for invalid rejectionReason", async () => {
    const repo = makeFakeRepo();
    const result = await rejectFosterProposal(
      { ...baseInput, rejectionReason: "bad_reason" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/inválido/i);
  });

  it("returns error when proposal not found", async () => {
    const repo = makeFakeRepo({ findProposalByToken: vi.fn().mockResolvedValue(null) });
    const result = await rejectFosterProposal(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/no encontrada/i);
  });

  it("returns error when proposal not for this user", async () => {
    const repo = makeFakeRepo({
      findProposalByToken: vi
        .fn()
        .mockResolvedValue(makeProposal({ volunteerUserId: "other-user" })),
    });
    const result = await rejectFosterProposal(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/para vos/i);
  });

  it("returns error when proposal not pending", async () => {
    const repo = makeFakeRepo({
      findProposalByToken: vi.fn().mockResolvedValue(makeProposal({ status: "rejected" })),
    });
    const result = await rejectFosterProposal(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/activa/i);
  });

  it("calls insertRejectFosterProposal inside tx on success", async () => {
    const repo = makeFakeRepo();
    const result = await rejectFosterProposal(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: true });
    expect(fakeTransaction).toHaveBeenCalledOnce();
    expect(repo.insertRejectFosterProposal).toHaveBeenCalledWith(
      expect.objectContaining({ rejectionReason: "capacity" }),
      fakeTx,
    );
  });

  it("returns foster_proposal_rejected_org notification for org coordinators", async () => {
    const repo = makeFakeRepo();
    const result = await rejectFosterProposal(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    const r = result as { ok: true; notifications: { notificationType: string; userId: string }[] };
    const n = r.notifications.find((n) => n.notificationType === "foster_proposal_rejected_org");
    expect(n).toBeDefined();
    expect(n?.userId).toBe("coord-1");
  });

  it("validates all 6 rejection reasons", async () => {
    const validReasons = [
      "capacity",
      "health_mismatch",
      "timing",
      "distance",
      "household",
      "other",
    ];
    for (const reason of validReasons) {
      const repo = makeFakeRepo();
      const result = await rejectFosterProposal(
        { ...baseInput, rejectionReason: reason },
        { repo, actor, transaction: fakeTransaction },
      );
      expect(result).toMatchObject({ ok: true });
    }
  });
});
