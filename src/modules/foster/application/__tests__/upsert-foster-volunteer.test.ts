// Unit tests for upsertFosterVolunteer use-case.
// TDD: RED → GREEN (upsert-foster-volunteer.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FosterRepository } from "../../infrastructure/foster-repository";
import { upsertFosterVolunteer } from "../upsert-foster-volunteer";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    accountType: "personal",
    role: "owner",
    dniVerified: true,
    displayName: "Test User",
    phone: "+5491112345678",
    ...overrides,
  };
}

function makeVolunteer(overrides: Record<string, unknown> = {}) {
  return {
    id: "vol-1",
    userId: "user-1",
    status: "active",
    availableSlots: 1,
    ...overrides,
  };
}

function makeFakeRepo(
  overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {},
): typeof FosterRepository {
  return {
    findProfileById: vi.fn().mockResolvedValue(makeProfile()),
    findVolunteerByUserId: vi.fn().mockResolvedValue(null),
    upsertVolunteer: vi.fn().mockResolvedValue({ id: "vol-1", availableSlots: 1 }),
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
  mode: "enroll" as const,
  status: "active" as const,
  jurisdictionProvince: "Buenos Aires",
  jurisdictionLocality: null as string | null,
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
  maxDurationWeeks: null as number | null,
  householdOtherPets: null as boolean | null,
  householdKids: null as boolean | null,
  notes: null as string | null,
};

// ---------------------------------------------------------------------------
// Tests — upsertFosterVolunteer
// ---------------------------------------------------------------------------

describe("upsertFosterVolunteer", () => {
  beforeEach(() => {
    fakeTransaction.mockClear();
  });

  it("returns error when profile not found", async () => {
    const repo = makeFakeRepo({ findProfileById: vi.fn().mockResolvedValue(null) });
    const result = await upsertFosterVolunteer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/perfil/i);
  });

  it("returns error when profile is not personal+owner (D13)", async () => {
    const repo = makeFakeRepo({
      findProfileById: vi.fn().mockResolvedValue(makeProfile({ accountType: "org" })),
    });
    const result = await upsertFosterVolunteer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/personal/i);
  });

  it("returns error when DNI not verified (D13)", async () => {
    const repo = makeFakeRepo({
      findProfileById: vi.fn().mockResolvedValue(makeProfile({ dniVerified: false })),
    });
    const result = await upsertFosterVolunteer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/DNI/i);
  });

  it("returns error when displayName missing (D13)", async () => {
    const repo = makeFakeRepo({
      findProfileById: vi.fn().mockResolvedValue(makeProfile({ displayName: null })),
    });
    const result = await upsertFosterVolunteer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/nombre/i);
  });

  it("returns error when phone missing (D13)", async () => {
    const repo = makeFakeRepo({
      findProfileById: vi.fn().mockResolvedValue(makeProfile({ phone: null })),
    });
    const result = await upsertFosterVolunteer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/teléfono/i);
  });

  it("returns error when active status but no species selected", async () => {
    const repo = makeFakeRepo();
    const result = await upsertFosterVolunteer(
      { ...baseInput, acceptsDogs: false, acceptsCats: false, acceptsOtherSpecies: false },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/especie/i);
  });

  it("returns error when maxDurationWeeks is negative", async () => {
    const repo = makeFakeRepo();
    const result = await upsertFosterVolunteer(
      { ...baseInput, maxDurationWeeks: -1 },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/negativa/i);
  });

  it("calls upsertVolunteer inside tx on success", async () => {
    const repo = makeFakeRepo();
    const result = await upsertFosterVolunteer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    expect(result).toMatchObject({ ok: true });
    expect(fakeTransaction).toHaveBeenCalledOnce();
    expect(repo.upsertVolunteer).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      fakeTx,
    );
  });

  it("returns volunteerId and availableSlots", async () => {
    const repo = makeFakeRepo({
      upsertVolunteer: vi.fn().mockResolvedValue({ id: "vol-abc", availableSlots: 2 }),
    });
    const result = await upsertFosterVolunteer(baseInput, {
      repo,
      actor,
      transaction: fakeTransaction,
    });
    const r = result as { ok: true; value: { volunteerId: string; availableSlots: number } };
    expect(r.value.volunteerId).toBe("vol-abc");
    expect(r.value.availableSlots).toBe(2);
  });

  it("computes newSlots=1 for INSERT branch with mode=enroll", async () => {
    // No existing volunteer row
    const repo = makeFakeRepo({ findVolunteerByUserId: vi.fn().mockResolvedValue(null) });
    await upsertFosterVolunteer(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(repo.upsertVolunteer).toHaveBeenCalledWith(
      expect.objectContaining({ newSlots: 1 }),
      fakeTx,
    );
  });

  it("computes newSlots=slots+1 for UPDATE branch active + enroll", async () => {
    const repo = makeFakeRepo({
      findVolunteerByUserId: vi
        .fn()
        .mockResolvedValue(makeVolunteer({ status: "active", availableSlots: 3 })),
    });
    await upsertFosterVolunteer(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(repo.upsertVolunteer).toHaveBeenCalledWith(
      expect.objectContaining({ newSlots: 4 }),
      fakeTx,
    );
  });

  it("computes newSlots=1 for withdrawn+enroll (reset)", async () => {
    const repo = makeFakeRepo({
      findVolunteerByUserId: vi
        .fn()
        .mockResolvedValue(makeVolunteer({ status: "withdrawn", availableSlots: 0 })),
    });
    await upsertFosterVolunteer(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(repo.upsertVolunteer).toHaveBeenCalledWith(
      expect.objectContaining({ newSlots: 1 }),
      fakeTx,
    );
  });
});
