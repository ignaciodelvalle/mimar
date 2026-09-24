// The choke point's dual-write — resolveOpenedReasonColumns.
//
// Every case-open in the system funnels through CasesRepository.openCase. This
// is the pure function that decides what the three opened_reason columns get,
// extracted so the contract is testable without a DB.
//
// The `string` branch that existed here during the writer migration (ADR-8
// step 1) is GONE, along with its tests — the input type is the closed union
// now, so "what happens with a raw string" is not a question the type system
// permits anyone to ask.

import { describe, expect, it } from "vitest";
import type { OpenedReason } from "../domain/opened-reason";
import { resolveOpenedReasonColumns } from "../infrastructure/cases-repository";

describe("resolveOpenedReasonColumns — structured input dual-writes", () => {
  it("writes byte-identical prose AND the code AND the params", () => {
    const reason: OpenedReason = { code: "custody_handoff_direct", toRole: "owner" };
    expect(resolveOpenedReasonColumns(reason)).toEqual({
      // byte-identical to what transfer-custody.ts emitted before the cutover
      openedReason: "auto: direct custody handoff to_role=owner",
      openedReasonCode: "custody_handoff_direct",
      openedReasonParams: { toRole: "owner" },
    });
  });

  it("stores {} for a param-less code, never null (the pair CHECK)", () => {
    const out = resolveOpenedReasonColumns({ code: "adoption_application_submitted" });
    expect(out.openedReasonCode).toBe("adoption_application_submitted");
    expect(out.openedReasonParams).toEqual({});
    // cases_opened_reason_structured_pair: code is null or params is not null
    expect(out.openedReasonParams).not.toBeNull();
  });

  it("keeps the code out of params (params is the code's complement)", () => {
    const out = resolveOpenedReasonColumns({
      code: "welfare_report_citizen",
      referenceCode: "DEN-1",
      kind: "neglect",
      severity: "low",
    });
    expect(out.openedReasonParams).toEqual({
      referenceCode: "DEN-1",
      kind: "neglect",
      severity: "low",
    });
    expect(out.openedReasonParams).not.toHaveProperty("code");
  });

  it("routes audit ids to prose ONLY — never to params", () => {
    const VOLUNTEER = "3f1a9c2e-1111-4222-8333-444455556666";
    const ORG = "7a2b4d6f-8888-4999-8aaa-bbbbccccdddd";
    const out = resolveOpenedReasonColumns(
      { code: "foster_proposal_sent" },
      { volunteerUserId: VOLUNTEER, orgId: ORG },
    );
    expect(out.openedReason).toBe(`Foster proposal to volunteer ${VOLUNTEER} by org ${ORG}`);
    expect(out.openedReasonParams).toEqual({});
    expect(JSON.stringify(out.openedReasonParams)).not.toContain(VOLUNTEER);
    expect(JSON.stringify(out.openedReasonParams)).not.toContain(ORG);
  });

  it("every structured write satisfies cases_opened_reason_min_length", () => {
    const reasons: OpenedReason[] = [
      { code: "adoption_application_submitted" },
      { code: "org_intake", intakeReason: "rescue" },
      { code: "custody_dispute_raised", raisedByRole: "owner" },
    ];
    for (const reason of reasons) {
      expect(resolveOpenedReasonColumns(reason).openedReason.length).toBeGreaterThanOrEqual(10);
    }
  });
});
