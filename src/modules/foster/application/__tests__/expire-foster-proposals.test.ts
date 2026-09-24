// Unit tests for expireFosterProposals use-case (cron).
// TDD: RED → GREEN (expire-foster-proposals.ts).

import { describe, expect, it, vi } from "vitest";
import type { FosterRepository } from "../../infrastructure/foster-repository";
import { expireFosterProposals } from "../expire-foster-proposals";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeFakeRepo(
  overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {},
): typeof FosterRepository {
  return {
    expirePendingProposals: vi.fn().mockResolvedValue({ candidates: 3, expired: 3, errors: 0 }),
    // unused stubs
    findProposalByToken: vi.fn().mockResolvedValue(null),
    findShelterPetByToken: vi.fn().mockResolvedValue(null),
    findActiveFosterRows: vi.fn().mockResolvedValue([]),
    findActiveMembership: vi.fn().mockResolvedValue(null),
    insertFosterOwnership: vi.fn().mockResolvedValue({ id: "own-1" }),
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
    endFosterOwnership: vi.fn().mockResolvedValue(undefined),
    findDuplicatePending: vi.fn().mockResolvedValue(false),
    pendingProposalsForVolunteer: vi.fn().mockResolvedValue([]),
    insertProposal: vi.fn().mockResolvedValue({ id: "prop-1" }),
    updateProposalStatus: vi.fn().mockResolvedValue(undefined),
    findVolunteerByUserId: vi.fn().mockResolvedValue(null),
    orgFosterCoordinatorUserIds: vi.fn().mockResolvedValue([]),
    expirablePending: vi.fn().mockResolvedValue([]),
    upsertVolunteer: vi.fn().mockResolvedValue({ id: "vol-1", availableSlots: 1 }),
    setVolunteerSlots: vi.fn().mockResolvedValue(undefined),
    withdrawVolunteer: vi.fn().mockResolvedValue(undefined),
    searchVolunteers: vi.fn().mockResolvedValue([]),
    acceptedCountsByVolunteer: vi.fn().mockResolvedValue(new Map()),
    ...overrides,
  } as unknown as typeof FosterRepository;
}

// ---------------------------------------------------------------------------
// Tests — expireFosterProposals
// ---------------------------------------------------------------------------

describe("expireFosterProposals", () => {
  it("delegates to repo.expirePendingProposals with current timestamp", async () => {
    const repo = makeFakeRepo();
    const result = await expireFosterProposals({ repo });
    expect(result).toMatchObject({ ok: true });
    // Standalone (no dispatcher): no budget to forward, so the repo falls back
    // to its own 45 s ceiling exactly as before (RN #9 half b).
    expect(repo.expirePendingProposals).toHaveBeenCalledWith(expect.any(Date), {
      budgetHeaders: undefined,
    });
  });

  it("forwards the dispatcher's budget headers to the repo sweep", async () => {
    const repo = makeFakeRepo();
    const budgetHeaders = { get: () => "2391" };
    await expireFosterProposals({ repo }, { budgetHeaders });
    expect(repo.expirePendingProposals).toHaveBeenCalledWith(expect.any(Date), { budgetHeaders });
  });

  it("returns candidates, expired, errors stats", async () => {
    const repo = makeFakeRepo({
      expirePendingProposals: vi.fn().mockResolvedValue({ candidates: 5, expired: 4, errors: 1 }),
    });
    const result = await expireFosterProposals({ repo });
    const r = result as {
      ok: true;
      value: { candidates: number; expired: number; errors: number };
    };
    expect(r.value).toEqual({ candidates: 5, expired: 4, errors: 1 });
  });

  it("returns errors in value even when errors > 0 (non-fatal per spec R7)", async () => {
    const repo = makeFakeRepo({
      expirePendingProposals: vi.fn().mockResolvedValue({ candidates: 3, expired: 2, errors: 1 }),
    });
    const result = await expireFosterProposals({ repo });
    // R7: per-row error does not abort the sweep; result is ok:true with errors count
    expect(result).toMatchObject({ ok: true });
    const r = result as { ok: true; value: { errors: number } };
    expect(r.value.errors).toBe(1);
  });

  it("returns ok:false on unexpected hard failure", async () => {
    const repo = makeFakeRepo({
      expirePendingProposals: vi.fn().mockRejectedValue(new Error("unexpected DB failure")),
    });
    const result = await expireFosterProposals({ repo });
    expect(result).toMatchObject({ ok: false });
  });
});
