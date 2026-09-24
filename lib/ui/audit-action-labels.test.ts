import { describe, expect, it } from "vitest";

import { GOVT_BUSINESS_RULE_TYPES } from "@/db";
import { AUDIT_ACTION_LABELS, auditActionLabel } from "@/lib/ui/audit-action-labels";

// Phase 7 (admin-rules-console, NF4) — the 3 govt_business_rule_* audit
// action codes are GENERIC across every rule type (the ruleType lives in
// the audit payload, not the action code itself), so promoting new rule
// types — including the 4 promoted types + ppp_weight_threshold enforcement
// — requires NO new audit-label entries. These tests lock in that
// invariant: every current AND future GOVT_BUSINESS_RULE_TYPES value is
// covered by the SAME 3 codes, so /admin/auditoria never renders an
// unlabeled entry for a rule-type mutation.
describe("AUDIT_ACTION_LABELS — govt_business_rule_* codes cover every rule type generically", () => {
  const RULE_ACTION_CODES = [
    "govt_business_rule_created",
    "govt_business_rule_updated",
    "govt_business_rule_deleted",
  ] as const;

  it("all 3 rule-mutation action codes are labeled (no raw-code fallback)", () => {
    for (const code of RULE_ACTION_CODES) {
      expect(AUDIT_ACTION_LABELS[code]).toBeDefined();
      expect(auditActionLabel(code)).not.toBe(code);
    }
  });

  it("the action codes are rule-type-agnostic — GOVT_BUSINESS_RULE_TYPES has 8 entries, action codes have 3 (by design)", () => {
    // Sanity: if this ever grows to per-type codes, this test documents the
    // deliberate choice NOT to do that — the audit payload carries ruleType.
    expect(GOVT_BUSINESS_RULE_TYPES.length).toBeGreaterThanOrEqual(8);
    expect(RULE_ACTION_CODES.length).toBe(3);
  });
});
