// Unit tests for withdrawFosterVolunteer use-case.
// TDD: RED → GREEN (withdraw-foster-volunteer.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FosterRepository } from "../../infrastructure/foster-repository";
import { withdrawFosterVolunteer } from "../withdraw-foster-volunteer";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeFakeRepo(
  overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {},
): typeof FosterRepository {
  return {
    withdrawVolunteer: vi.fn().mockResolvedValue(undefined),
    findVolunteerByUserId: vi
      .fn()
      .mockResolvedValue({ id: "vol-1", userId: "user-1", status: "active" }),
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
    insertRejectFosterProposal: vi.fn().mockResolvedValue({ orgCoordinatorIds: [] }),
    insertCancelFosterProposal: vi.fn().mockResolvedValue({ volunteerUserId: "vol-user-1" }),
    insertSetCoFosterAllowed: vi.fn().mockResolvedValue(undefined),
    findActiveFosterOwnershipById: vi.fn().mockResolvedValue(null),
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
    orgFosterCoordinatorUserIds: vi.fn().mockResolvedValue([]),
    expirablePending: vi.fn().mockResolvedValue([]),
    expirePendingProposals: vi.fn().mockResolvedValue({ candidates: 0, expired: 0, errors: 0 }),
    upsertVolunteer: vi.fn().mockResolvedValue({ id: "vol-1", availableSlots: 0 }),
    setVolunteerSlots: vi.fn().mockResolvedValue(undefined),
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

// ---------------------------------------------------------------------------
// Tests — withdrawFosterVolunteer
// ---------------------------------------------------------------------------

describe("withdrawFosterVolunteer", () => {
  beforeEach(() => {
    fakeTransaction.mockClear();
  });

  it("returns error when volunteer not enrolled", async () => {
    const repo = makeFakeRepo({ findVolunteerByUserId: vi.fn().mockResolvedValue(null) });
    const result = await withdrawFosterVolunteer({ repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/inscripto/i);
  });

  it("calls repo.withdrawVolunteer inside tx on success", async () => {
    const repo = makeFakeRepo();
    const result = await withdrawFosterVolunteer({ repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: true });
    expect(fakeTransaction).toHaveBeenCalledOnce();
    expect(repo.withdrawVolunteer).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      fakeTx,
    );
  });

  it("propagates error from repo as ok:false", async () => {
    const repo = makeFakeRepo({
      withdrawVolunteer: vi.fn().mockRejectedValue(new Error("DB error")),
    });
    const result = await withdrawFosterVolunteer({ repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/retirar/i);
  });

  it("returns ok:true on success", async () => {
    const repo = makeFakeRepo();
    const result = await withdrawFosterVolunteer({ repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: true });
    const r = result as { ok: true; value: { ok: true } };
    expect(r.value.ok).toBe(true);
  });
});
