// Outbox read queries (C2).
//
// The SLA-breach count must be IDENTICAL on the two surfaces that show it:
//   - the nav badge in app/admin/layout.tsx
//   - the breach banner in app/admin/outbox/page.tsx
// The banner used to derive its number from the visible page (LIMIT/keyset),
// so it sub-reported once breaches existed beyond page 1 while the badge did a
// global count(*). countOutboxBreaches() is the single source of truth: a
// global count(*) with the exact predicate `status='pending' AND
// sla_due_at < now()`.

import { and, eq, lt, sql } from "drizzle-orm";

import { db, eventNotificationOutbox } from "@/db";

/**
 * Global count of outbox rows in SLA breach: pending AND past their SLA
 * deadline. Used by BOTH the nav badge and the outbox banner so the two
 * numbers can never disagree.
 *
 * @param now Reference time (defaults to the current time; injectable for tests).
 */
export async function countOutboxBreaches(now: Date = new Date()): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(eventNotificationOutbox)
    .where(
      and(eq(eventNotificationOutbox.status, "pending"), lt(eventNotificationOutbox.slaDueAt, now)),
    );
  return row?.count ?? 0;
}
