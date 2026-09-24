// Use-case: revokeGovtLocalityForAuthority (REQ-3, REQ-4)
//
// Revokes a govt_assignments row with:
//   1. Pre-flight validation
//   2. loadActorAuthority — reject if not admin/govt
//   3. Load target assignment, self-revocation check, idempotency
//   4. canRevoke — reject if out of scope
//   5. Check if last active locality (for notification body)
//   6. db.transaction:
//      a. Mutate target (anti-race WHERE revoked_at IS NULL)
//      b. INSERT audit_log RETURNING id
//      c. Claim attachments
//      d. Collect notification to govt user
//   7. Post-tx: flush pendingNotifications (§2.2 — NOT inside the tx)
//   8. Return { ok: true } or { error: string }
//
// §2.2: notifications accumulate in pendingNotifications[] inside the tx
// and are inserted AFTER the transaction commits (best-effort, logged on failure).

import { and, count, eq, isNull } from "drizzle-orm";

import { auditLog, db, govtAssignments, notifications } from "@/db";
import { canRevoke } from "@/lib/domain/revocation-scope";
import type { RevocationTarget } from "@/lib/domain/revocation-scope";
import { validateMotivoAndAttachments } from "@/lib/domain/revocation-validation";

import { claimAttachmentsForAudit, loadActorAuthority } from "./helpers";
import type { RevocationResult } from "./types";

export async function revokeGovtLocalityForAuthority(
  actorUserId: string,
  input: {
    govtAssignmentId: string;
    motivo: string;
    attachmentIds: string[];
    bulkActionId?: string | null;
  },
): Promise<RevocationResult> {
  const validationError = validateMotivoAndAttachments(input.motivo, input.attachmentIds);
  if (validationError) return validationError;

  const auth = await loadActorAuthority(actorUserId);
  if (!auth.ok) return { error: auth.error };

  // Load target assignment
  const [assignment] = await db
    .select({
      id: govtAssignments.id,
      userId: govtAssignments.userId,
      jurisdictionProvince: govtAssignments.jurisdictionProvince,
      jurisdictionLocality: govtAssignments.jurisdictionLocality,
      revokedAt: govtAssignments.revokedAt,
    })
    .from(govtAssignments)
    .where(eq(govtAssignments.id, input.govtAssignmentId))
    .limit(1);

  if (!assignment) return { error: "Asignación de localidad no encontrada." };

  // Self-revocation footgun — BEFORE canRevoke (spec §REQ-3, design §2d)
  if (assignment.userId === actorUserId) {
    return { error: "SELF_REVOCATION_DENIED" };
  }

  // Idempotency: already revoked
  if (assignment.revokedAt !== null) {
    return { ok: true, noOp: true };
  }

  // Capability check
  const target: RevocationTarget = {
    type: "govt_locality",
    province: assignment.jurisdictionProvince,
    locality: assignment.jurisdictionLocality,
  };
  if (!canRevoke(auth.profile, target, auth.jurisdictions)) {
    return { error: "CAPABILITY_DENIED" };
  }

  // Check if this is the last active locality for the target user (for notification body)
  const [activeCount] = await db
    .select({ count: count() })
    .from(govtAssignments)
    .where(and(eq(govtAssignments.userId, assignment.userId), isNull(govtAssignments.revokedAt)));
  const isLastLocality = (activeCount?.count ?? 0) <= 1;

  type PendingNotification = typeof notifications.$inferInsert;
  const pendingNotifications: PendingNotification[] = [];

  try {
    await db.transaction(async (tx) => {
      // a. Mutate target — anti-race WHERE revoked_at IS NULL
      const updatedRows = await tx
        .update(govtAssignments)
        .set({
          revokedAt: new Date(),
          revokedByUserId: actorUserId,
          revocationReason: input.motivo.trim(),
        })
        .where(
          and(eq(govtAssignments.id, input.govtAssignmentId), isNull(govtAssignments.revokedAt)),
        )
        .returning({ id: govtAssignments.id });
      if (updatedRows.length < 1) {
        throw new Error("RACE_CONDITION: assignment already revoked");
      }

      // b. INSERT audit_log RETURNING id
      const [logRow] = await tx
        .insert(auditLog)
        .values({
          actorUserId,
          action: "revocation_govt_assignment",
          targetUserId: assignment.userId,
          targetGovtAssignmentId: input.govtAssignmentId,
          payload: {
            reason: input.motivo.trim(),
            evidence_attachment_ids: input.attachmentIds,
            province: assignment.jurisdictionProvince,
            locality: assignment.jurisdictionLocality,
            ...(input.bulkActionId ? { bulk_action_id: input.bulkActionId } : {}),
          },
        })
        .returning({ id: auditLog.id });

      // c. Claim attachments
      await claimAttachmentsForAudit(tx, logRow.id, input.attachmentIds, actorUserId);

      // d. Notification to the govt user whose locality was revoked
      const lastLocalityWarning = isLastLocality
        ? " Perdiste tu última localidad activa — ya no tenés jurisdicción asignada."
        : "";
      pendingNotifications.push({
        userId: assignment.userId,
        notificationType: "govt_locality_revoked",
        title: `Localidad revocada: ${assignment.jurisdictionLocality}`,
        body: `${input.motivo.trim()}${lastLocalityWarning}`,
        severity: "warning",
        ctaLabel: "Ver cuenta",
        ctaUrl: "/cuenta",
      });
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("RACE_CONDITION")) {
      return { ok: true, noOp: true };
    }
    return {
      error: err instanceof Error ? err.message : "Error desconocido al revocar.",
    };
  }

  if (pendingNotifications.length > 0) {
    try {
      await db.insert(notifications).values(pendingNotifications);
    } catch (e) {
      console.error("notifications insert failed (action did succeed)", e);
    }
  }

  return { ok: true };
}
