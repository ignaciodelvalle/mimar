// Use-case: govtSelfDeactivateForUser (§7.5)
//
// Steps:
//   1. Load profile
//   2. Idempotency: if already deactivated → noOp
//   3. Capability check: role='govt', accountType='institutional', deactivatedAt IS NULL
//   4. Coverage check (inside tx with SELECT FOR UPDATE):
//      For each active locality assignment, count OTHER active govts covering it.
//      If any has count=0 → block with LOCALITY_WOULD_BE_UNCOVERED.
//   5. If coverage OK (same tx):
//      0. If the caller is a jurisdiction administrator, their appointment is
//         revoked FIRST — by themself, a resignation (the database admits the
//         appointee as the one revoker besides the platform admin, 0270, and
//         refuses to revoke the implied grant while the appointment is
//         active, 0268 guard b). Security review L5.
//      a. Revoke all active govt_assignments for caller
//      b. SET deactivated_at on profiles (anti-race WHERE)
//      c. INSERT audit_log action='govt_self_deactivated'
//      d. INSERT notification to each active admin
//      e. INSERT notification to each OTHER govt who now sole-covers a locality
//         (cascade notice — they didn't gain a new assignment, but their existing
//          one may now be the only coverage for a formerly-shared locality)
//
// Note: auth.users is NOT deleted. The deactivated_at IS NOT NULL check in
// requireAdminOrGovtOrRedirect already blocks further privileged access.
// Pending approval_requests for ex-localities fall back to admin queue via the
// NOT EXISTS clause in lib/approval-scope.ts (already in place since Fase 5).
//
// §2.2: notifications accumulate in pendingNotifications[] inside the tx
// and are inserted AFTER the transaction commits (best-effort, logged on failure).
//
// Every timestamp is the DATABASE clock (now()), never this Node process: the
// revocations sit next to the defaultNow() audit row of the same transaction,
// and the audit guard recognises "revoked by this actor in this transaction"
// by revoked_at = now() (0269). Security review L4.
//
// A refusal the DATABASE makes never reaches the UI as its raw text (L5).
//
// `exec` (optional, default the module db) lets tests run it inside a
// transaction they roll back — an appointment fixture is append-only.

import { and, count, eq, isNull, ne, sql } from "drizzle-orm";

import { auditLog, db, govtAssignments, notifications, profiles } from "@/db";
import { pgError } from "@/lib/infra/db-errors";
import {
  type RevokedAppointment,
  revokeActiveAppointmentInTx,
} from "@/lib/infra/jurisdiction-admin-appointments";
import { jurisdictionAdminRefusal } from "@/lib/infra/jurisdiction-admin-refusals";
import { provinceByCode } from "@/lib/reference/ar-provincias";
import { JURISDICTION_ADMIN_REFUSAL_COPY } from "@/lib/ui/jurisdiction-admin-copy";

import type { GovtSelfDeactivateResult } from "./types";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const GOVT_SELF_DEACTIVATE_DB_ERROR = "No se pudo desactivar tu cuenta. Probá de nuevo.";

/** What the audit payload records of a resigned appointment. */
function appointmentSummary(appointment: RevokedAppointment | null) {
  return appointment
    ? { appointment_id: appointment.appointmentId, province_code: appointment.provinceCode }
    : null;
}

/** The sentence the admins' notice adds when an appointee resigned. */
function appointmentNote(appointment: RevokedAppointment | null): string {
  if (!appointment) return "";
  const province = provinceByCode(appointment.provinceCode)?.name ?? appointment.provinceCode;
  return ` Era administrador/a jurisdiccional de ${province}: la designación quedó revocada.`;
}

