// unverifyOrgForAuthority use-case.
//
// Lightweight un-verify without evidence upload. For evidence-backed revocations
// with formal accountability, use revokeOrgVerificationForAuthority instead.
// Sets organizations.verified=false; preserves verifiedAt/verifiedByUserId as
// historical record (mirrors revokeOrgVerificationForAuthority behaviour).

import { and, eq } from "drizzle-orm";

import { auditLog, db, notifications, organizations, profiles } from "@/db";

import { isActiveInstitutionalAdmin, loadOrgAdminUserIds } from "./helpers";
import type { VerifyOrgResult } from "./types";

export async function unverifyOrgForAuthority(
  actorUserId: string,
  input: { organizationId: string; reason?: string },
): Promise<VerifyOrgResult> {
  // Load actor — must be active institutional admin (defense-in-depth: mirrors
  // the full requireAdminOrRedirect gate including accountType check).
  const [actor] = await db
    .select({
      id: profiles.id,
      role: profiles.role,
      accountType: profiles.accountType,
      deactivatedAt: profiles.deactivatedAt,
    })
    .from(profiles)
    .where(eq(profiles.id, actorUserId))
    .limit(1);

  if (!actor || !isActiveInstitutionalAdmin(actor)) {
    return { error: "CAPABILITY_DENIED" };
  }

  // Load target org (display name only — idempotency check moves inside tx).
  const [org] = await db
    .select({
      id: organizations.id,
      displayName: organizations.displayName,
    })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .limit(1);

  if (!org) return { error: "Organización no encontrada." };

  type PendingNotification = typeof notifications.$inferInsert;
  let pendingNotifications: PendingNotification[] = [];
  let noOp = false;

  try {
    await db.transaction(async (tx) => {
      // a. Mutate — idempotency decided inside tx by affected-row count
      //    (WHERE verified=true means 0 rows = already unverified, no audit).
      // Preserve verifiedAt / verifiedByUserId as historical record.
      const updatedRows = await tx
        .update(organizations)
        .set({
          verified: false,
          updatedAt: new Date(),
        })
        .where(and(eq(organizations.id, input.organizationId), eq(organizations.verified, true)))
        .returning({ id: organizations.id });

      if (updatedRows.length < 1) {
        // Already unverified (concurrent or pre-existing) — noOp, no audit.
        noOp = true;
        return;
      }

      // b. INSERT audit_log
      await tx.insert(auditLog).values({
        actorUserId,
        action: "org_unverified",
        targetOrganizationId: input.organizationId,
        payload: {
          org_id: input.organizationId,
          org_display_name: org.displayName,
          ...(input.reason ? { reason: input.reason.trim() } : {}),
        },
      });

      // c. Notify org admins
      const adminUserIds = await loadOrgAdminUserIds(tx, input.organizationId);

      const body = input.reason
        ? `${org.displayName} fue des-verificada. Motivo: ${input.reason.trim()}`
        : `${org.displayName} fue des-verificada por un administrador.`;

      pendingNotifications = adminUserIds.map((userId) => ({
        userId,
        notificationType: "org_verification_revoked",
        title: "La verificación de tu organización fue removida",
        body,
        severity: "warning" as const,
        ctaLabel: "Ir al panel",
        ctaUrl: "/org",
      }));
    });
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Error desconocido al des-verificar.",
    };
  }

  if (noOp) return { ok: true, noOp: true };

  if (pendingNotifications.length > 0) {
    try {
      await db.insert(notifications).values(pendingNotifications);
    } catch (e) {
      console.error("notifications insert failed (unverifyOrgForAuthority did succeed)", e);
    }
  }

  return { ok: true };
}
