// Unit tests for escalateModerationToAdmin use-case.
// SDD phase 2 — govt hands a flagged denuncia back to the national admin queue.

import { describe, expect, it, vi } from "vitest";

import type { WelfareReport } from "@/db/schema";
import type { WelfareRepository } from "../../infrastructure/welfare-repository";
import { escalateModerationToAdmin } from "../escalate-moderation-to-admin";

function makeFlaggedReport(overrides: Partial<WelfareReport> = {}): WelfareReport {
  return {
    id: "rpt-001",
    referenceCode: "DEN-TEST-001",
    status: "open",
    reporterUserId: "user-reporter-01",
    caseId: null,
    triagedAt: null,
    triagedByUserId: null,
    closedAt: null,
    resolutionNotes: null,
    flaggedAt: new Date("2026-01-01"),
    flagReasons: ["trivial_description"],
    moderationResolvedAt: null,
    moderationResolvedByUserId: null,
    moderationEscalatedAt: null,
    moderationEscalatedByUserId: null,
    assignedToUserId: null,
    subjectPetId: null,
    kind: "neglect",
    severity: "low",
    subjectKind: "unowned_animal",
    subjectDescription: "Un perro callejero",
    description: "Perro flaco en la calle.",
    observedSymptoms: null,
    occurredAt: null,
    locationAddress: null,
    locationLat: null,
    locationLng: null,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  } as WelfareReport;
}

function makeRepo(report: WelfareReport) {
  return {
    findById: vi.fn().mockResolvedValue(report),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    insertAudit: vi.fn().mockResolvedValue(undefined),
  } as unknown as WelfareRepository;
}

function makeTx() {
  return vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
    await cb({});
  });
}

describe("escalateModerationToAdmin — valid", () => {
  it("sets moderationEscalatedAt + audit_log(welfare_report_escalated_to_admin)", async () => {
    const report = makeFlaggedReport();
    const repo = makeRepo(report);
    const transaction = makeTx();
    const actor = { user: { id: "govt-mod-01" } };

    const result = await escalateModerationToAdmin(
      { welfareReportId: "rpt-001", notes: "Jurisdicción ambigua, la escalo a plataforma." },
      { repo, transaction, actor },
    );

    expect(result.ok).toBe(true);

    expect(repo.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "welfare_report_escalated_to_admin",
        payload: expect.objectContaining({
          welfare_report_id: "rpt-001",
          reference_code: "DEN-TEST-001",
          flag_reasons_snapshot: ["trivial_description"],
        }),
      }),
      expect.anything(),
    );

    const patch = (repo.updateStatus as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(patch).toEqual(
      expect.objectContaining({
        moderationEscalatedAt: expect.any(Date),
        moderationEscalatedByUserId: "govt-mod-01",
      }),
    );
    // Escalation must NOT resolve the row — it stays in the admin queue.
    expect(patch.moderationResolvedAt).toBeUndefined();
  });

  it("returns empty notifications", async () => {
    const report = makeFlaggedReport();
    const repo = makeRepo(report);
    const transaction = makeTx();
    const actor = { user: { id: "govt-mod-01" } };

    const result = await escalateModerationToAdmin(
      { welfareReportId: "rpt-001", notes: "La escalo por cruce de jurisdicciones." },
      { repo, transaction, actor },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notifications).toHaveLength(0);
  });
});

describe("escalateModerationToAdmin — guard failures", () => {
  it("notes too short → error, no load", async () => {
    const report = makeFlaggedReport();
    const repo = makeRepo(report);
    const transaction = makeTx();
    const actor = { user: { id: "govt-mod-01" } };

    const result = await escalateModerationToAdmin(
      { welfareReportId: "rpt-001", notes: "Corto" },
      { repo, transaction, actor },
    );

    expect(result.ok).toBe(false);
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it("not flagged → error", async () => {
    const report = makeFlaggedReport({ flaggedAt: null });
    const repo = makeRepo(report);
    const transaction = makeTx();
    const actor = { user: { id: "govt-mod-01" } };

    const result = await escalateModerationToAdmin(
      { welfareReportId: "rpt-001", notes: "La escalo por cruce de jurisdicciones." },
      { repo, transaction, actor },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/flagged/i);
  });

  it("already moderation-resolved → error", async () => {
    const report = makeFlaggedReport({ moderationResolvedAt: new Date() });
    const repo = makeRepo(report);
    const transaction = makeTx();
    const actor = { user: { id: "govt-mod-01" } };

    const result = await escalateModerationToAdmin(
      { welfareReportId: "rpt-001", notes: "La escalo por cruce de jurisdicciones." },
      { repo, transaction, actor },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/moderación/i);
  });

  it("already escalated → error", async () => {
    const report = makeFlaggedReport({ moderationEscalatedAt: new Date() });
    const repo = makeRepo(report);
    const transaction = makeTx();
    const actor = { user: { id: "govt-mod-01" } };

    const result = await escalateModerationToAdmin(
      { welfareReportId: "rpt-001", notes: "La escalo por cruce de jurisdicciones." },
      { repo, transaction, actor },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/escalada/i);
  });
});
