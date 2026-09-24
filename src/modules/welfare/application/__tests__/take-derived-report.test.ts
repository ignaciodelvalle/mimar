// Unit tests for takeDerivedReport use-case (UI-7 Part A).
// Org marks a derived report "tomado" — no welfare-status transition, gov notified.

import { describe, expect, it, vi } from "vitest";

import { takeDerivedReport } from "../take-derived-report";

type Row = {
  id: string;
  referenceCode: string;
  status: string;
  caseId: string | null;
  derivedToOrganizationId: string | null;
  derivedByUserId: string | null;
  orgInterventionStatus: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
};

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "rpt-001",
    referenceCode: "DEN-AAAA-0001",
    status: "in_progress",
    caseId: "case-001",
    derivedToOrganizationId: "org-001",
    derivedByUserId: "govt-user-01",
    orgInterventionStatus: null,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
    ...overrides,
  };
}

function makeDeps(rowOverride?: Partial<Row>) {
  const row = makeRow(rowOverride);
  const repo = {
    findById: vi.fn().mockResolvedValue(row),
    setOrgIntervention: vi.fn().mockResolvedValue(undefined),
    insertCaseEvent: vi.fn().mockResolvedValue({ id: "ce-001" }),
  };
  const findGovRecipients = vi.fn().mockResolvedValue(["govt-user-01", "govt-user-02"]);
  const actor = { userId: "org-member-01", orgId: "org-001", orgDisplayName: "Refugio Test" };
  return { repo, findGovRecipients, actor };
}

describe("takeDerivedReport", () => {
  it("marks tomado: sets intervention state, writes case_event, notifies gov", async () => {
    const { repo, findGovRecipients, actor } = makeDeps();

    const result = await takeDerivedReport(
      { welfareReportId: "rpt-001" },
      { repo, findGovRecipients, actor },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // State set to tomado (no welfare status change).
    expect(repo.setOrgIntervention).toHaveBeenCalledWith("rpt-001", {
      orgInterventionStatus: "tomado",
      orgInterventionAt: expect.any(Date),
    });

    // case_event recorded for gov visibility.
    expect(repo.insertCaseEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        caseId: "case-001",
        entryType: "org_intervention_taken",
        recordedByUserId: "org-member-01",
      }),
    );

    // Gov notified (deriving user + jurisdiction authorities).
    expect(result.notifications).toHaveLength(2);
    expect(result.notifications[0]).toMatchObject({
      notificationType: "welfare_org_intervention_taken",
      ctaUrl: "/gob/maltrato/rpt-001",
    });
  });

  it("rejects when the report is not derived to this org", async () => {
    const { repo, findGovRecipients, actor } = makeDeps({ derivedToOrganizationId: "other-org" });

    const result = await takeDerivedReport(
      { welfareReportId: "rpt-001" },
      { repo, findGovRecipients, actor },
    );

    expect(result.ok).toBe(false);
    expect(repo.setOrgIntervention).not.toHaveBeenCalled();
  });

  it("rejects terminal reports", async () => {
    const { repo, findGovRecipients, actor } = makeDeps({ status: "closed" });

    const result = await takeDerivedReport(
      { welfareReportId: "rpt-001" },
      { repo, findGovRecipients, actor },
    );

    expect(result.ok).toBe(false);
    expect(repo.setOrgIntervention).not.toHaveBeenCalled();
  });

  it("is idempotent: already-tomado is a no-op success with no notifications", async () => {
    const { repo, findGovRecipients, actor } = makeDeps({ orgInterventionStatus: "tomado" });

    const result = await takeDerivedReport(
      { welfareReportId: "rpt-001" },
      { repo, findGovRecipients, actor },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(repo.setOrgIntervention).not.toHaveBeenCalled();
    expect(result.notifications).toHaveLength(0);
  });
});
