// Unit tests for assignFoster use-case.
// All DB interactions faked via a minimal FosterRepository stub — no Postgres needed.
// TDD cycle: RED (this file) → GREEN (assign-foster.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FosterRepository } from "../../infrastructure/foster-repository";
import { assignFoster } from "../assign-foster";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type FakeRepo = {
  [K in keyof typeof FosterRepository]: ReturnType<typeof vi.fn>;
};

function makeFakeRepo(overrides: Partial<FakeRepo> = {}): typeof FosterRepository {
  return {
    findShelterPetByToken: vi.fn().mockResolvedValue({
      id: "pet-1",
      name: "Luna",
      publicToken: "PT-tok",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    }),
    findActiveMembership: vi.fn().mockResolvedValue({ id: "mem-1" }),
    findActiveFosterRows: vi.fn().mockResolvedValue([]),
    insertFosterOwnership: vi.fn().mockResolvedValue({ id: "own-foster-1" }),
    insertAssignFoster: vi
      .fn()
      .mockResolvedValue({ ownershipId: "own-foster-1", caseId: "case-1" }),
    insertEndFoster: vi.fn().mockResolvedValue({ caseId: "case-1", volunteerAvailableSlots: 2 }),
    insertProposeFoster: vi.fn().mockResolvedValue({ proposalId: "prop-1", caseId: "case-2" }),
    insertAcceptFosterProposal: vi.fn().mockResolvedValue({
      ownershipId: "own-1",
      newSlots: 0,
      cascadeCancelledTokens: [],
      cascadeOrgNotifyTargets: [],
      acceptingOrgCoordinatorIds: [],
      actorDisplayName: "Test User",
    }),
    insertRejectFosterProposal: vi.fn().mockResolvedValue({ orgCoordinatorIds: [] }),
    insertCancelFosterProposal: vi.fn().mockResolvedValue({ volunteerUserId: "vol-user-1" }),
    insertSetCoFosterAllowed: vi.fn().mockResolvedValue(undefined),
    findActiveFosterOwnershipById: vi.fn().mockResolvedValue(null),
    findProfileById: vi.fn().mockResolvedValue(null),
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
  fosterUserId: "foster-user-1",
  expectedWeeksRaw: "4",
  notes: null as string | null,
};

// ---------------------------------------------------------------------------
// Tests — assignFoster
// ---------------------------------------------------------------------------

describe("assignFoster", () => {
  beforeEach(() => {
    fakeTransaction.mockClear();
  });

  it("returns error when fosterUserId is empty", async () => {
    const repo = makeFakeRepo();
    const result = await assignFoster(
      { ...baseInput, fosterUserId: "   " },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/voluntario/i);
  });

  it("returns error when pet not found in org shelter custody", async () => {
    const repo = makeFakeRepo({ findShelterPetByToken: vi.fn().mockResolvedValue(null) });
    const result = await assignFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/custodia/i);
  });

  it("returns error when foster is not an active member of the org", async () => {
    const repo = makeFakeRepo({ findActiveMembership: vi.fn().mockResolvedValue(null) });
    const result = await assignFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/miembro activo/i);
  });

  it("returns error when pet already has an active foster row", async () => {
    const repo = makeFakeRepo({
      findActiveFosterRows: vi
        .fn()
        .mockResolvedValue([{ id: "own-existing", ownerUserId: "someone", allowCoFoster: false }]),
    });
    const result = await assignFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/tránsito activo/i);
  });

  it("runs a transaction and calls insertAssignFoster on success", async () => {
    const repo = makeFakeRepo();
    const result = await assignFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: true });
    expect(fakeTransaction).toHaveBeenCalledOnce();
    expect(repo.insertAssignFoster).toHaveBeenCalledWith(
      expect.objectContaining({ petId: "pet-1", fosterUserId: "foster-user-1" }),
      fakeTx,
    );
  });

  it("returns notifications array (not flushed inside use-case)", async () => {
    const repo = makeFakeRepo();
    const result = await assignFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: true });
    const r = result as { ok: true; notifications: unknown[] };
    expect(Array.isArray(r.notifications)).toBe(true);
    expect(r.notifications.length).toBeGreaterThan(0);
  });

  it("includes foster_assigned notification for the foster user", async () => {
    const repo = makeFakeRepo();
    const result = await assignFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    const r = result as { ok: true; notifications: { notificationType: string; userId: string }[] };
    const n = r.notifications.find((n) => n.notificationType === "foster_assigned");
    expect(n).toBeDefined();
    expect(n?.userId).toBe("foster-user-1");
  });

  it("parses expectedWeeks=0 when raw is non-numeric", async () => {
    const repo = makeFakeRepo();
    const result = await assignFoster(
      { ...baseInput, expectedWeeksRaw: "abc" },
      { repo, actor, transaction: fakeTransaction },
    );
    // Non-numeric raw → expectedWeeks=0; use-case should still succeed.
    expect(result).toMatchObject({ ok: true });
    expect(repo.insertAssignFoster).toHaveBeenCalledWith(
      expect.objectContaining({ petId: "pet-1", expectedWeeks: 0 }),
      fakeTx,
    );
  });

  it("returns redirect path on success", async () => {
    const repo = makeFakeRepo();
    const result = await assignFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    const r = result as { ok: true; value: { redirectPath: string } };
    expect(r.value.redirectPath).toMatch(/foster=PT-tok/);
  });

  it("propagates tx error as ok:false", async () => {
    const repo = makeFakeRepo({
      insertAssignFoster: vi.fn().mockRejectedValue(new Error("constraint violation")),
    });
    const result = await assignFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/asignar/i);
  });
});
