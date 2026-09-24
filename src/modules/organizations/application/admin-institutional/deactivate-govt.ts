// Use-case: deactivateGovtForAuthority
//
// Deactivates a govt account — or a national observer (pilot T1-P9):
//   1. Validation
//   2. Capability check (admin only)
//   3. Verify target is an active institutional govt or national
//   4. DB transaction: revoke localities, deactivate, audit_log, claim attachments, notification
//
// §2.2: notifications accumulate in pendingNotificationsGovt[] inside the tx
// and are inserted AFTER the transaction commits (best-effort, logged on failure).

import { and, eq, isNull } from "drizzle-orm";

import { auditLog, db, govtAssignments, notifications, profiles } from "@/db";
import { canDeactivateGovt } from "@/lib/domain/institutional-scope";
import { validateMotivoAndAttachments } from "@/lib/domain/revocation-validation";
import { claimAttachmentsForAudit } from "@/src/modules/organizations/application/revocations/helpers";

import { loadActorProfile } from "./helpers";
import type { DeactivateResult } from "./types";

export async function deactivateGovtForAuthority(
  actorUserId: string,
  input: {
    targetGovtUserId: string;
    motivo: string;
    attachmentIds: string[];
  },
): Promise<DeactivateResult> {
  // 1. Validate motivo + attachments
  const validationError = validateMotivoAndAttachments(input.motivo, input.attachmentIds);
  if (validationError) return validationError;

  // 2. Load actor profile + capability check
  const actorProfile = await loadActorProfile(actorUserId);
  if (!actorProfile) return { error: "CAPABILITY_DENIED" };
  if (!canDeactivateGovt(actorProfile)) return { error: "CAPABILITY_DENIED" };

  // 3. Verify target is an active institutional govt OR national.
  //
  // `national` (the read-only, country-wide observer, migration 0214) is
  // deactivated through THIS use case rather than a copy of it: the act is the
  // same (deactivated_at, audit row with the evidence, notification), and a
  // national simply holds no govt_assignments, so step a revokes zero rows.
  // Until this existed an admin could create a national and never switch it
  // off. The audit action stays `govt_deactivated_by_admin` (a new action
  // would need a migration of the audit_log CHECK); `target_role` in the
  // payload says which of the two it was.
  const [targetProfile] = await db
    .select({
      id: profiles.id,
      role: profiles.role,
      accountType: profiles.accountType,
      deactivatedAt: profiles.deactivatedAt,
    })
    .from(profiles)
    .where(eq(profiles.id, input.targetGovtUserId))
    .limit(1);

  if (!targetProfile) return { error: "NOT_INSTITUTIONAL_GOVT" };
  if (
    (targetProfile.role !== "govt" && targetProfile.role !== "national") ||
    targetProfile.accountType !== "institutional"
  ) {
    return { error: "NOT_INSTITUTIONAL_GOVT" };
  }
  if (targetProfile.deactivatedAt !== null) {
    return { error: "TARGET_ALREADY_DEACTIVATED" };
  }

  // 4. Transaction: revoke localities, deactivate, audit, notify
  type PendingNotification = typeof notifications.$inferInsert;
  const pendingNotificationsGovt: PendingNotification[] = [];

  try {
    await db.transaction(async (tx) => {
      // a. Revoke all active govt_assignments for target
      const revokedAssignments = await tx
        .update(govtAssignments)
        .set({
          revokedAt: new Date(),
          revokedByUserId: actorUserId,
          revocationReason: input.motivo.trim(),
        })
        .where(
          and(
            eq(govtAssignments.userId, input.targetGovtUserId),
            isNull(govtAssignments.revokedAt),
          ),
        )
        .returning({ id: govtAssignments.id });

      const revokedCount = revokedAssignments.length;

      // b. SET deactivated_at with anti-race WHERE
      const updatedRows = await tx
        .update(profiles)
        .set({ deactivatedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(profiles.id, input.targetGovtUserId), isNull(profiles.deactivatedAt)))
        .returning({ id: profiles.id });

      if (updatedRows.length < 1) {
        throw new Error("RACE_CONDITION");
      }

      // c. INSERT audit_log RETURNING id
      const [logRow] = await tx
        .insert(auditLog)
        .values({
          actorUserId,
          action: "govt_deactivated_by_admin",
          targetUserId: input.targetGovtUserId,
          payload: {
            reason: input.motivo.trim(),
            evidence_attachment_ids: input.attachmentIds,
            revoked_assignments_count: revokedCount,
            target_role: targetProfile.role,
          },
        })
        .returning({ id: auditLog.id });

      // d. Claim attachments
      await claimAttachmentsForAudit(tx, logRow.id, input.attachmentIds, actorUserId);

      // e. Notification to deactivated govt operator (accumulated post-tx)
      pendingNotificationsGovt.push({
        userId: input.targetGovtUserId,
        notificationType: "govt_deactivated",
        title: "Tu cuenta de operador fue desactivada",
        body: input.motivo.trim(),
        severity: "warning",
        ctaLabel: "Ver notificaciones",
        ctaUrl: "/cuenta",
      });
    });
  } catch (err) {
    if (err instanceof Error && err.message === "RACE_CONDITION") {
      return { ok: true, noOp: true };
    }
    return {
      error: err instanceof Error ? err.message : "Error desconocido al desactivar govt.",
    };
  }

  if (pendingNotificationsGovt.length > 0) {
    try {
      await db.insert(notifications).values(pendingNotificationsGovt);
    } catch (e) {
      console.error("notifications insert failed (action did succeed)", e);
    }
  }

  return { ok: true };
}
