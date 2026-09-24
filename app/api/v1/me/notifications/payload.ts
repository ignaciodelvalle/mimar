// The inbox, as `MyNotificationsV1`.
//
// A PROJECTION AND NOT A SECOND QUERY. Every row here came out of
// `listNotificationsForUser` — the same function `/notificaciones` calls — and
// every count came out of the same two aggregates the web page uses. This file
// only decides what of that reaches a phone.
//
// THE THREE JUDGEMENT CALLS IN IT, all made server-side on purpose:
//
//   · `petLinkAvailable` — the "Ver {nombre}" denylist
//     (`lib/domain/notification-pet-link.ts`), shared with the web card. A client
//     deriving it from "do I own this pet" would rebuild the narrower, wrong
//     version that adversarial review 2026-08-08 rejected.
//   · `cta.route` — the stored `cta_url` is a WEB path, matched back through
//     `@dim/contract/links` to the native route for the same destination, or
//     `null` when the app has no screen for it. A phone must not be handed a web
//     path to push.
//   · `category` — narrowed to the six the contract names. A row whose column
//     holds something else (the column is nullable `text` with no CHECK) comes
//     across as `null`: in the list, in no tab, exactly as on the web.

import { petLinkAvailable } from "@/lib/domain/notification-pet-link";
import type { NotificationInboxRow } from "@/src/modules/notifications/application/read/list-notifications-for-user";
import {
  MY_NOTIFICATIONS_PAYLOAD_VERSION,
  MY_NOTIFICATIONS_STALE_AFTER_MS,
  type MyNotificationV1,
  type MyNotificationsV1,
  NOTIFICATION_CATEGORIES_V1,
  type NotificationCategoryCountV1,
  type NotificationCategoryV1,
  type NotificationCtaV1,
} from "@dim/contract/api";
import { type DeepLinkName, appRoutePath, matchWebPath } from "@dim/contract/links";

import { apiV1Envelope } from "@/lib/infra/api-v1";

/** The six the contract names, as a lookup. A column value outside it is `null`. */
const KNOWN_CATEGORIES: ReadonlySet<string> = new Set(NOTIFICATION_CATEGORIES_V1);

/**
 * `appRoutePath`, called with a destination name that is not known statically.
 *
 * The generic signature exists so a caller writing `appRoutePath("pet", {…})`
 * gets its placeholder names checked at compile time. Here the name comes out of
 * `matchWebPath` at runtime, so there is nothing to check and the widening is
 * what says so — the params it hands over are the ones the matched pattern
 * produced, which is exactly the set that pattern needs.
 */
const resolveAppRoute = appRoutePath as (
  name: DeepLinkName,
  params: Record<string, string>,
) => string | null;

function categoryOf(raw: string | null): NotificationCategoryV1 | null {
  if (raw === null) return null;
  return KNOWN_CATEGORIES.has(raw) ? (raw as NotificationCategoryV1) : null;
}

/**
 * The CTA, with its web path resolved to a native route where one exists.
 *
 * BOTH COLUMNS OR NEITHER. The web card renders the button only when `cta_label`
 * and `cta_url` are both set, and erasure nulls the two together
 * (`erase_subject_data`, migration 0170) — so a half-filled CTA is not a state
 * this payload can express, and a row that has been redacted comes across with no
 * CTA at all rather than with a label pointing nowhere.
 *
 * AN ABSOLUTE URL RESOLVES TO `route: null` AND KEEPS ITS LABEL. `cta_url` also
 * holds external `https://` links (the web opens those in a new tab), and
 * `matchWebPath` refuses them by construction rather than matching some other
 * origin's path against our table. The label still rides, because the words are
 * part of what the notification SAYS; the client renders them inert.
 */
function ctaOf(label: string | null, url: string | null): NotificationCtaV1 | null {
  if (label === null || url === null) return null;
  const destination = matchWebPath(url);
  if (destination === null) return { label, route: null };
  return { label, route: resolveAppRoute(destination.name, destination.params) };
}

export function buildMyNotificationV1(row: NotificationInboxRow): MyNotificationV1 {
  const { notification, pet } = row;
  return {
    id: notification.id,
    notificationType: notification.notificationType,
    // Verbatim, sentinels included. A client that recognised `[eliminado]` and
    // substituted friendlier copy would be un-redacting a row on the reader's
    // screen — see the contract's header.
    title: notification.title,
    body: notification.body,
    severity: notification.severity,
    category: categoryOf(notification.category),
    createdAt: notification.createdAt.toISOString(),
    // The instant itself is not carried: nothing renders it, and a read receipt's
    // timestamp is one more fact about a person on a wire that does not need it.
    read: notification.readAt !== null,
    pet: pet === null ? null : { publicToken: pet.publicToken, name: pet.name },
    petLinkAvailable: petLinkAvailable({
      notificationType: notification.notificationType,
      hasRelatedPet: pet !== null,
    }),
    cta: ctaOf(notification.ctaLabel, notification.ctaUrl),
  };
}

export function buildMyNotificationsV1(input: {
  rows: NotificationInboxRow[];
  /** Per-category counts across the whole inbox, from the shared aggregate. */
  countsByCategory: Readonly<Record<NotificationCategoryV1, number>>;
  /** Unread across the whole inbox — never the page's. */
  unreadCount: number;
  /** Non-archived across the whole inbox, by the list's own predicate. */
  total: number;
  now?: Date;
}): MyNotificationsV1 {
  const categories: NotificationCategoryCountV1[] = NOTIFICATION_CATEGORIES_V1.filter(
    // ABSENT RATHER THAN ZERO: the web hides an empty tab, and a client drawing a
    // zero would be rendering a tab the browser does not.
    (category) => input.countsByCategory[category] > 0,
  ).map((category) => ({ category, count: input.countsByCategory[category] }));

  return {
    ...apiV1Envelope({
      payloadVersion: MY_NOTIFICATIONS_PAYLOAD_VERSION,
      issuedAt: input.now,
      staleAfterMs: MY_NOTIFICATIONS_STALE_AFTER_MS,
    }),
    notifications: input.rows.map(buildMyNotificationV1),
    categories,
    unreadCount: input.unreadCount,
    total: input.total,
    // Derived, not assumed: a client must not have to know the server's cap to
    // tell a complete list from a capped one.
    truncated: input.rows.length < input.total,
  };
}
