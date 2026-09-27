// Use-cases: confirm a govt user's grants onto an authority unit
// (localidades-por-id D2 — the partial-grant confirm flow).
//
// This is the ONE writer of govt_assignments.authority_unit_id (fenced by
// __tests__/authority-unit-id-writers.test.ts). Setting it moves a grant from
// its (province, locality) name pair to the unit's membership, so it is an
// act of authority, made by a person:
//
//   - which grants move: the user's ACTIVE legacy grants whose recorded
//     catalogue row (govt_assignments.locality_id, 0246) is an active member
//     of the unit. A grant that recorded no row is NEVER mapped by its name —
//     a name two partidos share would pick one (P1). It stays on the name
//     path until someone records its row.
//   - a provincial unit takes the user's WHOLE-PROVINCE grant of that
//     province (the '' sentinel, or CABA's INDEC whole-city entry). A
//     whole-CABA grant therefore maps to the provincia AR-C unit — the one
//     that also sees unresolved places — never to the ciudad unit (stage C
//     verify follow-up, orchestrator decision).
//   - only a CONFIRMED unit takes grants: a draft is the seed's proposal and
//     governs nothing (stage D review W1; govt_scope enforces it too, 0260).
//   - no silent widening (spec "Partial grants never auto-widen"): when the
//     unit governs localities the user's grants do not, the admin must name
//     every one of them (`acceptAdded`, the exact set). Until then the grants
//     stay as they are — 8 of 9 stays 8 of 9.
//
// WHO (jurisdiction-admin Phase 4): the platform admin, or the jurisdiction
// admin of the unit's province — and then only for a funcionario whose active
// grants all lie in that province, who is not the actor and not another
// appointee. Taking grants back off a unit (unconfirmGrantUnit) is the
// platform admin's alone.
//
// Membership rows + the audit row (who, why, before/after) commit together.
// Executor-first, so tests roll back.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod/v4";

import { authorityUnits, type db, govtAssignments } from "@/db";
import { isWholeProvinceLocality } from "@/lib/domain/jurisdiction-canonical";
import { writeAuditLog } from "@/lib/infra/audit-log";
import { provinceByCode } from "@/lib/reference/ar-provincias";
import {
  hasAdminAuthority,
  requireJurisdictionAdminFor,
  requirePlatformAdmin,
} from "@/src/modules/organizations/application/admin-authority/authority";
import {
  govtTargetProvince,
  singleProvince,
} from "@/src/modules/organizations/application/admin-authority/target-province";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type GrantUnitExecutor = typeof db | Tx;

export type GrantUnitError =
  | "CAPABILITY_DENIED"
  | "OUT_OF_PROVINCE"
  | "TARGET_OUT_OF_PROVINCE"
  | "SELF_ACTION"
  | "NOT_ON_UNIT"
  | "NOT_FOUND"
  | "NO_GRANTS"
  | "WHOLE_PROVINCE_GRANT"
  | "PARTIAL_GRANT"
  | "UNIT_NOT_CONFIRMED"
  | `VALIDATION_ERROR: ${string}`;

export type GrantUnitPlan = {
  unit: { id: string; kind: string; name: string; provinceCode: string; status: string };
  /** The grants that would move onto the unit. */
  grants: Array<{ assignmentId: string; locality: string }>;
  /** Localities the unit governs that none of those grants holds. */
  added: Array<{ localityId: string; name: string }>;
};

const uuid = z.string().uuid();

