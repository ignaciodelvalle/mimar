// deriveWelfareToOrg — the R7 derivation writer.
//
// Forwards a non-terminal welfare report to a verified shelter / rescue_network
// / sanitary_authority for follow-up: validates the target, persists the
// derivation fields, appends the audit_log row, and BUILDS (does not send) the
// notifications its caller must flush after the transaction.
//
// WHY IT LIVES HERE AND NOT IN actions.ts
// ---------------------------------------------------------------------------
// `src/modules/welfare/actions.ts` is a size-ratchet offender
// (scripts/file-size-baseline.json) and this body was ~145 of its lines, none
// of it controller work. What stays in the action is exactly the controller's
// job: the auth guard, the jurisdiction scope load, the terminal-status
// validation, the notification flush and revalidatePath.
//
// THE AUDIT WRITE — READ THIS BEFORE MOVING THE CALL
// ---------------------------------------------------------------------------
// The row is written with `writeAuditLog(tx, …)` from lib/infra/audit-log.ts,
// NOT through `WelfareRepository.insertAudit`. Two load-bearing reasons:
//
//   1. scripts/check-audit-log-coverage.ts (pnpm lint:audit-log) follows
//      exactly ONE hop out of a server action's body. `deriveWelfareToOrgAction`
//      → this module IS that hop. Routing the audit through the repository
//      would put the signal two hops away and the action would read as
//      UNAUDITED — a mutating admin/govt action with no reachable trace is the
//      exact class that fence exists to catch (Ley 25.326).
//   2. `writeAuditLog` composes INSIDE the transaction that performs the
//      mutation, so a rollback takes the audit row with it and a crash can
//      never leave the derivation persisted with no trace.
//
// The row is field-for-field what `repo.insertAudit` wrote before the split:
// same `action`, same actor, same target organization, same payload keys.
// `buildAuditLogValues` additionally pins the unused nullable columns to
// explicit NULLs — which is what the DB defaults already produced.
//
// Idempotent: re-deriving overwrites the previous derivation target and resets
// org intervention state so the new org starts from a clean slate. The previous
// org's members are NOT de-notified (true notification retraction is not
// possible); they receive a corrective `welfare_report_rederived_away` notice
// instead — UI-7 B8.

import { and, eq, isNull } from "drizzle-orm";

import { db, organizationMemberships, organizations, welfareReports } from "@/db";
import { writeAuditLog } from "@/lib/infra/audit-log";

import { canReceiveDerivedWelfare } from "../domain/derivation-eligibility";

/** Active members notified per organization. Mirrors the pre-split cap. */
const MEMBER_NOTIFICATION_CAP = 10;

/**
 * One pending notification row, built here and flushed by the caller AFTER the
 * transaction commits. Structurally identical to the shape
 * `flushNotifications` (actions.ts) accepts — the notification write path is
 * deliberately NOT moved here: `actions.ts` shares one flush helper across
 * every welfare action, and this module must stay out of the
 * `lint:notifications` corpus.
 */
export type DerivationNotification = {
  userId: string;
  notificationType: string;
  title: string;
  body: string;
  severity: "info" | "success" | "warning" | "urgent";
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  category?: string | null;
};

export type DeriveWelfareToOrgInput = {
  /** The report being derived. Already scope-verified by the caller. */
  welfareReportId: string;
  /** Derivation target. Existence / verified / eligibility are checked here. */
  targetOrgId: string;
  /** Acting admin/govt user — recorded on the report AND on the audit row. */
  actorUserId: string;
  /** `welfare_reports.reference_code`, quoted in the audit payload and copy. */
  referenceCode: string;
  /**
   * `welfare_reports.derived_to_organization_id` as read BEFORE this write.
   * Drives the UI-7 B8 corrective notice; `null` on a first derivation.
   */
  previousOrgId: string | null;
};

export type DeriveWelfareToOrgOutcome =
  | { ok: false; error: string }
  | {
      ok: true;
      /** Target org public token — NEVER the UUID — for the caller's revalidate. */
      targetOrgPublicToken: string;
      /** Built, not sent. The caller flushes these post-transaction. */
      notifications: DerivationNotification[];
    };

/**
 * Persist a welfare-report derivation and return the notifications it implies.
 *
 * The caller is responsible for authorization, jurisdiction scoping and the
 * terminal-status refusal; this writer owns target validation, persistence, the
 * audit row and the notification payloads. Error strings are Spanish (es-AR)
 * because they surface verbatim in the gov console.
 */
