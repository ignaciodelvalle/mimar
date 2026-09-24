// BITE-NAME-HIDE (PO decision) — the anonymous public view of a cruelty/bite
// case must NOT show the pet's proper name; species/sex/photo stay. An
// authenticated in-scope viewer still sees the name. Lost-pet / adoption cases
// are unaffected (there the name helps recovery / matching).
//
// Covers:
//   - shouldRedactPetName policy (kind × isPublic).
//   - SubjectCard render contract: with a name the name shows; when redacted
//     (petName null) the name is absent from the markup but the species
//     descriptor ("Perro · macho") and the card still render.

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  PET_NAME_HIDDEN_CASE_KINDS,
  shouldRedactPetName,
} from "@/components/casos/pet-name-redaction";
import { SubjectCard } from "@/components/ui/dashboard/CaseDetailShell";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

describe("shouldRedactPetName", () => {
  it("redacts the name for an anonymous viewer on cruelty/bite kinds", () => {
    for (const kind of PET_NAME_HIDDEN_CASE_KINDS) {
      expect(shouldRedactPetName(kind, true)).toBe(true);
    }
    expect(shouldRedactPetName("bite_incident", true)).toBe(true);
    expect(shouldRedactPetName("welfare_denuncia", true)).toBe(true);
  });

  it("never redacts for an authenticated viewer", () => {
    expect(shouldRedactPetName("bite_incident", false)).toBe(false);
    expect(shouldRedactPetName("welfare_denuncia", false)).toBe(false);
  });

  it("does not redact lost-pet or adoption cases (name is the point there)", () => {
    expect(shouldRedactPetName("lost_pet_episode", true)).toBe(false);
    expect(shouldRedactPetName("adoption_listing", true)).toBe(false);
  });
});

describe("SubjectCard pet-name render contract", () => {
  const NAME = "Firulais";
  const SPECIES = "Perro · macho";

  it("authed view shows the pet's proper name", () => {
    const html = render(
      <SubjectCard subject={{ kind: "pet", petName: NAME, petSpecies: SPECIES }} />,
    );
    expect(html).toContain(NAME);
    expect(html).toContain(SPECIES);
  });

  it("redacted (anonymous) view hides the name but keeps the species descriptor", () => {
    const html = render(
      // petName null == redacted (what CaseDetailView passes for an anon
      // cruelty/bite viewer). Species/sex must still render.
      <SubjectCard subject={{ kind: "pet", petName: null, petSpecies: SPECIES }} />,
    );
    expect(html).not.toContain(NAME);
    expect(html).toContain(SPECIES);
    // The pet card still renders (photo/species), not the generic fallback card.
    expect(html).toContain("Mascota sujeto del caso");
  });
});
