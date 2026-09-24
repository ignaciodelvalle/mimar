// Unit tests for addReporterComment use-case.
//
// Scenarios:
//   - Reporter (authenticated owner of the denuncia) can add a comment.
//   - Non-reporter is rejected with "forbidden".
//   - Empty text is rejected with "validation".
//   - Text over 2000 chars is rejected with "validation".
//   - Report with no linked case is rejected with "no_case".
//   - Report text is NOT mutated.
//   - Returned case_event carries entryType=reporter_comment and the text in notes.

import { describe, expect, it, vi } from "vitest";

import type { WelfareReport } from "@/db/schema";
import { type AddReporterCommentInput, addReporterComment } from "../add-reporter-comment";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReport(overrides: Partial<WelfareReport> = {}): WelfareReport {
  return {
    id: "rpt-001",
    referenceCode: "DEN-TEST-CMMT",
    status: "open",
    reporterUserId: "reporter-user-id",
    reporterOrganizationId: null,
    reporterContactEmail: null,
    reporterContactPhone: null,
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
    description: "Descripcion de la denuncia de prueba.",
    occurredAt: null,
    locationAddress: null,
    locationLat: null,
    locationLng: null,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "CABA",
    createdAt: new Date("2026-01-01"),
    ...overrides,
  } as unknown as WelfareReport;
}

type InsertCaseEventFn = (values: {
  caseId: string;
  entryType: string;
  payload: Record<string, unknown>;
  notes?: string | null;
  recordedByUserId?: string | null;
  occurredAt?: Date;
}) => Promise<{ id: string }>;

function makeDeps(reportOverride?: Partial<WelfareReport>) {
  const report = makeReport(reportOverride);
  const repo = {
    findById: vi.fn().mockResolvedValue(report),
  };
  const insertCaseEvent: InsertCaseEventFn = vi.fn().mockResolvedValue({ id: "ce-001" });
  return { repo, insertCaseEvent, report };
}

function makeInput(overrides: Partial<AddReporterCommentInput> = {}): AddReporterCommentInput {
  return {
    reportId: "rpt-001",
    reporterUserId: "reporter-user-id",
    text: "Este es un comentario del denunciante sobre el caso.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("addReporterComment — authorization", () => {
  it("allows the reporter to add a comment", async () => {
    const { repo, insertCaseEvent } = makeDeps();
    const result = await addReporterComment(makeInput(), { repo, insertCaseEvent });
    expect(result.ok).toBe(true);
  });

  it("rejects a non-reporter user", async () => {
    const { repo, insertCaseEvent } = makeDeps();
    const result = await addReporterComment(makeInput({ reporterUserId: "some-other-user" }), {
      repo,
      insertCaseEvent,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("forbidden");
  });
});

describe("addReporterComment — validation", () => {
  it("rejects empty text", async () => {
    const { repo, insertCaseEvent } = makeDeps();
    const result = await addReporterComment(makeInput({ text: "   " }), { repo, insertCaseEvent });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("validation");
  });

  it("rejects text over 2000 chars", async () => {
    const { repo, insertCaseEvent } = makeDeps();
    const longText = "a".repeat(2001);
    const result = await addReporterComment(makeInput({ text: longText }), {
      repo,
      insertCaseEvent,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("validation");
  });

  it("accepts text exactly at 2000 chars", async () => {
    const { repo, insertCaseEvent } = makeDeps();
    const borderText = "a".repeat(2000);
    const result = await addReporterComment(makeInput({ text: borderText }), {
      repo,
      insertCaseEvent,
    });
    expect(result.ok).toBe(true);
  });
});

describe("addReporterComment — case linkage", () => {
  it("rejects when the report has no linked case", async () => {
    const { repo, insertCaseEvent } = makeDeps({ caseId: null });
    const result = await addReporterComment(makeInput(), { repo, insertCaseEvent });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("no_case");
  });
});

describe("addReporterComment — immutability", () => {
  it("does NOT mutate the welfare report fields", async () => {
    const { repo, insertCaseEvent, report } = makeDeps();
    const descriptionBefore = report.description;
    const statusBefore = report.status;
    await addReporterComment(makeInput(), { repo, insertCaseEvent });
    // repo.updateStatus or any mutation must NOT have been called
    expect(repo.findById).toHaveBeenCalledOnce();
    expect(Object.keys(repo)).not.toContain("updateStatus");
    expect(report.description).toBe(descriptionBefore);
    expect(report.status).toBe(statusBefore);
  });
});

describe("addReporterComment — case_event shape", () => {
  it("inserts a reporter_comment entry_type with text in notes", async () => {
    const { repo, insertCaseEvent } = makeDeps();
    const result = await addReporterComment(makeInput(), { repo, insertCaseEvent });
    expect(result.ok).toBe(true);
    expect(insertCaseEvent).toHaveBeenCalledOnce();
    const callArgs = (insertCaseEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.entryType).toBe("reporter_comment");
    expect(callArgs.caseId).toBe("case-001");
    expect(callArgs.notes).toBe(makeInput().text);
    expect(callArgs.recordedByUserId).toBe("reporter-user-id");
    expect(callArgs.payload).toMatchObject({ source: "reporter" });
  });

  it("returns the inserted case event id on success", async () => {
    const { repo, insertCaseEvent } = makeDeps();
    const result = await addReporterComment(makeInput(), { repo, insertCaseEvent });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.caseEventId).toBe("ce-001");
  });
});