export async function deriveWelfareToOrg(
  input: DeriveWelfareToOrgInput,
): Promise<DeriveWelfareToOrgOutcome> {
  // Verify the target org exists, is verified, and is an eligible derivation
  // recipient (shelter / rescue_network / sanitary_authority — #48).
  const [targetOrg] = await db
    .select({
      id: organizations.id,
      displayName: organizations.displayName,
      publicToken: organizations.publicToken,
      verified: organizations.verified,
      orgType: organizations.orgType,
    })
    .from(organizations)
    .where(eq(organizations.id, input.targetOrgId))
    .limit(1);

  if (!targetOrg) return { ok: false, error: "Organización no encontrada." };
  if (!targetOrg.verified) return { ok: false, error: "La organización no está verificada." };
  if (!canReceiveDerivedWelfare(targetOrg.orgType)) {
    return {
      ok: false,
      error:
        "Solo se puede derivar a refugios, redes de rescate o autoridades sanitarias verificadas.",
    };
  }

  // Persist derivation fields + the audit row in ONE transaction. Re-deriving
  // resets any prior org intervention state so the new org starts from a clean
  // slate ('tomado'/'devuelto' cleared).
  await db.transaction(async (tx) => {
    await tx
      .update(welfareReports)
      .set({
        derivedToOrganizationId: targetOrg.id,
        derivedAt: new Date(),
        derivedByUserId: input.actorUserId,
        orgInterventionStatus: null,
        orgInterventionAt: null,
      })
      .where(eq(welfareReports.id, input.welfareReportId));

    await writeAuditLog(tx, {
      actorUserId: input.actorUserId,
      action: "welfare_report_derived_to_org",
      targetOrganizationId: targetOrg.id,
      payload: {
        welfareReportId: input.welfareReportId,
        referenceCode: input.referenceCode,
        targetOrgId: targetOrg.id,
        targetOrgDisplayName: targetOrg.displayName,
      },
    });
  });

  // Notify active org members (capped) — use publicToken in ctaUrl (NEVER UUID).
  const memberRows = await db
    .select({ userId: organizationMemberships.userId })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, targetOrg.id),
        isNull(organizationMemberships.leftAt),
      ),
    )
    .limit(MEMBER_NOTIFICATION_CAP);

  const ctaUrl = `/org/${targetOrg.publicToken}/maltrato/recibidos?tab=recibidos`;
  const notifications: DerivationNotification[] = memberRows.map((m) => ({
    userId: m.userId,
    notificationType: "welfare_report_derived_to_org",
    title: "Nueva derivación de denuncia",
    body: `El gobierno derivó la denuncia ${input.referenceCode} a tu organización para seguimiento.`,
    severity: "warning",
    ctaLabel: "Ver denuncia",
    ctaUrl,
    category: "welfare",
  }));

  // Re-derivation de-notify (UI-7 B8): when the report was previously derived to
  // a DIFFERENT org, notify that org's active members that they are no longer
  // responsible. Corrective notice (info) with a CTA to their recibidos list.
  const previousOrgId = input.previousOrgId;
  if (previousOrgId && previousOrgId !== targetOrg.id) {
    const [previousOrg] = await db
      .select({ publicToken: organizations.publicToken })
      .from(organizations)
      .where(eq(organizations.id, previousOrgId))
      .limit(1);

    const previousMemberRows = await db
      .select({ userId: organizationMemberships.userId })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, previousOrgId),
          isNull(organizationMemberships.leftAt),
        ),
      )
      .limit(MEMBER_NOTIFICATION_CAP);

    const previousCtaUrl = previousOrg
      ? `/org/${previousOrg.publicToken}/maltrato/recibidos?tab=recibidos`
      : null;

    for (const m of previousMemberRows) {
      notifications.push({
        userId: m.userId,
        notificationType: "welfare_report_rederived_away",
        title: "Derivación reasignada",
        body: `El gobierno reasignó la denuncia ${input.referenceCode} a otra organización. Tu organización ya no es responsable de su seguimiento.`,
        severity: "info",
        // CTA only when the previous org still resolves — a label without a
        // destination violates the notification CTA contract.
        ctaLabel: previousCtaUrl ? "Ver mis recibidos" : null,
        ctaUrl: previousCtaUrl,
        category: "welfare",
      });
    }
  }

  return { ok: true, targetOrgPublicToken: targetOrg.publicToken, notifications };
}
