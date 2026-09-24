// Use-case: an org adds an intervention note to a derived welfare report. The
// note is recorded as a case_events row (entry_type='org_intervention_note')
// and is VISIBLE to gov in the maltrato detail timeline.
//
// Preconditions (enforced by the action edge):
//   - The caller is an authenticated, active member of the receiving org with a
//     case-handling role (admin / coordinator), scoped to that org's token.
//
// Business rules:
//   - The report MUST currently be derived to this org.
//   - The report MUST be 'tomado' (taken) — notes follow the take action.
//   - Text must be 1–2000 characters (trimmed).
//   - The welfare report itself is IMMUTABLE — no welfare columns change.
//   - Notifies the deriving gov user + jurisdiction authorities (CTA → gov detail).

import type { NewNotification, UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WelfareReportRow = {
  id: string;
  referenceCode: string;
  caseId: string | null;
  derivedToOrganizationId: string | null;
  derivedByUserId: string | null;
  orgInterventionStatus: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
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
  repo: {
    findById: (id: string) => Promise<WelfareReportRow | null>;
    insertCaseEvent: InsertCaseEventFn;
  };
  findGovRecipients: (input: {
    derivedByUserId: string | null;
    jurisdictionProvince: string | null;
    jurisdictionLocality: string | null;
  }) => Promise<string[]>;
  actor: { userId: string; orgId: string; orgDisplayName: string };
};

export type AddInterventionNoteInput = {
  welfareReportId: string;
  text: string;
};

const MAX_NOTE_LEN = 2000;

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function addInterventionNote(
  input: AddInterventionNoteInput,
  deps: Deps,
): Promise<UseCaseResult<{ caseEventId: string }>> {
  const { repo, findGovRecipients, actor } = deps;

  const trimmed = input.text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NOTE_LEN) {
    return { ok: false, error: "La nota debe tener entre 1 y 2000 caracteres." };
  }

  const report = await repo.findById(input.welfareReportId);
  if (!report) return { ok: false, error: "Denuncia no encontrada." };

  if (report.derivedToOrganizationId !== actor.orgId) {
    return { ok: false, error: "Esta denuncia no está derivada a tu organización." };
  }

  if (report.orgInterventionStatus !== "tomado") {
    return {
      ok: false,
      error: "Primero marcá la denuncia como tomada para poder agregar notas de intervención.",
    };
  }

  if (!report.caseId) {
    return { ok: false, error: "Esta denuncia aún no tiene un caso asociado." };
  }

  const now = new Date();
  const caseEvent = await repo.insertCaseEvent({
    caseId: report.caseId,
    entryType: "org_intervention_note",
    payload: { source: "org", orgId: actor.orgId, orgDisplayName: actor.orgDisplayName },
    notes: trimmed,
    recordedByUserId: actor.userId,
    occurredAt: now,
  });

  const recipients = await findGovRecipients({
    derivedByUserId: report.derivedByUserId,
    jurisdictionProvince: report.jurisdictionProvince,
    jurisdictionLocality: report.jurisdictionLocality,
  });

  const ctaUrl = `/gob/maltrato/${report.id}`;
  const notifications: NewNotification[] = recipients.map((userId) => ({
    userId,
    notificationType: "welfare_org_intervention_note",
    title: "Nueva nota de intervención",
    body: `${actor.orgDisplayName} agregó una nota de intervención en la denuncia ${report.referenceCode}.`,
    severity: "info",
    ctaLabel: "Ver denuncia",
    ctaUrl,
    relatedCaseId: report.caseId,
    category: "welfare",
  }));

  return { ok: true, value: { caseEventId: caseEvent.id }, notifications };
}
