// Use-case: revokeVetRoleForAuthority (REQ-1, REQ-4, REQ-7)
//
// Downgrades a vet → owner with:
//   1. Pre-flight validation (motivo length, attachmentIds count)
//   2. loadActorAuthority — reject if not admin/govt
//   3. Load target profile, check state (no-op idempotency)
//   4. canRevoke — reject if out of scope
//   5. db.transaction:
//      a. Mutate target (anti-race WHERE + rowCount check)
//      b. Cascade un-verify clinic orgs auto-verified via this vet's matrícula
//      c. INSERT audit_log RETURNING id
//      d. Claim attachments (UPDATE WHERE uploaded_by_user_id=actor)
//      e. Collect notification to target
//   6. Post-tx: flush pendingNotifications (§2.2 — NOT inside the tx)
//   7. Return { ok: true } or { error: string }
//
// §2.2: notifications accumulate in pendingNotifications[] inside the tx
// and are inserted AFTER the transaction commits (best-effort, logged on failure).

import { and, count, eq, inArray, isNull } from "drizzle-orm";

import {
  auditLog,
  db,
  notifications,
  organizationMemberships,
  organizations,
  profiles,
} from "@/db";
import { canRevoke } from "@/lib/domain/revocation-scope";
import type { RevocationTarget } from "@/lib/domain/revocation-scope";
import { validateMotivoAndAttachments } from "@/lib/domain/revocation-validation";

import { claimAttachmentsForAudit, loadActorAuthority } from "./helpers";
import type { RevocationResult } from "./types";

export async function revokeVetRoleForAuthority(
  actorUserId: string,
  input: {
    targetUserId: string;
    motivo: string;
    attachmentIds: string[];
    bulkActionId?: string | null;
  },
): Promise<RevocationResult> {
  // Pre-flight validation
  const validationError = validateMotivoAndAttachments(input.motivo, input.attachmentIds);
  if (validationError) return validationError;

  const auth = await loadActorAuthority(actorUserId);
  if (!auth.ok) return { error: auth.error };

  // Load target profile
  const [targetProfile] = await db
    .select({
      id: profiles.id,
      role: profiles.role,
      matriculaVerified: profiles.matriculaVerified,
      matriculaJurisdiccion: profiles.matriculaJurisdiccion,
    })
    .from(profiles)
    .where(eq(profiles.id, input.targetUserId))
    .limit(1);

  if (!targetProfile) return { error: "Usuario destino no encontrado." };

  // Idempotency: already owner
  if (targetProfile.role !== "vet") {
    return { ok: true, noOp: true };
  }

  // Capability check
  const target: RevocationTarget = {
    type: "vet_role",
    matriculaJurisdiccion: targetProfile.matriculaJurisdiccion ?? "",
  };
  if (!canRevoke(auth.profile, target, auth.jurisdictions)) {
    return { error: "CAPABILITY_DENIED" };
  }

  type PendingNotification = typeof notifications.$inferInsert;
  const pendingNotifications: PendingNotification[] = [];

  try {
    await db.transaction(async (tx) => {
      // a. Mutate target with anti-race WHERE clause
      const updatedRows = await tx
        .update(profiles)
        .set({ role: "owner", matriculaVerified: false, updatedAt: new Date() })
        .where(and(eq(profiles.id, input.targetUserId), eq(profiles.role, "vet")))
        .returning({ id: profiles.id });
      if (updatedRows.length < 1) {
        // Lost the race — another concurrent revocation already ran
        throw new Error("RACE_CONDITION: target profile already updated");
      }

      // D4: Cascade — un-verify any clinic org that was auto-verified via this
      // vet's matrícula AND where the revoked user is still the sole active admin.
      //
      // "Sole active admin" means exactly one active membership with role=admin.
      // We check this by finding all clinic orgs where:
      //   (1) the vet is an active admin
      //   (2) autoVerifiedViaMatricula = true
      //   (3) there is only one active admin membership total on that org
      //
      // This protects multi-admin orgs from cascading incorrectly.
      const vetAdminMemberships = await tx
        .select({ organizationId: organizationMemberships.organizationId })
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.userId, input.targetUserId),
            eq(organizationMemberships.role, "admin"),
            isNull(organizationMemberships.leftAt),
          ),
        );

      if (vetAdminMemberships.length > 0) {
        const orgIds = vetAdminMemberships.map((m) => m.organizationId);

        // Load the candidate orgs that are auto-verified via matrícula
        const candidateOrgs = await tx
          .select({ id: organizations.id, createdByUserId: organizations.createdByUserId })
          .from(organizations)
          .where(
            and(
              inArray(organizations.id, orgIds),
              eq(organizations.verified, true),
              eq(organizations.autoVerifiedViaMatricula, true),
            ),
          );

        for (const org of candidateOrgs) {
          // Check that this org has exactly one active admin (the vet being revoked).
          // If there are co-admins, do NOT cascade — the org has its own governance.
          const [adminCount] = await tx
            .select({ count: count() })
            .from(organizationMemberships)
            .where(
              and(
                eq(organizationMemberships.organizationId, org.id),
                eq(organizationMemberships.role, "admin"),
                isNull(organizationMemberships.leftAt),
              ),
            );

          if ((adminCount?.count ?? 0) === 1) {
            await tx
              .update(organizations)
              .set({
                verified: false,
                verifiedAt: null,
                verifiedByUserId: null,
                autoVerifiedViaMatricula: false,
                updatedAt: new Date(),
              })
              .where(eq(organizations.id, org.id));

            // Queue a notification for the org owner (best-effort, same pattern
            // as revokeOrgVerificationForAuthority).
            if (org.createdByUserId) {
              pendingNotifications.push({
                userId: org.createdByUserId,
                notificationType: "revocation_executed_org",
                title: "La verificación de tu consultorio fue revocada",
                body: "La matrícula del titular fue revocada. Tu consultorio requiere verificación institucional para volver a operar.",
                severity: "warning",
                ctaLabel: "Más información",
                ctaUrl: "/org",
              });
            }
          }
        }
      }

      // b. INSERT audit_log RETURNING id
      const [logRow] = await tx
        .insert(auditLog)
        .values({
          actorUserId,
          action: "revocation_vet_role",
          targetUserId: input.targetUserId,
          payload: {
            reason: input.motivo.trim(),
            evidence_attachment_ids: input.attachmentIds,
            ...(input.bulkActionId ? { bulk_action_id: input.bulkActionId } : {}),
          },
        })
        .returning({ id: auditLog.id });

      // c. Claim attachments
      await claimAttachmentsForAudit(tx, logRow.id, input.attachmentIds, actorUserId);

      // d. Notification to target
      pendingNotifications.push({
        userId: input.targetUserId,
        notificationType: "revocation_executed_vet",
        title: "Tu rol veterinario fue revocado",
        body: input.motivo.trim(),
        severity: "warning",
        ctaLabel: "Ver opciones",
        ctaUrl: "/cuenta/upgrade",
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
