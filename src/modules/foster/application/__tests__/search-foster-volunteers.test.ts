// Unit tests for searchFosterVolunteers use-case.
// TDD: RED → GREEN (search-foster-volunteers.ts).

import { describe, expect, it, vi } from "vitest";
import type { FosterRepository } from "../../infrastructure/foster-repository";
import { searchFosterVolunteers } from "../search-foster-volunteers";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeVolunteerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "vol-1",
    userId: "user-1",
    displayName: "Test Volunteer",
    status: "active",
    availableSlots: 2,
    acceptsDogs: true,
    acceptsCats: false,
    acceptsOtherSpecies: false,
    acceptsSizeSmall: true,
    acceptsSizeMedium: true,
    acceptsSizeLarge: false,
    acceptsPuppies: false,
    acceptsSeniors: false,
    acceptsChronicConditions: false,
    acceptsDangerousBreeds: false,
    maxDurationWeeks: null,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: null,
    ...overrides,
  };
}

function makeFakeRepo(
  overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {},
): typeof FosterRepository {
  return {
    searchVolunteers: vi.fn().mockResolvedValue([makeVolunteerRow()]),
    acceptedCountsByVolunteer: vi.fn().mockResolvedValue(new Map([["user-1", 3]])),
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
    findVolunteerByUserId: vi.fn().mockResolvedValue(null),
    orgFosterCoordinatorUserIds: vi.fn().mockResolvedValue([]),
    expirablePending: vi.fn().mockResolvedValue([]),
    expirePendingProposals: vi.fn().mockResolvedValue({ candidates: 0, expired: 0, errors: 0 }),
    upsertVolunteer: vi.fn().mockResolvedValue({ id: "vol-1", availableSlots: 1 }),
    setVolunteerSlots: vi.fn().mockResolvedValue(undefined),
    withdrawVolunteer: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as typeof FosterRepository;
}

// ---------------------------------------------------------------------------
// Tests — searchFosterVolunteers
// ---------------------------------------------------------------------------

describe("searchFosterVolunteers", () => {
  it("returns rows from repo with acceptedCount merged", async () => {
    const repo = makeFakeRepo();
    const result = await searchFosterVolunteers(
      { province: null, locality: null, species: undefined, limit: 50 },
      { repo },
    );
    expect(result).toMatchObject({ ok: true });
    const r = result as { ok: true; value: { rows: { userId: string; acceptedCount: number }[] } };
    expect(r.value.rows.length).toBe(1);
    expect(r.value.rows[0].userId).toBe("user-1");
    expect(r.value.rows[0].acceptedCount).toBe(3);
  });

  it("clamps limit to 1..200", async () => {
    const repo = makeFakeRepo();
    await searchFosterVolunteers({ limit: 999 }, { repo });
    expect(repo.searchVolunteers).toHaveBeenCalledWith(expect.anything(), 200);
    await searchFosterVolunteers({ limit: 0 }, { repo });
    expect(repo.searchVolunteers).toHaveBeenCalledWith(expect.anything(), 1);
  });

  it("returns 0 acceptedCount when volunteer not in count map", async () => {
    const repo = makeFakeRepo({
      acceptedCountsByVolunteer: vi.fn().mockResolvedValue(new Map()),
    });
    const result = await searchFosterVolunteers({}, { repo });
    const r = result as { ok: true; value: { rows: { acceptedCount: number }[] } };
    expect(r.value.rows[0].acceptedCount).toBe(0);
  });

  it("includes matchScore=null when no pet token provided", async () => {
    const repo = makeFakeRepo();
    const result = await searchFosterVolunteers({}, { repo });
    const r = result as { ok: true; value: { rows: { matchScore: number | null }[] } };
    expect(r.value.rows[0].matchScore).toBeNull();
  });

  it("sorts rows by matchScore desc → slots desc → acceptedCount desc", async () => {
    const rows = [
      makeVolunteerRow({ userId: "u1", availableSlots: 2 }),
      makeVolunteerRow({ userId: "u2", availableSlots: 5 }),
    ];
    const repo = makeFakeRepo({
      searchVolunteers: vi.fn().mockResolvedValue(rows),
      acceptedCountsByVolunteer: vi.fn().mockResolvedValue(
        new Map([
          ["u1", 10],
          ["u2", 1],
        ]),
      ),
    });
    const result = await searchFosterVolunteers({}, { repo });
    const r = result as { ok: true; value: { rows: { userId: string }[] } };
    // No match score → sort by slots: u2(5) > u1(2)
    expect(r.value.rows[0].userId).toBe("u2");
    expect(r.value.rows[1].userId).toBe("u1");
  });
});
