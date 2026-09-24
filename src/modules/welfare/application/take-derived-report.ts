// Use-case: an org marks a derived welfare report as "tomado" (taken / under
// intervention). The org does NOT close the report — gov stays the only closer.
//
// Preconditions (enforced by the action edge):
//   - The caller is an authenticated, active member of the receiving org with a
//     case-handling role (admin / coordinator), scoped to that org's token.
//
// Business rules:
//   - The report MUST currently be derived to this org (derivedToOrganizationId).
//   - The report MUST NOT be terminal (closed / invalid / duplicate).
//   - Sets org_intervention_status='tomado' + org_intervention_at=now.
//   - Records an org_intervention_taken case_events note (visible to gov).
//   - Notifies the deriving gov user + jurisdiction authorities (CTA → gov detail).
//   - The welfare status enum is NOT touched.
//
// Idempotent: marking an already-'tomado' report taken again is a no-op success.

import type { NewNotification, UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WelfareReportRow = {
  id: string;
  referenceCode: string;
  status: string;
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
    setOrgIntervention: (
      reportId: string,
      patch: {
        orgInterventionStatus: "tomado" | "devuelto" | null;
        orgInterventionAt: Date | null;
      },
    ) => Promise<void>;
    insertCaseEvent: InsertCaseEventFn;
  };
  // Resolve the gov recipients to notify: the deriving user + jurisdiction
  // authorities. Returns distinct user IDs.
  findGovRecipients: (input: {
    derivedByUserId: string | null;
    jurisdictionProvince: string | null;
    jurisdictionLocality: string | null;
  }) => Promise<string[]>;
  actor: { userId: string; orgId: string; orgDisplayName: string };
};

export type TakeDerivedReportInput = {
  welfareReportId: string;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function takeDerivedReport(
  input: TakeDerivedReportInput,
  deps: Deps,
): Promise<UseCaseResult<void>> {
  const { repo, findGovRecipients, actor } = deps;

  const report = await repo.findById(input.welfareReportId);
  if (!report) return { ok: false, error: "Denuncia no encontrada." };

  // Must be derived to THIS org.
  if (report.derivedToOrganizationId !== actor.orgId) {
    return { ok: false, error: "Esta denuncia no está derivada a tu organización." };
  }

  // Terminal reports cannot be acted on.
  if (report.status === "closed" || report.status === "invalid" || report.status === "duplicate") {
    return { ok: false, error: "No se puede intervenir una denuncia cerrada o inválida." };
  }

  // Idempotent: already taken → no-op success.
  if (report.orgInterventionStatus === "tomado") {
    return { ok: true, value: undefined, notifications: [] };
  }

  const now = new Date();
  await repo.setOrgIntervention(report.id, {
    orgInterventionStatus: "tomado",
    orgInterventionAt: now,
  });

  if (report.caseId) {
    await repo.insertCaseEvent({
      caseId: report.caseId,
      entryType: "org_intervention_taken",
      payload: { source: "org", orgId: actor.orgId, orgDisplayName: actor.orgDisplayName },
      notes: `${actor.orgDisplayName} tomó la denuncia y está interviniendo.`,
      recordedByUserId: actor.userId,
      occurredAt: now,
    });
  }

  const recipients = await findGovRecipients({
    derivedByUserId: report.derivedByUserId,
    jurisdictionProvince: report.jurisdictionProvince,
    jurisdictionLocality: report.jurisdictionLocality,
  });

  const ctaUrl = `/gob/maltrato/${report.id}`;
  const notifications: NewNotification[] = recipients.map((userId) => ({
    userId,
    notificationType: "welfare_org_intervention_taken",
    title: "La organización tomó la denuncia",
    body: `${actor.orgDisplayName} marcó la denuncia ${report.referenceCode} como tomada y está interviniendo.`,
    severity: "info",
    ctaLabel: "Ver denuncia",
    ctaUrl,
    relatedCaseId: report.caseId,
    category: "welfare",
  }));

  return { ok: true, value: undefined, notifications };
}
