// Use-case: appoint a jurisdiction administrator (SDD jurisdiction-admin,
// Phase 3). PLATFORM ADMIN ONLY — a jurisdiction admin never appoints, not
// even inside their own province (spec: "Jurisdiction admin cannot appoint or
// revoke").
//
// One transaction:
//   1. requirePlatformAdmin — inside the transaction (the authority is read in
//      the same snapshot as the rows it authorizes);
//   2. the appointee: an active institutional govt, locked FOR UPDATE so a
//      concurrent deactivation waits;
//   3. the province is free and the person holds no other appointment;
//   4. single-province (design D3): no active grant outside P;
//   5. the implied grant (design D1): the person's active whole-province grant
//      of P is REUSED (grant_created = false), or one is CREATED here
//      (grant_created = true — revoking the appointment then revokes it);
//   6. the appointment row, then its audit row (jurisdiction_admin_appointed,
//      platform-only at the database too).
// The database re-checks every one of these (0268's INSERT validator, the
// unique indexes, the audit guard); the checks here exist to answer with a
// precise code instead of a raw trigger message, never as the only wall.
//
// Executor-first, so a caller can compose it and tests can roll it back.

import { eq, isNull, sql } from "drizzle-orm";
import { z } from "zod/v4";

import { type db, govtAssignments, jurisdictionAdminAppointments, profiles } from "@/db";
import { WHOLE_PROVINCE_SENTINEL } from "@/lib/domain/jurisdiction-canonical";
import { writeAuditLog } from "@/lib/infra/audit-log";
import { createNotification } from "@/lib/infra/notification-service";
import { provinceByCode } from "@/lib/reference/ar-provincias";

import {
  type JurisdictionAdminRefusal,
  jurisdictionAdminRefusal,
} from "@/lib/infra/jurisdiction-admin-refusals";
import { requirePlatformAdmin } from "./authority";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type AppointmentExecutor = typeof db | Tx;

export type AppointError =
  | "PLATFORM_ONLY"
  | "NOT_FOUND"
  | "APPOINTEE_INVALID"
  | "PROVINCE_TAKEN"
  | "USER_ALREADY_APPOINTED"
  | "FOREIGN_GRANT"
  | "UNEXPECTED"
  | Exclude<JurisdictionAdminRefusal, "PLATFORM_ONLY">
  | `VALIDATION_ERROR: ${string}`;

export type AppointResult =
  | { ok: true; appointmentId: string; grantCreated: boolean }
  | { error: AppointError };

export const appointmentReasonSchema = z
  .string()
  .trim()
  .min(1, "Contá por qué se designa (o se revoca) a esta persona.")
  .max(500, "El motivo admite hasta 500 caracteres.");

const uuidSchema = z.string().uuid();

/** Thrown inside the transaction to roll it back with a code. */
class Refused extends Error {
  constructor(readonly code: AppointError) {
    super(code);
  }
}

