// T-4.3 — Origin-org resolver for the public credential.
//
// Given a pet ID, resolves the "origin shelter" — the organization that
// currently holds the pet in shelter_custody, or the one that last
// adopted the pet out (payload.previous_owner_organization_id on the
// latest adoption_finalized event). Returns null when neither exists.
//
// Gating rule (applied by the caller, not this helper):
//   render badge ONLY when:
//     org.verified === true AND org.tier0ShowOriginOrg === true
//
// This module is server-only — imported only from RSCs / server actions.
// The page exports only its default component; this file keeps the
// resolver logic out of the page module (constraint: page.tsx must not
// export extra symbols).

import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";

import { db, organizations, ownerships, petEvents } from "@/db";

export type OriginOrg = {
  id: string;
  displayName: string;
  verified: boolean;
  tier0ShowOriginOrg: boolean;
  avatarUrl: string | null;
};

/**
 * Resolve the origin organization for a pet.
 *
 * Resolution order:
 *   1. Active `shelter_custody` ownership row (isNull endedAt).
 *   2. Latest `adoption_finalized` event → `previous_owner_organization_id`.
 *
 * Returns null when no org can be resolved (individual owner, no adoption
 * history, etc.).
 */
export async function resolveOriginOrg(petId: string): Promise<OriginOrg | null> {
  // 1. Active shelter_custody ownership.
  // isNotNull(ownerOrganizationId) guards against malformed rows where the org
  // column is null — those would resolve to null anyway but cause a redundant
  // org-lookup pass further below.
  const [activeCustody] = await db
    .select({
      orgId: ownerships.ownerOrganizationId,
    })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.petId, petId),
        eq(ownerships.role, "shelter_custody"),
        isNull(ownerships.endedAt),
        isNotNull(ownerships.ownerOrganizationId),
      ),
    )
    .limit(1);

  let orgId: string | null = activeCustody?.orgId ?? null;

  // 2. Fallback: latest adoption_finalized event
  if (!orgId) {
    const [latestAdoption] = await db
      .select({ payload: petEvents.payload })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "adoption_finalized")))
      .orderBy(desc(petEvents.occurredAt))
      .limit(1);

    if (latestAdoption) {
      const payload = latestAdoption.payload as { previous_owner_organization_id?: unknown };
      const pid = payload?.previous_owner_organization_id;
      if (typeof pid === "string" && pid.length > 0) {
        orgId = pid;
      }
    }
  }

  if (!orgId) return null;

  const [org] = await db
    .select({
      id: organizations.id,
      displayName: organizations.displayName,
      verified: organizations.verified,
      tier0ShowOriginOrg: organizations.tier0ShowOriginOrg,
      avatarUrl: organizations.avatarUrl,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  return org ?? null;
}

/**
 * Whether to show the origin-org badge on the public credential.
 * Both verified AND tier0ShowOriginOrg must be true.
 */
export function shouldShowOriginOrgBadge(org: OriginOrg | null): boolean {
  return org !== null && org.verified === true && org.tier0ShowOriginOrg === true;
}
