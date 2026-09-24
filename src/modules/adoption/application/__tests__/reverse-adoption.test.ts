// Unit tests for reverseAdoption use-case.
// All DB interactions faked via repo spies — no real Postgres needed.
// Mirrors finalize-adoption.test.ts's fake-repo pattern.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdoptionRepository } from "../../infrastructure/adoption-repository";
import { reverseAdoption } from "../reverse-adoption";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makePet(overrides: Record<string, unknown> = {}) {
  return { id: "pet-1", name: "Max", ...overrides };
}

function makeReversible(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    finalizeEventId: "evt-finalized-1",
    adopterOwnershipId: "own-owner-1",
    adopterUserId: "adopter-user-1",
    petName: "Max",
    ...overrides,
  };
}

type Tx = unknown;

function makeFakeRepo(
  options: {
    pet?: { id: string; name: string } | null;
    reversible?:
      | {
          ok: true;
          finalizeEventId: string;
          adopterOwnershipId: string;
          adopterUserId: string | null;
          petName: string;
        }
      | { ok: false; error: string };
  } = {},
): typeof AdoptionRepository {
  const pet = options.pet !== undefined ? options.pet : makePet();
  const reversible = options.reversible ?? makeReversible();

  return {
    findPetByToken: vi.fn().mockResolvedValue(pet),
    findReversibleAdoption: vi.fn().mockResolvedValue(reversible),
    insertAdoptionReversed: vi.fn().mockResolvedValue({ eventId: "evt-reversed-1" }),
  } as unknown as typeof AdoptionRepository;
}

const fakeTransaction = vi
  .fn()
  .mockImplementation(async (cb: (tx: Tx) => unknown) => cb("fake-tx"));

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
  petPublicToken: "tok-1",
  reason: null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reverseAdoption", () => {
  beforeEach(() => {
    fakeTransaction.mockClear();
  });

  // ---- Input validation (domain rules via use-case) ----------------------

  it("returns error when reason exceeds the length limit", async () => {
    const repo = makeFakeRepo();
    const result = await reverseAdoption(
      { ...baseInput, reason: "a".repeat(501) },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/500 caracteres/i);
    expect(repo.findPetByToken).not.toHaveBeenCalled();
  });

  // ---- Pet lookup ---------------------------------------------------------

  it("returns error when pet is not found by token", async () => {
    const repo = makeFakeRepo({ pet: null });
    const result = await reverseAdoption(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/no encontrada/i);
  });

  it("looks up the pet with NO org-ownership constraint (the org may no longer hold it)", async () => {
    const repo = makeFakeRepo();
    await reverseAdoption(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(repo.findPetByToken).toHaveBeenCalledWith("tok-1");
  });

  // ---- Reversibility gate: only the finalizing org, no double-reverse ----

  it("returns the repo's error when this org did not finalize the adoption", async () => {
    const repo = makeFakeRepo({
      reversible: {
        ok: false,
        error: "Esta organización no finalizó ninguna adopción para esta mascota.",
      },
    });
    const result = await reverseAdoption(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/no finalizó/i);
    expect(repo.insertAdoptionReversed).not.toHaveBeenCalled();
  });

  it("returns the repo's error on a double-reverse attempt (already reversed)", async () => {
    const repo = makeFakeRepo({
      reversible: { ok: false, error: "Esta adopción ya fue revertida." },
    });
    const result = await reverseAdoption(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/ya fue revertida/i);
    expect(repo.insertAdoptionReversed).not.toHaveBeenCalled();
  });

  it("calls findReversibleAdoption scoped to THIS org, not any org", async () => {
    const repo = makeFakeRepo();
    await reverseAdoption(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(repo.findReversibleAdoption).toHaveBeenCalledWith("pet-1", "org-1");
  });

  // ---- Successful atomic write: custody returns to the finalizing org ----

  it("calls insertAdoptionReversed inside a transaction, wiring custody back to the finalizing org", async () => {
    const repo = makeFakeRepo();
    const result = await reverseAdoption(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: true });
    expect(fakeTransaction).toHaveBeenCalledOnce();
    expect(repo.insertAdoptionReversed).toHaveBeenCalledWith(
      expect.objectContaining({
        petId: "pet-1",
        orgId: "org-1", // the finalizing org — same org.id the actor authorized as
        userId: "org-user-1",
        adopterOwnershipId: "own-owner-1",
        finalizeEventId: "evt-finalized-1",
      }),
      "fake-tx",
    );
  });

  it("passes the caller-supplied reason through to the repo write", async () => {
    const repo = makeFakeRepo();
    await reverseAdoption(
      { ...baseInput, reason: "El adoptante no pudo sostener el cuidado." },
      { repo, actor, transaction: fakeTransaction },
    );
    expect(repo.insertAdoptionReversed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "El adoptante no pudo sostener el cuidado." }),
      "fake-tx",
    );
  });

  it("propagates a transaction failure as a use-case error (simulates tx rollback)", async () => {
    const repo = makeFakeRepo();
    (
      repo as unknown as { insertAdoptionReversed: ReturnType<typeof vi.fn> }
    ).insertAdoptionReversed.mockRejectedValue(new Error("DB constraint violation"));
    const throwingTx = vi.fn().mockImplementation(async (cb: (tx: Tx) => unknown) => cb("fake-tx"));

    const result = await reverseAdoption(baseInput, { repo, actor, transaction: throwingTx });
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toMatch(/revertir/i);
  });

  it("maps a collision on the one-live-org-custody index (0195) to the custody refusal, not a raw query error", async () => {
    // drizzle 0.45 shape: the pg error rides on `.cause`, the top-level
    // message is the SQL text. A reader of the old catch saw that SQL text.
    const repo = makeFakeRepo();
    const collision = new Error('Failed query: insert into "ownerships" ...');
    (collision as Error & { cause?: unknown }).cause = {
      code: "23505",
      constraint_name: "ownerships_one_active_org_shelter_custody_per_pet",
      message:
        'duplicate key value violates unique constraint "ownerships_one_active_org_shelter_custody_per_pet"',
    };
    (
      repo as unknown as { insertAdoptionReversed: ReturnType<typeof vi.fn> }
    ).insertAdoptionReversed.mockRejectedValue(collision);

    const result = await reverseAdoption(baseInput, { repo, actor, transaction: fakeTransaction });
    expect(result).toMatchObject({ ok: false });
    const error = (result as { ok: false; error: string }).error;
    expect(error).toMatch(/custodia de una organización/);
    expect(error).not.toMatch(/Failed query/);
  });

  // ---- Notifications (best-effort, returned not flushed) -----------------

  it("returns an adoption_reversed notification for the former adopter", async () => {
    const repo = makeFakeRepo();
    const result = await reverseAdoption(baseInput, { repo, actor, transaction: fakeTransaction });
    const r = result as {
      ok: true;
      notifications: { notificationType: string; userId: string; category?: string | null }[];
    };
    const notif = r.notifications.find((n) => n.notificationType === "adoption_reversed");
    expect(notif).toBeDefined();
    expect(notif?.userId).toBe("adopter-user-1");
    expect(notif?.category).toBe("adoption");
  });

  it("does not include an adopter notification when adopterUserId is null", async () => {
    const repo = makeFakeRepo({ reversible: makeReversible({ adopterUserId: null }) });
    const result = await reverseAdoption(baseInput, { repo, actor, transaction: fakeTransaction });
    const r = result as { ok: true; notifications: unknown[] };
    expect(r.notifications).toHaveLength(0);
  });
});