export async function appointJurisdictionAdmin(
  exec: AppointmentExecutor,
  actorUserId: string,
  input: { userId: string; provinceCode: string; reason: string },
): Promise<AppointResult> {
  const reason = appointmentReasonSchema.safeParse(input.reason);
  if (!reason.success) {
    return { error: `VALIDATION_ERROR: ${reason.error.issues[0]?.message ?? "motivo inválido"}` };
  }
  const province = provinceByCode(input.provinceCode);
  if (!province) return { error: "VALIDATION_ERROR: Provincia desconocida." };
  if (!uuidSchema.safeParse(input.userId).success) return { error: "NOT_FOUND" };

  try {
    const result = await exec.transaction(async (tx) => {
      if (!(await requirePlatformAdmin(tx, actorUserId))) throw new Refused("PLATFORM_ONLY");

      const [target] = await tx
        .select({
          role: profiles.role,
          accountType: profiles.accountType,
          deactivatedAt: profiles.deactivatedAt,
          deletedAt: profiles.deletedAt,
        })
        .from(profiles)
        .where(eq(profiles.id, input.userId))
        .for("update")
        .limit(1);
      if (!target) throw new Refused("NOT_FOUND");
      if (
        target.role !== "govt" ||
        target.accountType !== "institutional" ||
        target.deactivatedAt !== null ||
        target.deletedAt !== null
      ) {
        throw new Refused("APPOINTEE_INVALID");
      }

      const active = await tx
        .select({
          userId: jurisdictionAdminAppointments.userId,
          provinceCode: jurisdictionAdminAppointments.provinceCode,
        })
        .from(jurisdictionAdminAppointments)
        .where(isNull(jurisdictionAdminAppointments.revokedAt));
      if (active.some((a) => a.provinceCode === province.code)) {
        throw new Refused("PROVINCE_TAKEN");
      }
      if (active.some((a) => a.userId === input.userId)) {
        throw new Refused("USER_ALREADY_APPOINTED");
      }

      // D3: every active grant of the person must be in P. Province compared
      // by CODE through the database's own mapping (the column stores names).
      const grants = (await tx.execute(sql`
        select id::text as id,
               public.ar_province_code(jurisdiction_province) as province_code,
               public.govt_grant_is_whole_province(jurisdiction_province, jurisdiction_locality)
                 as whole_province
          from public.govt_assignments
         where user_id = ${input.userId}::uuid and revoked_at is null
         for share`)) as unknown as Array<{
        id: string;
        province_code: string | null;
        whole_province: boolean;
      }>;
      if (grants.some((g) => g.province_code !== province.code)) {
        throw new Refused("FOREIGN_GRANT");
      }

      // D1: reuse the person's whole-province grant of P, else create it.
      const reused = grants.find((g) => g.whole_province);
      let grantId: string;
      let grantCreated: boolean;
      if (reused) {
        grantId = reused.id;
        grantCreated = false;
      } else {
        const [created] = await tx
          .insert(govtAssignments)
          .values({
            userId: input.userId,
            jurisdictionProvince: province.name,
            jurisdictionLocality: WHOLE_PROVINCE_SENTINEL,
            localityId: null,
            grantedByUserId: actorUserId,
          })
          .returning({ id: govtAssignments.id });
        grantId = created.id;
        grantCreated = true;
      }

      const [appointment] = await tx
        .insert(jurisdictionAdminAppointments)
        .values({
          userId: input.userId,
          provinceCode: province.code,
          govtAssignmentId: grantId,
          grantCreated,
          appointedByUserId: actorUserId,
          appointmentReason: reason.data,
        })
        .returning({ id: jurisdictionAdminAppointments.id });

      await writeAuditLog(tx, {
        action: "jurisdiction_admin_appointed",
        actorUserId,
        targetUserId: input.userId,
        targetGovtAssignmentId: grantId,
        payload: {
          appointment_id: appointment.id,
          province_code: province.code,
          govt_assignment_id: grantId,
          grant_created: grantCreated,
          reason: reason.data,
        },
        before: null,
        after: { province_code: province.code, grant_created: grantCreated },
      });

      return { appointmentId: appointment.id, grantCreated };
    });

    // After the commit, through the canonical path (idempotent, dead-lettered,
    // never throws): the designation stands without it.
    await createNotification(
      {
        userId: input.userId,
        notificationType: "jurisdiction_admin_appointed",
        title: `Te designaron administrador/a jurisdiccional de ${province.name}`,
        body: `Desde ahora administrás funcionarios, unidades y reglas de ${province.name}. Solo podés actuar dentro de esa provincia.`,
        severity: "info",
        ctaLabel: "Ir a mi panel",
        ctaUrl: "/gob",
        dedupeKey: `jurisdiction_admin_appointed:${result.appointmentId}`,
      },
      exec,
    );

    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof Refused) return { error: err.code };
    const refusal = jurisdictionAdminRefusal(err);
    if (refusal) return { error: refusal };
    console.error("appointJurisdictionAdmin failed", err);
    return { error: "UNEXPECTED" };
  }
}
