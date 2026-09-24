/**
 * Owner-scoped "how many are waiting on me" counters — extracted from
 * owner-dashboard.ts on 2026-08-01 under the file-size fence.
 *
 * WHY ITS OWN FILE: a security fix added 36 lines to a file already at its
 * baseline, and the fence's own message is the rule — "shrink it or split it;
 * do not feed a file that is already too large." These five are a coherent
 * unit: each answers the same question for a different queue, each takes a
 * userId and returns a count, and none of them touches the dashboard
 * projections the rest of that file builds.
 *
 * Re-exported from owner-dashboard.ts so no consumer import had to move.
 */

import { and, count, eq, isNull, or, sql } from "drizzle-orm";

import { db, fosterProposals, ownerships, petTransfers } from "@/db";

/**
 * Count pending foster proposals for a volunteer user.
 * Used by the /cuenta/transitos hub to show a badge on the Propuestas card.
 */
export async function countPendingFosterProposals(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(fosterProposals)
    .where(and(eq(fosterProposals.volunteerUserId, userId), eq(fosterProposals.status, "pending")));
  return row?.n ?? 0;
}

/**
 * Count active foster ownerships (role = 'foster', endedAt IS NULL).
 * Used by the /cuenta/transitos hub to show a badge on the Tránsitos activos card.
 */
export async function countActiveFosterOwnerships(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.ownerUserId, userId),
        eq(ownerships.role, "foster"),
        isNull(ownerships.endedAt),
      ),
    );
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Count helpers for /mis-mascotas "Más acciones" badges
// ---------------------------------------------------------------------------

/**
 * Count the user's adoption applications in pending state.
 *
 * Mirrors the predicate in /mis-mascotas/postulaciones/page.tsx exactly:
 *   - event_type = 'adoption_application_submitted'
 *   - payload->>'applicant_user_id' = userId
 *   - no later 'adoption_application_resolved' for the same application
 *   - no 'adoption_finalized' for this pet WHERE adopter_user_id = userId
 *     (a finalization to a DIFFERENT adopter does NOT remove the application
 *     from the list, so it must not remove it from the count either)
 */
export async function countPendingApplications(userId: string): Promise<number> {
  const [row] = await db.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n
    FROM pet_events e
    WHERE e.event_type = 'adoption_application_submitted'
      AND e.payload->>'applicant_user_id' = ${userId}
      AND NOT EXISTS (
        SELECT 1 FROM pet_events r
        WHERE r.pet_id = e.pet_id
          AND r.event_type = 'adoption_application_resolved'
          AND r.payload->>'application_event_id' = e.id::text
      )
      AND NOT EXISTS (
        SELECT 1 FROM pet_events f
        WHERE f.pet_id = e.pet_id
          AND f.event_type = 'adoption_finalized'
          AND f.payload->>'adopter_user_id' = ${userId}
      )
  `);
  return Number(row?.n ?? 0);
}

/**
 * Count pending ownership transfers awaiting acceptance by this user.
 *
 * Handles both cases:
 *   1. toOwnerId is already resolved (registered user) → match by UUID.
 *   2. toOwnerId is NULL (recipient not yet registered) → match by email.
 *
 * The dual OR mirrors the inbox query in /transferencias and the guard in
 * acceptPetTransferAction / rejectPetTransferAction.
 */
/**
 * Count of pending transfers this user SENT (C.2).
 *
 * Exists because the only entry point to /transferencias was gated on the
 * INCOMING count with `hideWhenZero`, and the page has had an "Enviadas"
 * section since UX 3.1 that queries fromOwnerId. So a user who sent a transfer
 * and has no incoming ones lost the route entirely — the page kept a live,
 * pending outgoing proposal and the IA had no link to it. Someone built that
 * section and left it unreachable for exactly the user it was built for.
 */
export async function countOutgoingPendingTransfers(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(petTransfers)
    .where(and(eq(petTransfers.status, "pending"), eq(petTransfers.fromOwnerId, userId)));
  return row?.n ?? 0;
}

export async function countPendingTransfers(userId: string, email: string): Promise<number> {
  const normalizedEmail = email.toLowerCase();
  // Include the email branch only when the caller has a non-empty email
  // (defense-in-depth: phone-only / OAuth-without-email accounts must not
  // match rows with an empty toOwnerEmail).
  const recipientMatch = normalizedEmail
    ? or(
        eq(petTransfers.toOwnerId, userId),
        and(isNull(petTransfers.toOwnerId), eq(petTransfers.toOwnerEmail, normalizedEmail)),
      )
    : eq(petTransfers.toOwnerId, userId);
  const [row] = await db
    .select({ n: count() })
    .from(petTransfers)
    .where(and(eq(petTransfers.status, "pending"), recipientMatch));
  return row?.n ?? 0;
}
