// Use-case: an org returns a derived welfare report ("no podemos intervenir"),
// with a required reason. Gov stays the only closer — this does NOT close the
// report; it makes it actionable again in the gov derivation panel.
//
// Preconditions (enforced by the action edge):
//   - The caller is an authenticated, active member of the receiving org with a
//     case-handling role (admin / coordinator), scoped to that org's token.
//
// Business rules:
//   - The report MUST currently be derived to this org.
//   - The report MUST NOT be terminal (closed / invalid / duplicate).
//   - A reason of >= 10 characters is required.
//   - Sets org_intervention_status='devuelto' + org_intervention_at=now AND
//     clears derived_to_organization_id so the report reappears in the gov
//     derivation panel as actionable. (derivedByUserId is preserved so gov can
//     still be notified; the derivation panel keys "derived" off
//     derivedToOrganizationId, so nulling it removes the org from the inbox.)
//   - Records an org_intervention_return case_events note carrying the reason,
//     which the gov derivation panel surfaces as "devuelto por la org: <reason>".
//   - Notifies the deriving gov user + jurisdiction authorities (CTA → gov detail).

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
    returnDerivation: (reportId: string, patch: { orgInterventionAt: Date }) => Promise<void>;
    insertCaseEvent: InsertCaseEventFn;
  };
  findGovRecipients: (input: {
    derivedByUserId: string | null;
    jurisdictionProvince: string | null;
    jurisdictionLocality: string | null;
  }) => Promise<string[]>;
  actor: { userId: string; orgId: string; orgDisplayName: string };
};

export type ReturnDerivedReportInput = {
  welfareReportId: string;
  reason: string;
};

const MIN_REASON_LEN = 10;

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function returnDerivedReport(
  input: ReturnDerivedReportInput,
  deps: Deps,
): Promise<UseCaseResult<void>> {
  const { repo, findGovRecipients, actor } = deps;

  const reason = input.reason.trim();
  if (reason.length < MIN_REASON_LEN) {
    return {
      ok: false,
      error: `El motivo de devolución debe tener al menos ${MIN_REASON_LEN} caracteres.`,
    };
  }

  const report = await repo.findById(input.welfareReportId);
  if (!report) return { ok: false, error: "Denuncia no encontrada." };

  if (report.derivedToOrganizationId !== actor.orgId) {
    return { ok: false, error: "Esta denuncia no está derivada a tu organización." };
  }

  if (report.status === "closed" || report.status === "invalid" || report.status === "duplicate") {
    return { ok: false, error: "No se puede devolver una denuncia cerrada o inválida." };
  }

  const now = new Date();

  // Sets org_intervention_status='devuelto', org_intervention_at, and nulls
  // derived_to_organization_id so the gov derivation panel shows it actionable.
  await repo.returnDerivation(report.id, { orgInterventionAt: now });

  // The reason lives in a case_events note so the gov side can render it.
  if (report.caseId) {
    await repo.insertCaseEvent({
      caseId: report.caseId,
      entryType: "org_intervention_return",
      payload: {
        source: "org",
        orgId: actor.orgId,
        orgDisplayName: actor.orgDisplayName,
        reason,
      },
      notes: reason,
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
    notificationType: "welfare_org_intervention_returned",
    title: "La organización devolvió la denuncia",
    body: `${actor.orgDisplayName} devolvió la denuncia ${report.referenceCode}: no puede intervenir. Volvé a derivarla o gestionala.`,
    severity: "warning",
    ctaLabel: "Ver denuncia",
    ctaUrl,
    relatedCaseId: report.caseId,
    category: "welfare",
  }));

  return { ok: true, value: undefined, notifications };
}
