// Unit tests for setCoFosterAllowed use-case.
// TDD: RED → GREEN (set-co-foster-allowed.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FosterRepository } from "../../infrastructure/foster-repository";
import { setCoFosterAllowed } from "../set-co-foster-allowed";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeFakeRepo(
  overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {},
): typeof FosterRepository {
  return {
    findActiveFosterOwnershipById: vi.fn().mockResolvedValue({ id: "own-1", petId: "pet-1" }),
    insertSetCoFosterAllowed: vi.fn().mockResolvedValue(undefined),
    // unused stubs
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
    insertRejectFosterProposal: vi.fn().mockResolvedValue({ orgCoordinatorIds: [] }),
    insertCancelFosterProposal: vi.fn().mockResolvedValue({ volunteerUserId: "vol-user-1" }),
    findOrgCustodyByPetId: vi.fn().mockResolvedValue(null),
    findProfileById: vi.fn().mockResolvedValue(null),
    findShelterPetByToken: vi.fn().mockResolvedValue(null),
    findActiveFosterRows: vi.fn().mockResolvedValue([]),
    findActiveMembership: vi.fn().mockResolvedValue(null),
    insertFosterOwnership: vi.fn().mockResolvedValue({ id: "own-1" }),
    endFosterOwnership: vi.fn().mockResolvedValue(undefined),
    findProposalByToken: vi.fn().mockResolvedValue(null),
    findDuplicatePending: vi.fn().mockResolvedValue(false),
    pendingProposalsForVolunteer: vi.fn().mockResolvedValue([]),
    insertProposal: vi.fn().mockResolvedValue({ id: "prop-1" }),
    updateProposalStatus: vi.fn().mockResolvedValue(undefined),
    findVolunteerByUserId: vi.fn().mockResolvedValue(null),
    orgFosterCoordinatorUserIds: vi.fn().mockResolvedValue([]),
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

const actor = { user: { id: "user-1" } };

const baseInput = {
  fosterOwnershipId: "own-1",
  allowCoFoster: true,
};

// ---------------------------------------------------------------------------
// Tests — setCoFosterAllowed
// ---------------------------------------------------------------------------

describe("setCoFosterAllowed", () => {
  beforeEach(() => {
    fakeTransaction.mockClear();
  });

  it("returns error when foster ownership not found or not owned by user", async () => {
    const repo = makeFakeRepo({ findActiveFosterOwnershipById: vi.fn().mockResolvedValue(null) });
    const result = await setCoFosterAllowed(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/no es tuyo|no encontrado/i);
  });

  it("calls insertSetCoFosterAllowed inside tx on success", async () => {
    const repo = makeFakeRepo();
    const result = await setCoFosterAllowed(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: true });
    expect(fakeTransaction).toHaveBeenCalledOnce();
    expect(repo.insertSetCoFosterAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ ownershipId: "own-1", petId: "pet-1", allowCoFoster: true }),
      fakeTx,
    );
  });

  it("propagates tx error as ok:false", async () => {
    const repo = makeFakeRepo({
      insertSetCoFosterAllowed: vi.fn().mockRejectedValue(new Error("DB error")),
    });
    const result = await setCoFosterAllowed(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/co-foster/i);
  });
});
