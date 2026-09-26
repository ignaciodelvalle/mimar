// E3 (localidades-por-id): the memberships of localities the INDEC import
// removed.
//
// The importer only soft-removes a catalogue row (removed_at), and a removed
// row keeps its active unit memberships: nothing closes a membership behind
// an admin's back, and the membership fence (every LIVE locality in exactly
// one municipal unit) says nothing about a row the catalogue no longer holds.
// Left alone, such a membership still widens the unit on the id path for a
// place nobody can pick any more. So they are LISTED for an admin, who closes
// each one explicitly: with a reason, in one transaction with its audit row,
// never automatically.
//
// The audit action is the editor's own `authority_unit_membership_removed`
// (no new action, no migration), with `cause: locality_removed_from_catalogue`
// so the change log tells it apart from a regional removal.

import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod/v4";

import { arLocalities, authorityUnitLocalities, authorityUnits, profiles } from "@/db";
import { type ActorProfile, canAssignGovtLocality } from "@/lib/domain/institutional-scope";
import { writeAuditLog } from "@/lib/infra/audit-log";

import type { UnitExecutor } from "./manage-units";

export type RemovedLocalityMembership = {
  localityId: string;
  localityName: string;
  departmentName: string | null;
  removedAt: Date;
  unitId: string;
  unitName: string;
  level: string;
  since: Date;
};

export type CloseRemovedError =
  | "CAPABILITY_DENIED"
  | "NOT_FOUND"
  | "NOT_A_MEMBER"
  | "LOCALITY_NOT_REMOVED"
  | `VALIDATION_ERROR: ${string}`;

/** Active memberships of removed catalogue rows in one province, oldest removal first. */
export async function listRemovedLocalityMemberships(
  exec: UnitExecutor,
  input: { provinceCode: string },
): Promise<RemovedLocalityMembership[]> {
  const rows = await exec
    .select({
      localityId: arLocalities.id,
      localityName: arLocalities.localityName,
      departmentName: arLocalities.departmentName,
      removedAt: arLocalities.removedAt,
      unitId: authorityUnits.id,
      unitName: authorityUnits.name,
      level: authorityUnitLocalities.level,
      since: authorityUnitLocalities.validFrom,
    })
    .from(authorityUnitLocalities)
    .innerJoin(arLocalities, eq(arLocalities.id, authorityUnitLocalities.localityId))
    .innerJoin(authorityUnits, eq(authorityUnits.id, authorityUnitLocalities.unitId))
    .where(
      and(
        isNull(authorityUnitLocalities.validTo),
        sql`${arLocalities.removedAt} IS NOT NULL`,
        eq(arLocalities.provinceCode, input.provinceCode),
      ),
    )
    .orderBy(arLocalities.removedAt, arLocalities.localityName);
  return rows.map((r) => ({ ...r, removedAt: r.removedAt as Date }));
}

const inputSchema = z.object({
  localityId: z.string().uuid(),
  unitId: z.string().uuid(),
  reason: z
    .string()
    .trim()
    .min(1, "Contá por qué se cierra la pertenencia.")
    .max(500, "El motivo admite hasta 500 caracteres."),
});

async function isActiveAdmin(exec: UnitExecutor, actorUserId: string): Promise<boolean> {
  const [row] = await exec
    .select({
      id: profiles.id,
      role: profiles.role,
      accountType: profiles.accountType,
      deactivatedAt: profiles.deactivatedAt,
    })
    .from(profiles)
    .where(eq(profiles.id, actorUserId))
    .limit(1);
  if (!row) return false;
  return canAssignGovtLocality({
    id: row.id,
    role: row.role as ActorProfile["role"],
    accountType: row.accountType as ActorProfile["accountType"],
    deactivatedAt: row.deactivatedAt,
  });
}

/** Close one active membership of a REMOVED locality. Admin only; reason required. */
export async function closeRemovedLocalityMembership(
  exec: UnitExecutor,
  actorUserId: string,
  input: { localityId: string; unitId: string; reason: string },
): Promise<{ ok: true } | { error: CloseRemovedError }> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.path[0] !== "reason") return { error: "NOT_FOUND" };
    return { error: `VALIDATION_ERROR: ${issue.message}` };
  }
  if (!(await isActiveAdmin(exec, actorUserId))) return { error: "CAPABILITY_DENIED" };
  const { localityId, unitId, reason } = parsed.data;

  const [locality] = await exec
    .select({ removedAt: arLocalities.removedAt })
    .from(arLocalities)
    .where(eq(arLocalities.id, localityId))
    .limit(1);
  if (!locality) return { error: "NOT_FOUND" };
  // A live locality's municipal membership only moves (the editor's rule).
  if (locality.removedAt === null) return { error: "LOCALITY_NOT_REMOVED" };

  return exec.transaction(async (tx) => {
    const closed = await tx
      .update(authorityUnitLocalities)
      .set({ validTo: sql`now()`, endedBy: actorUserId })
      .where(
        and(
          eq(authorityUnitLocalities.unitId, unitId),
          eq(authorityUnitLocalities.localityId, localityId),
          isNull(authorityUnitLocalities.validTo),
        ),
      )
      .returning({ level: authorityUnitLocalities.level });
    const level = closed[0]?.level;
    if (!level) return { error: "NOT_A_MEMBER" as const };
    await writeAuditLog(tx, {
      action: "authority_unit_membership_removed",
      actorUserId,
      payload: {
        locality_id: localityId,
        unit_id: unitId,
        level,
        reason,
        cause: "locality_removed_from_catalogue",
      },
      before: { unit_id: unitId },
      after: { unit_id: null },
    });
    return { ok: true as const };
  });
}
