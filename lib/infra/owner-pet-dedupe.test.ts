// A2-alta-asentar-04 — the retry that was answered with the duplicate dialog.
//
// THE SCENARIO, which is the normal operating condition of the client this
// endpoint exists for. The native alta gives up after 10 s and says "No pudimos
// conectarnos"; on a slow connection the server commits anyway. The person taps
// Registrar again, the request carries the SAME `Idempotency-Key` — which is the
// entire point of the key — and `registerPet`'s in-transaction replay would
// answer 201 with the original token. It never ran: the dedupe scan is BEFORE
// it, matched the pet the phone had just created, and the app showed "Ya tenés
// registrada una mascota llamada Pampa…". "Cancelar" then sent the person away
// believing nothing had been registered.
//
// The match rule is tested here rather than through the route because the
// exclusion is a BEHAVIOUR: a route test can only assert that an argument was
// passed, and an argument nothing reads is not a fix.

import { describe, expect, it } from "vitest";

import { type OwnerPetRow, normalizePetName, selectDuplicateRow } from "./owner-pet-dedupe";

const KEY = "9f0c2f4e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const OTHER_KEY = "1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9";

const PAMPA: OwnerPetRow = {
  publicToken: "DIM-PAMP-0001",
  name: "Pampa",
  species: "dog",
  sex: "female",
  registrationKey: KEY,
};

const CANDIDATE = { name: "Pampa", species: "dog", sex: "female" } as const;

describe("selectDuplicateRow — the same-owner dedupe scan", () => {
  it("matches an active owned pet on folded name + species + sex", () => {
    // NON-VACUITY for everything below: the gate still does its job.
    expect(selectDuplicateRow([PAMPA], CANDIDATE)?.publicToken).toBe("DIM-PAMP-0001");
    expect(selectDuplicateRow([PAMPA], { ...CANDIDATE, name: "  pámpa " })?.publicToken).toBe(
      "DIM-PAMP-0001",
    );
  });

  it("does NOT report the pet this very key created as a duplicate", () => {
    // THE DEFECT. Same body, same key, second attempt.
    expect(
      selectDuplicateRow([PAMPA], { ...CANDIDATE, excludeClientIdempotencyKey: KEY }),
    ).toBeNull();
  });

  it("still reports a duplicate registered under a DIFFERENT key", () => {
    // A retry is not a licence to skip the gate: only the pet this attempt
    // itself created is excluded.
    expect(
      selectDuplicateRow([PAMPA], { ...CANDIDATE, excludeClientIdempotencyKey: OTHER_KEY })
        ?.publicToken,
    ).toBe("DIM-PAMP-0001");
  });

  it("still reports a duplicate that carries no registration key at all", () => {
    // A pet registered before the key existed, or through a path that does not
    // send one. `null === null` would exclude every one of them if the guard
    // compared without checking that an exclusion was asked for.
    const legacy: OwnerPetRow = { ...PAMPA, registrationKey: null };
    expect(
      selectDuplicateRow([legacy], { ...CANDIDATE, excludeClientIdempotencyKey: null })
        ?.publicToken,
    ).toBe("DIM-PAMP-0001");
    expect(
      selectDuplicateRow([legacy], { ...CANDIDATE, excludeClientIdempotencyKey: "  " })
        ?.publicToken,
    ).toBe("DIM-PAMP-0001");
  });

  it("keeps scanning past the excluded pet instead of stopping at it", () => {
    // Two dogs called Pampa: the one this key just created, and a real earlier
    // duplicate. Excluding the first must not hide the second.
    const earlier: OwnerPetRow = {
      ...PAMPA,
      publicToken: "DIM-PAMP-0000",
      registrationKey: OTHER_KEY,
    };
    expect(
      selectDuplicateRow([PAMPA, earlier], { ...CANDIDATE, excludeClientIdempotencyKey: KEY })
        ?.publicToken,
    ).toBe("DIM-PAMP-0000");
  });

  it("does not match on a different species or sex", () => {
    expect(selectDuplicateRow([PAMPA], { ...CANDIDATE, species: "cat" })).toBeNull();
    expect(selectDuplicateRow([PAMPA], { ...CANDIDATE, sex: "male" })).toBeNull();
  });

  it("folds accents and whitespace the way the rest of the app does", () => {
    // THE LITERAL, not a re-derivation. The expected value used to be built by
    // running `.normalize("NFD").replace(/\p{M}/gu, "")` over a string — the
    // same two primitives the function under test uses, so a mutation to either
    // of them changed both sides and the assertion stayed green (L2-12).
    expect(normalizePetName("  Ñañdú   José ")).toBe("nandu jose");
  });
});