/** What confirming `userId`'s grants onto `unitId` would do. Reads only. */
export async function planGrantUnit(
  exec: GrantUnitExecutor,
  input: { userId: string; unitId: string },
): Promise<GrantUnitPlan | { error: GrantUnitError }> {
  if (!uuid.safeParse(input.userId).success || !uuid.safeParse(input.unitId).success) {
    return { error: "NOT_FOUND" };
  }
  const [unit] = await exec
    .select({
      id: authorityUnits.id,
      kind: authorityUnits.kind,
      name: authorityUnits.name,
      provinceCode: authorityUnits.provinceCode,
      status: authorityUnits.status,
    })
    .from(authorityUnits)
    .where(eq(authorityUnits.id, input.unitId))
    .limit(1);
  const province = unit ? provinceByCode(unit.provinceCode) : null;
  if (!unit || !province) return { error: "NOT_FOUND" };
  // A draft unit is the seed's PROPOSAL: it governs nothing (govt_scope,
  // 0260), so no grant moves onto it until an admin confirmed it with the
  // authority (stage D review W1).
  if (unit.status !== "confirmed") return { error: "UNIT_NOT_CONFIRMED" };

  const legacy = await exec
    .select({
      assignmentId: govtAssignments.id,
      locality: govtAssignments.jurisdictionLocality,
      localityId: govtAssignments.localityId,
    })
    .from(govtAssignments)
    .where(
      and(
        eq(govtAssignments.userId, input.userId),
        eq(govtAssignments.jurisdictionProvince, province.name),
        isNull(govtAssignments.revokedAt),
        isNull(govtAssignments.authorityUnitId),
      ),
    );
  const whole = legacy.filter((g) => isWholeProvinceLocality(province.name, g.locality));

  if (unit.kind === "provincia") {
    if (whole.length === 0) return { error: "NO_GRANTS" };
    return {
      unit,
      grants: whole.map((g) => ({ assignmentId: g.assignmentId, locality: g.locality })),
      added: [],
    };
  }
  // A whole-province grant belongs on the provincial unit, never on a part
  // of the province (it would narrow, and for CABA lose unresolved places).
  if (whole.length > 0) return { error: "WHOLE_PROVINCE_GRANT" };

  const members = (await exec.execute(sql`
    select l.id::text as "localityId", l.locality_name as name
      from public.authority_unit_localities m
      join public.ar_localities l on l.id = m.locality_id
     where m.unit_id = ${unit.id}::uuid and m.valid_to is null
     order by l.locality_name, l.id
  `)) as unknown as Array<{ localityId: string; name: string }>;
  const memberIds = new Set(members.map((m) => m.localityId));
  const moving = legacy.filter((g) => g.localityId !== null && memberIds.has(g.localityId));
  if (moving.length === 0) return { error: "NO_GRANTS" };
  const held = new Set(moving.map((g) => g.localityId));
  return {
    unit,
    grants: moving.map((g) => ({ assignmentId: g.assignmentId, locality: g.locality })),
    added: members.filter((m) => !held.has(m.localityId)),
  };
}

export type GrantCandidate = {
  userId: string;
  displayName: string;
} & Pick<GrantUnitPlan, "grants" | "added">;

/**
 * Every active govt holder whose legacy grants would move onto `unitId`, with
 * the plan for each — what the unit's page shows before anyone confirms.
 */
