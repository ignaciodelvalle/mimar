// Use-case: reactivateGovtForAuthority (jurisdiction-admin, admin-reversal)
//
// The platform admin's reversal of a deactivation: a deactivated institutional
// govt (or national observer) is switched back on, whoever deactivated it — the
// platform admin, a jurisdiction admin, or the funcionario themself.
//
// PLATFORM-ONLY, TWICE: requirePlatformAdmin here, inside the transaction, and
// the audit_log BEFORE INSERT guard, which refuses `govt_reactivated_by_admin`
// from any other actor (0270, c_platform_only). A jurisdiction admin can end a
// funcionario's access in their province; only the platform admin gives it back.
//
// What comes back is the ACCOUNT, nothing else:
//   - the localities the deactivation revoked stay revoked. A reactivated govt
//     with no active grant reads nothing (fail-closed) until the platform admin
//     assigns a place again — a deliberate second step, never a silent replay
//     of grants someone decided to end;
//   - an appointment the deactivation revoked stays revoked (re-appointing is
//     a new act, /admin/designaciones).
//
// The audit row lands WHERE the deactivation did: its province_code is copied
// from the target's latest deactivation row (`govt_deactivated_by_admin` or
// `govt_self_deactivated`), so the jurisdiction admin who deactivated sees it
// was reversed. The trigger accepts a supplied place with nothing to derive it
// from only from the platform admin (0270, guard b); a deactivated account
// holds no active grant, so there is nothing to derive.
//
// Timestamps come from the DATABASE clock (sql`now()`), never this process.
// Executor-last and optional (`exec`, default the module db) so tests can run
// it inside a transaction they roll back.

import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { auditLog, db, profiles } from "@/db";
import { MOTIVO_MIN } from "@/lib/domain/revocation-validation";
import { writeAuditLog } from "@/lib/infra/audit-log";
import { jurisdictionAdminRefusal } from "@/lib/infra/jurisdiction-admin-refusals";
import { JURISDICTION_ADMIN_REFUSAL_COPY } from "@/lib/ui/jurisdiction-admin-copy";
import { requirePlatformAdmin } from "@/src/modules/organizations/application/admin-authority/authority";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type ReactivateGovtExecutor = typeof db | Tx;

export type ReactivateGovtResult = { error: string } | { ok: true };

/** What the platform admin reads for each refusal (es-AR). */
export const REACTIVATE_GOVT_COPY = {
  REASON_TOO_SHORT: `El motivo requiere al menos ${MOTIVO_MIN} caracteres.`,
  CAPABILITY_DENIED: "Solo el administrador de la plataforma puede reactivar una cuenta.",
  NOT_INSTITUTIONAL_GOVT: "Esa cuenta no es de gobierno ni de observación nacional.",
  NOT_DEACTIVATED: "Esa cuenta ya está activa.",
  ERASED: "Esa cuenta fue eliminada y no se puede reactivar.",
  FAILED: "No se pudo reactivar la cuenta. Probá de nuevo.",
} as const;

/** Thrown inside the transaction to roll it back with copy. */
class Refused extends Error {}

export async function reactivateGovtForAuthority(
  actorUserId: string,
  input: { targetGovtUserId: string; reason: string },
  exec: ReactivateGovtExecutor = db,
): Promise<ReactivateGovtResult> {
  const reason = (input.reason ?? "").trim();
  if (reason.length < MOTIVO_MIN) return { error: REACTIVATE_GOVT_COPY.REASON_TOO_SHORT };

  try {
    await exec.transaction(async (tx) => {
      if (!(await requirePlatformAdmin(tx, actorUserId))) {
        throw new Refused(REACTIVATE_GOVT_COPY.CAPABILITY_DENIED);
      }

      const [target] = await tx
        .select({
          role: profiles.role,
          accountType: profiles.accountType,
          deactivatedAt: profiles.deactivatedAt,
          deletedAt: profiles.deletedAt,
        })
        .from(profiles)
        .where(eq(profiles.id, input.targetGovtUserId))
        .for("update")
        .limit(1);
      if (
        !target ||
        (target.role !== "govt" && target.role !== "national") ||
        target.accountType !== "institutional"
      ) {
        throw new Refused(REACTIVATE_GOVT_COPY.NOT_INSTITUTIONAL_GOVT);
      }
      if (target.deletedAt !== null) throw new Refused(REACTIVATE_GOVT_COPY.ERASED);
      if (target.deactivatedAt === null) throw new Refused(REACTIVATE_GOVT_COPY.NOT_DEACTIVATED);

      // The deactivation being reversed: who did it, and where it was filed.
      const [deactivation] = await tx
        .select({
          id: auditLog.id,
          actorUserId: auditLog.actorUserId,
          provinceCode: auditLog.provinceCode,
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.targetUserId, input.targetGovtUserId),
            inArray(auditLog.action, ["govt_deactivated_by_admin", "govt_self_deactivated"]),
          ),
        )
        .orderBy(desc(auditLog.performedAt), desc(auditLog.id))
        .limit(1);

      const updated = await tx
        .update(profiles)
        .set({ deactivatedAt: null, updatedAt: sql`now()` })
        .where(and(eq(profiles.id, input.targetGovtUserId), isNotNull(profiles.deactivatedAt)))
        .returning({ id: profiles.id });
      if (updated.length < 1) throw new Refused(REACTIVATE_GOVT_COPY.NOT_DEACTIVATED);

      await writeAuditLog(tx, {
        action: "govt_reactivated_by_admin",
        actorUserId,
        targetUserId: input.targetGovtUserId,
        provinceCode: deactivation?.provinceCode ?? null,
        payload: {
          reason,
          target_role: target.role,
          deactivation_audit_id: deactivation?.id ?? null,
          deactivated_by_user_id: deactivation?.actorUserId ?? null,
          // Grants and appointments are NOT restored (see the header).
          grants_restored: false,
        },
        before: { deactivated: true },
        after: { deactivated: false },
      });
    });
  } catch (err) {
    if (err instanceof Refused) return { error: err.message };
    const refusal = jurisdictionAdminRefusal(err);
    if (refusal) return { error: JURISDICTION_ADMIN_REFUSAL_COPY[refusal] };
    console.error("reactivateGovtForAuthority failed", err);
    return { error: REACTIVATE_GOVT_COPY.FAILED };
  }
  return { ok: true };
}
