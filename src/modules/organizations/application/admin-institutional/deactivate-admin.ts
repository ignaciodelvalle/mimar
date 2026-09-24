// Use-case: deactivateAdminForAuthority
//
// Deactivates an admin account with:
//   1. Validation (motivo ≥30 chars, attachmentIds ≥1)
//   2. Self-deactivation check
//   3. Capability check (actor must be active admin)
//   4. DB transaction with SELECT FOR UPDATE on active admin set (last-admin guard)
//   5. SET deactivated_at, audit_log, claim attachments, notification
//
// §2.2: notifications accumulate in pendingNotificationsAdmin[] inside the tx
// and are inserted AFTER the transaction commits (best-effort, logged on failure).

import { and, eq, isNull, sql } from "drizzle-orm";

import { auditLog, db, notifications, profiles } from "@/db";
import { canCreateInstitutional } from "@/lib/domain/institutional-scope";
import { validateMotivoAndAttachments } from "@/lib/domain/revocation-validation";
import { claimAttachmentsForAudit } from "@/src/modules/organizations/application/revocations/helpers";

import { loadActorProfile } from "./helpers";
import type { DeactivateResult } from "./types";

export async function deactivateAdminForAuthority(
  actorUserId: string,
  input: {
    targetAdminUserId: string;
    motivo: string;
    attachmentIds: string[];
  },
): Promise<DeactivateResult> {
  // 1. Validate motivo + attachments
  const validationError = validateMotivoAndAttachments(input.motivo, input.attachmentIds);
  if (validationError) return validationError;

  // 2. Self-deactivation check (before any DB read)
  if (actorUserId === input.targetAdminUserId) {
    return { error: "SELF_DENIED" };
  }

  // 3. Load actor profile + capability check
  const actorProfile = await loadActorProfile(actorUserId);
  if (!actorProfile) return { error: "CAPABILITY_DENIED" };
  if (!canCreateInstitutional(actorProfile)) return { error: "CAPABILITY_DENIED" };

  // 4. Transaction with SELECT FOR UPDATE on active admin set (last-admin guard + deactivation)
  type PendingNotification = typeof notifications.$inferInsert;
  const pendingNotificationsAdmin: PendingNotification[] = [];

  try {
    await db.transaction(async (tx) => {
      // SELECT FOR UPDATE — locks ALL active admin rows to prevent concurrent last-admin races.
      // The lock is row-level; only competing writers to these rows will wait.
      // We use raw SQL here because drizzle ORM doesn't expose FOR UPDATE in SELECT directly.
      // With drizzle-orm/postgres-js, tx.execute returns the raw postgres-js result which
      // behaves as an array-like iterable of row objects.
      // C21: select is_system alongside id so the last-admin floor counts only
      // HUMAN admins (is_system = false). A system/service admin must never keep
      // the count above the floor — otherwise the last human admin could be
      // deactivated while a machine account masks the gap. We still lock the full
      // active-admin set (the system rows included) so concurrent writers to any
      // admin row serialize correctly.
      const lockResult = await tx.execute(
        sql`SELECT id, is_system FROM profiles WHERE account_type = 'institutional' AND role = 'admin' AND deactivated_at IS NULL FOR UPDATE`,
      );
      // postgres-js with drizzle returns the SQL result directly as an iterable array.
      // Cast to unknown first, then spread into a regular array for safe iteration.
      const adminRows: Array<{ id: string; is_system: boolean }> = [
        ...(lockResult as unknown as Iterable<{ id: string; is_system: boolean }>),
      ];
      // Human-admin floor: ignore system/service accounts (is_system = true) in the count.
      const humanAdminCount = adminRows.filter((r) => r.is_system === false).length;

      // Idempotency: if target is NOT in the active set, it's already deactivated.
      const targetRow = adminRows.find((r) => r.id === input.targetAdminUserId);
      if (!targetRow) {
        throw new Error("NO_OP");
      }

      // Last-HUMAN-admin guard (C21): system/service accounts (is_system) must not
      // prop up the floor — otherwise the last human admin could be deactivated while
      // a service account keeps the raw count ≥ 2. Deactivating a service account
      // itself never reduces the human count, so the guard only fires for humans.
      const targetIsSystem = targetRow.is_system === true;
      if (!targetIsSystem && humanAdminCount - 1 < 1) {
        throw new Error("LAST_ADMIN");
      }
      const remainingHumanAdmins = humanAdminCount - (targetIsSystem ? 0 : 1);

      // a. SET deactivated_at with anti-race WHERE
      const updatedRows = await tx
        .update(profiles)
        .set({ deactivatedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(profiles.id, input.targetAdminUserId), isNull(profiles.deactivatedAt)))
        .returning({ id: profiles.id });

      if (updatedRows.length < 1) {
        throw new Error("RACE_CONDITION");
      }

      // b. INSERT audit_log RETURNING id
      const [logRow] = await tx
        .insert(auditLog)
        .values({
          actorUserId,
          action: "admin_deactivated_by_admin",
          targetUserId: input.targetAdminUserId,
          payload: {
            reason: input.motivo.trim(),
            evidence_attachment_ids: input.attachmentIds,
            remaining_admins_count: remainingHumanAdmins,
          },
        })
        .returning({ id: auditLog.id });

      // c. Claim attachments
      await claimAttachmentsForAudit(tx, logRow.id, input.attachmentIds, actorUserId);

      // d. Notification to deactivated admin (accumulated post-tx)
      pendingNotificationsAdmin.push({
        userId: input.targetAdminUserId,
        notificationType: "admin_deactivated",
        title: "Tu cuenta de administrador fue desactivada",
        body: input.motivo.trim(),
        severity: "warning",
        ctaLabel: "Ver notificaciones",
        ctaUrl: "/cuenta",
      });
    });
  } catch (err) {
    if (err instanceof Error) {
      if (err.message === "NO_OP") return { ok: true, noOp: true };
      if (err.message === "LAST_ADMIN") {
        return { error: "LAST_ADMIN: No podés desactivar al último admin del sistema." };
      }
      if (err.message === "RACE_CONDITION") return { ok: true, noOp: true };
    }
    return {
      error: err instanceof Error ? err.message : "Error desconocido al desactivar admin.",
    };
  }

  if (pendingNotificationsAdmin.length > 0) {
    try {
      await db.insert(notifications).values(pendingNotificationsAdmin);
    } catch (e) {
      console.error("notifications insert failed (action did succeed)", e);
    }
  }

  return { ok: true };
}
