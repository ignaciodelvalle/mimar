// The header count on /mis-mascotas must not lie.
//
// THE BUG THIS PREVENTS. `fetchPetsForOwner` and the list query both scope to
// "any active ownership row, no role filter" — which is CORRECT for the list
// (a caretaker should see the animal they are caring for) and WRONG for the
// count. A titular of three pets who accepts one caretaker arrangement would
// read "4 activas" on a header titled "Mis mascotas", and one of those four is
// not theirs. The design's own words: an undifferentiated total would lie.
//
// The split is pure and lives here rather than in the page so the rule can be
// tested without a database, and so the same wording cannot drift between the
// two surfaces that will eventually want it.

import { describe, expect, it } from "vitest";

import { ownerPetCountLabel, splitOwnerPetCounts } from "./owner-pet-counts";

describe("splitOwnerPetCounts", () => {
  it("counts a caretaker row apart from every other role", () => {
    expect(
      splitOwnerPetCounts([
        { ownershipRole: "owner" },
        { ownershipRole: "owner" },
        { ownershipRole: "owner" },
        { ownershipRole: "caretaker" },
      ]),
    ).toEqual({ ownCount: 3, caretakerCount: 1 });
  });

  it("counts foster and shelter_custody as the viewer's own — they are not caretakers", () => {
    // A tránsito IS in this person's care in the sense the header means, and
    // the row already carries its own "En tránsito" badge. Splitting it out too
    // would be a different product decision smuggled in here.
    expect(
      splitOwnerPetCounts([
        { ownershipRole: "foster" },
        { ownershipRole: "shelter_custody" },
        { ownershipRole: "co_owner" },
      ]),
    ).toEqual({ ownCount: 3, caretakerCount: 0 });
  });

  it("handles an empty household", () => {
    expect(splitOwnerPetCounts([])).toEqual({ ownCount: 0, caretakerCount: 0 });
  });
});

describe("ownerPetCountLabel", () => {
  it("keeps today's wording when no caretaker arrangement exists", () => {
    // "N activas" is only ambiguous once a second class of pet appears. Owners
    // with no caretaker read exactly what they read before this change.
    expect(ownerPetCountLabel({ ownCount: 3, caretakerCount: 0, deceasedCount: 0 })).toBe(
      "3 activas",
    );
  });

  it("splits the moment a caretaker arrangement exists — never an undifferentiated total", () => {
    expect(ownerPetCountLabel({ ownCount: 3, caretakerCount: 1, deceasedCount: 0 })).toBe(
      "3 tuyas · 1 al cuidado",
    );
  });

  it("never renders the sum anywhere in the split label", () => {
    // NON-VACUITY WITH TEETH: the failure mode is a "4" appearing at all.
    const label = ownerPetCountLabel({ ownCount: 3, caretakerCount: 1, deceasedCount: 0 });
    expect(label).not.toContain("4");
  });

  it("pluralises both halves in es-AR", () => {
    expect(ownerPetCountLabel({ ownCount: 1, caretakerCount: 2, deceasedCount: 0 })).toBe(
      "1 tuya · 2 al cuidado",
    );
  });

  it("keeps the in-memoriam tail", () => {
    expect(ownerPetCountLabel({ ownCount: 2, caretakerCount: 1, deceasedCount: 3 })).toBe(
      "2 tuyas · 1 al cuidado · 3 en memoria",
    );
    expect(ownerPetCountLabel({ ownCount: 2, caretakerCount: 0, deceasedCount: 1 })).toBe(
      "2 activas · 1 en memoria",
    );
  });

  it("says something honest when every pet on the list belongs to someone else", () => {
    // A person whose only listed animal is one they are caring for. "0 tuyas"
    // is arithmetically right and reads as an error; the caretaker half alone
    // is the truth.
    expect(ownerPetCountLabel({ ownCount: 0, caretakerCount: 1, deceasedCount: 0 })).toBe(
      "1 al cuidado",
    );
  });

  it("renders nothing rather than a row of zeroes for an empty household", () => {
    expect(ownerPetCountLabel({ ownCount: 0, caretakerCount: 0, deceasedCount: 0 })).toBe(
      "0 activas",
    );
  });
});
