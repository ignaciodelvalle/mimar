// correctPetSpecies — the use-case against FAKE deps (unit project).
//
// WHAT THIS FILE HAS TO PROVE, now that two doors reach one module:
//   1. THE SAME SPECIES IS A SUCCESS THAT WRITES NOTHING. A correction's success
//      invalidates its own precondition, so the replay of a request that lost
//      its response must answer the way the first did — and must not open a
//      transaction, resolve PPP, or append a second event to do it.
//   2. A BREED THE NEW SPECIES' CATALOG DOES NOT CARRY IS CLEARED in the same
//      write, and the PPP rule sees (new species, cleared breed) — never the
//      cross-species breed (adversarial review 2026-08-14, F2).
//   3. A SPECIAL OPTION SURVIVES, because it resolves in every catalog.
//   4. THE VOCABULARY IS CLOSED. A species the contract does not list is
//      refused before any I/O.
//   5. A WRITE THAT THROWS IS A TYPED FAILURE, never an unhandled error, and
//      the message reaches the caller for the web's own sentence.
//   6. THE AUTHORSHIP THE CALLER HANDS IN IS WHAT SIGNS THE EVENT.

import { describe, expect, it, vi } from "vitest";

import {
  CORRECTABLE_SPECIES,
  type CorrectPetSpeciesDeps,
  correctPetSpecies,
} from "../application/profile/correct-species";

const PET = {
  id: "pet-1",
  species: "dog",
  breed: "Labrador",
  estimatedWeightKg: "22.5",
  jurisdictionProvince: "Buenos Aires",
  jurisdictionLocality: "La Plata",
};

const OWNER_AUTHORSHIP = {
  authorRole: "owner" as const,
  authorOrganizationId: null,
  authorVerified: false,
};

function makeDeps(over: Partial<CorrectPetSpeciesDeps> = {}) {
  const correctSpecies = vi.fn().mockResolvedValue({ eventId: "event-1" });
  const resolvePpp = vi.fn().mockResolvedValue(false);
  const transaction = vi.fn(async <T>(cb: (tx: unknown) => Promise<T>) => cb("fake-tx"));
  return {
    deps: { repo: { correctSpecies }, transaction, resolvePpp, ...over } as CorrectPetSpeciesDeps,
    correctSpecies,
    resolvePpp,
    transaction,
  };
}

const actor = { userId: "user-1", eventAuthorship: OWNER_AUTHORSHIP };

describe("correctPetSpecies — the replay rule", () => {
  it("answers changed:false for the species the animal already has, and touches nothing", async () => {
    const { deps, correctSpecies, resolvePpp, transaction } = makeDeps();
    const result = await correctPetSpecies({ pet: PET, newSpecies: "dog", actor }, deps);
    expect(result).toEqual({ ok: true, changed: false, species: "dog" });
    // MUTATION APPLIED: drop the same-species short-circuit. Red on all three —
    // a replayed correction would append a second `pet_profile_updated` whose
    // diff is species→species, and the ledger would record a correction that
    // corrected nothing.
    expect(transaction).not.toHaveBeenCalled();
    expect(correctSpecies).not.toHaveBeenCalled();
    expect(resolvePpp).not.toHaveBeenCalled();
  });

  it("trims the submitted value before comparing, as the form's parser did", async () => {
    const { deps, correctSpecies } = makeDeps();
    const result = await correctPetSpecies({ pet: PET, newSpecies: "  dog  ", actor }, deps);
    expect(result).toEqual({ ok: true, changed: false, species: "dog" });
    expect(correctSpecies).not.toHaveBeenCalled();
  });
});

