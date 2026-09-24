// Unit tests for passWelfareToTriage + confirmWelfareAsSpam use-cases.
// Spec R4 — moderation (admin-only): unflag or spam-confirm with audit_log.

import { describe, expect, it, vi } from "vitest";

import type { WelfareReport } from "@/db/schema";
import type { WelfareRepository } from "../../infrastructure/welfare-repository";
import { confirmWelfareAsSpam } from "../confirm-welfare-as-spam";
import { passWelfareToTriage } from "../pass-welfare-to-triage";

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
    jurisdictionLocality: "CABA",
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

// ---------------------------------------------------------------------------
// passWelfareToTriage
// ---------------------------------------------------------------------------

describe("passWelfareToTriage — valid", () => {
  it("sets moderationResolvedAt + audit_log(welfare_report_unflagged)", async () => {
    const report = makeFlaggedReport();
    const repo = makeRepo(report);
    const transaction = makeTx();
    const actor = { user: { id: "admin-mod-01" } };

    const result = await passWelfareToTriage(
      { welfareReportId: "rpt-001", notes: "La denuncia parece válida aquí." },
      { repo, transaction, actor },
    );

    expect(result.ok).toBe(true);

    expect(repo.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "welfare_report_unflagged",
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
        moderationResolvedAt: expect.any(Date),
        moderationResolvedByUserId: "admin-mod-01",
      }),
    );
  });

  it("returns empty notifications (no notif on unflag)", async () => {
    const report = makeFlaggedReport();
    const repo = makeRepo(report);
    const transaction = makeTx();
    const actor = { user: { id: "admin-mod-01" } };

    const result = await passWelfareToTriage(
      { welfareReportId: "rpt-001", notes: "La denuncia parece válida hoy." },
      { repo, transaction, actor },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notifications).toHaveLength(0);
  });
});

describe("passWelfareToTriage — guard failures", () => {
  it("notes too short → error", async () => {
    const report = makeFlaggedReport();
    const repo = makeRepo(report);
    const transaction = makeTx();
    const actor = { user: { id: "admin-mod-01" } };

    const result = await passWelfareToTriage(
      { welfareReportId: "rpt-001", notes: "Corto" },
      { repo, transaction, actor },
    );

    expect(result.ok).toBe(false);
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it("report not found → error", async () => {
    const repo = {
      findById: vi.fn().mockResolvedValue(null),
      updateStatus: vi.fn(),
      insertAudit: vi.fn(),
    } as unknown as WelfareRepository;
    const transaction = makeTx();
    const actor = { user: { id: "admin-mod-01" } };

    const result = await passWelfareToTriage(
      { welfareReportId: "rpt-missing", notes: "La denuncia parece válida acá." },
      { repo, transaction, actor },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/no encontrada/i);
  });

  it("not flagged → error", async () => {
    const report = makeFlaggedReport({ flaggedAt: null });
    const repo = makeRepo(report);
    const transaction = makeTx();
    const actor = { user: { id: "admin-mod-01" } };

    const result = await passWelfareToTriage(
      { welfareReportId: "rpt-001", notes: "La denuncia parece válida aquí." },
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
    const actor = { user: { id: "admin-mod-01" } };

    const result = await passWelfareToTriage(
      { welfareReportId: "rpt-001", notes: "La denuncia parece válida aquí." },
      { repo, transaction, actor },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/moderación/i);
  });
});

// ---------------------------------------------------------------------------
// confirmWelfareAsSpam
// ---------------------------------------------------------------------------

describe("confirmWelfareAsSpam — valid", () => {
  it("sets status=invalid + triage + closed + moderation + audit_log(welfare_report_confirmed_spam)", async () => {
    const report = makeFlaggedReport();
    const repo = makeRepo(report);
    const transaction = makeTx();
    const actor = { user: { id: "admin-mod-01" } };

    const result = await confirmWelfareAsSpam(
      { welfareReportId: "rpt-001", notes: "Es claramente spam o falso aquí." },
      { repo, transaction, actor },
    );

    expect(result.ok).toBe(true);

    expect(repo.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "welfare_report_confirmed_spam",
        payload: expect.objectContaining({
          welfare_report_id: "rpt-001",
          flag_reasons_snapshot: ["trivial_description"],
        }),
      }),
      expect.anything(),
    );

    const patch = (repo.updateStatus as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(patch).toEqual(
      expect.objectContaining({
        status: "invalid",
        triagedAt: expect.any(Date),
        triagedByUserId: "admin-mod-01",
        closedAt: expect.any(Date),
        resolutionNotes: expect.any(String),
        moderationResolvedAt: expect.any(Date),
        moderationResolvedByUserId: "admin-mod-01",
      }),
    );
  });
});

describe("confirmWelfareAsSpam — guard failures", () => {
  it("notes too short → error", async () => {
    const report = makeFlaggedReport();
    const repo = makeRepo(report);
    const transaction = makeTx();
    const actor = { user: { id: "admin-mod-01" } };

    const result = await confirmWelfareAsSpam(
      { welfareReportId: "rpt-001", notes: "Spam" },
      { repo, transaction, actor },
    );

    expect(result.ok).toBe(false);
  });

  it("not flagged → error", async () => {
    const report = makeFlaggedReport({ flaggedAt: null });
    const repo = makeRepo(report);
    const transaction = makeTx();
    const actor = { user: { id: "admin-mod-01" } };

    const result = await confirmWelfareAsSpam(
      { welfareReportId: "rpt-001", notes: "Es claramente spam o falso aquí." },
      { repo, transaction, actor },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/flagged/i);
  });
});
