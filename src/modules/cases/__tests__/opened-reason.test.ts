// opened-reason — the closed union of case open reasons.
//
// What these tests pin:
//   - each of the 19 codes parses its valid params
//   - malformed / missing params are REJECTED (this is the write-boundary fence)
//   - `.strict()` rejects extra keys — notably the internal UUIDs that must
//     never reach opened_reason_params
//   - an unknown code is rejected

import { describe, expect, it } from "vitest";
import { OPENED_REASON_CODES, OpenedReasonSchema } from "../domain/opened-reason";

// One valid instance per code. This table IS the enumeration of the union —
// the coverage test below asserts it stays exhaustive.
const VALID: Record<string, unknown> = {
  adoption_listing_opened: { code: "adoption_listing_opened" },
  adoption_application_submitted: { code: "adoption_application_submitted" },
  welfare_report_citizen: {
    code: "welfare_report_citizen",
    referenceCode: "DEN-2026-0012",
    kind: "physical_abuse",
    severity: "high",
  },
  welfare_report_org: {
    code: "welfare_report_org",
    referenceCode: "DEN-2026-0044",
    orgDisplayName: "Refugio Esperanza",
  },
  foster_placement_assigned: {
    code: "foster_placement_assigned",
    actorOrgDisplayName: "Refugio Esperanza",
    expectedWeeks: 6,
  },
  foster_proposal_sent: { code: "foster_proposal_sent" },
  pet_marked_lost: {
    code: "pet_marked_lost",
    petPublicToken: "DIM-A1B2-C3D4",
    ownerNote: "se escapó en la plaza",
  },
  lost_search_reactivated: { code: "lost_search_reactivated", petPublicToken: "DIM-A1B2-C3D4" },
  decomiso_executed: {
    code: "decomiso_executed",
    motive: "maltrato_fisico",
    judicialRef: "IPP-123/26",
  },
  decomiso_handoff_accepted: {
    code: "decomiso_handoff_accepted",
    sourceCasePublicCode: "CASO-2026-0007",
  },
  bite_reported_owner: { code: "bite_reported_owner", victimKind: "human", severity: "moderate" },
  bite_reported_org: {
    code: "bite_reported_org",
    orgDisplayName: "Clínica Veterinaria Norte",
    reporterRole: "vet",
    victimKind: "human",
    severity: "severe",
  },
  custody_handoff_direct: { code: "custody_handoff_direct", toRole: "owner" },
  cross_org_transfer_proposed: {
    code: "cross_org_transfer_proposed",
    reason: "space_constraint",
  },
  org_intake: { code: "org_intake", intakeReason: "rescue" },
  microchip_replaced: {
    code: "microchip_replaced",
    reason: "duplicate_detected",
    duplicateDetected: true,
  },
  custody_dispute_raised: { code: "custody_dispute_raised", raisedByRole: "owner" },
  outbreak_investigation_manual: {
    code: "outbreak_investigation_manual",
    diseaseCode: "rabia",
    note: "tres casos confirmados en la zona sur",
  },
  rehome_requested: { code: "rehome_requested", orgDisplayName: "Refugio Padrino" },
};

