// The ONE loader of administrative authority (jurisdiction-admin design,
// "Authority module").
//
// Every writer that acts as an administrator asks here, and nowhere else:
//   - requirePlatformAdmin(exec, actor)             — platform-only acts;
//   - requireJurisdictionAdminFor(exec, actor, P)   — acts a jurisdiction
//     admin may perform inside province P (the platform admin always passes;
//     `null` means the target belongs to no province → platform only).
//
// Both are EXECUTOR-FIRST and must be called INSIDE the writer's transaction,
// with the transaction as `exec`: the authority is then read in the same
// snapshot as the rows it authorizes, so a deactivation or revocation that
// commits first is seen, and one that commits later waits or is serialized
// behind the writer — never the "checked before BEGIN" gap.
//
// The decision itself is pure (lib/domain/institutional-scope.ts,
// decideAdminAuthority / canActInProvince); this file only loads its inputs.
//
// The jurisdiction branch (design D4): for an institutional govt the
// appointment province comes from the DATABASE TWIN,
// public.jurisdiction_admin_province(uid) — one definition of "who is a live
// jurisdiction admin", shared with every trigger and policy (migration 0268).
// Before asking it, the actor's ACTIVE appointment row is locked FOR SHARE: a
// revocation (an UPDATE of that row) that has not committed yet makes this
// writer wait, and one that starts after this read waits for the writer. The
// revoke-racing-a-write gap (TOCTOU) closes on one row lock. The implied
// grant needs no lock of its own: the database refuses to revoke it while the
// appointment is active (0268, guard b), so it cannot go first.

import { eq, sql } from "drizzle-orm";
import { z } from "zod/v4";

import { type db, profiles } from "@/db";
import {
  type ActorProfile,
  type AdminAuthority,
  canActInProvince,
  decideAdminAuthority,
  isPlatformAdmin,
} from "@/lib/domain/institutional-scope";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type AuthorityExecutor = typeof db | Tx;

const uuid = z.string().uuid();

/** The actor's profile as the authority decision needs it, or null. */
async function loadAuthorityProfile(
  exec: AuthorityExecutor,
  actorUserId: string,
): Promise<ActorProfile | null> {
  // A malformed id is nobody — never a query error the caller must map.
  if (!uuid.safeParse(actorUserId).success) return null;
  const [row] = await exec
    .select({
      id: profiles.id,
      role: profiles.role,
      accountType: profiles.accountType,
      deactivatedAt: profiles.deactivatedAt,
      deletedAt: profiles.deletedAt,
    })
    .from(profiles)
    .where(eq(profiles.id, actorUserId))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    role: row.role as ActorProfile["role"],
    accountType: row.accountType as ActorProfile["accountType"],
    deactivatedAt: row.deactivatedAt,
    deletedAt: row.deletedAt,
  };
}

/**
 * The province the actor administers per the database twin, with the active
 * appointment row locked FOR SHARE for the rest of `exec`'s transaction.
 * Null when there is no live appointment (any drift fails closed, 0268 D2).
 */
async function loadAppointmentProvince(
  exec: AuthorityExecutor,
  actorUserId: string,
): Promise<string | null> {
  await exec.execute(sql`
    select id from public.jurisdiction_admin_appointments
     where user_id = ${actorUserId}::uuid and revoked_at is null
     for share`);
  const rows = (await exec.execute(
    sql`select public.jurisdiction_admin_province(${actorUserId}::uuid) as province_code`,
  )) as unknown as Array<{ province_code: string | null }>;
  return rows[0]?.province_code ?? null;
}

/** What administrative authority `actorUserId` holds, read through `exec`. */
export async function loadAdminAuthority(
  exec: AuthorityExecutor,
  actorUserId: string,
): Promise<AdminAuthority> {
  const profile = await loadAuthorityProfile(exec, actorUserId);
  if (!profile) return { kind: "none" };
  if (isPlatformAdmin(profile)) return { kind: "platform" };
  // Only an active institutional govt can be a jurisdiction admin; nobody
  // else costs the twin a query.
  if (
    profile.role !== "govt" ||
    profile.accountType !== "institutional" ||
    profile.deactivatedAt !== null ||
    profile.deletedAt !== null
  ) {
    return { kind: "none" };
  }
  return decideAdminAuthority(profile, await loadAppointmentProvince(exec, actorUserId));
}

/** True only for the active, non-erased institutional platform admin. */
export async function requirePlatformAdmin(
  exec: AuthorityExecutor,
  actorUserId: string,
): Promise<boolean> {
  const profile = await loadAuthorityProfile(exec, actorUserId);
  return profile !== null && isPlatformAdmin(profile);
}

/**
 * True when the actor may act on a target in `provinceCode`: the platform
 * admin anywhere, a jurisdiction admin only inside their own province.
 * `provinceCode` MUST be derived from the target row, never from input.
 */
export async function requireJurisdictionAdminFor(
  exec: AuthorityExecutor,
  actorUserId: string,
  provinceCode: string | null,
): Promise<boolean> {
  return canActInProvince(await loadAdminAuthority(exec, actorUserId), provinceCode);
}
