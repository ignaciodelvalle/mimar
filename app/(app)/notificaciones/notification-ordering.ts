// Notification list ordering + grouping — the WEB's adapter over the shared rule.
//
// THE RULE ITSELF IS NO LONGER HERE. It moved to `@dim/contract/notifications`
// in WU-Q-1, when the native inbox landed and this file's logic acquired a
// second renderer. What stays is the projection: how a Drizzle row answers the
// five questions the rule asks, and nothing else.
//
// NOTHING ABOUT THIS SURFACE'S BEHAVIOUR CHANGED IN THAT MOVE, and the evidence
// is that `./notification-ordering.test.ts` was not edited: the same cases, the
// same expectations, now running through the delegation. A rule that had been
// retyped rather than moved would have needed the test adjusted, which is
// exactly the review signal a copy-paste hides.
//
// THE EXPORTS KEEP THEIR NAMES AND THEIR SHAPES on purpose. `page.tsx` and
// `lib/infra/notify-owners-of-clinical-event.test.ts` both import from here, and
// renaming a function in the same change that moves its body makes the diff
// unreadable at precisely the moment it needs to be readable.
//
// Both are non-mutating. The caller keeps its SQL-ordered `rows` intact because
// the keyset cursor is derived from the SQL order's last row, NOT from the
// display order — reordering in place would corrupt "Ver más antiguos".

import type { Notification, Pet } from "@/db";
import {
  type NotificationGroup,
  type NotificationOrderingFacts,
  groupForDisplay,
  severityRank as sharedSeverityRank,
  sortForDisplay,
} from "@dim/contract/notifications";

export type NotificationRow = { notification: Notification; pet: Pet | null };

/**
 * The web's projection: one Drizzle row, as the five values the rule reads.
 *
 * `relatedPetId` GOES ACROSS AS THE DATABASE ID HERE, while the native adapter
 * substitutes the pet's public token. The two are different strings and produce
 * IDENTICAL buckets, because grouping only ever asks whether two rows name the
 * same animal and both columns are unique per animal.
 * `__tests__/notification-ordering-parity.test.ts` is what holds that claim up.
 */
function facts(row: NotificationRow): NotificationOrderingFacts {
  return {
    severity: row.notification.severity,
    createdAtMs: row.notification.createdAt.getTime(),
    id: row.notification.id,
    relatedPetId: row.notification.relatedPetId,
    notificationType: row.notification.notificationType,
  };
}

/** Where a severity sits in the inbox. Lower is higher up. */
export function severityRank(severity: Notification["severity"]): number {
  return sharedSeverityRank(severity);
}

/**
 * Order a page of rows for display: highest severity first, then most recent,
 * then id descending as a stable tiebreak (mirrors the SQL keyset order's
 * secondary sort). Returns a NEW array — the input is never mutated, so the
 * caller's chronologically ordered page stays valid for keyset pagination.
 */
export function sortNotificationsForDisplay(rows: NotificationRow[]): NotificationRow[] {
  return sortForDisplay(rows, facts);
}

export type Group = NotificationGroup<NotificationRow>;

/**
 * Collapse runs of the same (relatedPetId, notificationType) into one group once
 * there are at least three of them. Adjacency-independent: rows are bucketed by
 * key wherever they appear, so a prior severity sort does not fragment a group —
 * the group leader is simply the first instance in the incoming order (i.e. the
 * highest-priority one after sortNotificationsForDisplay).
 */
export function groupNotifications(rows: NotificationRow[]): Group[] {
  return groupForDisplay(rows, facts);
}
