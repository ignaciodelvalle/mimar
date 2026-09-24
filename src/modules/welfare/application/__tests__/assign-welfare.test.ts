// Unit tests for assignWelfare + unassignWelfare use-cases.
// Spec R5 — assign/unassign (no tx, no audit_log).

import { describe, expect, it, vi } from "vitest";

import type { WelfareReport } from "@/db/schema";
import type { WelfareRepository } from "../../infrastructure/welfare-repository";
import { assignWelfare } from "../assign-welfare";
import { unassignWelfare } from "../unassign-welfare";

function makeReport(overrides: Partial<WelfareReport> = {}): WelfareReport {
  return {
    id: "rpt-001",
    referenceCode: "DEN-TEST-001",
    status: "open",
    reporterUserId: null,
    caseId: null,
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
// assignWelfare
// ---------------------------------------------------------------------------

describe("assignWelfare — valid", () => {
  it("unassigned report → sets assignedToUserId to actor", async () => {
    const report = makeReport({ assignedToUserId: null });
    const repo = {
      findById: vi.fn().mockResolvedValue(report),
      setAssignee: vi.fn().mockResolvedValue(undefined),
    } as unknown as WelfareRepository;

    const result = await assignWelfare(
      { welfareReportId: "rpt-001" },
      { repo, actor: { user: { id: "admin-user-01" }, profile: { role: "admin" as const } } },
    );

    expect(result.ok).toBe(true);
    expect(repo.setAssignee).toHaveBeenCalledWith("rpt-001", "admin-user-01");
  });

  it("already assigned to same user → re-assign (idempotent)", async () => {
    const report = makeReport({ assignedToUserId: "admin-user-01" });
    const repo = {
      findById: vi.fn().mockResolvedValue(report),
      setAssignee: vi.fn().mockResolvedValue(undefined),
    } as unknown as WelfareRepository;

    const result = await assignWelfare(
      { welfareReportId: "rpt-001" },
      { repo, actor: { user: { id: "admin-user-01" }, profile: { role: "admin" as const } } },
    );

    expect(result.ok).toBe(true);
    expect(repo.setAssignee).toHaveBeenCalledWith("rpt-001", "admin-user-01");
  });
});

describe("assignWelfare — guard failures", () => {
  it("assigned to DIFFERENT user → conflict error", async () => {
    const report = makeReport({ assignedToUserId: "other-agent-99" });
    const repo = {
      findById: vi.fn().mockResolvedValue(report),
      setAssignee: vi.fn(),
    } as unknown as WelfareRepository;

    const result = await assignWelfare(
      { welfareReportId: "rpt-001" },
      { repo, actor: { user: { id: "admin-user-01" }, profile: { role: "admin" as const } } },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/asignada a otro/i);
    expect(repo.setAssignee).not.toHaveBeenCalled();
  });

  it("report not found → error", async () => {
    const repo = {
      findById: vi.fn().mockResolvedValue(null),
      setAssignee: vi.fn(),
    } as unknown as WelfareRepository;

    const result = await assignWelfare(
      { welfareReportId: "rpt-missing" },
      { repo, actor: { user: { id: "admin-user-01" }, profile: { role: "admin" as const } } },
    );

    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// unassignWelfare
// ---------------------------------------------------------------------------

describe("unassignWelfare — valid", () => {
  it("assignee unassigns own report → setAssignee(null)", async () => {
    const report = makeReport({ assignedToUserId: "agent-01" });
    const repo = {
      findById: vi.fn().mockResolvedValue(report),
      setAssignee: vi.fn().mockResolvedValue(undefined),
    } as unknown as WelfareRepository;

    const result = await unassignWelfare(
      { welfareReportId: "rpt-001" },
      { repo, actor: { user: { id: "agent-01" }, profile: { role: "govt" as const } } },
    );

    expect(result.ok).toBe(true);
    expect(repo.setAssignee).toHaveBeenCalledWith("rpt-001", null);
  });

  it("admin can unassign any report", async () => {
    const report = makeReport({ assignedToUserId: "agent-01" });
    const repo = {
      findById: vi.fn().mockResolvedValue(report),
      setAssignee: vi.fn().mockResolvedValue(undefined),
    } as unknown as WelfareRepository;

    const result = await unassignWelfare(
      { welfareReportId: "rpt-001" },
      { repo, actor: { user: { id: "admin-99" }, profile: { role: "admin" as const } } },
    );

    expect(result.ok).toBe(true);
  });
});

describe("unassignWelfare — guard failures", () => {
  it("not assigned → error", async () => {
    const report = makeReport({ assignedToUserId: null });
    const repo = {
      findById: vi.fn().mockResolvedValue(report),
      setAssignee: vi.fn(),
    } as unknown as WelfareRepository;

    const result = await unassignWelfare(
      { welfareReportId: "rpt-001" },
      { repo, actor: { user: { id: "admin-user-01" }, profile: { role: "admin" as const } } },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/no está asignada/i);
  });

  it("different govt cannot unassign another agent's report", async () => {
    const report = makeReport({ assignedToUserId: "agent-01" });
    const repo = {
      findById: vi.fn().mockResolvedValue(report),
      setAssignee: vi.fn(),
    } as unknown as WelfareRepository;

    const result = await unassignWelfare(
      { welfareReportId: "rpt-001" },
      { repo, actor: { user: { id: "other-govt-02" }, profile: { role: "govt" as const } } },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/solo el agente/i);
    expect(repo.setAssignee).not.toHaveBeenCalled();
  });
});
