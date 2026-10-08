// `GET /api/v1/me/notifications/unread-count` — how many notifications the
// caller has not read yet, and nothing else.
//
// WHY A DOOR OF ITS OWN (inicio-app-rediseno, PO 2026-10-07)
// ---------------------------------------------------------------------------
// The app's header now carries a bell with an unread badge, re-read every time
// "Mis mascotas" or a pet screen comes back into focus. `GET /me/notifications`
// already carries `unreadCount`, but it carries it beside a page of up to a
// hundred rows joined against `pets` plus the per-category counts — a read the
// size of the inbox, on a Samsung J7, to draw one digit. This one runs ONLY the
// aggregate: the same `fetchUnreadNotificationCount` the inbox read calls, with
// the same predicate (non-archived, unread, minus the two read-time
// reconciliations), so the bell and the inbox cannot disagree about the number.
//
// THE WHOLE INBOX, NEVER A TAB. There is no `?cat=`: the bell counts everything
// unread, which is the figure the web's masthead bell shows too.
//
// A FAILED READ HAS NO NUMBER. A client that cannot read this hides the badge;
// it never draws a "0" it did not receive (see `notificationBadgeLabel`).

export const MY_UNREAD_NOTIFICATIONS_PAYLOAD_VERSION = 1;

/**
 * THIRTY SECONDS, the inbox's own window (`MY_NOTIFICATIONS_STALE_AFTER_MS`),
 * and for its reason: this number moves whenever anybody acts on anything that
 * concerns the caller, and a stale badge reads as "nothing new".
 */
export const MY_UNREAD_NOTIFICATIONS_STALE_AFTER_MS = 30_000;

/** The unread count. */
export type MyUnreadNotificationsV1 = {
  payloadVersion: typeof MY_UNREAD_NOTIFICATIONS_PAYLOAD_VERSION;
  /** The three envelope fields §6 requires on every read. Built by `apiV1Envelope`. */
  issuedAt: string;
  staleAfter: string;
  /** Unread, non-archived rows across the whole inbox. Never negative. */
  unreadCount: number;
};

/**
 * The text a bell badge shows for a count, or `null` when it shows none.
 *
 * `null` for a count that is unknown (a failed read) AND for zero: an empty
 * badge and a badge reading "0" say different things, and only the first is
 * true when the read failed. Above nine it is "9+", the web masthead's cap
 * (`AppCitizenMasthead`), because a two-digit number does not fit the dot.
 */
export function notificationBadgeLabel(count: number | null): string | null {
  if (count === null || !Number.isFinite(count) || count <= 0) return null;
  return count > 9 ? "9+" : String(Math.floor(count));
}
