// Integration test for the rule-impact count (admin fresh-sweep A2).
//
// Reproduces the bug: the original `trim(breed) = ANY(${breeds})` threw on the
// untyped array param, so the impact banner only ever showed its error
// fallback. This test inserts an unflagged dog whose breed is in the candidate
// list and asserts a real count (≥1) with no throw.

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pets } from "@/db";
import { countDogsAffectedByRule } from "@/lib/infra/rule-impact";

const TOKEN = "AFF-RULEIMPACT-TEST-0001";
const BREED = "RuleImpactTestBreedZZZ"; // unique — won't collide with seed data

beforeAll(async () => {
  await db.delete(pets).where(eq(pets.publicToken, TOKEN));
  await db.insert(pets).values({
    publicToken: TOKEN,
    name: "Impact Test Dog",
    species: "dog",
    breed: BREED,
    jurisdictionCountry: "AR",
    jurisdictionProvince: "Buenos Aires",
    potentiallyDangerousBreed: false,
  });
});

afterAll(async () => {
  await db.delete(pets).where(eq(pets.publicToken, TOKEN));
});

describe("countDogsAffectedByRule (A2)", () => {
  it("ppp_breed_list: counts an unflagged in-jurisdiction dog whose breed is listed (≥1, no throw)", async () => {
    const n = await countDogsAffectedByRule({
      ruleType: "ppp_breed_list",
      breeds: [BREED],
      country: "AR",
      province: "Buenos Aires",
      locality: null,
    });
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it("does not throw on a breed list that matches nothing (returns an integer)", async () => {
    const n = await countDogsAffectedByRule({
      ruleType: "ppp_breed_list",
      breeds: ["A-Breed-That-Does-Not-Exist-Anywhere"],
      country: "AR",
      province: "Buenos Aires",
      locality: null,
    });
    expect(Number.isInteger(n)).toBe(true);
  });

  it("returns 0 for an empty breed list (no query)", async () => {
    const n = await countDogsAffectedByRule({
      ruleType: "ppp_breed_list",
      breeds: [],
      country: "AR",
      province: null,
      locality: null,
    });
    expect(n).toBe(0);
  });
});
