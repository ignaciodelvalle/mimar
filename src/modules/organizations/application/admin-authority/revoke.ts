// Use-case: revoke a jurisdiction administrator's appointment (SDD
// jurisdiction-admin, Phase 3), and the one in-transaction step every other
// path that ends an appointee's authority shares.
//
// revokeJurisdictionAdmin — PLATFORM ADMIN ONLY, reason required:
//   1. requirePlatformAdmin inside the transaction;
//   2. the appointment row locked FOR UPDATE (a second revocation waits, then
//      sees it revoked);
//   3. revoke the appointment FIRST, then — when appointing created it — its
//      implied grant (the database refuses the other order: 0268, guard b),
//      so the appointee's reads and powers vanish together;
//   4. the audit row jurisdiction_admin_revoked (platform-only at the
//      database too).
//
// revokeActiveAppointmentInTx (lib/infra/jurisdiction-admin-appointments.ts)
// is the step alone, for callers that already hold a transaction and their
// own authority: the platform admin deactivating an appointee
// (deactivate-govt) and the appointee resigning (govt-self-deactivate).
//
// Timestamps are the DATABASE clock (now()), like every revocation that sits
// next to a defaultNow() audit row in the same transaction.

import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod/v4";

import { type db, govtAssignments, jurisdictionAdminAppointments } from "@/db";
import { writeAuditLog } from "@/lib/infra/audit-log";
import {
  type JurisdictionAdminRefusal,
  jurisdictionAdminRefusal,
} from "@/lib/infra/jurisdiction-admin-refusals";
import { createNotification } from "@/lib/infra/notification-service";
import { provinceByCode } from "@/lib/reference/ar-provincias";

import { appointmentReasonSchema } from "./appoint";
import { requirePlatformAdmin } from "./authority";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type RevocationExecutor = typeof db | Tx;

export type RevokeError =
  | "PLATFORM_ONLY"
  | "NOT_FOUND"
  | "ALREADY_REVOKED"
  | "UNEXPECTED"
  | Exclude<JurisdictionAdminRefusal, "PLATFORM_ONLY">
  | `VALIDATION_ERROR: ${string}`;

export type RevokeResult =
  | { ok: true; grantRevoked: boolean; provinceCode: string }
  | { error: RevokeError };

class Refused extends Error {
  constructor(readonly code: RevokeError) {
    super(code);
  }
}

const uuidSchema = z.string().uuid();

export async function revokeJurisdictionAdmin(
  exec: RevocationExecutor,
  actorUserId: string,
  input: { appointmentId: string; reason: string },
): Promise<RevokeResult> {
  const reason = appointmentReasonSchema.safeParse(input.reason);
  if (!reason.success) {
    return { error: `VALIDATION_ERROR: ${reason.error.issues[0]?.message ?? "motivo inválido"}` };
  }
  if (!uuidSchema.safeParse(input.appointmentId).success) return { error: "NOT_FOUND" };

  try {
    const result = await exec.transaction(async (tx) => {
      if (!(await requirePlatformAdmin(tx, actorUserId))) throw new Refused("PLATFORM_ONLY");

      const [appointment] = await tx
        .select({
          id: jurisdictionAdminAppointments.id,
          userId: jurisdictionAdminAppointments.userId,
          provinceCode: jurisdictionAdminAppointments.provinceCode,
          govtAssignmentId: jurisdictionAdminAppointments.govtAssignmentId,
          grantCreated: jurisdictionAdminAppointments.grantCreated,
          revokedAt: jurisdictionAdminAppointments.revokedAt,
        })
        .from(jurisdictionAdminAppointments)
        .where(eq(jurisdictionAdminAppointments.id, input.appointmentId))
        .for("update")
        .limit(1);
      if (!appointment) throw new Refused("NOT_FOUND");
      if (appointment.revokedAt !== null) throw new Refused("ALREADY_REVOKED");

      // The appointment first; the database refuses the implied grant first.
      await tx
        .update(jurisdictionAdminAppointments)
        .set({
          revokedAt: sql`now()`,
          revokedByUserId: actorUserId,
          revocationReason: reason.data,
        })
        .where(eq(jurisdictionAdminAppointments.id, appointment.id));

      // The grant appointing created goes with it; a reused one was the
      // person's before the appointment and stays theirs.
      let grantRevoked = false;
      if (appointment.grantCreated) {
        const revoked = await tx
          .update(govtAssignments)
          .set({
            revokedAt: sql`now()`,
            revokedByUserId: actorUserId,
            revocationReason: reason.data,
          })
          .where(
            and(
              eq(govtAssignments.id, appointment.govtAssignmentId),
              isNull(govtAssignments.revokedAt),
            ),
          )
          .returning({ id: govtAssignments.id });
        grantRevoked = revoked.length > 0;
      }

      await writeAuditLog(tx, {
        action: "jurisdiction_admin_revoked",
        actorUserId,
        targetUserId: appointment.userId,
        targetGovtAssignmentId: appointment.govtAssignmentId,
        payload: {
          appointment_id: appointment.id,
          province_code: appointment.provinceCode,
          govt_assignment_id: appointment.govtAssignmentId,
          grant_revoked: grantRevoked,
          reason: reason.data,
        },
        before: { province_code: appointment.provinceCode, active: true },
        after: { province_code: appointment.provinceCode, active: false },
      });

      return { userId: appointment.userId, provinceCode: appointment.provinceCode, grantRevoked };
    });

    // After the commit, through the canonical path (idempotent, dead-lettered,
    // never throws): the revocation stands without it.
    const provinceName = provinceByCode(result.provinceCode)?.name ?? result.provinceCode;
    await createNotification(
      {
        userId: result.userId,
        notificationType: "jurisdiction_admin_revoked",
        title: `Terminó tu designación como administrador/a jurisdiccional de ${provinceName}`,
        body: reason.data,
        severity: "warning",
        ctaLabel: "Ir a mi panel",
        ctaUrl: "/gob",
        dedupeKey: `jurisdiction_admin_revoked:${input.appointmentId}`,
      },
      exec,
    );

    return { ok: true, grantRevoked: result.grantRevoked, provinceCode: result.provinceCode };
  } catch (err) {
    if (err instanceof Refused) return { error: err.code };
    const refusal = jurisdictionAdminRefusal(err);
    if (refusal) return { error: refusal === "APPEND_ONLY" ? "ALREADY_REVOKED" : refusal };
    console.error("revokeJurisdictionAdmin failed", err);
    return { error: "UNEXPECTED" };
  }
}
