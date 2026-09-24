// Unit tests for endFoster use-case.
// All DB interactions faked — no Postgres needed.
// TDD cycle: RED → GREEN (end-foster.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FosterRepository } from "../../infrastructure/foster-repository";
import { endFoster } from "../end-foster";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeFakeRepo(
  overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {},
): typeof FosterRepository {
  return {
    findShelterPetByToken: vi.fn().mockResolvedValue({
      id: "pet-1",
      name: "Luna",
      publicToken: "PT-tok",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: null,
    }),
    findActiveFosterRows: vi
      .fn()
      .mockResolvedValue([
        { id: "own-foster-1", ownerUserId: "foster-user-1", allowCoFoster: false },
      ]),
    insertEndFoster: vi.fn().mockResolvedValue({ caseId: "case-1", volunteerAvailableSlots: 2 }),
    // composite methods (unused in end-foster but required for type)
    insertAssignFoster: vi.fn().mockResolvedValue({ ownershipId: "own-1", caseId: "case-1" }),
    insertProposeFoster: vi.fn().mockResolvedValue({ proposalId: "prop-1", caseId: "case-2" }),
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
    findVolunteerByUserId: vi.fn().mockResolvedValue({ availableSlots: 2 }),
    findProposalByToken: vi.fn().mockResolvedValue(null),
    findDuplicatePending: vi.fn().mockResolvedValue(false),
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
    verified: false,
    displayName: "Refugio Test",
  },
};

const baseInput = {
  petPublicToken: "PT-tok",
  reasonRaw: "returned",
  notes: null as string | null,
};

// ---------------------------------------------------------------------------
// Tests — endFoster
// ---------------------------------------------------------------------------

describe("endFoster", () => {
  beforeEach(() => {
    fakeTransaction.mockClear();
  });

  it("returns error when pet not found in org custody", async () => {
    const repo = makeFakeRepo({ findShelterPetByToken: vi.fn().mockResolvedValue(null) });
    const result = await endFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/custodia/i);
  });

  it("returns error when no active foster row exists", async () => {
    const repo = makeFakeRepo({ findActiveFosterRows: vi.fn().mockResolvedValue([]) });
    const result = await endFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/no tiene un tránsito activo/i);
  });

  it("returns error when active foster row has no ownerUserId", async () => {
    const repo = makeFakeRepo({
      findActiveFosterRows: vi
        .fn()
        .mockResolvedValue([{ id: "own-1", ownerUserId: null, allowCoFoster: false }]),
    });
    const result = await endFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/tránsito activo/i);
  });

  it("runs a transaction and calls insertEndFoster on success", async () => {
    const repo = makeFakeRepo();
    const result = await endFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: true });
    expect(fakeTransaction).toHaveBeenCalledOnce();
    expect(repo.insertEndFoster).toHaveBeenCalledWith(
      expect.objectContaining({ fosterOwnershipId: "own-foster-1", fosterUserId: "foster-user-1" }),
      fakeTx,
    );
  });

  it("defaults invalid reason to 'returned'", async () => {
    const repo = makeFakeRepo();
    const result = await endFoster(
      { ...baseInput, reasonRaw: "invalid_reason" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("returns redirect path with ?fostend= param (NOT ?foster=)", async () => {
    const repo = makeFakeRepo();
    const result = await endFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    const r = result as { ok: true; value: { redirectPath: string } };
    expect(r.value.redirectPath).toMatch(/fostend=PT-tok/);
    expect(r.value.redirectPath).not.toMatch(/[?&]foster=/);
  });

  it("includes foster_ended notification for the foster user", async () => {
    const repo = makeFakeRepo();
    const result = await endFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    const r = result as { ok: true; notifications: { notificationType: string; userId: string }[] };
    const n = r.notifications.find((n) => n.notificationType === "foster_ended");
    expect(n).toBeDefined();
    expect(n?.userId).toBe("foster-user-1");
  });

  it("does NOT add re-enroll prompt when availableSlots > 0", async () => {
    const repo = makeFakeRepo({
      insertEndFoster: vi.fn().mockResolvedValue({ caseId: null, volunteerAvailableSlots: 2 }),
    });
    const result = await endFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    const r = result as { ok: true; notifications: { notificationType: string }[] };
    expect(
      r.notifications.some((n) => n.notificationType === "foster_volunteer_reenroll_prompt"),
    ).toBe(false);
  });

  it("adds re-enroll prompt when availableSlots === 0 (read inside tx)", async () => {
    const repo = makeFakeRepo({
      insertEndFoster: vi.fn().mockResolvedValue({ caseId: null, volunteerAvailableSlots: 0 }),
    });
    const result = await endFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    const r = result as { ok: true; notifications: { notificationType: string }[] };
    expect(
      r.notifications.some((n) => n.notificationType === "foster_volunteer_reenroll_prompt"),
    ).toBe(true);
  });

  it("does NOT add re-enroll prompt when volunteer row does not exist (null slots)", async () => {
    const repo = makeFakeRepo({
      insertEndFoster: vi.fn().mockResolvedValue({ caseId: null, volunteerAvailableSlots: null }),
    });
    const result = await endFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    const r = result as { ok: true; notifications: { notificationType: string }[] };
    expect(
      r.notifications.some((n) => n.notificationType === "foster_volunteer_reenroll_prompt"),
    ).toBe(false);
  });

  it("propagates tx error as ok:false", async () => {
    const repo = makeFakeRepo({
      insertEndFoster: vi.fn().mockRejectedValue(new Error("DB error")),
    });
    const result = await endFoster(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/finalizar/i);
  });
});
