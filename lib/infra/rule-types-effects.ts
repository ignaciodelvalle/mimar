// Server-only side-effect registry for rule types (design ADR-2).
//
// Keeps `db`-touching behavior (re-evaluation sweeps, impact previews) OUT of
// the pure lib/domain/rule-types-registry.ts, mirroring why breeds-server.ts
// is split from lib/breeds.ts. The 3 writer use-cases
// (create/update/delete-business-rule.ts) call `reevalHook` generically
// instead of hardcoding `if (ruleType === 'ppp_breed_list')`.
//
// Only rule types that affect real records (pets, orgs, ...) need an entry
// here. Config-only rule types (ppp_attestation_required_registries,
// physical_credential_channels) have no hook — saving them never triggers a
// sweep or an impact-preview gate.

import "server-only";

import type { GovtBusinessRuleType } from "@/db";
import type { JurisdictionScope, ReevalCounters } from "@/lib/infra/business-rules-reeval";
import { reEvaluatePppClassificationChange } from "@/lib/infra/business-rules-reeval";
import type { RuleImpactPreviewInput } from "@/lib/infra/rule-impact";
import { countDogsAffectedByRule } from "@/lib/infra/rule-impact";

export interface RuleTypeEffects {
  /** Re-evaluate affected records after a create/update/delete. */
  reevalHook?: (scope: JurisdictionScope) => Promise<ReevalCounters>;
  /** Preview the blast radius of a candidate payload before it is saved. */
  impactPreview?: (input: RuleImpactPreviewInput) => Promise<number>;
}

// ppp_breed_list AND ppp_weight_threshold both register the SAME
// reevalHook (reEvaluatePppClassificationChange) — a pet's classification
// depends on both rules together via the composed resolver
// (resolvePppClassificationForJurisdiction), so either rule type changing
// requires the same full re-evaluation sweep (admin-rules-console ADR-3).
export const RULE_TYPE_EFFECTS: Partial<Record<GovtBusinessRuleType, RuleTypeEffects>> = {
  ppp_breed_list: {
    reevalHook: reEvaluatePppClassificationChange,
    impactPreview: countDogsAffectedByRule,
  },
  ppp_weight_threshold: {
    reevalHook: reEvaluatePppClassificationChange,
    impactPreview: countDogsAffectedByRule,
  },
};

/** Run the reevalHook for `ruleType` if one is registered. No-op otherwise. */
export async function runReevalHookIfRegistered(
  ruleType: GovtBusinessRuleType,
  scope: JurisdictionScope,
): Promise<ReevalCounters | null> {
  const hook = RULE_TYPE_EFFECTS[ruleType]?.reevalHook;
  if (!hook) return null;
  return hook(scope);
}