export async function govtSelfDeactivateForUser(
  userId: string,
  input?: { reason?: string },
  exec: typeof db | Tx = db,
): Promise<GovtSelfDeactivateResult> {
  // 1. Load profile
  const [profile] = await exec
    .select({
      id: profiles.id,
      role: profiles.role,
      accountType: profiles.accountType,
      deactivatedAt: profiles.deactivatedAt,
    })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);

  if (!profile) return { error: "NOT_FOUND" };

  // 2. Idempotency: already deactivated → noOp
  if (profile.deactivatedAt !== null) {
    return { ok: true, noOp: true };
  }

  // 3. Capability check
  if (profile.role !== "govt" || profile.accountType !== "institutional") {
    return {
      error: "ROLE_MISMATCH: only an active institutional govt account can self-deactivate",
    };
  }

  // 4+5. Coverage check + deactivation inside a single transaction.
  // SELECT FOR UPDATE on profiles + govtAssignments rows prevents concurrent
  // self-deactivations from two govts in the same locality racing past coverage.
  type PendingNotification = typeof notifications.$inferInsert;
  const pendingNotifications: PendingNotification[] = [];
  const resignationReason = input?.reason?.trim() || "Baja de la propia cuenta";

  try {
    await exec.transaction(async (tx) => {
      // Lock caller's profile row to serialise concurrent self-deactivation attempts.
      await tx.execute(sql`SELECT id FROM profiles WHERE id = ${userId} FOR UPDATE`);

      // Load caller's active assignments
      const myAssignments = await tx
        .select({
          id: govtAssignments.id,
          province: govtAssignments.jurisdictionProvince,
          locality: govtAssignments.jurisdictionLocality,
        })
        .from(govtAssignments)
        .where(and(eq(govtAssignments.userId, userId), isNull(govtAssignments.revokedAt)));

      // 4. Coverage check — for each locality, ensure at least one OTHER active govt covers it
      const uncovered: { province: string; locality: string }[] = [];

      for (const assignment of myAssignments) {
        // Count other active govts covering this same (province, locality).
        // "Active" means: their assignment is not revoked AND their profile is not deactivated.
        const [{ otherCount }] = await tx
          .select({ otherCount: count() })
          .from(govtAssignments)
          .innerJoin(profiles, eq(profiles.id, govtAssignments.userId))
          .where(
            and(
              ne(govtAssignments.userId, userId),
              eq(govtAssignments.jurisdictionProvince, assignment.province),
              eq(govtAssignments.jurisdictionLocality, assignment.locality),
              isNull(govtAssignments.revokedAt),
              isNull(profiles.deactivatedAt),
            ),
          );

        if (otherCount === 0) {
          uncovered.push({ province: assignment.province, locality: assignment.locality });
        }
      }

      if (uncovered.length > 0) {
        // Surface all uncovered localities to the caller so the UI can display them.
        throw Object.assign(new Error("LOCALITY_WOULD_BE_UNCOVERED"), { uncovered });
      }

      // 5.0 A jurisdiction administrator resigns their appointment first.
      const appointment = await revokeActiveAppointmentInTx(tx, {
        userId,
        revokedBy: userId,
        reason: resignationReason,
      });

      // 5a. Revoke all active assignments
      const revokedRows = await tx
        .update(govtAssignments)
        .set({
          revokedAt: sql`now()`,
          revokedByUserId: userId,
          revocationReason: "Self-deactivation",
        })
        .where(and(eq(govtAssignments.userId, userId), isNull(govtAssignments.revokedAt)))
        .returning({
          id: govtAssignments.id,
          province: govtAssignments.jurisdictionProvince,
          locality: govtAssignments.jurisdictionLocality,
        });

      const revokedCount = revokedRows.length;

      // 5b. SET deactivated_at (anti-race WHERE)
      const updatedRows = await tx
        .update(profiles)
        .set({ deactivatedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(profiles.id, userId), isNull(profiles.deactivatedAt)))
        .returning({ id: profiles.id });

      if (updatedRows.length < 1) {
        throw new Error("RACE_CONDITION");
      }

      // 5c. Audit log
      await tx.insert(auditLog).values({
        actorUserId: userId,
        action: "govt_self_deactivated",
        targetUserId: userId,
        payload: {
          reason: input?.reason ?? null,
          assignments_revoked_count: revokedCount,
          revoked_localities: revokedRows.map((r) => ({
            province: r.province,
            locality: r.locality,
          })),
          appointment_revoked: appointmentSummary(appointment),
        },
      });
      const resignedNote = appointmentNote(appointment);

      // 5d. Notify each active admin
      const activeAdmins = await tx
        .select({ id: profiles.id })
        .from(profiles)
        .where(
          and(
            eq(profiles.role, "admin"),
            eq(profiles.accountType, "institutional"),
            isNull(profiles.deactivatedAt),
          ),
        );

      for (const admin of activeAdmins) {
        pendingNotifications.push({
          userId: admin.id,
          notificationType: "govt_self_deactivated_admin_notice",
          title: "Un operador govt se auto-desactivó",
          body: `El operador con ID ${userId} desactivó su propia cuenta.${input?.reason ? ` Motivo: ${input.reason}` : ""}${resignedNote}`,
          severity: "warning" as const,
          ctaUrl: `/admin/govts/${userId}`,
          ctaLabel: "Ver perfil",
        });
      }

      // 5e. Notify other govts who now sole-cover one of the revoked localities.
      // Collect unique other-govt user IDs that have active assignments in the revoked localities.
      const revokedLocalities = revokedRows.map((r) => ({
        province: r.province,
        locality: r.locality,
      }));

      const cascadeGovtIds = new Set<string>();

      for (const loc of revokedLocalities) {
        const otherGovts = await tx
          .select({ userId: govtAssignments.userId })
          .from(govtAssignments)
          .innerJoin(profiles, eq(profiles.id, govtAssignments.userId))
          .where(
            and(
              ne(govtAssignments.userId, userId),
              eq(govtAssignments.jurisdictionProvince, loc.province),
              eq(govtAssignments.jurisdictionLocality, loc.locality),
              isNull(govtAssignments.revokedAt),
              isNull(profiles.deactivatedAt),
            ),
          );

        for (const g of otherGovts) {
          cascadeGovtIds.add(g.userId);
        }
      }

      for (const gId of cascadeGovtIds) {
        pendingNotifications.push({
          userId: gId,
          notificationType: "govt_self_deactivated_cascade_notice",
          title: "Cambio en tus localidades asignadas",
          body: "Un operador govt de tu área desactivó su cuenta. Tus asignaciones de localidad siguen activas y pueden tener mayor alcance.",
          severity: "info" as const,
          ctaUrl: "/gob",
          ctaLabel: "Ver mi panel",
        });
      }
    });
  } catch (err) {
    if (err instanceof Error) {
      if (err.message === "LOCALITY_WOULD_BE_UNCOVERED") {
        const uncovered =
          (err as Error & { uncovered?: { province: string; locality: string }[] }).uncovered ?? [];
        return { error: "LOCALITY_WOULD_BE_UNCOVERED", uncoveredLocalities: uncovered };
      }
      if (err.message === "RACE_CONDITION") {
        return { ok: true, noOp: true };
      }
    }
    // A database refusal (trigger, constraint) is translated, never shown raw.
    const refusal = jurisdictionAdminRefusal(err);
    if (refusal) return { error: JURISDICTION_ADMIN_REFUSAL_COPY[refusal] };
    if (pgError(err)) {
      console.error("govtSelfDeactivateForUser failed", err);
      return { error: GOVT_SELF_DEACTIVATE_DB_ERROR };
    }
    return {
      error: err instanceof Error ? err.message : "Error desconocido al desactivar cuenta.",
    };
  }

  if (pendingNotifications.length > 0) {
    try {
      await exec.insert(notifications).values(pendingNotifications);
    } catch (e) {
      console.error("notifications insert failed (govtSelfDeactivateForUser did succeed)", e);
    }
  }

  return { ok: true };
}
