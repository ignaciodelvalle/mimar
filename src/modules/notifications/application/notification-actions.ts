// Use-case: notification-actions — mark read, archive, mark all read (strangler migration 59/61).
//
// Auth moved to the shim wrapper (app/actions/notifications.ts). Each function
// now receives the already-authenticated userId directly so authentication is
// not duplicated and the use-case stays pure.
//
// Each function enforces ownership: a notification belongs to exactly one user,
// and the WHERE clause always scopes updates to that user's rows. An id that
// belongs to somebody else and an id that belongs to nobody update the same
// number of rows — zero — which is why the caller may report both identically
// without needing to know which it was.
//
// WHAT THESE MUTATE, AND WHAT THEY DO NOT (WU-Q-1, said out loud because a
// second door now calls them). `notifications.read_at` and
// `notifications.archived_at`, and nothing else. NOTHING ON THE EVENT SPINE: a
// read receipt is a fact about a person's inbox, not about an animal, so there is
// no asiento to append and invariant #2 is untouched rather than bent. Neither
// column is a CACHE of anything either (invariant #3) — nothing derives them and
// no re-derivation could reconstruct them. They are operational state whose only
// source of truth is the tap that set them.
//
// EACH RETURNS HOW MANY ROWS IT ACTUALLY CHANGED. The web ignores it (a form
// action's return value goes nowhere), but `POST /api/v1/me/notifications`
// answers `changed`, and a client that can tell "I just cleared twelve unread"
// from "another tab already did" is a client that can correct its own badge
// without a second round trip. The predicates below are what make the number
// honest: `read_at IS NULL` on the marks, so re-marking a read row counts zero.

import { db, notifications } from "@/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

/** Both surfaces that render a notification. Revalidated after every write. */
function revalidateInboxes(): void {
  revalidatePath("/notificaciones");
  revalidatePath("/mis-mascotas");
}

/**
 * Mark one or many of the caller's notifications read.
 *
 * THE BATCH IS THE PRIMITIVE and the single-row case is an array of one. A
 * browser posts one form submission per button, so the web never sends more than
 * one; a phone tapping through a screenful would otherwise spend one HTTP round
 * trip per row against a per-user limiter. One UPDATE, one definition, two call
 * shapes — see `@dim/contract/input`'s `notification.ts`.
 *
 * `read_at IS NULL` IS IN THE PREDICATE and not only in the SET. Without it the
 * statement would rewrite `read_at` on rows that were already read, moving a
 * timestamp nobody asked to move and reporting every one of them as "changed".
 */
export async function markNotificationsRead(
  userId: string,
  notificationIds: readonly string[],
): Promise<{ changed: number }> {
  if (notificationIds.length === 0) return { changed: 0 };
  const changed = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        inArray(notifications.id, [...notificationIds]),
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id });
  revalidateInboxes();
  return { changed: changed.length };
}

/** One row, by the batch above. Kept as its own name because the web calls it. */
export async function markNotificationRead(
  userId: string,
  notificationId: string,
): Promise<{ changed: number }> {
  return markNotificationsRead(userId, [notificationId]);
}

/**
 * Take one row out of the inbox for good.
 *
 * IT ALSO MARKS IT READ, which the original did and which is right: an archived
 * row is out of the list, so leaving it unread would keep it in the unread COUNT
 * with no way to reach it. `archived_at IS NULL` in the predicate so a second
 * archive of the same row reports `changed: 0` rather than moving both stamps.
 */
export async function archiveNotification(
  userId: string,
  notificationId: string,
): Promise<{ changed: number }> {
  const now = new Date();
  const changed = await db
    .update(notifications)
    .set({ archivedAt: now, readAt: now })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.userId, userId),
        isNull(notifications.archivedAt),
      ),
    )
    .returning({ id: notifications.id });
  revalidateInboxes();
  return { changed: changed.length };
}

/**
 * Mark every unread notification read.
 *
 * NO CATEGORY PREDICATE, deliberately: the web's button clears everything unread
 * regardless of which tab is showing, and a scoped variant on the native side
 * would be a phone doing something a browser cannot.
 *
 * IT REACHES ARCHIVED ROWS TOO, as it always has. They are not in any list, so
 * this is invisible — and it is the correct direction: an archived row that is
 * somehow still unread is one the unread count would otherwise carry forever.
 */
export async function markAllNotificationsRead(userId: string): Promise<{ changed: number }> {
  const changed = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  revalidateInboxes();
  return { changed: changed.length };
}
