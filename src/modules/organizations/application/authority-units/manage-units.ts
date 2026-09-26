// Use-cases: the /admin/localidades unit editor (localidades-por-id C4).
//
// Current unit membership decides which authority sees a locality's history
// (design addendum #2), so every change here is an act of authority:
//   1. capability — an active platform admin only (the same predicate that
//      gates govt grants);
//   2. ONE transaction — the membership rows (which carry who and when:
//      added_by / ended_by, valid_from / valid_to) and the audit_log row (which
//      carries WHY and before/after) commit together or not at all;
//   3. a municipal membership is MOVED, never removed: every live locality
//      stays in exactly one municipal unit (the membership fence). A regional
//      membership can be removed.
// A unit is never deleted and a provincial unit is never created by hand (the
// seed owns one per province; it has no explicit members).
//
// DEFERRED ON PURPOSE: this editor cannot create a SUBMUNICIPAL unit. The
// schema has the level (0253) for CABA's comunas under the ciudad unit, but no
// kind maps to it here (LEVEL_OF_KIND below: `comuna` is the municipal-level
// comuna of provinces like Santa Fe). CABA comunas as submunicipal units, with
// editor support and a test, are a separate task, not a gap in this one.
//
// Every function takes its executor first — the module `db`, or a
// transaction — so a caller can compose it and tests can roll it back. The
// "use server" shims live in app/actions/authority-units.ts.

import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod/v4";

import {
  type AuthorityUnitKind,
  type AuthorityUnitLevel,
  arLocalities,
  authorityUnitLocalities,
  authorityUnits,
  type db,
  profiles,
} from "@/db";
import { type ActorProfile, canAssignGovtLocality } from "@/lib/domain/institutional-scope";
import { writeAuditLog } from "@/lib/infra/audit-log";
import { provinceByCode } from "@/lib/reference/ar-provincias";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type UnitExecutor = typeof db | Tx;

export type UnitEditError =
  | "CAPABILITY_DENIED"
  | "NOT_FOUND"
  | "PROVINCE_MISMATCH"
  | "PROVINCIAL_UNIT_HAS_NO_MEMBERS"
  | "MUNICIPAL_MEMBERSHIP_MOVES_ONLY"
  | "NOT_A_MEMBER"
  | "ALREADY_CONFIRMED"
  | `VALIDATION_ERROR: ${string}`;

/** The kinds an admin may create. A provincia is the seed's, one per province. */
export const EDITABLE_UNIT_KINDS = [
  "region",
  "municipio",
  "ciudad",
  "comuna",
  "departamento",
] as const satisfies readonly AuthorityUnitKind[];

// No kind maps to `submunicipal` yet — see the deferral in the header.
const LEVEL_OF_KIND: Record<(typeof EDITABLE_UNIT_KINDS)[number], AuthorityUnitLevel> = {
  region: "regional",
  municipio: "municipal",
  ciudad: "municipal",
  comuna: "municipal",
  departamento: "municipal",
};

const reasonSchema = z
  .string()
  .trim()
  .min(1, "Contá por qué cambia la unidad.")
  .max(500, "El motivo admite hasta 500 caracteres.");
const nameSchema = z
  .string()
  .trim()
  .min(1, "La unidad necesita un nombre.")
  .max(200, "El nombre admite hasta 200 caracteres.");

function validationError(error: z.ZodError): { error: UnitEditError } {
  return { error: `VALIDATION_ERROR: ${error.issues[0]?.message ?? "datos inválidos"}` };
}

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

async function loadUnit(exec: UnitExecutor, unitId: string) {
  const [unit] = await exec
    .select({
      id: authorityUnits.id,
      kind: authorityUnits.kind,
      level: authorityUnits.level,
      provinceCode: authorityUnits.provinceCode,
      name: authorityUnits.name,
      status: authorityUnits.status,
    })
    .from(authorityUnits)
    .where(eq(authorityUnits.id, unitId))
    .limit(1);
  return unit ?? null;
}

const uuidSchema = z.string().uuid();

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/**
 * Place a locality in `toUnitId`, closing its active membership at that
 * unit's level (if any). A locality with no membership at that level is
 * simply added; the audit row then has `from_unit_id: null`.
 */
