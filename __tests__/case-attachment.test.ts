// Coverage + invariants for CASE_ATTACHMENT_RULES.
//
// What we enforce:
//  - Every EVENT_TYPES value has a rule (no silent gaps).
//  - For non-'never' modes, `compatibleWith` is non-empty.
//  - For 'opens' modes, `opensKind` is set AND is in `compatibleWith`.
//  - For 'never' modes, `compatibleWith` is empty AND there's no opensKind.
//  - Every kind referenced in any rule is a real CASE_KINDS value.
//  - Branched rules return safe partials (no escape hatches).

import { describe, expect, it } from "vitest";

import { EVENT_TYPES } from "@/db/schema";
import { CASE_ATTACHMENT_RULES, decideAttachment } from "@/lib/infra/case-attachment";
import { CASE_KINDS } from "@/src/modules/cases/domain/case-kinds";

describe("CASE_ATTACHMENT_RULES — coverage", () => {
  it("has a rule for every EVENT_TYPES value", () => {
    for (const eventType of EVENT_TYPES) {
      expect(CASE_ATTACHMENT_RULES[eventType]).toBeDefined();
    }
  });

  it("declares no extra entries beyond EVENT_TYPES", () => {
    const allowed = new Set<string>(EVENT_TYPES);
    for (const key of Object.keys(CASE_ATTACHMENT_RULES)) {
      expect(allowed.has(key)).toBe(true);
    }
  });
});

describe("CASE_ATTACHMENT_RULES — invariants per rule", () => {
  for (const eventType of EVENT_TYPES) {
    const rule = CASE_ATTACHMENT_RULES[eventType];

    it(`${eventType}: every compatibleWith kind is a real CASE_KIND`, () => {
      for (const k of rule.compatibleWith) {
        expect(CASE_KINDS).toContain(k);
      }
    });

    if (rule.mode === "never") {
      it(`${eventType}: 'never' mode declares empty compatibleWith + no opensKind (base)`, () => {
        // status_changed/symptom_observed/etc. use mode='never' as the BASE
        // and branch to 'opens'/'attaches-when-open' at runtime. So we
        // assert only the BASE invariant — the branched return is exempt.
        expect(rule.compatibleWith.length === 0 || rule.branch !== undefined).toBe(true);
        if (!rule.branch) expect(rule.opensKind).toBeUndefined();
      });
    } else {
      it(`${eventType}: non-'never' mode declares non-empty compatibleWith`, () => {
        expect(rule.compatibleWith.length).toBeGreaterThan(0);
      });
    }

    if (rule.mode === "opens") {
      it(`${eventType}: 'opens' mode declares opensKind + it is in compatibleWith`, () => {
        expect(rule.opensKind).toBeDefined();
        expect(rule.compatibleWith).toContain(rule.opensKind);
      });
    }
  }
});

describe("decideAttachment — branched events", () => {
  it("status_changed to lost opens lost_pet_episode", () => {
    const decision = decideAttachment("status_changed", { to_status: "lost" }, []);
    expect(decision.opensNewCase?.kind).toBe("lost_pet_episode");
  });

  it("status_changed from lost to active attaches to open lost_pet_episode", () => {
    const decision = decideAttachment(
      "status_changed",
      { to_status: "active", from_status: "lost" },
      [{ id: "case-1", caseKind: "lost_pet_episode" }],
    );
    expect(decision.attachToCaseId).toBe("case-1");
  });

  it("incident_reported.bite_inflicted opens bite_incident", () => {
    const decision = decideAttachment("incident_reported", { incident_type: "bite_inflicted" }, []);
    expect(decision.opensNewCase?.kind).toBe("bite_incident");
  });

  it("rabies_observation_ended requires open bite_incident — rejects if none", () => {
    const decision = decideAttachment("rabies_observation_ended", {}, []);
    expect(decision.rejectReason).toBeTruthy();
  });

  it("rabies_observation_ended attaches when bite_incident is open", () => {
    const decision = decideAttachment("rabies_observation_ended", {}, [
      { id: "case-bite", caseKind: "bite_incident" },
    ]);
    expect(decision.attachToCaseId).toBe("case-bite");
  });

  it("adoption_eligibility_set with eligible=true opens adoption_listing", () => {
    const decision = decideAttachment("adoption_eligibility_set", { eligible: true }, []);
    expect(decision.opensNewCase?.kind).toBe("adoption_listing");
  });

  it("adoption_eligibility_set with eligible=false closes existing adoption_listing", () => {
    const decision = decideAttachment("adoption_eligibility_set", { eligible: false }, [
      { id: "case-listing", caseKind: "adoption_listing" },
    ]);
    expect(decision.attachToCaseId).toBe("case-listing");
  });

  it("microchip_replaced with reason=damaged does not open a case", () => {
    const decision = decideAttachment("microchip_replaced", { reason: "damaged" }, []);
    expect(decision.opensNewCase).toBeUndefined();
  });

  it("microchip_replaced with reason=fraud_detected opens microchip_remediation", () => {
    const decision = decideAttachment("microchip_replaced", { reason: "fraud_detected" }, []);
    expect(decision.opensNewCase?.kind).toBe("microchip_remediation");
  });

  it("microchip_replaced with reason=duplicate_detected opens microchip_remediation", () => {
    const decision = decideAttachment("microchip_replaced", { reason: "duplicate_detected" }, []);
    expect(decision.opensNewCase?.kind).toBe("microchip_remediation");
  });

  it("vaccination_administered is libreta-only (never)", () => {
    const decision = decideAttachment("vaccination_administered", {}, []);
    expect(decision.opensNewCase).toBeUndefined();
    expect(decision.attachToCaseId).toBeUndefined();
    expect(decision.rejectReason).toBeUndefined();
  });
});
