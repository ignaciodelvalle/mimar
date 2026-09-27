// Ending a jurisdiction administrator's appointment inside a caller's
// transaction (SDD jurisdiction-admin). The one step every path that ends an
// appointee's authority shares: the platform admin's revocation
// (src/modules/organizations/application/admin-authority/revoke.ts), the
// platform admin deactivating an appointee (deactivate-govt) and the appointee
// resigning (govt-self-deactivate, in the pets module — hence lib/, since
// module-to-module imports are fenced by lint:deps).
//
// It revokes the APPOINTMENT only, never a grant: the database refuses to
// revoke the implied grant while the appointment is active (0268, guard b), so
// this runs first and each caller revokes grants right after. The timestamp
// is the DATABASE clock (now()), like every revocation that sits next to a
// defaultNow() audit row in the same transaction.

import { and, eq, isNull, sql } from "drizzle-orm";

import { type db, jurisdictionAdminAppointments } from "@/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type RevokedAppointment = {
  appointmentId: string;
  provinceCode: string;
  govtAssignmentId: string;
  grantCreated: boolean;
};

/**
 * Revoke `userId`'s ACTIVE appointment, if any, inside `tx`, by `revokedBy`
 * (the platform admin, or `userId` themself resigning — the only two the
 * database admits, 0270). Returns what was revoked, or null when there was
 * nothing to revoke. Does NOT write an audit row: the caller's own audit row
 * records the act (and names the appointment it ended).
 */
export async function revokeActiveAppointmentInTx(
  tx: Tx,
  params: { userId: string; revokedBy: string; reason: string },
): Promise<RevokedAppointment | null> {
  const [row] = await tx
    .update(jurisdictionAdminAppointments)
    .set({
      revokedAt: sql`now()`,
      revokedByUserId: params.revokedBy,
      revocationReason: params.reason,
    })
    .where(
      and(
        eq(jurisdictionAdminAppointments.userId, params.userId),
        isNull(jurisdictionAdminAppointments.revokedAt),
      ),
    )
    .returning({
      appointmentId: jurisdictionAdminAppointments.id,
      provinceCode: jurisdictionAdminAppointments.provinceCode,
      govtAssignmentId: jurisdictionAdminAppointments.govtAssignmentId,
      grantCreated: jurisdictionAdminAppointments.grantCreated,
    });
  return row ?? null;
}