export async function moveLocalityToUnit(
  exec: UnitExecutor,
  actorUserId: string,
  input: { localityId: string; toUnitId: string; reason: string },
): Promise<{ ok: true; noOp: boolean } | { error: UnitEditError }> {
  const reason = reasonSchema.safeParse(input.reason);
  if (!reason.success) return validationError(reason.error);
  if (!uuidSchema.safeParse(input.localityId).success) return { error: "NOT_FOUND" };
  if (!uuidSchema.safeParse(input.toUnitId).success) return { error: "NOT_FOUND" };
  if (!(await isActiveAdmin(exec, actorUserId))) return { error: "CAPABILITY_DENIED" };

  const unit = await loadUnit(exec, input.toUnitId);
  if (!unit) return { error: "NOT_FOUND" };
  if (unit.level === "provincial") return { error: "PROVINCIAL_UNIT_HAS_NO_MEMBERS" };
  const [locality] = await exec
    .select({ id: arLocalities.id, provinceCode: arLocalities.provinceCode })
    .from(arLocalities)
    .where(and(eq(arLocalities.id, input.localityId), isNull(arLocalities.removedAt)))
    .limit(1);
  if (!locality) return { error: "NOT_FOUND" };
  if (locality.provinceCode !== unit.provinceCode) return { error: "PROVINCE_MISMATCH" };

  return exec.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: authorityUnitLocalities.id, unitId: authorityUnitLocalities.unitId })
      .from(authorityUnitLocalities)
      .where(
        and(
          eq(authorityUnitLocalities.localityId, locality.id),
          eq(authorityUnitLocalities.level, unit.level as "municipal"),
          isNull(authorityUnitLocalities.validTo),
        ),
      )
      .for("update")
      .limit(1);
    if (current?.unitId === unit.id) return { ok: true as const, noOp: true };

    if (current) {
      await tx
        .update(authorityUnitLocalities)
        .set({ validTo: sql`now()`, endedBy: actorUserId })
        .where(eq(authorityUnitLocalities.id, current.id));
    }
    await tx.insert(authorityUnitLocalities).values({
      unitId: unit.id,
      localityId: locality.id,
      level: unit.level as "municipal",
      addedBy: actorUserId,
    });
    await writeAuditLog(tx, {
      action: "authority_unit_membership_moved",
      actorUserId,
      payload: {
        locality_id: locality.id,
        from_unit_id: current?.unitId ?? null,
        to_unit_id: unit.id,
        unit_id: unit.id,
        level: unit.level,
        reason: reason.data,
      },
      before: { unit_id: current?.unitId ?? null },
      after: { unit_id: unit.id },
    });
    return { ok: true as const, noOp: false };
  });
}

/**
 * Close a regional membership. A municipal one only moves. The submunicipal
 * branch is reachable only once submunicipal units exist, which this editor
 * cannot create yet (deferred: CABA comunas — see the header).
 */