export async function listGrantCandidates(
  exec: GrantUnitExecutor,
  unitId: string,
): Promise<GrantCandidate[]> {
  if (!uuid.safeParse(unitId).success) return [];
  const holders = (await exec.execute(sql`
    select distinct g.user_id::text as "userId", p.display_name as "displayName"
      from public.govt_assignments g
      join public.profiles p on p.id = g.user_id
      join public.authority_units u on u.id = ${unitId}::uuid
     where g.revoked_at is null
       and g.authority_unit_id is null
       and p.role = 'govt' and p.deactivated_at is null and p.deleted_at is null
       and g.jurisdiction_province = public.ar_province_name(u.province_code)
       and (
         (u.kind = 'provincia')
         or g.locality_id in (
           select m.locality_id from public.authority_unit_localities m
            where m.unit_id = u.id and m.valid_to is null)
       )
     order by 2, 1
  `)) as unknown as Array<{ userId: string; displayName: string }>;
  const out: GrantCandidate[] = [];
  for (const h of holders) {
    const plan = await planGrantUnit(exec, { userId: h.userId, unitId });
    if ("error" in plan) continue;
    out.push({ ...h, grants: plan.grants, added: plan.added });
  }
  return out;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

const reasonSchema = z
  .string()
  .trim()
  .min(1, "Contá por qué la concesión pasa a la unidad.")
  .max(500, "El motivo admite hasta 500 caracteres.");

/**
 * Why a delegated confirmation is refused, or null when the actor may make it
 * (always null for the platform admin). A unit that does not exist is left to
 * the plan, which answers NOT_FOUND.
 */
async function delegatedGrantRefusal(
  tx: GrantUnitExecutor,
  actorUserId: string,
  input: { userId: string; unitId: string },
): Promise<"OUT_OF_PROVINCE" | "TARGET_OUT_OF_PROVINCE" | "SELF_ACTION" | null> {
  if (!uuid.safeParse(input.userId).success || !uuid.safeParse(input.unitId).success) return null;
  const [unit] = await tx
    .select({ provinceCode: authorityUnits.provinceCode })
    .from(authorityUnits)
    .where(eq(authorityUnits.id, input.unitId))
    .limit(1);
  if (!unit) return null;
  if (!(await requireJurisdictionAdminFor(tx, actorUserId, unit.provinceCode))) {
    return "OUT_OF_PROVINCE";
  }
  if (await requirePlatformAdmin(tx, actorUserId)) return null;
  if (input.userId === actorUserId) return "SELF_ACTION";
  const target = await govtTargetProvince(tx, input.userId);
  if (
    target.isAppointee ||
    !(await requireJurisdictionAdminFor(tx, actorUserId, singleProvince(target)))
  ) {
    return "TARGET_OUT_OF_PROVINCE";
  }
  return null;
}

/**
 * Take `userId`'s grants OFF `unitId` (jurisdiction-admin, admin reversal):
 * authority_unit_id back to NULL, so each grant answers by its recorded
 * (province, locality) again. PLATFORM ADMIN ONLY — the undo of a delegated
 * confirmation is never itself delegated. Lives here because this file is the
 * one writer of govt_assignments.authority_unit_id.
 */
export async function unconfirmGrantUnit(
  exec: GrantUnitExecutor,
  actorUserId: string,
  input: { userId: string; unitId: string; reason: string },
): Promise<{ ok: true; assignmentIds: string[] } | { error: GrantUnitError }> {
  return exec.transaction(async (tx) => {
    if (!(await requirePlatformAdmin(tx, actorUserId))) {
      return { error: "CAPABILITY_DENIED" as const };
    }
    const reason = reasonSchema.safeParse(input.reason);
    if (!reason.success) {
      return {
        error: `VALIDATION_ERROR: ${reason.error.issues[0]?.message ?? "datos inválidos"}` as const,
      };
    }
    if (!uuid.safeParse(input.userId).success || !uuid.safeParse(input.unitId).success) {
      return { error: "NOT_FOUND" as const };
    }
    const moved = await tx
      .update(govtAssignments)
      .set({ authorityUnitId: null })
      .where(
        and(
          eq(govtAssignments.userId, input.userId),
          eq(govtAssignments.authorityUnitId, input.unitId),
          isNull(govtAssignments.revokedAt),
        ),
      )
      .returning({ id: govtAssignments.id });
    if (moved.length === 0) return { error: "NOT_ON_UNIT" as const };
    const assignmentIds = moved.map((m) => m.id).sort();
    await writeAuditLog(tx, {
      action: "govt_assignment_unit_unconfirmed",
      actorUserId,
      targetUserId: input.userId,
      payload: { unit_id: input.unitId, assignment_ids: assignmentIds, reason: reason.data },
      before: { authority_unit_id: input.unitId },
      after: { authority_unit_id: null },
    });
    return { ok: true as const, assignmentIds };
  });
}

/**
 * Move `userId`'s grants onto `unitId`. `acceptAdded` must list EXACTLY the
 * localities the unit adds to them (the plan's `added`); anything else is
 * PARTIAL_GRANT and nothing changes.
 */
export async function confirmGrantUnit(
  exec: GrantUnitExecutor,
  actorUserId: string,
  input: { userId: string; unitId: string; reason: string; acceptAdded: readonly string[] },
): Promise<
  { ok: true; assignmentIds: string[] } | { error: GrantUnitError; added?: GrantUnitPlan["added"] }
> {
  // The authority, the plan and the move are read and written in ONE
  // transaction: a deactivation of the actor, or a concurrent change to the
  // grants, that commits first is seen here instead of after the check.
  return exec.transaction(async (tx) => {
    if (!(await hasAdminAuthority(tx, actorUserId))) {
      return { error: "CAPABILITY_DENIED" as const };
    }
    const reason = reasonSchema.safeParse(input.reason);
    if (!reason.success) {
      return {
        error: `VALIDATION_ERROR: ${reason.error.issues[0]?.message ?? "datos inválidos"}` as const,
      };
    }
    // jurisdiction-admin Phase 4. The unit's province is the place of the
    // act; the funcionario whose grants move must lie wholly inside it too
    // (single(P)), must not be the actor, and must not be another appointee.
    // The platform admin passes every one of these as before.
    const refusal = await delegatedGrantRefusal(tx, actorUserId, input);
    if (refusal) return { error: refusal };
    const plan = await planGrantUnit(tx, input);
    if ("error" in plan) return plan;
    const added = plan.added.map((a) => a.localityId);
    if (!sameSet(added, input.acceptAdded)) {
      return { error: "PARTIAL_GRANT" as const, added: plan.added };
    }

    const assignmentIds = plan.grants.map((g) => g.assignmentId).sort();
    await tx
      .update(govtAssignments)
      .set({ authorityUnitId: plan.unit.id })
      .where(
        and(inArray(govtAssignments.id, assignmentIds), isNull(govtAssignments.authorityUnitId)),
      );
    await writeAuditLog(tx, {
      action: "govt_assignment_unit_confirmed",
      actorUserId,
      targetUserId: input.userId,
      payload: {
        unit_id: plan.unit.id,
        assignment_ids: assignmentIds,
        added_locality_ids: [...added].sort(),
        reason: reason.data,
      },
      before: { authority_unit_id: null },
      after: { authority_unit_id: plan.unit.id },
    });
    return { ok: true as const, assignmentIds };
  });
}
