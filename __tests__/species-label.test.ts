// Locks the shared es-AR species label map (lib/utils/format#speciesLabel).
//
// Regression guard for the "rabbit" leak spotted in the Ciudadano Cero QA
// (2026-07-08): /mis-mascotas and the org pipeline board reimplemented a local,
// incomplete dog/cat map and fell through to the raw English enum for every
// other species. Both surfaces now route through this shared map, so this test
// asserts the map is exhaustive and never returns the raw English token.

import { describe, expect, it } from "vitest";

import { speciesLabel, speciesLabelPlural } from "@/lib/utils/format";

// Canonical species set (pets.species): db/schema.ts comment + additional-species
// design (2026-05-17). Every value the app writes must render in es-AR.
const SPECIES = ["dog", "cat", "rabbit", "guinea_pig", "ferret", "other"] as const;

const EXPECTED: Record<(typeof SPECIES)[number], string> = {
  dog: "Perro",
  cat: "Gato",
  rabbit: "Conejo",
  guinea_pig: "Cobayo",
  ferret: "Hurón",
  other: "Otra",
};

describe("speciesLabel — es-AR map", () => {
  it("maps every known species to its es-AR label", () => {
    for (const s of SPECIES) {
      expect(speciesLabel(s)).toBe(EXPECTED[s]);
    }
  });

  it("never leaks the raw English enum token for a known species", () => {
    for (const s of SPECIES) {
      expect(speciesLabel(s)).not.toBe(s);
    }
  });

  it("falls back to the raw value only for genuinely unknown input", () => {
    expect(speciesLabel("unknown_freetext")).toBe("unknown_freetext");
  });
});

// The plural map serves surfaces that name a SET of species — filter dropdowns
// and the service eligibility rows. It gets the same exhaustiveness guard as
// the singular, because the failure mode is identical: add a species to one
// number, forget the other, and the forgotten one renders the English token.
const EXPECTED_PLURAL: Record<(typeof SPECIES)[number], string> = {
  dog: "Perros",
  cat: "Gatos",
  rabbit: "Conejos",
  guinea_pig: "Cobayos",
  ferret: "Hurones",
  other: "Otras",
};

describe("speciesLabelPlural — es-AR map", () => {
  it("maps every known species to its es-AR plural", () => {
    for (const s of SPECIES) {
      expect(speciesLabelPlural(s)).toBe(EXPECTED_PLURAL[s]);
    }
  });

  it("never leaks the raw English enum token for a known species", () => {
    for (const s of SPECIES) {
      expect(speciesLabelPlural(s)).not.toBe(s);
    }
  });

  it("covers exactly the same species as the singular map", () => {
    // A species added to one map and not the other is the defect this pair of
    // suites exists to prevent; asserting the key sets match catches it at the
    // dictionary instead of at whichever screen happens to render it first.
    expect(Object.keys(EXPECTED_PLURAL).sort()).toEqual([...SPECIES].sort());
  });
});
