// Use-case: reporter adds a comment to their denuncia's case.
//
// Preconditions:
//   - The caller (action) has authenticated the user.
//   - `reporterUserId` is the authenticated user's id.
//
// Business rules:
//   - Only the reporter who filed the denuncia may comment (welfareReports.reporterUserId).
//   - Text must be 1–2000 characters (trimmed).
//   - The welfare report itself is IMMUTABLE — no fields are changed.
//   - The comment is recorded as a case_events row with entryType='reporter_comment'.
//   - Works for ALL subjectKinds (pet-backed and petless) because case_events
//     is pet-independent and every welfare_denuncia always has a linked case.
//
// Error codes:
//   - "forbidden": userId does not match report.reporterUserId.
//   - "validation": text is empty or exceeds 2000 chars.
//   - "no_case": report.caseId is null (pre-cases-system row).
//   - "report_not_found": no report found for reportId.
//   - "db_error": unexpected persistence failure.

import type { WelfareReport } from "@/db/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AddReporterCommentInput = {
  reportId: string;
  reporterUserId: string;
  text: string;
};

type InsertCaseEventFn = (values: {
  caseId: string;
  entryType: string;
  payload: Record<string, unknown>;
  notes?: string | null;
  recordedByUserId?: string | null;
  occurredAt?: Date;
}) => Promise<{ id: string }>;

type Deps = {
  repo: Pick<{ findById: (id: string) => Promise<WelfareReport | null> }, "findById">;
  insertCaseEvent: InsertCaseEventFn;
};

export type AddReporterCommentResult =
  | { ok: true; caseEventId: string }
  | { ok: false; error: "forbidden" | "validation" | "no_case" | "report_not_found" | "db_error" };

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function addReporterComment(
  input: AddReporterCommentInput,
  deps: Deps,
): Promise<AddReporterCommentResult> {
  const { reportId, reporterUserId, text } = input;
  const { repo, insertCaseEvent } = deps;

  // Load report
  const report = await repo.findById(reportId);
  if (!report) return { ok: false, error: "report_not_found" };

  // Auth: only the reporter who filed the denuncia
  if (report.reporterUserId !== reporterUserId) return { ok: false, error: "forbidden" };

  // Validate text
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 2000) return { ok: false, error: "validation" };

  // Guard: report must have a linked case
  if (!report.caseId) return { ok: false, error: "no_case" };

  // Insert case_event — report itself is NOT touched
  try {
    const caseEvent = await insertCaseEvent({
      caseId: report.caseId,
      entryType: "reporter_comment",
      payload: { source: "reporter" },
      notes: trimmed,
      recordedByUserId: reporterUserId,
      occurredAt: new Date(),
    });
    return { ok: true, caseEventId: caseEvent.id };
  } catch {
    return { ok: false, error: "db_error" };
  }
}
