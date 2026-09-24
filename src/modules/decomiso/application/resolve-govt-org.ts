// Internal read helper — resolves the sanitary_authority organization for a
// user. NOT a server action: this module is intentionally outside any
// "use server" file so it cannot be invoked from the client with an
// attacker-supplied userId (authz triage 2026-07-04). Callers must supply a
// session-derived userId.

import { and, asc, eq, isNull } from "drizzle-orm";

import { db, organizationMemberships, organizations } from "@/db";

/**
 * Returns the sanitary_authority organization where `userId` holds an active
 * membership. Returns null when no such org exists.
 *
 * MULTI-AUTHORITY OPERATORS (RA-8 R3). A user can legitimately hold active
 * memberships in more than one sanitary_authority. This function picks ONE, and
 * before 2026-07-31 it picked it with a bare `.limit(1)` and no ORDER BY —
 * whichever row the plan happened to emit first, which can differ between two
 * calls in the same request after an unrelated UPDATE moves a row in the heap.
 * A nondeterministic answer here is not a cosmetic bug: the pick decides which
 * `openedByOrganizationId` binds the decomiso list and both custody mutations,
 * so the same operator could see (and act on) different case sets on refresh.
 *
 * Ordering by `organizations.createdAt` makes it the OLDEST authority the user
 * belongs to — stable, explainable, and unchanged by any later write. The
 * secondary `id` key covers same-timestamp inserts.
 *
 * This is determinism, NOT authorization: which org binds no longer decides
 * what an operator may touch, because the jurisdictional fence
 * (decomiso-jurisdiction-fence.ts) applies on top of it everywhere. Serving a
 * genuinely multi-authority operator all of their orgs at once is a product
 * decision, still open, and deliberately not smuggled in here.
 */
export async function resolveGovtOrgForUser(userId: string): Promise<{
  id: string;
  displayName: string;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
} | null> {
  const [row] = await db
    .select({
      id: organizations.id,
      displayName: organizations.displayName,
      jurisdictionProvince: organizations.jurisdictionProvince,
      jurisdictionLocality: organizations.jurisdictionLocality,
    })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .where(
      and(
        eq(organizationMemberships.userId, userId),
        eq(organizations.orgType, "sanitary_authority"),
        eq(organizations.status, "active"),
        isNull(organizationMemberships.leftAt),
      ),
    )
    .orderBy(asc(organizations.createdAt), asc(organizations.id))
    .limit(1);
  return row ?? null;
}
