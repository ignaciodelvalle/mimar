// Use-case: deactivateGovtForAuthority
//
// Deactivates a govt account — or a national observer (pilot T1-P9):
//   1. Validation
//   2. ONE transaction:
//      a. authority — read INSIDE the transaction (the one admin-authority
//         loader; security review L6): the platform admin, or a jurisdiction
//         admin (Phase 4);
//      b. the target, locked FOR UPDATE: an active institutional govt or
//         national. A jurisdiction admin may only deactivate a govt whose
//         active grants all lie in their province — never themself, another
//         appointee, a national, or a govt with no single province;
//      c. if the target is a jurisdiction administrator, their appointment is
//         revoked FIRST (the database refuses to revoke its implied grant
//         while it is active — 0268, guard b) and that revocation is audited
//         (jurisdiction_admin_revoked; security review L5);
//      d. revoke localities, deactivate, audit_log, claim attachments,
//         notification.
//
// §2.2: notifications accumulate in pendingNotificationsGovt[] inside the tx
// and are inserted AFTER the transaction commits (best-effort, logged on failure).
//
// A refusal the DATABASE makes (a trigger) never reaches the UI as its raw
// text: it is translated to es-AR copy (security review L5).
//
// Executor-last and optional (`exec`, default the module db) so tests can run
// it inside a transaction they roll back: the appointment table is
// append-only, so a committed appointee fixture could never be cleaned up.

import { and, eq, isNull, sql } from "drizzle-orm";

import { auditLog, db, govtAssignments, notifications, profiles } from "@/db";
import { validateMotivoAndAttachments } from "@/lib/domain/revocation-validation";
import { writeAuditLog } from "@/lib/infra/audit-log";
import { revokeActiveAppointmentInTx } from "@/lib/infra/jurisdiction-admin-appointments";
import { jurisdictionAdminRefusal } from "@/lib/infra/jurisdiction-admin-refusals";
import {
  JURISDICTION_ADMIN_REFUSAL_COPY,
  JURISDICTION_ADMIN_WRITER_COPY,
} from "@/lib/ui/jurisdiction-admin-copy";
import {
  hasAdminAuthority,
  requireJurisdictionAdminFor,
  requirePlatformAdmin,
} from "@/src/modules/organizations/application/admin-authority/authority";
import {
  govtTargetProvince,
  singleProvince,
} from "@/src/modules/organizations/application/admin-authority/target-province";
import { claimAttachmentsForAudit } from "@/src/modules/organizations/application/revocations/helpers";

import type { DeactivateResult } from "./types";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DeactivateGovtExecutor = typeof db | Tx;

/** Thrown inside the transaction to roll it back with a result code. */
class Refused extends Error {}

export const DEACTIVATE_GOVT_DB_ERROR = "No se pudo desactivar la cuenta. Probá de nuevo.";

/**
 * Why a JURISDICTION admin may not deactivate this target, or null (always
 * null for the platform admin). Read with the target already locked.
 *
 * NO ORACLE (Phase-4 review LOW-1). For a jurisdiction admin this is asked
 * BEFORE any check on the target row, and a target that does not exist, is
 * not an institutional govt, or is already deactivated reads exactly like a
 * target in another province: OUT_OF_PROVINCE. Otherwise distinct answers
 * would tell a delegated administrator which ids exist anywhere in the
 * country, and what they are.
 */
async function delegatedDeactivationRefusal(
  tx: Tx,
  actorUserId: string,
  targetUserId: string,
  target: { role: string; accountType: string; deactivatedAt: Date | null } | undefined,
): Promise<string | null> {
  if (await requirePlatformAdmin(tx, actorUserId)) return null;
  if (targetUserId === actorUserId) return JURISDICTION_ADMIN_WRITER_COPY.SELF_DEACTIVATE;
  const place = await govtTargetProvince(tx, targetUserId);
  if (
    !target ||
    target.role !== "govt" ||
    target.accountType !== "institutional" ||
    target.deactivatedAt !== null ||
    place.isAppointee ||
    !(await requireJurisdictionAdminFor(tx, actorUserId, singleProvince(place)))
  ) {
    return JURISDICTION_ADMIN_WRITER_COPY.OUT_OF_PROVINCE;
  }
  return null;
}

