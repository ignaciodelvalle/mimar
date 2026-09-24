// Unit tests for the additional-species spec mapping (PetForm.tsx) at the
// pure-data level. The form's UI is a top select (Perro / Gato / Otra) plus
// a sub-select that only appears when the top is "Otra"; the value that hits
// `formData.species` is the *resolved* species. Spec §"Stored value mapping".

import { describe, expect, it } from "vitest";

import { speciesLabel } from "@/lib/utils/format";

// Mirrors the resolver embedded in PetForm: the persisted value is the
// sub-select value when the group is "other", except for the explicit
// "Otro / no listado" choice which collapses back to "other".
function resolveSpecies(group: "dog" | "cat" | "other", sub: string | null): string {
  if (group === "dog") return "dog";
  if (group === "cat") return "cat";
  if (sub === null || sub === "" || sub === "other_unlisted") return "other";
  return sub;
}

describe("species resolver (PetForm)", () => {
  it("Perro maps to dog regardless of sub", () => {
    expect(resolveSpecies("dog", null)).toBe("dog");
    expect(resolveSpecies("dog", "rabbit")).toBe("dog");
  });

  it("Gato maps to cat", () => {
    expect(resolveSpecies("cat", null)).toBe("cat");
  });

  it("Otra → Conejo maps to rabbit", () => {
    expect(resolveSpecies("other", "rabbit")).toBe("rabbit");
  });

  it("Otra → Cobayo maps to guinea_pig", () => {
    expect(resolveSpecies("other", "guinea_pig")).toBe("guinea_pig");
  });

  it("Otra → Hurón maps to ferret", () => {
    expect(resolveSpecies("other", "ferret")).toBe("ferret");
  });

  it("Otra → Otro/no listado collapses to other", () => {
    expect(resolveSpecies("other", "other_unlisted")).toBe("other");
  });

  it("Otra without sub-selection falls back to other (form-level required catches this in UI)", () => {
    expect(resolveSpecies("other", null)).toBe("other");
    expect(resolveSpecies("other", "")).toBe("other");
  });
});

describe("speciesLabel covers the new species", () => {
  it("renders Spanish labels for rabbit / guinea_pig / ferret", () => {
    expect(speciesLabel("rabbit")).toBe("Conejo");
    expect(speciesLabel("guinea_pig")).toBe("Cobayo");
    expect(speciesLabel("ferret")).toBe("Hurón");
  });

  it("keeps existing labels", () => {
    expect(speciesLabel("dog")).toBe("Perro");
    expect(speciesLabel("cat")).toBe("Gato");
    expect(speciesLabel("other")).toBe("Otra");
  });

  it("falls through unknown values as-is", () => {
    expect(speciesLabel("llama")).toBe("llama");
  });
});
