// Unit tests for addInterventionNote use-case (UI-7 Part A).
// Org note visible to gov via case_events; requires tomado; report immutable.

import { describe, expect, it, vi } from "vitest";

import { addInterventionNote } from "../add-intervention-note";

type Row = {
  id: string;
  referenceCode: string;
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
    caseId: "case-001",
    derivedToOrganizationId: "org-001",
    derivedByUserId: "govt-user-01",
    orgInterventionStatus: "tomado",
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
    ...overrides,
  };
}

function makeDeps(rowOverride?: Partial<Row>) {
  const row = makeRow(rowOverride);
  const repo = {
    findById: vi.fn().mockResolvedValue(row),
    insertCaseEvent: vi.fn().mockResolvedValue({ id: "ce-001" }),
  };
  const findGovRecipients = vi.fn().mockResolvedValue(["govt-user-01"]);
  const actor = { userId: "org-member-01", orgId: "org-001", orgDisplayName: "Refugio Test" };
  return { repo, findGovRecipients, actor };
}

describe("addInterventionNote", () => {
  it("records an org_intervention_note case_event and notifies gov", async () => {
    const { repo, findGovRecipients, actor } = makeDeps();

    const result = await addInterventionNote(
      { welfareReportId: "rpt-001", text: "Llegamos al lugar; el animal fue rescatado." },
      { repo, findGovRecipients, actor },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(repo.insertCaseEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        caseId: "case-001",
        entryType: "org_intervention_note",
        notes: "Llegamos al lugar; el animal fue rescatado.",
      }),
    );
    expect(result.notifications[0]).toMatchObject({
      notificationType: "welfare_org_intervention_note",
      ctaUrl: "/gob/maltrato/rpt-001",
    });
  });

  it("rejects when the report has not been taken (not tomado)", async () => {
    const { repo, findGovRecipients, actor } = makeDeps({ orgInterventionStatus: null });

    const result = await addInterventionNote(
      { welfareReportId: "rpt-001", text: "Una nota cualquiera." },
      { repo, findGovRecipients, actor },
    );

    expect(result.ok).toBe(false);
    expect(repo.insertCaseEvent).not.toHaveBeenCalled();
  });

  it("rejects empty / overlong text", async () => {
    const { repo, findGovRecipients, actor } = makeDeps();

    const empty = await addInterventionNote(
      { welfareReportId: "rpt-001", text: "   " },
      { repo, findGovRecipients, actor },
    );
    expect(empty.ok).toBe(false);

    const overlong = await addInterventionNote(
      { welfareReportId: "rpt-001", text: "x".repeat(2001) },
      { repo, findGovRecipients, actor },
    );
    expect(overlong.ok).toBe(false);
    expect(repo.insertCaseEvent).not.toHaveBeenCalled();
  });

  it("rejects when the report is not derived to this org", async () => {
    const { repo, findGovRecipients, actor } = makeDeps({ derivedToOrganizationId: "other-org" });

    const result = await addInterventionNote(
      { welfareReportId: "rpt-001", text: "Una nota válida de intervención." },
      { repo, findGovRecipients, actor },
    );

    expect(result.ok).toBe(false);
    expect(repo.insertCaseEvent).not.toHaveBeenCalled();
  });
});
