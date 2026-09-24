import { describe, expect, it } from "vitest";

import { businessRuleTargetSummary } from "@/lib/ui/audit-target-link";

// Live-QA finding (admin-rules-console): /admin/auditoria rows for
// "Regla de negocio creada/eliminada" showed action + actor + timestamp but
// NO target — impossible to tell WHICH rule was mutated. Fixed by deriving a
// "ruleType @ jurisdiction" summary from the payload the writers already
// record (previousPayload/newPayload/jurisdiction).
describe("businessRuleTargetSummary", () => {
  it("returns null for non-business-rule actions", () => {
    expect(businessRuleTargetSummary("profile_self_updated", { ruleType: "x" })).toBeNull();
  });

  it("returns null when payload is missing or malformed", () => {
    expect(businessRuleTargetSummary("govt_business_rule_created", null)).toBeNull();
    expect(businessRuleTargetSummary("govt_business_rule_created", undefined)).toBeNull();
    expect(businessRuleTargetSummary("govt_business_rule_created", "not an object")).toBeNull();
    expect(businessRuleTargetSummary("govt_business_rule_created", {})).toBeNull();
  });

  it("formats country-only scope", () => {
    expect(
      businessRuleTargetSummary("govt_business_rule_created", {
        ruleType: "ppp_breed_list",
        jurisdiction: { country: "AR", province: null, locality: null },
      }),
    ).toBe("ppp_breed_list @ AR · (nivel país) · (toda la provincia)");
  });

  it("formats province + locality scope", () => {
    expect(
      businessRuleTargetSummary("govt_business_rule_updated", {
        ruleType: "long_stay_days",
        jurisdiction: { country: "AR", province: "Buenos Aires", locality: "La Plata" },
      }),
    ).toBe("long_stay_days @ AR · Buenos Aires · La Plata");
  });

  it("works for all 3 rule-mutation action codes", () => {
    for (const action of [
      "govt_business_rule_created",
      "govt_business_rule_updated",
      "govt_business_rule_deleted",
    ]) {
      const summary = businessRuleTargetSummary(action, {
        ruleType: "ppp_weight_threshold",
        jurisdiction: { country: "AR", province: null, locality: null },
      });
      expect(summary).toBe("ppp_weight_threshold @ AR · (nivel país) · (toda la provincia)");
    }
  });
});
