// `speciesLabel` — the six words it knows, and the one it says for a seventh.
//
// WHY THE SEVENTH IS THE POINT (finding M1, review 2026-09-07). The payload
// types `species` as a plain `string`, so this function cannot be exhaustive and
// meets values this build has never heard of. It used to hand the raw one
// straight to the citizen — `chinchilla`, an internal identifier in English, in
// a wallet whose entire UI is es-AR — which is `ui/enum-label.ts`'s defect one
// layer over, and an OTA channel makes meeting one ordinary rather than
// hypothetical.

import { describe, expect, it } from "@jest/globals";

import { PET_SPECIES } from "@dim/contract/input";

import { SPECIES_OPTIONS, UNKNOWN_SPECIES_LABEL, speciesLabel } from "./species";

describe("the vocabulary this build knows", () => {
  it("gives every contract species an es-AR word that is not its identifier", () => {
    // Derived from the contract rather than transcribed, so a species added
    // there without a word here fails HERE and not on somebody's phone.
    for (const species of PET_SPECIES) {
      const label = speciesLabel(species);
      expect(label).not.toBe(species);
      expect(label).not.toBe(UNKNOWN_SPECIES_LABEL);
    }
    expect(new Set(PET_SPECIES.map(speciesLabel)).size).toBe(PET_SPECIES.length);
  });

  it("trims what the server sent before looking it up", () => {
    expect(speciesLabel("  dog  ")).toBe("Perro");
  });

  it("offers the picker the same words, in the contract's order", () => {
    expect(SPECIES_OPTIONS.map((option) => option.value)).toEqual([...PET_SPECIES]);
    expect(SPECIES_OPTIONS.map((option) => option.label)).toEqual(PET_SPECIES.map(speciesLabel));
  });
});

describe("a species from a server newer than this bundle", () => {
  it("never prints the raw identifier to a citizen", () => {
    expect(speciesLabel("chinchilla")).toBe(UNKNOWN_SPECIES_LABEL);
    expect(speciesLabel("bearded_dragon")).toBe(UNKNOWN_SPECIES_LABEL);
    // The property, not the two examples: whatever the fallback says, it may not
    // be the thing the server called it.
    for (const unknown of ["chinchilla", "bearded_dragon", "pot_bellied_pig", "hedgehog"]) {
      expect(speciesLabel(unknown)).not.toBe(unknown);
    }
  });

  it("does NOT collapse into the label of the real `other` member", () => {
    // The original objection, which the raw-value fallback was written to
    // answer and which this fallback answers too: showing "Otro" for an animal
    // the server called `chinchilla` would hide a gap in this app behind a
    // category somebody chose on purpose.
    expect(speciesLabel("other")).toBe("Otro");
    expect(UNKNOWN_SPECIES_LABEL).not.toBe("Otro");
    expect(speciesLabel("chinchilla")).not.toBe(speciesLabel("other"));
  });
});
