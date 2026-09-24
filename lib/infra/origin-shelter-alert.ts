// A5 — who the "origin shelter alert" goes to, resolved ONCE.
//
// When a finder reports having someone's pet, the organization that PLACED that
// pet is notified too (PO decision 2026-08-04). The PO's mitigation for the
// privacy cost is DISCLOSURE: the titular's own profile must say this happens.
//
// Disclosure only works if it describes the same pets the notification actually
// fires for. Two copies of the predicate would drift, and the drift is
// asymmetric in the worst way — a profile that promises an alert nobody gets is
// noise, while an alert with no disclosure is exactly the surprise the PO's
// mitigation exists to prevent. So the predicate lives here and both the
// notifier (app/(public)/p/[publicToken]/encontre/action.ts) and the profile
// disclosure read it.
//
// "Origin shelter" = the organization whose `shelter_custody` ownership was
// CLOSED most recently. That closure is the handoff that produced the current
// titular (an adoption, or a return to owner), so a pet that passed through two
// shelters credits the one that placed it. Derived, never stored.
//
// NOT the same predicate as `lib/infra/origin-org.ts` (`resolveOriginOrg`),
// which powers the PUBLIC credential badge: that one prefers an ACTIVE custody
// row and falls back to an `adoption_finalized` payload, and it is additionally
// gated on the org's verification + display toggle. A badge is a courtesy; this
// is a notification. They answer different questions and must not be merged.

import { and, desc, eq, sql } from "drizzle-orm";

import { db, ownerships } from "@/db";

/**
 * The organization id of the pet's origin shelter, or `null` when the pet never
 * came out of one.
 *
 * @param petId internal pet id (not the public token).
 */
export async function resolveOriginShelterOrgId(petId: string): Promise<string | null> {
  const [originShelter] = await db
    .select({ orgId: ownerships.ownerOrganizationId })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.petId, petId),
        eq(ownerships.role, "shelter_custody"),
        sql`${ownerships.ownerOrganizationId} IS NOT NULL`,
        sql`${ownerships.endedAt} IS NOT NULL`,
      ),
    )
    .orderBy(desc(ownerships.endedAt))
    .limit(1);

  return originShelter?.orgId ?? null;
}

/**
 * Does a found-pet report on this pet alert an origin shelter?
 *
 * The question the PROFILE asks. Same answer as the notifier's, by construction.
 */
export async function petAlertsOriginShelter(petId: string): Promise<boolean> {
  return (await resolveOriginShelterOrgId(petId)) !== null;
}
