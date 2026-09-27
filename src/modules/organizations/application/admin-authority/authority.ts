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
// Stage: the jurisdiction branch is not wired yet. appointmentProvince is
// always null here, so only the platform admin holds authority — exactly the
// behavior of the five local isActiveAdmin copies this module replaced. The
// database twin public.jurisdiction_admin_province(uid) supplies it when
// appointments ship (with FOR SHARE on the appointment row, design D4).

import { eq } from "drizzle-orm";
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

/** What administrative authority `actorUserId` holds, read through `exec`. */
export async function loadAdminAuthority(
  exec: AuthorityExecutor,
  actorUserId: string,
): Promise<AdminAuthority> {
  const profile = await loadAuthorityProfile(exec, actorUserId);
  return decideAdminAuthority(profile, null);
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
