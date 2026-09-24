// Unit tests for closeWelfareReport use-case.
// Spec R3 — close transitions + audit_log + triage-actor backfill + closeCase(resolved).

import { describe, expect, it, vi } from "vitest";

import type { WelfareReport } from "@/db/schema";
import type { WelfareRepository } from "../../infrastructure/welfare-repository";
import { closeWelfareReport } from "../close-welfare-report";

function makeReport(overrides: Partial<WelfareReport> = {}): WelfareReport {
  return {
    id: "rpt-001",
    referenceCode: "DEN-TEST-001",
    status: "in_progress",
    reporterUserId: "user-reporter-01",
    caseId: "case-001",
    triagedAt: new Date("2026-01-05"),
    triagedByUserId: "admin-user-01",
    closedAt: null,
    resolutionNotes: null,
    moderationResolvedAt: null,
    moderationResolvedByUserId: null,
    flaggedAt: null,
    flagReasons: [],
    assignedToUserId: null,
    subjectPetId: null,
    kind: "neglect",
    severity: "medium",
    subjectKind: "unowned_animal",
    subjectDescription: "Un perro callejero",
    description: "El animal parece estar desnutrido y sin agua.",
    observedSymptoms: null,
    occurredAt: null,
    locationAddress: null,
    locationLat: null,
    locationLng: null,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "CABA",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  } as WelfareReport;
}

function makeDeps(reportOverride?: Partial<WelfareReport>) {
  const report = makeReport(reportOverride);
  const repo = {
    findById: vi.fn().mockResolvedValue(report),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    insertAudit: vi.fn().mockResolvedValue(undefined),
  } as unknown as WelfareRepository;
  const closeCase = vi.fn().mockResolvedValue(undefined);
  const transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
    await cb({});
  });
  const actor = { user: { id: "admin-user-01" }, profile: { role: "admin" as const } };
  return { repo, closeCase, transaction, actor };
}

describe("closeWelfareReport — valid transitions", () => {
  it("in_progress → closed: status patch + audit_log + closeCase(resolved) + reporter notif", async () => {
    const { repo, closeCase, transaction, actor } = makeDeps();

    const result = await closeWelfareReport(
      { welfareReportId: "rpt-001", resolutionNotes: "Situación resuelta con intervención." },
      { repo, closeCase, transaction, actor },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(repo.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "welfare_report_closed" }),
      expect.anything(),
    );

    expect(closeCase).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: "case-001", reason: "resolved" }),
      expect.anything(),
    );

    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].notificationType).toBe("welfare_report_status_changed");
    // The category is what routes this into the centre's "Denuncias" tab, and
    // the tab only renders when its count is > 0. Without it the row was written
    // and had nowhere to appear, so a citizen who reported animal cruelty got a
    // reference code and then silence (master test CIU §9 #5). The old assertion
    // covered the TYPE and passed the whole time this was broken — which is why
    // it is pinned here now.
    expect(result.notifications[0].category).toBe("welfare");
  });

  it("open → closed is allowed per state machine", async () => {
    const { repo, closeCase, transaction, actor } = makeDeps({ status: "open", triagedAt: null });

    const result = await closeWelfareReport(
      { welfareReportId: "rpt-001", resolutionNotes: "Cerrado directamente sin triage." },
      { repo, closeCase, transaction, actor },
    );

    expect(result.ok).toBe(true);
  });

  it("backfills triagedAt/By when null on close", async () => {
    const { repo, closeCase, transaction, actor } = makeDeps({ status: "open", triagedAt: null });

    await closeWelfareReport(
      { welfareReportId: "rpt-001", resolutionNotes: "Cerrado sin triage previo aquí." },
      { repo, closeCase, transaction, actor },
    );

    const patch = (repo.updateStatus as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(patch).toEqual(
      expect.objectContaining({ triagedAt: expect.any(Date), triagedByUserId: "admin-user-01" }),
    );
  });

  it("skips closeCase when caseId is null", async () => {
    const { repo, closeCase, transaction, actor } = makeDeps({ caseId: null });

    const result = await closeWelfareReport(
      { welfareReportId: "rpt-001", resolutionNotes: "Denuncia pre-sistema de casos aquí." },
      { repo, closeCase, transaction, actor },
    );

    expect(result.ok).toBe(true);
    expect(closeCase).not.toHaveBeenCalled();
  });

  it("anon reporter → no notification", async () => {
    const { repo, closeCase, transaction, actor } = makeDeps({ reporterUserId: null });

    const result = await closeWelfareReport(
      { welfareReportId: "rpt-001", resolutionNotes: "Denuncia anónima cerrada hoy." },
      { repo, closeCase, transaction, actor },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notifications).toHaveLength(0);
  });
});

describe("closeWelfareReport — guard failures", () => {
  it("notes too short → error", async () => {
    const { repo, transaction, closeCase, actor } = makeDeps();
    const result = await closeWelfareReport(
      { welfareReportId: "rpt-001", resolutionNotes: "Corto" },
      { repo, closeCase, transaction, actor },
    );
    expect(result.ok).toBe(false);
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it("already closed → error (terminal)", async () => {
    const { repo, transaction, closeCase, actor } = makeDeps({
      status: "closed",
      closedAt: new Date(),
    });
    const result = await closeWelfareReport(
      { welfareReportId: "rpt-001", resolutionNotes: "Intentando cerrar dos veces." },
      { repo, closeCase, transaction, actor },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/estado/);
  });
});
