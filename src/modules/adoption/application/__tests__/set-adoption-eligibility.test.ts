// Unit tests for setAdoptionEligibility use-case.
// All DB interactions are faked via a repo spy — no real Postgres needed.
// TDD cycle: RED (this file) → GREEN (set-adoption-eligibility.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdoptionRepository } from "../../infrastructure/adoption-repository";
import { setAdoptionEligibility } from "../set-adoption-eligibility";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeFakeRepo(
  overrides: Partial<typeof AdoptionRepository> = {},
): typeof AdoptionRepository {
  return {
    findShelterPet: vi.fn().mockResolvedValue({
      id: "pet-1",
      publicToken: "tok-1",
      adoptionEligible: null,
      adoptionIneligibleReason: null,
      custodyOwnershipId: "own-1",
    }),
    findActiveFoster: vi.fn().mockResolvedValue(null),
    findStubAdopterByDni: vi.fn().mockResolvedValue(null),
    setEligibility: vi.fn().mockResolvedValue(undefined),
    setListingStatus: vi.fn().mockResolvedValue(undefined),
    updateListingContent: vi.fn().mockResolvedValue(undefined),
    insertApplication: vi.fn().mockResolvedValue({ eventId: "evt-1" }),
    resolveApplication: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as typeof AdoptionRepository;
}

// Fake db.transaction — calls the callback with the tx arg and returns the result.
const fakeTransaction = vi
  .fn()
  .mockImplementation(async (cb: (tx: unknown) => unknown) => cb("fake-tx"));

const actor = {
  user: { id: "user-1" },
  organization: { id: "org-1", publicToken: "org-tok", verified: true },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setAdoptionEligibility", () => {
  let repo: typeof AdoptionRepository;

  beforeEach(() => {
    repo = makeFakeRepo();
    fakeTransaction.mockClear();
  });

  // ---- Validation errors (domain rules re-exercised via use-case) --------

  it("returns error when ineligible without reason", async () => {
    const result = await setAdoptionEligibility(
      { petPublicToken: "tok-1", eligible: false },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/razón/i);
  });

  it("returns error when eligible but reason provided", async () => {
    const result = await setAdoptionEligibility(
      { petPublicToken: "tok-1", eligible: true, ineligibleReason: "age" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/no corresponde razón/i);
  });

  it("returns error when reason=other with no notes", async () => {
    const result = await setAdoptionEligibility(
      {
        petPublicToken: "tok-1",
        eligible: false,
        ineligibleReason: "other",
        ineligibleReasonNotes: "",
      },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/nota/i);
  });

  it("returns error when invalid date supplied", async () => {
    const result = await setAdoptionEligibility(
      {
        petPublicToken: "tok-1",
        eligible: false,
        ineligibleReason: "medical_treatment",
        ineligibleUntilIso: "not-a-date",
      },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/fecha/i);
  });

  // ---- Pet lookup failure ------------------------------------------------

  it("returns error when pet is not found in shelter custody", async () => {
    repo = makeFakeRepo({ findShelterPet: vi.fn().mockResolvedValue(null) });
    const result = await setAdoptionEligibility(
      { petPublicToken: "tok-missing", eligible: true },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/no encontrada/i);
  });

  // ---- Successful path --------------------------------------------------

  it("calls repo.setEligibility inside a transaction on valid input", async () => {
    const result = await setAdoptionEligibility(
      { petPublicToken: "tok-1", eligible: true },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: true });
    expect(fakeTransaction).toHaveBeenCalledOnce();
    expect(repo.setEligibility).toHaveBeenCalledWith(
      expect.objectContaining({
        petId: "pet-1",
        eligible: true,
        userId: "user-1",
        orgId: "org-1",
        orgVerified: true,
      }),
      "fake-tx",
    );
  });

  it("captures previous eligibility state BEFORE calling repo.setEligibility", async () => {
    // Pet has existing eligibility=false, reason=age
    repo = makeFakeRepo({
      findShelterPet: vi.fn().mockResolvedValue({
        id: "pet-1",
        publicToken: "tok-1",
        adoptionEligible: false,
        adoptionIneligibleReason: "age",
        custodyOwnershipId: "own-1",
      }),
    });

    await setAdoptionEligibility(
      { petPublicToken: "tok-1", eligible: true },
      { repo, actor, transaction: fakeTransaction },
    );

    expect(repo.setEligibility).toHaveBeenCalledWith(
      expect.objectContaining({
        previousState: { eligible: false, reason: "age" },
      }),
      "fake-tx",
    );
  });

  it("returns ok:true and empty notifications on success", async () => {
    const result = await setAdoptionEligibility(
      { petPublicToken: "tok-1", eligible: true },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toEqual({ ok: true, notifications: [] });
  });

  // ---- Idempotency guard (projection-writes audit §6) ---------------------

  it("double-submit no-op: pet already eligible=true → no tx, no event write", async () => {
    repo = makeFakeRepo({
      findShelterPet: vi.fn().mockResolvedValue({
        id: "pet-1",
        publicToken: "tok-1",
        adoptionEligible: true,
        adoptionIneligibleReason: null,
        adoptionIneligibleReasonNotes: null,
        adoptionIneligibleUntil: null,
        custodyOwnershipId: "own-1",
      }),
    });

    const result = await setAdoptionEligibility(
      { petPublicToken: "tok-1", eligible: true },
      { repo, actor, transaction: fakeTransaction },
    );

    expect(result).toEqual({ ok: true, notifications: [] });
    expect(fakeTransaction).not.toHaveBeenCalled();
    expect(repo.setEligibility).not.toHaveBeenCalled();
  });

  it("double-submit no-op: identical ineligible state (reason+notes) → no event write", async () => {
    repo = makeFakeRepo({
      findShelterPet: vi.fn().mockResolvedValue({
        id: "pet-1",
        publicToken: "tok-1",
        adoptionEligible: false,
        adoptionIneligibleReason: "other",
        adoptionIneligibleReasonNotes: "en tratamiento",
        adoptionIneligibleUntil: null,
        custodyOwnershipId: "own-1",
      }),
    });

    const result = await setAdoptionEligibility(
      {
        petPublicToken: "tok-1",
        eligible: false,
        ineligibleReason: "other",
        ineligibleReasonNotes: "en tratamiento",
      },
      { repo, actor, transaction: fakeTransaction },
    );

    expect(result).toEqual({ ok: true, notifications: [] });
    expect(repo.setEligibility).not.toHaveBeenCalled();
  });

  it("NOT a no-op: same eligible=false but different notes → event written", async () => {
    repo = makeFakeRepo({
      findShelterPet: vi.fn().mockResolvedValue({
        id: "pet-1",
        publicToken: "tok-1",
        adoptionEligible: false,
        adoptionIneligibleReason: "other",
        adoptionIneligibleReasonNotes: "nota vieja",
        adoptionIneligibleUntil: null,
        custodyOwnershipId: "own-1",
      }),
    });

    const result = await setAdoptionEligibility(
      {
        petPublicToken: "tok-1",
        eligible: false,
        ineligibleReason: "other",
        ineligibleReasonNotes: "nota nueva",
      },
      { repo, actor, transaction: fakeTransaction },
    );

    expect(result).toMatchObject({ ok: true });
    expect(repo.setEligibility).toHaveBeenCalledOnce();
  });
});