describe("OpenedReasonSchema — the closed set", () => {
  it("declares exactly 19 codes", () => {
    expect(OPENED_REASON_CODES).toHaveLength(19);
    expect(new Set(OPENED_REASON_CODES).size).toBe(19);
  });

  it("has a valid fixture for every code (fixture table stays exhaustive)", () => {
    expect(Object.keys(VALID).sort()).toEqual([...OPENED_REASON_CODES].sort());
  });

  it.each(OPENED_REASON_CODES)("parses valid params for %s", (code) => {
    const parsed = OpenedReasonSchema.safeParse(VALID[code]);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("rejects an unknown code", () => {
    expect(OpenedReasonSchema.safeParse({ code: "definitely_not_a_code" }).success).toBe(false);
  });

  it("rejects a missing code", () => {
    expect(OpenedReasonSchema.safeParse({ referenceCode: "DEN-1" }).success).toBe(false);
  });
});

describe("OpenedReasonSchema — params are enforced, not decorative", () => {
  it("rejects missing required params", () => {
    // welfare_report_citizen without kind/severity
    expect(
      OpenedReasonSchema.safeParse({ code: "welfare_report_citizen", referenceCode: "DEN-1" })
        .success,
    ).toBe(false);
  });

  it("rejects a value outside a param's enum", () => {
    expect(
      OpenedReasonSchema.safeParse({
        code: "welfare_report_citizen",
        referenceCode: "DEN-1",
        kind: "not_a_kind",
        severity: "high",
      }).success,
    ).toBe(false);
  });

  it("rejects a wrong-typed param", () => {
    expect(
      OpenedReasonSchema.safeParse({
        code: "microchip_replaced",
        reason: "duplicate_detected",
        duplicateDetected: "yes",
      }).success,
    ).toBe(false);
  });

  it("accepts nullable params as null", () => {
    expect(
      OpenedReasonSchema.safeParse({
        code: "foster_placement_assigned",
        actorOrgDisplayName: "Refugio",
        expectedWeeks: null,
      }).success,
    ).toBe(true);
    expect(
      OpenedReasonSchema.safeParse({
        code: "pet_marked_lost",
        petPublicToken: null,
        ownerNote: null,
      }).success,
    ).toBe(true);
  });

  it("rejects expectedWeeks <= 0 and non-integers", () => {
    for (const expectedWeeks of [0, -3, 2.5]) {
      expect(
        OpenedReasonSchema.safeParse({
          code: "foster_placement_assigned",
          actorOrgDisplayName: "Refugio",
          expectedWeeks,
        }).success,
      ).toBe(false);
    }
  });
});

describe("OpenedReasonSchema — .strict() keeps internal ids out of params", () => {
  // This is the privacy fence at the WRITE boundary. The legacy regex layer
  // strips these UUIDs at render time; the union makes them unstorable.
  it("rejects volunteer/org UUIDs on foster_proposal_sent", () => {
    expect(
      OpenedReasonSchema.safeParse({
        code: "foster_proposal_sent",
        volunteerUserId: "3f1a9c2e-1111-4222-8333-444455556666",
        orgId: "3f1a9c2e-7777-4888-8999-aaaabbbbcccc",
      }).success,
    ).toBe(false);
  });

  it("rejects the secondary pet UUID on microchip_replaced", () => {
    expect(
      OpenedReasonSchema.safeParse({
        code: "microchip_replaced",
        reason: "duplicate_detected",
        duplicateDetected: true,
        secondaryPetId: "3f1a9c2e-1111-4222-8333-444455556666",
      }).success,
    ).toBe(false);
  });

  it("rejects the internal pet UUID on pet_marked_lost", () => {
    expect(
      OpenedReasonSchema.safeParse({
        code: "pet_marked_lost",
        petPublicToken: "DIM-A1B2-C3D4",
        ownerNote: null,
        petId: "3f1a9c2e-1111-4222-8333-444455556666",
      }).success,
    ).toBe(false);
  });

  it("rejects a wrong-face param (welfare params on a bite code)", () => {
    expect(
      OpenedReasonSchema.safeParse({
        code: "bite_reported_owner",
        victimKind: "human",
        severity: "moderate",
        referenceCode: "DEN-1",
      }).success,
    ).toBe(false);
  });
});

describe("custody_dispute_raised.raisedByRole — the DB CHECK is the closed set", () => {
  // db/schema.ts: raised_by_role in ('owner','org','govt','admin').
  it.each(["owner", "org", "govt", "admin"])("accepts %s", (raisedByRole) => {
    expect(
      OpenedReasonSchema.safeParse({ code: "custody_dispute_raised", raisedByRole }).success,
    ).toBe(true);
  });

  it("rejects a role outside the DB CHECK", () => {
    expect(
      OpenedReasonSchema.safeParse({ code: "custody_dispute_raised", raisedByRole: "vet" }).success,
    ).toBe(false);
  });
});
