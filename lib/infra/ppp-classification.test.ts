import { describe, expect, it } from "vitest";

import { classifyPpp } from "@/lib/infra/ppp-classification";

const NO_RULES = { breeds: new Set<string>(), kg: null, appliesIfBreedNotPPP: false };

describe("classifyPpp — weight-threshold enforcement seam (design ADR-3)", () => {
  it("non-dog species is never PPP regardless of rules", () => {
    expect(
      classifyPpp("cat", "Persa", 20, {
        breeds: new Set(["Persa"]),
        kg: 5,
        appliesIfBreedNotPPP: true,
      }),
    ).toBe(false);
  });

  it("default payload (kg: null) behaves EXACTLY like breed-only — dark rollout guarantee", () => {
    // Breed on the list -> PPP regardless of weight rule.
    expect(
      classifyPpp("dog", "Pit Bull Terrier", 30, {
        ...NO_RULES,
        breeds: new Set(["Pit Bull Terrier"]),
      }),
    ).toBe(true);
    // Breed NOT on the list, no weight rule (kg: null) -> not PPP, no matter the weight.
    expect(classifyPpp("dog", "Labrador", 45, NO_RULES)).toBe(false);
    // No breed data at all, no weight rule -> not PPP.
    expect(classifyPpp("dog", null, null, NO_RULES)).toBe(false);
  });

  it("appliesIfBreedNotPPP=false: weight only re-adds a condition to ALREADY-PPP breeds (no-op for non-PPP breeds)", () => {
    const rules = { breeds: new Set(["Pit Bull Terrier"]), kg: 20, appliesIfBreedNotPPP: false };
    // Non-PPP breed, over the weight threshold, but appliesIfBreedNotPPP=false -> still NOT PPP.
    expect(classifyPpp("dog", "Labrador", 30, rules)).toBe(false);
    // PPP breed -> already true via breedInList, weight condition doesn't matter.
    expect(classifyPpp("dog", "Pit Bull Terrier", 5, rules)).toBe(true);
  });

  it("appliesIfBreedNotPPP=true: weight can newly flip a non-PPP breed (the ONLY activation path)", () => {
    const rules = { breeds: new Set(["Pit Bull Terrier"]), kg: 20, appliesIfBreedNotPPP: true };
    expect(classifyPpp("dog", "Labrador", 25, rules)).toBe(true); // over threshold -> flips
    expect(classifyPpp("dog", "Labrador", 15, rules)).toBe(false); // under threshold -> stays false
    expect(classifyPpp("dog", "Labrador", null, rules)).toBe(false); // no weight data -> stays false
  });

  it("weight exactly AT the threshold counts as hitting it (>=)", () => {
    const rules = { breeds: new Set<string>(), kg: 20, appliesIfBreedNotPPP: true };
    expect(classifyPpp("dog", "Labrador", 20, rules)).toBe(true);
    expect(classifyPpp("dog", "Labrador", 19.9, rules)).toBe(false);
  });

  it("breed with no weight data and no breed match is never PPP even with appliesIfBreedNotPPP=true", () => {
    const rules = { breeds: new Set<string>(), kg: 20, appliesIfBreedNotPPP: true };
    expect(classifyPpp("dog", null, null, rules)).toBe(false);
  });
});

describe("classifyPpp — breed membership folds before matching (QA A4)", () => {
  // Raw Set.has was exact, case- and accent-sensitive equality: an
  // already-stored "pitbull" or "Mastin Napolitano" silently fell out of the
  // legal regime while lib/reference/breeds.ts had the canonicalization
  // written and in use everywhere else.
  const rules = { breeds: new Set(["Pit Bull Terrier"]), kg: null, appliesIfBreedNotPPP: false };

  it("classifies a stored colloquial alias", () => {
    expect(classifyPpp("dog", "pitbull", null, rules)).toBe(true);
  });

  it("classifies orthographic variants (case/accents/separators)", () => {
    const napolitano = {
      breeds: new Set(["Mastín Napolitano"]),
      kg: null,
      appliesIfBreedNotPPP: false,
    };
    expect(classifyPpp("dog", "mastin  napolitano", null, napolitano)).toBe(true);
    expect(classifyPpp("dog", "PIT BULL TERRIER", null, rules)).toBe(true);
  });

  it("never widens the regime: an alias off the effective list stays off", () => {
    const shortList = { breeds: new Set(["Rottweiler"]), kg: null, appliesIfBreedNotPPP: false };
    expect(classifyPpp("dog", "pitbull", null, shortList)).toBe(false);
  });

  it("matches when the JURISDICTION list entry is the alias form (folding asymmetry)", () => {
    // The admin-stored list is free text too: an entry "Pitbull" must catch a
    // canonically-stored "Pit Bull Terrier". Resolving only the candidate
    // left this pairing unmatched (adversarial review 2026-08-14).
    const aliasList = { breeds: new Set(["Pitbull"]), kg: null, appliesIfBreedNotPPP: false };
    expect(classifyPpp("dog", "Pit Bull Terrier", null, aliasList)).toBe(true);
    // Alias on BOTH sides still matches (both resolve to the same canonical).
    expect(classifyPpp("dog", "pitbull", null, aliasList)).toBe(true);
    // Never widens: a different breed stays off the regime.
    expect(classifyPpp("dog", "Labrador", null, aliasList)).toBe(false);
  });

  it("weight OR-composition is untouched by the folding", () => {
    const weightRules = {
      breeds: new Set(["Pit Bull Terrier"]),
      kg: 20,
      appliesIfBreedNotPPP: false,
    };
    // Folded breed match → PPP regardless of weight.
    expect(classifyPpp("dog", "pitbull", 5, weightRules)).toBe(true);
    // Non-matching breed, appliesIfBreedNotPPP=false → weight alone never flips.
    expect(classifyPpp("dog", "caniche", 30, weightRules)).toBe(false);
  });
});
