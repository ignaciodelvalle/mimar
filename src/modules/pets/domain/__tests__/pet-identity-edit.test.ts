// `composePetIdentityEdit` — the overlay that lets a THREE-FIELD request reach a
// SEVENTEEN-COLUMN writer without wiping the fourteen it did not name.
//
// WHAT THIS FILE HAS TO PROVE, and why it is not "it copies some fields"
// ---------------------------------------------------------------------------
// `PetsRepository.updatePetProfile` writes every column in its `SET`
// unconditionally, from `parsed`. So the failure this function exists to prevent
// is not a compile error and not an exception: it is a 200, a
// `pet_profile_updated` event faithfully recording the loss, and an owner who
// corrected a typo in a name and lost their animal's weight, allergies, training
// level, insurance policy and permanent medical conditions in the same click.
//
// The first test is therefore a WHOLE-OBJECT comparison against a literal, not
// a list of `expect(parsed.x)` lines. The difference is not style. A list can
// only fail on a field somebody remembered to list, which makes it blind to
// exactly the regression that matters: a field added to `ParsedPet` later and
// wired here to `null` instead of to `existing`. `toEqual` against a complete
// literal fails on that, on a field quietly dropped, and on a field added to the
// output that nobody declared — none of which a spot check can see.
//
// TypeScript covers the other half and only the other half: `composePetIdentityEdit`
// returns `ParsedPet`, so FORGETTING a new required field is a compile error. It
// is filling one in wrongly that compiles, and that is this test's subject.

import { describe, expect, it } from "vitest";

import type { ParsedPet } from "@/src/modules/pets/domain/types";

import {
  type EditablePetSnapshot,
  composePetIdentityEdit,
} from "@/src/modules/pets/domain/pet-identity-edit";

/** A pet with EVERY optional field populated — a blank one proves nothing. */
function fullPet(over: Partial<EditablePetSnapshot> = {}): EditablePetSnapshot {
  return {
    name: "Pampa",
    species: "dog",
    sex: "female",
    breed: "Mestizo",
    dateOfBirth: "2021-03-04",
    birthDateIsEstimated: true,
    color: "Atigrada",
    estimatedWeightKg: "18.50",
    favouriteFoods: ["pollo", "zanahoria"],
    knownAllergies: ["polen"],
    trainingLevel: "basic",
    insuranceCompany: "Aseguradora Sur",
    insurancePolicyNumber: "POL-9182",
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "San Carlos de Bariloche",
    acquisitionMethod: "adopted",
    emergencyInfoVisible: true,
    permanentConditions: ["ciego", "otra"],
    permanentConditionsOther: "displasia de cadera",
    discloseConditionsPublicly: true,
    ...over,
  };
}

describe("composePetIdentityEdit — what the caller did not name survives", () => {
  it("produces exactly this object and nothing else", () => {
    const parsed = composePetIdentityEdit(fullPet(), {
      name: "Pampita",
      breed: "Caniche",
      color: "Blanca",
    });

    // THE WHOLE OBJECT, written out. Annotated `ParsedPet` on purpose: a field
    // added to the type shows up here as a compile error in the LITERAL, which
    // is a reviewer being asked "carried over, or deliberately not?" rather than
    // a green suite that never noticed.
    const expected: ParsedPet = {
      // The three that were asked for.
      name: "Pampita",
      breed: "Caniche",
      color: "Blanca",

      // Everything the repository's unconditional `SET` would otherwise have
      // nulled or flipped.
      species: "dog",
      sex: "female",
      dateOfBirth: "2021-03-04",
      birthDateIsEstimated: true,
      estimatedWeightKg: "18.50",
      favouriteFoods: ["pollo", "zanahoria"],
      knownAllergies: ["polen"],
      trainingLevel: "basic",
      insuranceCompany: "Aseguradora Sur",
      insurancePolicyNumber: "POL-9182",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "San Carlos de Bariloche",
      acquisitionMethod: "adopted",
      emergencyInfoVisible: true,
      permanentConditions: ["ciego", "otra"],
      permanentConditionsOther: "displasia de cadera",
      discloseConditionsPublicly: true,

      // Deliberately not carried — each one for its own reason, in the header.
      microchipId: null,
      microchipCountryCode: null,
      microchipImplantedAt: null,
      microchipImplantedBy: null,
      microchipLocation: null,
      custodyKind: "owner",
    };

    expect(parsed).toEqual(expected);
    // `toEqual` ignores keys whose value is `undefined`, so it would not notice
    // `localityId: undefined` appearing. The key list is checked on its own —
    // `localityId` is OMITTED here, not nulled, because `updatePetProfile` has
    // no writer for it and stating a value would imply one.
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(expected).sort());
  });

  it("does not silently drop a permanent condition the catalog no longer names", () => {
    // A row written before a catalog entry was renamed. Re-validating here would
    // remove it on the next unrelated name edit — a MEDICAL fact about the
    // animal, disappearing from a form that never mentioned it.
    const parsed = composePetIdentityEdit(
      fullPet({ permanentConditions: ["una_condicion_que_ya_no_existe"] }),
      { name: "Pampa", breed: null, color: null },
    );
    expect(parsed.permanentConditions).toEqual(["una_condicion_que_ya_no_existe"]);
  });

  it("turns null array columns into empty arrays, which the writer stores back as null", () => {
    // `ParsedPet` types both as `string[]`; the repository writes
    // `length > 0 ? arr : null`. So null in must become null out, and the empty
    // array is the only shape that survives the round trip.
    const parsed = composePetIdentityEdit(fullPet({ favouriteFoods: null, knownAllergies: null }), {
      name: "Pampa",
      breed: null,
      color: null,
    });
    expect(parsed.favouriteFoods).toEqual([]);
    expect(parsed.knownAllergies).toEqual([]);
  });

  it("names no microchip, so no chip can be added down this door", () => {
    // `isChipNewlyAdded` answers false for a null `microchipId`, which is what
    // keeps this endpoint from appending a `microchip_implanted` event. A chip
    // is added through its own path.
    const parsed = composePetIdentityEdit(fullPet(), {
      name: "Pampa",
      breed: null,
      color: null,
    });
    expect(parsed.microchipId).toBeNull();
    expect(parsed.microchipCountryCode).toBeNull();
    expect(parsed.microchipImplantedAt).toBeNull();
    expect(parsed.microchipImplantedBy).toBeNull();
    expect(parsed.microchipLocation).toBeNull();
  });

  it("clears breed and colour when asked to, rather than treating null as 'leave it'", () => {
    const parsed = composePetIdentityEdit(fullPet(), {
      name: "Pampa",
      breed: null,
      color: null,
    });
    expect(parsed.breed).toBeNull();
    expect(parsed.color).toBeNull();
  });

  it("never lets the request decide the species", () => {
    // There is no species field on this request by construction — the 2026-08-14
    // adversarial finding (a crafted `species=cat` passing the breed gate
    // against the wrong catalog) is unreachable here because the only species in
    // play is the persisted one.
    const parsed = composePetIdentityEdit(fullPet({ species: "cat" }), {
      name: "Michi",
      breed: null,
      color: null,
    });
    expect(parsed.species).toBe("cat");
  });
});
