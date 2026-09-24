// Use-case: which notifications are in this person's inbox, and in what order.
//
// ONE DOOR, TWO RENDERERS
// ---------------------------------------------------------------------------
// This query used to live inline in `app/(app)/notificaciones/page.tsx`, which
// was right while a browser was the only thing that could open an inbox.
// `GET /api/v1/me/notifications` is the second, and a route handler with its own
// copy of the predicate is how the native list eventually shows a row the web
// list does not — the exact reason `listOwnerPets` moved out of
// `/mis-mascotas/page.tsx` (see that file's header).
//
// WHAT "IN THE INBOX" ACTUALLY MEANS, in one place
// ---------------------------------------------------------------------------
// Four clauses, and only the first is obvious:
//
//   1. the caller's own rows, not archived;
//   2. MINUS lost-active alerts whose subject pet is no longer lost — a sighting
//      report is "act now, your animal is out there", and it is a lie the moment
//      the animal is home (PO QA §2);
//   3. MINUS the onboarding welcome once the person actually owns a pet;
//   4. and, optionally, one category.
//
// (2) and (3) are READ-TIME reconciliations rather than writes, because events
// and their derived notifications are append-only (invariant #2) — nothing is
// mutated to make a stale row disappear. Both live in
// `lib/infra/notification-reconcile.ts`, which expresses each rule twice (a pure
// predicate and a SQL fragment) from one type list so the two cannot drift.
//
// THE ORDER IS THE CURSOR'S, NOT THE DISPLAY'S. Rows come back
// `created_at DESC, id DESC` — chronological — because that is what the keyset
// cursor is derived from. The severity-first order the reader sees is applied on
// top of the page by `@dim/contract/notifications`, and it MUST NOT be applied
// here: reordering the page before the caller takes its last row would hand the
// next page a cursor from the middle of this one.

import { db, notifications, pets } from "@/db";
import type { Notification, Pet } from "@/db";
import {
  excludeResolvedLostEpisodeSql,
  excludeStaleWelcomeSql,
} from "@/lib/infra/notification-reconcile";
import { keysetWhere } from "@/lib/utils/keyset-pagination";
import { and, desc, eq, isNull } from "drizzle-orm";

export type NotificationInboxRow = { notification: Notification; pet: Pet | null };

export type ListNotificationsArgs = {
  userId: string;
  /** One category tab, or `null`/absent for the unfiltered inbox. */
  category?: string | null;
  /** How many rows to RENDER. One more is fetched, to detect a next page. */
  limit: number;
  /** A decoded keyset cursor, or `null` for the first page. */
  cursor?: { ts: string; id: string } | null;
};

export type ListNotificationsResult = {
  /** At most `limit` rows, in `created_at DESC, id DESC` order. */
  rows: NotificationInboxRow[];
  /** Whether a further page exists behind the last row. */
  hasMore: boolean;
};

/**
 * One page of a person's inbox.
 *
 * FETCHES `limit + 1` AND RETURNS `limit`. That is how `hasMore` is answered
 * without a second COUNT: a caller must not have to run an aggregate to learn
 * whether there is a next page, and the extra row costs one index entry.
 */
export async function listNotificationsForUser(
  args: ListNotificationsArgs,
): Promise<ListNotificationsResult> {
  const clauses = [
    eq(notifications.userId, args.userId),
    isNull(notifications.archivedAt),
    args.category ? eq(notifications.category, args.category) : undefined,
    excludeResolvedLostEpisodeSql,
    excludeStaleWelcomeSql,
    keysetWhere(notifications.createdAt, notifications.id, args.cursor ?? null),
  ].filter(Boolean);

  const raw = await db
    .select({ notification: notifications, pet: pets })
    .from(notifications)
    .leftJoin(pets, eq(notifications.relatedPetId, pets.id))
    .where(and(...(clauses as Parameters<typeof and>)))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(args.limit + 1);

  const hasMore = raw.length > args.limit;
  return { rows: hasMore ? raw.slice(0, args.limit) : raw, hasMore };
}
