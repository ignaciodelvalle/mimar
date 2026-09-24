// Unit tests for updateAdoptionListingContent use-case.
// All DB interactions faked — no real Postgres needed.
// TDD cycle: RED (this file) → GREEN (update-adoption-listing-content.ts).

import { describe, expect, it, vi } from "vitest";
import type { AdoptionRepository } from "../../infrastructure/adoption-repository";
import { updateAdoptionListingContent } from "../update-adoption-listing-content";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeFakeRepo(
  petRow: Record<string, unknown> | null = {
    id: "pet-1",
    publicToken: "tok-1",
    custodyOwnershipId: "own-1",
  },
): typeof AdoptionRepository {
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

describe("updateAdoptionListingContent", () => {
  // ---- Enum validation ---------------------------------------------------

  it("returns error for invalid ageBucket", async () => {
    const repo = makeFakeRepo();
    const result = await updateAdoptionListingContent(
      { petPublicToken: "tok-1", ageBucket: "newborn" as never },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/edad/i);
  });

  it("returns error for invalid sizeEstimate", async () => {
    const repo = makeFakeRepo();
    const result = await updateAdoptionListingContent(
      { petPublicToken: "tok-1", sizeEstimate: "giant" as never },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/talle/i);
  });

  it("returns error for invalid energyLevel", async () => {
    const repo = makeFakeRepo();
    const result = await updateAdoptionListingContent(
      { petPublicToken: "tok-1", energyLevel: "extreme" as never },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/energía/i);
  });

  // ---- Text length caps -------------------------------------------------

  it("returns error when story exceeds 5000 chars", async () => {
    const repo = makeFakeRepo();
    const result = await updateAdoptionListingContent(
      { petPublicToken: "tok-1", story: "x".repeat(5001) },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/historia/i);
  });

  it("returns error when requirements exceed 2000 chars", async () => {
    const repo = makeFakeRepo();
    const result = await updateAdoptionListingContent(
      { petPublicToken: "tok-1", requirements: "x".repeat(2001) },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/requisitos/i);
  });

  // ---- Negative fee -----------------------------------------------------

  it("returns error for negative feeArs", async () => {
    const repo = makeFakeRepo();
    const result = await updateAdoptionListingContent(
      { petPublicToken: "tok-1", feeArs: -1 },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/negativo/i);
  });

  // ---- Pet not found ----------------------------------------------------

  it("returns error when pet not in shelter custody", async () => {
    const repo = makeFakeRepo(null);
    const result = await updateAdoptionListingContent(
      { petPublicToken: "tok-missing" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/no encontrada/i);
  });

  // ---- Successful update ------------------------------------------------

  it("calls repo.updateListingContent with trimmed values on valid input", async () => {
    const repo = makeFakeRepo();
    const result = await updateAdoptionListingContent(
      {
        petPublicToken: "tok-1",
        story: "  A nice story.  ",
        ageBucket: "adult",
        feeArs: 500,
      },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: true });
    expect(repo.updateListingContent).toHaveBeenCalledWith(
      expect.objectContaining({
        petId: "pet-1",
        story: "A nice story.",
        ageBucket: "adult",
        feeArs: 500,
      }),
      undefined,
    );
  });

  it("returns ok:true and empty notifications on success", async () => {
    const repo = makeFakeRepo();
    const result = await updateAdoptionListingContent(
      { petPublicToken: "tok-1" },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toEqual({ ok: true, notifications: [] });
  });
});