export async function removeLocalityFromUnit(
  exec: UnitExecutor,
  actorUserId: string,
  input: { localityId: string; unitId: string; reason: string },
): Promise<{ ok: true } | { error: UnitEditError }> {
  const reason = reasonSchema.safeParse(input.reason);
  if (!reason.success) return validationError(reason.error);
  if (!uuidSchema.safeParse(input.localityId).success) return { error: "NOT_FOUND" };
  if (!uuidSchema.safeParse(input.unitId).success) return { error: "NOT_FOUND" };
  if (!(await isActiveAdmin(exec, actorUserId))) return { error: "CAPABILITY_DENIED" };

  const unit = await loadUnit(exec, input.unitId);
  if (!unit) return { error: "NOT_FOUND" };
  if (unit.level === "municipal") return { error: "MUNICIPAL_MEMBERSHIP_MOVES_ONLY" };

  return exec.transaction(async (tx) => {
    const closed = await tx
      .update(authorityUnitLocalities)
      .set({ validTo: sql`now()`, endedBy: actorUserId })
      .where(
        and(
          eq(authorityUnitLocalities.unitId, unit.id),
          eq(authorityUnitLocalities.localityId, input.localityId),
          isNull(authorityUnitLocalities.validTo),
        ),
      )
      .returning({ id: authorityUnitLocalities.id });
    if (closed.length === 0) return { error: "NOT_A_MEMBER" as const };
    await writeAuditLog(tx, {
      action: "authority_unit_membership_removed",
      actorUserId,
      payload: {
        locality_id: input.localityId,
        unit_id: unit.id,
        level: unit.level,
        reason: reason.data,
      },
      before: { unit_id: unit.id },
      after: { unit_id: null },
    });
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------------------
// Unit lifecycle
// ---------------------------------------------------------------------------

export async function createAuthorityUnit(
  exec: UnitExecutor,
  actorUserId: string,
  input: { kind: string; provinceCode: string; name: string },
): Promise<{ ok: true; unitId: string } | { error: UnitEditError }> {
  const parsed = z
    .object({
      kind: z.enum(EDITABLE_UNIT_KINDS, "Elegí un tipo de unidad válido."),
      // One of the 24, not merely AR-shaped: AR-I would pass a regex and
      // leave the unit with no provincial parent (stage C verify S4).
      provinceCode: z
        .string()
        .refine((code) => provinceByCode(code)?.code === code, "Elegí una provincia."),
      name: nameSchema,
    })
    .safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  if (!(await isActiveAdmin(exec, actorUserId))) return { error: "CAPABILITY_DENIED" };

  const { kind, provinceCode, name } = parsed.data;
  return exec.transaction(async (tx) => {
    const [provincia] = await tx
      .select({ id: authorityUnits.id })
      .from(authorityUnits)
      .where(
        and(eq(authorityUnits.provinceCode, provinceCode), eq(authorityUnits.kind, "provincia")),
      )
      .limit(1);
    const [unit] = await tx
      .insert(authorityUnits)
      .values({
        kind,
        level: LEVEL_OF_KIND[kind],
        provinceCode,
        name,
        parentUnitId: provincia?.id ?? null,
      })
      .returning({ id: authorityUnits.id });
    await writeAuditLog(tx, {
      action: "authority_unit_created",
      actorUserId,
      payload: { unit_id: unit.id, kind, level: LEVEL_OF_KIND[kind], province_code: provinceCode },
      before: null,
      after: { name, kind, status: "draft" },
    });
    return { ok: true as const, unitId: unit.id };
  });
}

export async function renameAuthorityUnit(
  exec: UnitExecutor,
  actorUserId: string,
  input: { unitId: string; name: string },
): Promise<{ ok: true } | { error: UnitEditError }> {
  const name = nameSchema.safeParse(input.name);
  if (!name.success) return validationError(name.error);
  if (!uuidSchema.safeParse(input.unitId).success) return { error: "NOT_FOUND" };
  if (!(await isActiveAdmin(exec, actorUserId))) return { error: "CAPABILITY_DENIED" };
  const unit = await loadUnit(exec, input.unitId);
  if (!unit) return { error: "NOT_FOUND" };
  if (unit.name === name.data) return { ok: true };

  await exec.transaction(async (tx) => {
    await tx.update(authorityUnits).set({ name: name.data }).where(eq(authorityUnits.id, unit.id));
    await writeAuditLog(tx, {
      action: "authority_unit_renamed",
      actorUserId,
      payload: { unit_id: unit.id },
      before: { name: unit.name },
      after: { name: name.data },
    });
  });
  return { ok: true };
}

/** A draft unit becomes confirmed: an admin checked it with the authority. */
export async function confirmAuthorityUnit(
  exec: UnitExecutor,
  actorUserId: string,
  input: { unitId: string },
): Promise<{ ok: true } | { error: UnitEditError }> {
  if (!uuidSchema.safeParse(input.unitId).success) return { error: "NOT_FOUND" };
  if (!(await isActiveAdmin(exec, actorUserId))) return { error: "CAPABILITY_DENIED" };
  const unit = await loadUnit(exec, input.unitId);
  if (!unit) return { error: "NOT_FOUND" };
  if (unit.status === "confirmed") return { error: "ALREADY_CONFIRMED" };

  await exec.transaction(async (tx) => {
    await tx
      .update(authorityUnits)
      .set({ status: "confirmed", confirmedBy: actorUserId, confirmedAt: sql`now()` })
      .where(eq(authorityUnits.id, unit.id));
    await writeAuditLog(tx, {
      action: "authority_unit_confirmed",
      actorUserId,
      payload: { unit_id: unit.id },
      before: { status: "draft" },
      after: { status: "confirmed" },
    });
  });
  return { ok: true };
}
