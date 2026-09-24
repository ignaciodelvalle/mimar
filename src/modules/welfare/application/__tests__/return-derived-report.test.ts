// Unit tests for returnDerivedReport use-case (UI-7 Part A).
// Org returns the report → reappears in the gov queue (derivation cleared),
// reason captured in case_events, gov notified. Gov stays the only closer.

import { describe, expect, it, vi } from "vitest";

import { returnDerivedReport } from "../return-derived-report";

type Row = {
  id: string;
  referenceCode: string;
  status: string;
  caseId: string | null;
  derivedToOrganizationId: string | null;
  derivedByUserId: string | null;
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
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
    ...overrides,
  };
}

function makeDeps(rowOverride?: Partial<Row>) {
  const row = makeRow(rowOverride);
  const repo = {
    findById: vi.fn().mockResolvedValue(row),
    returnDerivation: vi.fn().mockResolvedValue(undefined),
    insertCaseEvent: vi.fn().mockResolvedValue({ id: "ce-001" }),
  };
  const findGovRecipients = vi.fn().mockResolvedValue(["govt-user-01"]);
  const actor = { userId: "org-member-01", orgId: "org-001", orgDisplayName: "Refugio Test" };
  return { repo, findGovRecipients, actor };
}

describe("returnDerivedReport", () => {
  it("returns the report: clears derivation, records reason note, notifies gov", async () => {
    const { repo, findGovRecipients, actor } = makeDeps();

    const result = await returnDerivedReport(
      {
        welfareReportId: "rpt-001",
        reason: "No tenemos capacidad operativa en esa zona esta semana.",
      },
      { repo, findGovRecipients, actor },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // returnDerivation nulls derivedToOrganizationId so the gov queue picks it up.
    expect(repo.returnDerivation).toHaveBeenCalledWith("rpt-001", {
      orgInterventionAt: expect.any(Date),
    });

    // Reason carried by the case_event for gov rendering.
    expect(repo.insertCaseEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        entryType: "org_intervention_return",
        notes: "No tenemos capacidad operativa en esa zona esta semana.",
      }),
    );

    expect(result.notifications[0]).toMatchObject({
      notificationType: "welfare_org_intervention_returned",
      severity: "warning",
      ctaUrl: "/gob/maltrato/rpt-001",
    });
  });

  it("rejects a too-short reason", async () => {
    const { repo, findGovRecipients, actor } = makeDeps();

    const result = await returnDerivedReport(
      { welfareReportId: "rpt-001", reason: "no" },
      { repo, findGovRecipients, actor },
    );

    expect(result.ok).toBe(false);
    expect(repo.returnDerivation).not.toHaveBeenCalled();
  });

  it("rejects when the report is not derived to this org", async () => {
    const { repo, findGovRecipients, actor } = makeDeps({ derivedToOrganizationId: "other-org" });

    const result = await returnDerivedReport(
      { welfareReportId: "rpt-001", reason: "Motivo suficientemente largo." },
      { repo, findGovRecipients, actor },
    );

    expect(result.ok).toBe(false);
    expect(repo.returnDerivation).not.toHaveBeenCalled();
  });

  it("rejects terminal reports", async () => {
    const { repo, findGovRecipients, actor } = makeDeps({ status: "closed" });

    const result = await returnDerivedReport(
      { welfareReportId: "rpt-001", reason: "Motivo suficientemente largo." },
      { repo, findGovRecipients, actor },
    );

    expect(result.ok).toBe(false);
    expect(repo.returnDerivation).not.toHaveBeenCalled();
  });
});
