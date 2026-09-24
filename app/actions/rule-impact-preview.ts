"use server";

// Rule-impact preview action for the PPP business-rule forms (Item 22).
//
// Returns the count of dogs in the target jurisdiction that the candidate rule
// would NEWLY classify as PPP, BEFORE it is saved. Read-only — writes nothing.
// The actual query lives in lib/rule-impact.ts (no auth) so it is integration-
// testable; this action only adds the admin auth guard. Admin fresh-sweep A2.

import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { type RuleImpactPreviewInput, countDogsAffectedByRule } from "@/lib/infra/rule-impact";

export type { RuleImpactPreviewInput };

export type RuleImpactPreviewResult = {
  affectedCount: number;
};

export async function previewRuleImpact(
  input: RuleImpactPreviewInput,
): Promise<RuleImpactPreviewResult> {
  await requireAdminOrRedirect();
  return { affectedCount: await countDogsAffectedByRule(input) };
}