describe("correctPetSpecies — what travels with the species", () => {
  it("clears a breed that does not resolve in the NEW species' catalog, and PPP sees the cleared breed", async () => {
    const { deps, correctSpecies, resolvePpp } = makeDeps();
    const result = await correctPetSpecies({ pet: PET, newSpecies: "cat", actor }, deps);
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      eventId: "event-1",
      species: "cat",
      breed: null,
      breedCleared: true,
    });
    expect(correctSpecies).toHaveBeenCalledWith(
      expect.objectContaining({
        petId: "pet-1",
        oldSpecies: "dog",
        newSpecies: "cat",
        oldBreed: "Labrador",
        newBreed: null,
        userId: "user-1",
        eventAuthorship: OWNER_AUTHORSHIP,
      }),
      "fake-tx",
    );
    // (cat, null, 22.5, AR/Buenos Aires/La Plata) — never (cat, "Labrador").
    expect(resolvePpp).toHaveBeenCalledWith("cat", null, 22.5, {
      country: "AR",
      province: "Buenos Aires",
      locality: "La Plata",
    });
  });

  it("keeps a special option — it resolves in every species' catalog", async () => {
    const { deps, correctSpecies } = makeDeps();
    const result = await correctPetSpecies(
      { pet: { ...PET, breed: "Mixto / Cruza" }, newSpecies: "cat", actor },
      deps,
    );
    expect(result).toMatchObject({ ok: true, changed: true, breed: "Mixto / Cruza" });
    expect(result.ok && result.changed && result.breedCleared).toBe(false);
    expect(correctSpecies).toHaveBeenCalledWith(
      expect.objectContaining({ newSpecies: "cat", newBreed: "Mixto / Cruza" }),
      expect.anything(),
    );
  });

  it("hands the PPP flag the resolver answered into the write, unchanged", async () => {
    const { deps, correctSpecies } = makeDeps();
    deps.resolvePpp = vi.fn().mockResolvedValue(true);
    const result = await correctPetSpecies(
      { pet: { ...PET, species: "cat", breed: null }, newSpecies: "dog", actor },
      deps,
    );
    expect(result).toMatchObject({ ok: true, changed: true, potentiallyDangerousBreed: true });
    expect(correctSpecies).toHaveBeenCalledWith(
      expect.objectContaining({ potentiallyDangerousBreed: true }),
      expect.anything(),
    );
  });

  it("reads a weight nobody can parse as no weight, never throwing mid-correction", async () => {
    const { deps, resolvePpp } = makeDeps();
    await correctPetSpecies(
      { pet: { ...PET, estimatedWeightKg: "mucho" }, newSpecies: "cat", actor },
      deps,
    );
    expect(resolvePpp).toHaveBeenCalledWith("cat", null, null, expect.anything());
  });
});

describe("correctPetSpecies — how it refuses", () => {
  it("refuses a species outside the contract's list before any I/O", async () => {
    const { deps, correctSpecies, resolvePpp, transaction } = makeDeps();
    const result = await correctPetSpecies({ pet: PET, newSpecies: "dragon", actor }, deps);
    expect(result).toEqual({ ok: false, code: "species_invalid" });
    expect(transaction).not.toHaveBeenCalled();
    expect(correctSpecies).not.toHaveBeenCalled();
    expect(resolvePpp).not.toHaveBeenCalled();
  });

  it("the list it refuses against is the contract's own six", () => {
    expect([...CORRECTABLE_SPECIES]).toEqual([
      "dog",
      "cat",
      "rabbit",
      "guinea_pig",
      "ferret",
      "other",
    ]);
  });

  it("turns a write that throws into write_failed carrying the message", async () => {
    const { deps } = makeDeps();
    deps.repo = { correctSpecies: vi.fn().mockRejectedValue(new Error("deadlock detected")) };
    const result = await correctPetSpecies({ pet: PET, newSpecies: "cat", actor }, deps);
    expect(result).toEqual({ ok: false, code: "write_failed", error: "deadlock detected" });
  });

  it("names an unknown throwable honestly rather than crashing on `.message`", async () => {
    const { deps } = makeDeps();
    deps.repo = { correctSpecies: vi.fn().mockRejectedValue("boom") };
    const result = await correctPetSpecies({ pet: PET, newSpecies: "cat", actor }, deps);
    expect(result).toEqual({ ok: false, code: "write_failed", error: "error desconocido" });
  });
});
