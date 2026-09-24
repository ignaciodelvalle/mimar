// Use-case: revokeOrgVerificationForAuthority (REQ-2, REQ-4)
//
// Clears org.verified flag with:
//   1. Pre-flight validation
//   2. loadActorAuthority — reject if not admin/govt
//   3. Load target org, check state (no-op idempotency)
//   4. canRevoke — reject if out of scope
//   5. db.transaction:
//      a. Mutate target (anti-race WHERE + rowCount check)
//      b. INSERT audit_log RETURNING id
//      c. Claim attachments
//      d. Collect notification to org owner
//   6. Post-tx: flush pendingNotifications (§2.2 — NOT inside the tx)
//   7. Return { ok: true } or { error: string }
//
// §2.2: notifications accumulate in pendingNotifications[] inside the tx
// and are inserted AFTER the transaction commits (best-effort, logged on failure).

import { and, eq } from "drizzle-orm";

import { auditLog, db, notifications, organizations } from "@/db";
import { canRevoke } from "@/lib/domain/revocation-scope";
import type { RevocationTarget } from "@/lib/domain/revocation-scope";
import { validateMotivoAndAttachments } from "@/lib/domain/revocation-validation";

import { claimAttachmentsForAudit, loadActorAuthority } from "./helpers";
import type { RevocationResult } from "./types";

export async function revokeOrgVerificationForAuthority(
  actorUserId: string,
  input: {
    organizationId: string;
    motivo: string;
    attachmentIds: string[];
    bulkActionId?: string | null;
  },
): Promise<RevocationResult> {
  const validationError = validateMotivoAndAttachments(input.motivo, input.attachmentIds);
  if (validationError) return validationError;

  const auth = await loadActorAuthority(actorUserId);
  if (!auth.ok) return { error: auth.error };

  // Load target org
  const [org] = await db
    .select({
      id: organizations.id,
      verified: organizations.verified,
      jurisdictionProvince: organizations.jurisdictionProvince,
      jurisdictionLocality: organizations.jurisdictionLocality,
      createdByUserId: organizations.createdByUserId,
    })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .limit(1);

  if (!org) return { error: "Organización no encontrada." };

  // Idempotency: already unverified
  if (!org.verified) {
    return { ok: true, noOp: true };
  }

  // Capability check
  const target: RevocationTarget = {
    type: "org_verification",
    province: org.jurisdictionProvince ?? "",
    locality: org.jurisdictionLocality ?? "",
  };
  if (!canRevoke(auth.profile, target, auth.jurisdictions)) {
    return { error: "CAPABILITY_DENIED" };
  }

  type PendingNotification = typeof notifications.$inferInsert;
  const pendingNotifications: PendingNotification[] = [];

  try {
    await db.transaction(async (tx) => {
      // a. Mutate target — do NOT clear verified_at / verified_by_user_id (historical record)
      const updatedRows = await tx
        .update(organizations)
        .set({ verified: false, updatedAt: new Date() })
        .where(and(eq(organizations.id, input.organizationId), eq(organizations.verified, true)))
        .returning({ id: organizations.id });
      if (updatedRows.length < 1) {
        throw new Error("RACE_CONDITION: org already updated");
      }

      // b. INSERT audit_log RETURNING id
      const [logRow] = await tx
        .insert(auditLog)
        .values({
          actorUserId,
          action: "revocation_org_verified",
          targetOrganizationId: input.organizationId,
          payload: {
            reason: input.motivo.trim(),
            evidence_attachment_ids: input.attachmentIds,
            ...(input.bulkActionId ? { bulk_action_id: input.bulkActionId } : {}),
          },
        })
        .returning({ id: auditLog.id });

      // c. Claim attachments
      await claimAttachmentsForAudit(tx, logRow.id, input.attachmentIds, actorUserId);

      // d. Notification to org owner — skip if createdByUserId is null
      if (org.createdByUserId) {
        pendingNotifications.push({
          userId: org.createdByUserId,
          notificationType: "revocation_executed_org",
          title: "La verificación de tu organización fue revocada",
          body: input.motivo.trim(),
          severity: "warning",
          ctaLabel: "Ir al panel",
          ctaUrl: "/org",
        });
      }
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