export async function deactivateGovtForAuthority(
  actorUserId: string,
  input: {
    targetGovtUserId: string;
    motivo: string;
    attachmentIds: string[];
  },
  exec: DeactivateGovtExecutor = db,
): Promise<DeactivateResult> {
  // 1. Validate motivo + attachments
  const validationError = validateMotivoAndAttachments(input.motivo, input.attachmentIds);
  if (validationError) return validationError;
  const motivo = input.motivo.trim();

  type PendingNotification = typeof notifications.$inferInsert;
  const pendingNotificationsGovt: PendingNotification[] = [];

  try {
    await exec.transaction(async (tx) => {
      // a. Authority, in this transaction's snapshot: the platform admin, or a
      //    jurisdiction admin (whose province is checked against the target
      //    below, once the target is locked).
      if (!(await hasAdminAuthority(tx, actorUserId))) throw new Refused("CAPABILITY_DENIED");

      // b. The target is an active institutional govt OR national.
      //
      // `national` (the read-only, country-wide observer, migration 0214) is
      // deactivated through THIS use case rather than a copy of it: the act is
      // the same (deactivated_at, audit row with the evidence, notification),
      // and a national simply holds no govt_assignments, so step d revokes zero
      // rows. Until this existed an admin could create a national and never
      // switch it off. The audit action stays `govt_deactivated_by_admin`;
      // `target_role` in the payload says which of the two it was.
      const [targetProfile] = await tx
        .select({
          id: profiles.id,
          role: profiles.role,
          accountType: profiles.accountType,
          deactivatedAt: profiles.deactivatedAt,
        })
        .from(profiles)
        .where(eq(profiles.id, input.targetGovtUserId))
        .for("update")
        .limit(1);

      // a'. WHERE the actor may act (jurisdiction-admin Phase 4), asked
      //    FIRST (review LOW-1: no oracle). The place is the target's: a govt
      //    whose active grants all lie in ONE province. A national observer,
      //    a govt with no active grant or with grants in two provinces has no
      //    single place — platform only. A jurisdiction admin never
      //    deactivates themself nor another appointee (only the platform
      //    admin ends an appointment).
      const delegated = await delegatedDeactivationRefusal(
        tx,
        actorUserId,
        input.targetGovtUserId,
        targetProfile,
      );
      if (delegated) throw new Refused(delegated);

      if (!targetProfile) throw new Refused("NOT_INSTITUTIONAL_GOVT");
      if (
        (targetProfile.role !== "govt" && targetProfile.role !== "national") ||
        targetProfile.accountType !== "institutional"
      ) {
        throw new Refused("NOT_INSTITUTIONAL_GOVT");
      }
      if (targetProfile.deactivatedAt !== null) throw new Refused("TARGET_ALREADY_DEACTIVATED");

      // Timestamps come from the DATABASE clock (now() = the transaction's
      // start), not this Node process: a Docker VM drifts from its host, and
      // these instants sit next to defaultNow() columns written in the same
      // transaction (audit_log.created_at).
      //
      // c. A jurisdiction administrator's appointment ends first, audited.
      const appointment = await revokeActiveAppointmentInTx(tx, {
        userId: input.targetGovtUserId,
        revokedBy: actorUserId,
        reason: motivo,
      });
      if (appointment) {
        await writeAuditLog(tx, {
          action: "jurisdiction_admin_revoked",
          actorUserId,
          targetUserId: input.targetGovtUserId,
          targetGovtAssignmentId: appointment.govtAssignmentId,
          payload: {
            appointment_id: appointment.appointmentId,
            province_code: appointment.provinceCode,
            govt_assignment_id: appointment.govtAssignmentId,
            // The deactivation below revokes every grant, the implied one too.
            grant_revoked: true,
            reason: motivo,
            via: "govt_deactivated_by_admin",
          },
          before: { province_code: appointment.provinceCode, active: true },
          after: { province_code: appointment.provinceCode, active: false },
        });
      }

      // d. Revoke all active govt_assignments for target
      const revokedAssignments = await tx
        .update(govtAssignments)
        .set({
          revokedAt: sql`now()`,
          revokedByUserId: actorUserId,
          revocationReason: motivo,
        })
        .where(
          and(
            eq(govtAssignments.userId, input.targetGovtUserId),
            isNull(govtAssignments.revokedAt),
          ),
        )
        .returning({ id: govtAssignments.id });

      const revokedCount = revokedAssignments.length;

      // SET deactivated_at with anti-race WHERE
      const updatedRows = await tx
        .update(profiles)
        .set({ deactivatedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(profiles.id, input.targetGovtUserId), isNull(profiles.deactivatedAt)))
        .returning({ id: profiles.id });

      if (updatedRows.length < 1) {
        throw new Error("RACE_CONDITION");
      }

      // INSERT audit_log RETURNING id
      const [logRow] = await tx
        .insert(auditLog)
        .values({
          actorUserId,
          action: "govt_deactivated_by_admin",
          targetUserId: input.targetGovtUserId,
          payload: {
            reason: motivo,
            evidence_attachment_ids: input.attachmentIds,
            revoked_assignments_count: revokedCount,
            target_role: targetProfile.role,
            appointment_revoked: appointment
              ? {
                  appointment_id: appointment.appointmentId,
                  province_code: appointment.provinceCode,
                }
              : null,
          },
        })
        .returning({ id: auditLog.id });

      // Claim attachments
      await claimAttachmentsForAudit(tx, logRow.id, input.attachmentIds, actorUserId);

      // Notification to deactivated govt operator (accumulated post-tx)
      pendingNotificationsGovt.push({
        userId: input.targetGovtUserId,
        notificationType: "govt_deactivated",
        title: "Tu cuenta de operador fue desactivada",
        body: motivo,
        severity: "warning",
        ctaLabel: "Ver notificaciones",
        ctaUrl: "/cuenta",
      });
    });
  } catch (err) {
    if (err instanceof Refused) return { error: err.message };
    if (err instanceof Error && err.message === "RACE_CONDITION") {
      return { ok: true, noOp: true };
    }
    // A database refusal (trigger, constraint) is translated, never shown raw.
    const refusal = jurisdictionAdminRefusal(err);
    if (refusal) return { error: JURISDICTION_ADMIN_REFUSAL_COPY[refusal] };
    // Anything else is logged, never shown raw (review LOW-2).
    console.error("deactivateGovtForAuthority failed", err);
    return { error: DEACTIVATE_GOVT_DB_ERROR };
  }

  if (pendingNotificationsGovt.length > 0) {
    try {
      await exec.insert(notifications).values(pendingNotificationsGovt);
    } catch (e) {
      console.error("notifications insert failed (action did succeed)", e);
    }
  }

  return { ok: true };
}
