// Unit tests for setAdoptionListingStatus use-case.
// All DB interactions faked — no real Postgres needed.
// TDD cycle: RED (this file) → GREEN (set-adoption-listing-status.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdoptionRepository } from "../../infrastructure/adoption-repository";
import { setAdoptionListingStatus } from "../set-adoption-listing-status";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeListablePet(overrides: Record<string, unknown> = {}) {
  return {
    id: "pet-1",
    publicToken: "tok-1",
    status: "active",
    adoptionEligible: true,
    inCustodyDispute: false,
    rabiesObservationStatus: null,
    adoptionListedAt: null,
    adoptionListingPausedAt: null,
    custodyOwnershipId: "own-1",
    ...overrides,
  };
}

function makeFakeRepo(petRow = makeListablePet()): typeof AdoptionRepository {
  return {
    findShelterPet: vi.fn().mockResolvedValue(petRow),
    findActiveFoster: vi.fn().mockResolvedValue(null),
    findStubAdopterByDni: vi.fn().mockResolvedValue(null),
    setEligibility: vi.fn().mockResolvedValue(undefined),
    setListingStatus: vi.fn().mockResolvedValue(undefined),
    updateListingContent: vi.fn().mockResolvedValue(undefined),
    insertApplication: vi.fn().mockResolvedValue({ eventId: "evt-1" }),
    resolveApplication: vi.fn().mockResolvedValue(undefined),
  } as unknown as typeof AdoptionRepository;
}

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

describe("setAdoptionListingStatus", () => {
  beforeEach(() => {
    fakeTransaction.mockClear();
  });

  // ---- Publish blocked scenarios (spec D18-D21) --------------------------

  it("returns error when publishing a lost pet", async () => {
    const repo = makeFakeRepo(makeListablePet({ status: "lost", adoptionListedAt: null }));
    const result = await setAdoptionListingStatus(
      { petPublicToken: "tok-1", action: "publish" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/perdida/i);
    expect(repo.setListingStatus).not.toHaveBeenCalled();
  });

  it("returns error when publishing a deceased pet", async () => {
    const repo = makeFakeRepo(makeListablePet({ status: "deceased" }));
    const result = await setAdoptionListingStatus(
      { petPublicToken: "tok-1", action: "publish" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/fallecida/i);
  });

  it("returns error when publishing a non-eligible pet", async () => {
    const repo = makeFakeRepo(makeListablePet({ adoptionEligible: false }));
    const result = await setAdoptionListingStatus(
      { petPublicToken: "tok-1", action: "publish" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/apta/i);
  });

  it("returns error when publishing a disputed pet", async () => {
    const repo = makeFakeRepo(makeListablePet({ inCustodyDispute: true }));
    const result = await setAdoptionListingStatus(
      { petPublicToken: "tok-1", action: "publish" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/disputa/i);
  });

  it("returns error when publishing a pet in rabies observation", async () => {
    const repo = makeFakeRepo(makeListablePet({ rabiesObservationStatus: "in_progress" }));
    const result = await setAdoptionListingStatus(
      { petPublicToken: "tok-1", action: "publish" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/observación/i);
  });

  // ---- Publish idempotent: adoptionListedAt not overwritten -------------

  it("does not overwrite adoptionListedAt on re-publish", async () => {
    const existingListedAt = new Date("2024-01-01T00:00:00Z");
    const repo = makeFakeRepo(makeListablePet({ adoptionListedAt: existingListedAt }));
    const result = await setAdoptionListingStatus(
      { petPublicToken: "tok-1", action: "publish" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: true });
    expect(repo.setListingStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "publish",
        currentListedAt: existingListedAt,
      }),
      undefined,
    );
  });

  // ---- Pause requires existing listing ----------------------------------

  it("returns error when pausing a non-published pet", async () => {
    const repo = makeFakeRepo(makeListablePet({ adoptionListedAt: null }));
    const result = await setAdoptionListingStatus(
      { petPublicToken: "tok-1", action: "pause" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/publicada/i);
  });

  it("pauses a published pet successfully", async () => {
    const repo = makeFakeRepo(makeListablePet({ adoptionListedAt: new Date() }));
    const result = await setAdoptionListingStatus(
      { petPublicToken: "tok-1", action: "pause" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: true });
    expect(repo.setListingStatus).toHaveBeenCalledWith(
      expect.objectContaining({ action: "pause" }),
      undefined,
    );
  });

  // ---- Unpause re-validates cross-spec guards ----------------------------

  it("returns error when unpausing a disputed pet", async () => {
    const repo = makeFakeRepo(
      makeListablePet({
        adoptionListedAt: new Date(),
        adoptionListingPausedAt: new Date(),
        inCustodyDispute: true,
      }),
    );
    const result = await setAdoptionListingStatus(
      { petPublicToken: "tok-1", action: "unpause" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/disputa/i);
  });

  it("unpauses a valid paused pet", async () => {
    const repo = makeFakeRepo(
      makeListablePet({ adoptionListedAt: new Date(), adoptionListingPausedAt: new Date() }),
    );
    const result = await setAdoptionListingStatus(
      { petPublicToken: "tok-1", action: "unpause" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: true });
    expect(repo.setListingStatus).toHaveBeenCalledWith(
      expect.objectContaining({ action: "unpause" }),
      undefined,
    );
  });

  // ---- Unpublish clears listing fields ----------------------------------

  it("unpublishes successfully (always valid)", async () => {
    const repo = makeFakeRepo(makeListablePet({ adoptionListedAt: new Date() }));
    const result = await setAdoptionListingStatus(
      { petPublicToken: "tok-1", action: "unpublish" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: true });
    expect(repo.setListingStatus).toHaveBeenCalledWith(
      expect.objectContaining({ action: "unpublish" }),
      undefined,
    );
  });

  // ---- Pet not found ----------------------------------------------------

  it("returns error when pet not in shelter custody", async () => {
    const repo = makeFakeRepo();
    (repo.findShelterPet as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await setAdoptionListingStatus(
      { petPublicToken: "tok-missing", action: "publish" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/no encontrada/i);
  });
});
