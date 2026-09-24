import {
  complianceRuleParams,
  microchipObligationRuleInfo,
  obligationRuleInfo,
} from "@/lib/domain/business-rules-defaults";
import type { ResolvedRule } from "@/lib/infra/business-rules-resolver";
import type { ComplianceInput } from "@/lib/projections/pet-compliance";

/**
 * The jurisdiction half of one pet's ComplianceInput: the tier + citation
 * (`obligations`) and the payload parameters (`ruleParams`, T1-G1) of the SAME
 * resolved rules. The caller keys all three rules off the same
 * distinct-jurisdiction set, so they hit or miss together; a miss (pet row
 * absent from the batch) falls back to the legacy universal behavior.
 *
 * Lives outside `owner-dashboard.ts` because that loader is baselined debt
 * under the file-size fence (`scripts/check-file-size.ts`): new code goes next
 * to it, not into it.
 */
export function jurisdictionComplianceInputs(
  rabiesRule: ResolvedRule<"rabies_vaccination"> | undefined,
  sterilizationRule: ResolvedRule<"sterilization"> | undefined,
  microchipRule: ResolvedRule<"microchip_required"> | undefined,
): Pick<ComplianceInput, "obligations" | "ruleParams"> {
  if (!rabiesRule || !sterilizationRule || !microchipRule) {
    return { obligations: undefined, ruleParams: undefined };
  }
  return {
    obligations: {
      rabies: obligationRuleInfo(rabiesRule),
      sterilization: obligationRuleInfo(sterilizationRule),
      microchip: microchipObligationRuleInfo(microchipRule),
    },
    ruleParams: complianceRuleParams(rabiesRule, sterilizationRule),
  };
}
