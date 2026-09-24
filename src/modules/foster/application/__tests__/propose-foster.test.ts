// Unit tests for proposeFoster use-case.
// TDD: RED → GREEN (propose-foster.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FosterRepository } from "../../infrastructure/foster-repository";
import { proposeFoster } from "../propose-foster";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeVolunteer(overrides: Record<string, unknown> = {}) {
  return {
    id: "vol-1",
    userId: "vol-user-1",
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
    jurisdictionProvince: null,
    jurisdictionLocality: null,
    ...overrides,
  };
}

function makePet(overrides: Record<string, unknown> = {}) {
  return {
    id: "pet-1",
    name: "Luna",
    publicToken: "PT-tok",
    species: "dog",
    estimatedWeightKg: null,
    dateOfBirth: null,
    potentiallyDangerousBreed: false,
    jurisdictionProvince: null,
    jurisdictionLocality: null,
    ...overrides,
  };
}

function makeFakeRepo(
  overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {},
): typeof FosterRepository {
  return {
    findShelterPetByToken: vi.fn().mockResolvedValue(makePet()),
    findActiveFosterRows: vi.fn().mockResolvedValue([]),
    findVolunteerByUserId: vi.fn().mockResolvedValue(makeVolunteer()),
    findDuplicatePending: vi.fn().mockResolvedValue(false),
    insertProposeFoster: vi.fn().mockResolvedValue({ proposalId: "prop-1", caseId: "case-1" }),
    // composite stubs
    insertAssignFoster: vi.fn().mockResolvedValue({ ownershipId: "own-1", caseId: "case-1" }),
    insertEndFoster: vi.fn().mockResolvedValue({ caseId: null, volunteerAvailableSlots: 2 }),
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
    findProfileById: vi.fn().mockResolvedValue(null),
    findActiveMembership: vi.fn().mockResolvedValue(null),
    insertFosterOwnership: vi.fn().mockResolvedValue({ id: "own-1" }),
    endFosterOwnership: vi.fn().mockResolvedValue(undefined),
    findProposalByToken: vi.fn().mockResolvedValue(null),
    pendingProposalsForVolunteer: vi.fn().mockResolvedValue([]),
    insertProposal: vi.fn().mockResolvedValue({ id: "prop-1" }),
    updateProposalStatus: vi.fn().mockResolvedValue(undefined),
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
  petPublicToken: "PT-tok",
  volunteerUserId: "vol-user-1",
  proposedDurationWeeks: null as number | null,
  proposedNotes: null as string | null,
};

// ---------------------------------------------------------------------------
// Tests — proposeFoster
// ---------------------------------------------------------------------------

describe("proposeFoster", () => {
  beforeEach(() => {
    fakeTransaction.mockClear();
  });

  it("returns error when pet not found", async () => {
    const repo = makeFakeRepo({ findShelterPetByToken: vi.fn().mockResolvedValue(null) });
    const result = await proposeFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/custodia/i);
  });

  it("returns error when active foster exists and does not allow co-foster (D17)", async () => {
    const repo = makeFakeRepo({
      findActiveFosterRows: vi
        .fn()
        .mockResolvedValue([{ id: "own-1", ownerUserId: "other-user", allowCoFoster: false }]),
    });
    const result = await proposeFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/co-foster/i);
  });

  it("proceeds when active foster allows co-foster", async () => {
    const repo = makeFakeRepo({
      findActiveFosterRows: vi
        .fn()
        .mockResolvedValue([{ id: "own-1", ownerUserId: "other-user", allowCoFoster: true }]),
    });
    const result = await proposeFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: true });
  });

  it("returns error when volunteer not enrolled", async () => {
    const repo = makeFakeRepo({ findVolunteerByUserId: vi.fn().mockResolvedValue(null) });
    const result = await proposeFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/inscripto/i);
  });

  it("returns error when volunteer is not active", async () => {
    const repo = makeFakeRepo({
      findVolunteerByUserId: vi.fn().mockResolvedValue(makeVolunteer({ status: "withdrawn" })),
    });
    const result = await proposeFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/activo/i);
  });

  it("returns error when volunteer has 0 slots", async () => {
    const repo = makeFakeRepo({
      findVolunteerByUserId: vi.fn().mockResolvedValue(makeVolunteer({ availableSlots: 0 })),
    });
    const result = await proposeFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/slots/i);
  });

  it("returns error when duplicate pending proposal exists", async () => {
    const repo = makeFakeRepo({ findDuplicatePending: vi.fn().mockResolvedValue(true) });
    const result = await proposeFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/propuesta pendiente/i);
  });

  it("calls insertProposeFoster inside tx on success", async () => {
    const repo = makeFakeRepo();
    const result = await proposeFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: true });
    expect(fakeTransaction).toHaveBeenCalledOnce();
    expect(repo.insertProposeFoster).toHaveBeenCalledWith(
      expect.objectContaining({ petId: "pet-1", volunteerUserId: "vol-user-1" }),
      fakeTx,
    );
  });

  it("returns proposalPublicToken with FP- prefix", async () => {
    const repo = makeFakeRepo();
    const result = await proposeFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    const r = result as { ok: true; value: { proposalPublicToken: string } };
    expect(r.value.proposalPublicToken).toMatch(/^FP-/);
  });

  it("returns foster_proposal_received notification for volunteer", async () => {
    const repo = makeFakeRepo();
    const result = await proposeFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    const r = result as { ok: true; notifications: { notificationType: string; userId: string }[] };
    const n = r.notifications.find((n) => n.notificationType === "foster_proposal_received");
    expect(n).toBeDefined();
    expect(n?.userId).toBe("vol-user-1");
  });
});
