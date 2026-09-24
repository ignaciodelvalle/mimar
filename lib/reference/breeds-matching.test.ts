// Breed matching — the PPP regime must not be escapable by typing.
//
// Regression origin: staging clickthrough, 2026-08-13. An owner typed "Pitbull"
// on a 21,4 kg dog in CABA; the catalog says "Pit Bull Terrier"; the match was
// exact string equality, so the PPP requirement vanished from the pet's
// compliance list (denominator 4 → 3) with no warning to anyone. A legal regime
// that a spelling can opt you out of is not a regime.

import { describe, expect, it } from "vitest";

import {
  CAT_BREEDS,
  DOG_BREEDS,
  POTENTIALLY_DANGEROUS_DOG_BREEDS,
  SPECIAL_BREED_OPTIONS,
  breedListIncludes,
  isPotentiallyDangerousBreed,
  normalizeBreedKey,
  resolveBreedLabel,
} from "@/lib/reference/breeds";

describe("normalizeBreedKey", () => {
  it("folds case, accents and separators", () => {
    expect(normalizeBreedKey("Mastín Napolitano")).toBe(normalizeBreedKey("mastin  napolitano"));
    expect(normalizeBreedKey("Dogo-Argentino")).toBe(normalizeBreedKey("DOGO ARGENTINO"));
  });

  it("does not collapse two different breeds into one key", () => {
    expect(normalizeBreedKey("Bull Terrier")).not.toBe(normalizeBreedKey("Pit Bull Terrier"));
  });
});

describe("isPotentiallyDangerousBreed", () => {
  it("classifies the exact case that shipped: 'Pitbull'", () => {
    expect(isPotentiallyDangerousBreed("dog", "Pitbull")).toBe(true);
  });

  it("classifies the row found UNFLAGGED in staging: 'Pit Bull Terrier Americano'", () => {
    // A real dog in CABA/Palermo, potentially_dangerous_breed = false, while an
    // identical dog in CABA/Recoleta was flagged — under the same law. Found by
    // reading the data, not by reasoning about the matcher.
    expect(isPotentiallyDangerousBreed("dog", "Pit Bull Terrier Americano")).toBe(true);
  });

  it("classifies orthographic variants of a catalog name", () => {
    expect(isPotentiallyDangerousBreed("dog", "mastin napolitano")).toBe(true);
    expect(isPotentiallyDangerousBreed("dog", "DOGO ARGENTINO")).toBe(true);
    expect(isPotentiallyDangerousBreed("dog", "  Rottweiler  ")).toBe(true);
  });

  it("still classifies every catalog label verbatim", () => {
    for (const breed of POTENTIALLY_DANGEROUS_DOG_BREEDS) {
      expect(isPotentiallyDangerousBreed("dog", breed)).toBe(true);
    }
  });

  it("does NOT sweep in breeds that merely share words", () => {
    // The reason aliases are curated instead of substring-matched.
    expect(isPotentiallyDangerousBreed("dog", "Beagle")).toBe(false);
    expect(isPotentiallyDangerousBreed("dog", "Border Collie")).toBe(false);
    expect(isPotentiallyDangerousBreed("dog", "Bulldog Francés")).toBe(false);
  });

  it("stays species-gated: a cat named after a dog breed is not PPP", () => {
    expect(isPotentiallyDangerousBreed("cat", "Pitbull")).toBe(false);
  });

  it("ignores empty and punctuation-only input", () => {
    expect(isPotentiallyDangerousBreed("dog", "   ")).toBe(false);
    expect(isPotentiallyDangerousBreed("dog", "---")).toBe(false);
  });
});

describe("resolveBreedLabel", () => {
  it("resolves a colloquial name to a label that exists in the catalog", () => {
    expect(resolveBreedLabel("amstaff")).toBe("American Staffordshire Terrier");
    expect(resolveBreedLabel("presa canario")).toBe("Dogo Canario (Presa Canario)");
  });

  it("resolves the non-PPP colloquials found in real data", () => {
    expect(resolveBreedLabel("Ovejero Alemán")).toBe("Pastor Alemán");
    expect(resolveBreedLabel("Caniche toy")).toBe("Caniche");
    expect(resolveBreedLabel("Salchicha")).toBe("Salchicha (Dachshund)");
    expect(resolveBreedLabel("Galgo (Greyhound)")).toBe("Galgo");
    expect(resolveBreedLabel("Rough Collie")).toBe("Collie");
  });

  it("resolves cat breeds and the special options, not only dogs", () => {
    // Buscaba sólo en DOG_BREEDS: toda raza de gato quedaba sin resolver.
    expect(resolveBreedLabel("común europeo")).toBe("Común europeo");
    expect(resolveBreedLabel("Mixto / Cruza")).toBe("Mixto / Cruza");
  });

  it("returns null for something that is not a breed at all", () => {
    expect(resolveBreedLabel("cualquier cosa")).toBeNull();
  });
});

describe("los alias no pueden inventar una raza", () => {
  it("todo alias resuelve a una etiqueta que existe en algún catálogo", () => {
    // Sin esto, un typo en el mapa crea un valor que ningún <select> ofrece y
    // que el auditor de catálogo va a marcar como inválido para siempre.
    const catalogo = new Set([...DOG_BREEDS, ...CAT_BREEDS, ...SPECIAL_BREED_OPTIONS]);
    const coloquiales = [
      "Pitbull",
      "Pit Bull Terrier Americano",
      "amstaff",
      "presa canario",
      "Ovejero Alemán",
      "Caniche toy",
      "Salchicha",
      "Galgo (Greyhound)",
      "Rough Collie",
      "Gran Danes",
      "Blue Heeler",
      "mestizo",
      "Cruza",
    ];
    for (const entrada of coloquiales) {
      const resuelto = resolveBreedLabel(entrada);
      expect(resuelto, `"${entrada}" no resolvió`).not.toBeNull();
      expect(catalogo, `"${entrada}" → "${resuelto}" no está en el catálogo`).toContain(resuelto);
    }
  });
});

describe("breedListIncludes", () => {
  it("never widens the regime: an alias off the effective list stays off", () => {
    // A province that enacted a SHORT list must not get extra breeds because
    // the owner typed a colloquial name for one that is not on it.
    const provinceList = ["Rottweiler"];
    expect(breedListIncludes(provinceList, resolveBreedLabel("Pitbull") ?? "")).toBe(false);
    expect(breedListIncludes(provinceList, resolveBreedLabel("rotweiler") ?? "")).toBe(true);
  });
});
