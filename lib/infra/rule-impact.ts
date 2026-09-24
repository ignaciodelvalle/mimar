// Rule-impact query — pure data access, NO "use server", NO auth. Extracted
// from app/actions/rule-impact-preview.ts so it can be integration-tested
// directly against the DB (the action wraps it with the admin auth guard).
//
// Admin fresh-sweep A2: the original action filtered breeds with
//   sql`trim(breed) = ANY(${breeds})`
// which bound the JS string[] as a single untyped parameter. Postgres could not
// infer the array element type, so the query threw — and the RuleImpactBanner
// only ever showed its error fallback ("No se pudo calcular…") even with
// matching seed dogs present. inArray() emits `trim(breed) in ($1, $2, …)` with
// typed scalar params, which counts correctly.

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { db, pets } from "@/db";

export type RuleImpactPreviewInput =
  | {
      ruleType: "ppp_breed_list";
      breeds: string[];
      country: string;
      province: string | null;
      locality: string | null;
    }
  | {
      ruleType: "ppp_weight_threshold";
      kg: number | null;
      appliesIfBreedNotPPP: boolean;
      country: string;
      province: string | null;
      locality: string | null;
    };

function buildJurisdictionConditions(
  country: string,
  province: string | null,
  locality: string | null,
) {
  const conditions = [eq(pets.jurisdictionCountry, country), eq(pets.species, "dog")];
  if (province !== null) conditions.push(eq(pets.jurisdictionProvince, province));
  if (locality !== null) conditions.push(eq(pets.jurisdictionLocality, locality));
  return conditions;
}

/**
 * Count dogs in the target jurisdiction that the candidate rule would NEWLY
 * classify as PPP (currently unflagged). Read-only; writes nothing. Returns 0
 * when the input cannot produce new classifications (empty breed list, null kg,
 * or a weight rule scoped to already-PPP dogs).
 */
export async function countDogsAffectedByRule(input: RuleImpactPreviewInput): Promise<number> {
  const { country, province, locality } = input;

  if (input.ruleType === "ppp_breed_list") {
    const { breeds } = input;
    if (breeds.length === 0) return 0;

    const conditions = buildJurisdictionConditions(country, province, locality);
    conditions.push(isNotNull(pets.breed));
    conditions.push(eq(pets.potentiallyDangerousBreed, false));
    // Trimmed, case-sensitive exact match against the candidate list.
    conditions.push(inArray(sql`trim(${pets.breed})`, breeds));

    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(pets)
      .where(and(...conditions));

    return row?.n ?? 0;
  }

  // ppp_weight_threshold
  const { kg, appliesIfBreedNotPPP } = input;
  if (kg === null) return 0;
  // Only currently-unflagged dogs can flip; if the threshold applies only to
  // already-PPP dogs, none would flip via weight alone.
  if (!appliesIfBreedNotPPP) return 0;

  const conditions = buildJurisdictionConditions(country, province, locality);
  conditions.push(eq(pets.potentiallyDangerousBreed, false));
  conditions.push(isNotNull(pets.estimatedWeightKg));
  conditions.push(sql`${pets.estimatedWeightKg} >= ${kg}`);

  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pets)
    .where(and(...conditions));

  return row?.n ?? 0;
}
