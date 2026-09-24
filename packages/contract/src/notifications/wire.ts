// The projection for the WIRE row — `MyNotificationV1` as the five values the
// display rule reads.
//
// WHY THIS IS IN THE PACKAGE AND THE WEB'S PROJECTION IS NOT
// ---------------------------------------------------------------------------
// `ordering.ts` is generic over the row because its two callers hold different
// objects: the web holds a Drizzle row (a `Date`, a `pets.id`), the phone holds
// this payload (an ISO string, a public token). The web's projection has to live
// in the web app — it names ORM types this package may not import — but THIS one
// does not: `MyNotificationV1` is the package's own wire shape, so the package
// can say once and for all how to read it.
//
// The consequence is that the native client writes no projection at all. It calls
// `sortForDisplay(payload.notifications, wireNotificationFacts)`, which means
// there is exactly ONE hand-written projection in the whole system —
// `app/(app)/notificaciones/notification-ordering.ts`'s — and exactly one place
// for the two renderers to disagree.
// `__tests__/notification-ordering-parity.test.ts` runs both over the same
// logical notifications and asserts the orders are identical.

import type { MyNotificationV1 } from "../api/my-notifications.ts";

import type { NotificationOrderingFacts } from "./ordering.ts";

/**
 * One wire row, as the five values the rule reads.
 *
 * `relatedPetId` IS THE PET'S PUBLIC TOKEN, not `pets.id`, and this is the whole
 * subtlety of the shared rule. Grouping only ever asks whether two rows name the
 * SAME animal; both columns are unique per animal, so the buckets are identical
 * while the wire stays free of database keys. See `my-notifications.ts`.
 *
 * AN UNPARSEABLE `createdAt` BECOMES 0 rather than NaN. A NaN would make the
 * comparator return NaN and hand the sort's behaviour to the engine — every row
 * in the list, not just the bad one. Zero sorts the offending row to the bottom
 * of its severity band, which is the honest place for a notification whose date
 * nobody can read, and it keeps the failure local to that row.
 */
export function wireNotificationFacts(row: MyNotificationV1): NotificationOrderingFacts {
  const ms = Date.parse(row.createdAt);
  return {
    severity: row.severity,
    createdAtMs: Number.isNaN(ms) ? 0 : ms,
    id: row.id,
    relatedPetId: row.pet === null ? null : row.pet.publicToken,
    notificationType: row.notificationType,
  };
}
