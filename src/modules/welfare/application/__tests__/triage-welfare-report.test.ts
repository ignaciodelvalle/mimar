// Unit tests for triageWelfareReport use-case.
// Spec R3 — triage transitions + audit_log + reporter notification + closeCase on terminal.
//
// All DB/repo calls are mocked. No Postgres required.

import { describe, expect, it, vi } from "vitest";

import type { WelfareReport } from "@/db/schema";
import type { WelfareRepository } from "../../infrastructure/welfare-repository";
import { triageWelfareReport } from "../triage-welfare-report";

// ---------------------------------------------------------------------------
// Minimal WelfareReport fixture
// ---------------------------------------------------------------------------

function makeReport(overrides: Partial<WelfareReport> = {}): WelfareReport {
  return {
    id: "rpt-001",
    referenceCode: "DEN-TEST-001",
    status: "open",
    reporterUserId: "user-reporter-01",
    caseId: "case-001",
    triagedAt: null,
    triagedByUserId: null,
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

// ---------------------------------------------------------------------------
// Mock repo + deps
// ---------------------------------------------------------------------------

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

  const actor = {
    user: { id: "admin-user-01" },
    profile: { role: "admin" as const },
  };

  return { repo, closeCase, transaction, actor, report };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("triageWelfareReport — valid transitions", () => {
  it("open → triaged: updates status + inserts audit_log + returns reporter notification", async () => {
    const { repo, closeCase, transaction, actor } = makeDeps();

    const result = await triageWelfareReport(
      { welfareReportId: "rpt-001", decision: "triaged", notes: "Todo parece correcto acá." },
      { repo, closeCase, transaction, actor },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // audit_log must be inserted
    expect(repo.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "welfare_report_triaged" }),
      expect.anything(),
    );

    // reporter notification included (non-anon reporter)
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].userId).toBe("user-reporter-01");
    expect(result.notifications[0].notificationType).toBe("welfare_report_status_changed");
    // Routes it into the "Denuncias" tab — see close-welfare-report.test.ts.
    expect(result.notifications[0].category).toBe("welfare");

    // closeCase NOT called for non-terminal decision
    expect(closeCase).not.toHaveBeenCalled();
  });

  it("open → invalid (terminal): closes case + sets closedAt in patch", async () => {
    const { repo, closeCase, transaction, actor } = makeDeps();

    const result = await triageWelfareReport(
      { welfareReportId: "rpt-001", decision: "invalid", notes: "Sin sustento suficiente aquí." },
      { repo, closeCase, transaction, actor },
    );

    expect(result.ok).toBe(true);

    // closeCase called for terminal decision
    expect(closeCase).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: "case-001", reason: "cancelled" }),
      expect.anything(),
    );

    // Status patch includes closedAt
    const updateCall = (repo.updateStatus as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(updateCall[1]).toEqual(expect.objectContaining({ closedAt: expect.any(Date) }));
  });

  it("open → duplicate (terminal): closes case", async () => {
    const { repo, closeCase, transaction, actor } = makeDeps();

    const result = await triageWelfareReport(
      { welfareReportId: "rpt-001", decision: "duplicate", notes: "Ya existe otra denuncia." },
      { repo, closeCase, transaction, actor },
    );

    expect(result.ok).toBe(true);
    expect(closeCase).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "cancelled" }),
      expect.anything(),
    );
  });

  it("triaged → in_progress is allowed", async () => {
    const { closeCase, transaction, actor, ...rest } = makeDeps({ status: "triaged" });
    const repo = rest.repo;

    const result = await triageWelfareReport(
      {
        welfareReportId: "rpt-001",
        decision: "in_progress" as "triaged",
        notes: "Se inicia la investigación.",
      },
      { repo, closeCase, transaction, actor },
    );

    // in_progress is not a TriageDecision type — we test status guard below.
    // This test verifies that if the state-machine allows it, audit goes through.
    // triageWelfareReport only handles triaged|invalid|duplicate decisions.
    // in_progress is handled by startWelfareReport — so this should be rejected.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Error message uses Spanish "decisión" (with accent) — match on the stable part
    expect(result.error).toMatch(/no es v.+lida para el triad?je/i);
  });
});

describe("triageWelfareReport — guard failures", () => {
  it("returns error when notes are too short (<10 chars)", async () => {
    const { repo, closeCase, transaction, actor } = makeDeps();

    const result = await triageWelfareReport(
      { welfareReportId: "rpt-001", decision: "triaged", notes: "Corto" },
      { repo, closeCase, transaction, actor },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/10 caracteres/);

    // No repo calls
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it("returns error when report not found", async () => {
    const { closeCase, transaction, actor } = makeDeps();
    const repo = {
      findById: vi.fn().mockResolvedValue(null),
      updateStatus: vi.fn(),
      insertAudit: vi.fn(),
    } as unknown as WelfareRepository;

    const result = await triageWelfareReport(
      { welfareReportId: "rpt-missing", decision: "triaged", notes: "Al menos diez caracteres." },
      { repo, closeCase, transaction, actor },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/no encontrada/i);
  });

  it("returns error on illegal transition (terminal → triaged)", async () => {
    const { repo, closeCase, transaction, actor } = makeDeps({ status: "closed" });

    const result = await triageWelfareReport(
      { welfareReportId: "rpt-001", decision: "triaged", notes: "Intentando reabrir denuncia." },
      { repo, closeCase, transaction, actor },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/estado/);
  });

  it("skips reporter notification for anonymous reporter (reporterUserId null)", async () => {
    const { repo, closeCase, transaction, actor } = makeDeps({ reporterUserId: null });

    const result = await triageWelfareReport(
      { welfareReportId: "rpt-001", decision: "triaged", notes: "Denuncia anónima revisada." },
      { repo, closeCase, transaction, actor },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notifications).toHaveLength(0);
  });

  it("skips closeCase when report has no caseId (pre-cases-system)", async () => {
    const { repo, closeCase, transaction, actor } = makeDeps({ caseId: null });

    const result = await triageWelfareReport(
      { welfareReportId: "rpt-001", decision: "invalid", notes: "Sin sustento suficiente aquí." },
      { repo, closeCase, transaction, actor },
    );

    expect(result.ok).toBe(true);
    expect(closeCase).not.toHaveBeenCalled();
  });
});
