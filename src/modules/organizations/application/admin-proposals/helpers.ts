// Shared helpers for admin-proposals use-cases.
//
// loadActorAuthority + canProposeInJurisdiction: shared by
// proposeVetUpgradeForUser and proposeOrgVerificationForOrg.

import { and, eq, isNull } from "drizzle-orm";

import { db, govtAssignments, profiles } from "@/db";
import { jurisdictionScopeContains } from "@/lib/domain/jurisdiction-canonical";

// ---------------------------------------------------------------------------
// loadActorAuthority
// ---------------------------------------------------------------------------

export type ActorAuthority = {
  profile: { id: string; role: "admin" | "govt" };
  jurisdictions: { province: string; locality: string }[];
};

export async function loadActorAuthority(
  actorUserId: string,
): Promise<ActorAuthority | { error: string }> {
  const [profile] = await db
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
  if (
    !profile ||
    (profile.role !== "admin" && profile.role !== "govt") ||
    profile.accountType !== "institutional"
  ) {
    return { error: "Solo govt o admin pueden proponer cambios." };
  }
  // AC1 defense-in-depth: deactivated OR erased (soft-deleted, session still
  // valid — Ley 25.326 art. 16) authorities cannot propose changes, even if the
  // inner writer is reached directly (the /gob guard already rejects them at the
  // request boundary; this mirrors that — role + accountType + deactivatedAt +
  // deletedAt — at the data layer).
  if (profile.deactivatedAt !== null || profile.deletedAt !== null) {
    return { error: "La cuenta está desactivada." };
  }
  // A govt proposer acts only inside its mandate (A10-2 / A10-7): load its
  // ACTIVE assignments so each use-case can check the target jurisdiction with
  // jurisdictionScopeContains. Mirrors admin-decisions/helpers.ts. Admin keeps
  // an empty list — the use-cases never consult it for admin (national scope).
  // A govt with no active assignment gets an empty list and is refused by the
  // scope check (fail closed).
  let jurisdictions: { province: string; locality: string }[] = [];
  if (profile.role === "govt") {
    jurisdictions = await db
      .select({
        province: govtAssignments.jurisdictionProvince,
        locality: govtAssignments.jurisdictionLocality,
      })
      .from(govtAssignments)
      .where(and(eq(govtAssignments.userId, profile.id), isNull(govtAssignments.revokedAt)));
  }
  return { profile: { id: profile.id, role: profile.role }, jurisdictions };
}

/**
 * Can this authority propose a change for a subject in (province, locality)?
 * Admin: always. Govt: only inside one of its active assignments
 * (whole-province subsumption applies). Anything else: never.
 */
export function canProposeInJurisdiction(
  auth: ActorAuthority,
  province: string | null | undefined,
  locality: string | null | undefined,
): boolean {
  if (auth.profile.role === "admin") return true;
  if (auth.profile.role !== "govt") return false;
  return jurisdictionScopeContains(auth.jurisdictions, province, locality);
}

export const OUT_OF_JURISDICTION_PROPOSAL_ERROR =
  "No podés proponer cambios fuera de tu jurisdicción.";
