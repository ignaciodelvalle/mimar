// Composed PPP (Potencialmente Peligroso) classification resolver — the
// weight-threshold enforcement seam (admin-rules-console, design ADR-3).
//
// PRODUCT SIGN-OFF: GRANTED (PO decision #604, 2026-07-02). Enforcement
// ships DARK — the default payload (`{ kg: null, appliesIfBreedNotPPP:
// false }`) makes this function behave EXACTLY like the breed-only
// `isPotentiallyDangerousBreedForJurisdiction` (see classifyPpp below:
// weightHits is false whenever kg is null). Classification only flips once
// an admin creates a ppp_weight_threshold rule row with a real kg AND
// appliesIfBreedNotPPP=true — the rule ROW's existence is the activation
// gate, not this code shipping.
//
// Split into a pure classifier (classifyPpp) + a rule fetcher
// (resolvePppRulesForJurisdiction) so callers that classify MANY
// individuals against the SAME jurisdiction (business-rules-reeval.ts'
// sweep) can resolve the two rules ONCE per distinct jurisdiction instead
// of once per individual — resolvePppClassificationForJurisdiction (the
// per-write-site convenience wrapper) composes both for the common
// single-pet case.

import "server-only";

import { resolveBusinessRule } from "@/lib/infra/business-rules-resolver";
import { breedListIncludesResolved, resolveBreedLabel } from "@/lib/reference/breeds";

export interface PppRules {
  breeds: ReadonlySet<string>;
  kg: number | null;
  appliesIfBreedNotPPP: boolean;
}

/** Resolve BOTH the breed-list and weight-threshold rules for a jurisdiction. */
export async function resolvePppRulesForJurisdiction(jurisdiction: {
  country?: string;
  province?: string | null;
  locality?: string | null;
}): Promise<PppRules> {
  const [breedRule, weightRule] = await Promise.all([
    resolveBusinessRule("ppp_breed_list", jurisdiction),
    resolveBusinessRule("ppp_weight_threshold", jurisdiction),
  ]);
  return {
    breeds: new Set(breedRule.payload.breeds),
    kg: weightRule.payload.kg,
    appliesIfBreedNotPPP: weightRule.payload.appliesIfBreedNotPPP,
  };
}

/**
 * Pure classification (no I/O) — combines the breed-list AND weight-
 * threshold rules (OR composition):
 *
 *   breedInList = species==='dog' && breed is in rules.breeds
 *   weightHits  = rules.kg != null && weight != null && weight >= rules.kg
 *                 && (rules.appliesIfBreedNotPPP || breedInList)
 *   isPpp       = breedInList || weightHits
 *
 * When `appliesIfBreedNotPPP` is false, the weight condition only re-adds a
 * requirement to ALREADY-PPP breeds (a classification no-op — breedInList
 * already made isPpp true). The ONLY way weight newly flips a non-PPP dog is
 * `appliesIfBreedNotPPP: true`. This mirrors rule-impact.ts's
 * countDogsAffectedByRule, which returns 0 for weight previews when
 * appliesIfBreedNotPPP is false, for the same reason.
 */
export function classifyPpp(
  species: string | null | undefined,
  breed: string | null | undefined,
  estimatedWeightKg: number | null | undefined,
  rules: PppRules,
): boolean {
  if (species !== "dog") return false;

  // Membership is by the SAME matcher every other classifier uses — case/
  // accent folding plus the curated colloquial aliases — never raw Set.has.
  // Exact equality here was QA A4's escape hatch: an already-stored "pitbull"
  // (or any legacy variant) fell out of the legal regime by spelling. An
  // alias never widens the regime: the resolved label still has to be on the
  // effective jurisdiction list to count.
  //
  // BOTH sides resolve through the alias table: the jurisdiction list is
  // admin-stored free text too, so a list entry in alias form ("Pitbull")
  // must match a canonically-stored breed ("Pit Bull Terrier") — resolving
  // only the candidate left that pairing unmatched (adversarial review
  // 2026-08-14, folding asymmetry).
  const breedLabel = breed?.trim() ?? "";
  const resolvedBreed = breedLabel.length > 0 ? (resolveBreedLabel(breedLabel) ?? breedLabel) : "";
  const breedInList =
    resolvedBreed.length > 0 && breedListIncludesResolved(rules.breeds, resolvedBreed);

  const weight = estimatedWeightKg ?? null;
  const weightHits =
    rules.kg !== null &&
    weight !== null &&
    weight >= rules.kg &&
    (rules.appliesIfBreedNotPPP || breedInList);

  return breedInList || weightHits;
}

/**
 * Convenience wrapper for the common single-pet case (the 3 write sites:
 * pets/actions.ts register/update, create-intake.ts) — resolves both rules
 * and classifies in one call. Sweeps over many pets should use
 * resolvePppRulesForJurisdiction + classifyPpp directly with a cache
 * instead (see business-rules-reeval.ts).
 */
export async function resolvePppClassificationForJurisdiction(
  species: string | null | undefined,
  breed: string | null | undefined,
  estimatedWeightKg: number | null | undefined,
  jurisdiction: { country?: string; province?: string | null; locality?: string | null },
): Promise<boolean> {
  if (species !== "dog") return false;
  const rules = await resolvePppRulesForJurisdiction(jurisdiction);
  return classifyPpp(species, breed, estimatedWeightKg, rules);
}
