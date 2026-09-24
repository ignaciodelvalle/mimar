// `GET /api/v1/me/notifications` — the owner's inbox, and
// `POST /api/v1/me/notifications` — the three things they can do to it.
//
// THE SAME ROWS THE WEB DRAWS, NOT A WIDER SET
// ---------------------------------------------------------------------------
// `app/(app)/notificaciones/page.tsx` is the reference and this payload is a
// projection of exactly its query: the caller's own non-archived rows, minus the
// two READ-TIME reconciliations (`lib/infra/notification-reconcile.ts`) that drop
// a lost-pet alert once the animal is home and the onboarding welcome once the
// person owns a pet. Those are not decorations — a phone that skipped them would
// show "Avistaje de Panchita · URGENTE" for a dog that has been back for a week,
// which is precisely the trust failure PO QA §2 closed on the web.
//
// THE ORDER IS NOT IN THIS FILE, AND MUST NOT BE
// ---------------------------------------------------------------------------
// The array arrives in the SQL's chronological order (created_at DESC, id DESC).
// The display order — severity first, then recency — is
// `@dim/contract/notifications`, shared with the web page, because two clients
// with two sorts is a promise nothing checks. A client renders this list through
// `sortForDisplay` + `groupForDisplay` or it is not showing the same inbox.
//
// WHAT IT CARRIES OF THE SUBJECT, AND WHAT IT DELIBERATELY DOES NOT
// ---------------------------------------------------------------------------
// NO INTERNAL IDS — no `relatedPetId`, no `relatedEventId`, no `relatedCaseId`,
// no `relatedReminderId`, no `userId`. The grouping rule keys on the subject
// ANIMAL, and `pet.publicToken` identifies one exactly as well as `pets.id` does
// (both unique, one per animal), so the bucket a row lands in is identical
// either way while the wire stays free of database keys. `MyPetsV1` made the
// same call and `__tests__/notification-ordering-parity.test.ts` is what proves
// the substitution costs nothing.
//
// `title` AND `body` RIDE VERBATIM, INCLUDING WHEN THEY ARE SENTINELS. Erasure
// (`erase_subject_data`, migration 0170) rewrites a subject's own notifications
// in place — title becomes `[eliminado]`, body becomes `[contenido eliminado a
// pedido del titular]`, and both CTA columns become NULL. This payload reads the
// columns and says nothing about them, which is the only correct behaviour: the
// redaction is the stored truth, and a client that recognised the sentinel and
// substituted friendlier copy would be un-redacting a row on the reader's screen.
//
// NO CATEGORY-WIDE `severity` ROLL-UP AND NO "urgentes" BADGE. The web's
// `fetchNotificationCategoryCounts` computes one for the /inicio dashboard; this
// surface carries counts per category and nothing else, because a second
// aggregate that only one screen reads is a query every cold start pays for.

import type { NotificationSeverity } from "../notifications/ordering.ts";

export const MY_NOTIFICATIONS_PAYLOAD_VERSION = 1;

/**
 * THIRTY SECONDS — the shortest window on this surface, and the shortest for a
 * reason the others do not have.
 *
 * Every sibling read (`/me/transfers`, `/me/caretaker-grants`, `/shares`,
 * `/lost`) takes a minute, sized against facts that move when somebody ELSE acts.
 * This one moves when anybody acts on anything: a sighting, a vaccination coming
 * due, a transfer offered, a caretaker answering. It is the screen a person opens
 * BECAUSE they expect it to have changed, and a stale inbox is the one stale
 * screen that reads as "nothing happened" rather than as "this is old".
 */
export const MY_NOTIFICATIONS_STALE_AFTER_MS = 30_000;

/**
 * The most rows one read returns.
 *
 * THE WEB'S OWN PAGE SIZE, and it is the web's because the web IMPORTS THIS
 * CONSTANT — `app/(app)/notificaciones/page.tsx` passes it straight to
 * `listNotificationsForUser`. That sentence used to name a `NOTIFICATIONS_PAGE_LIMIT`
 * literal declared over there, which is a different thing entirely: two numbers
 * that happened to be equal, under a comment claiming they could not diverge.
 *
 * WHY THE TWO HAVE TO BE ONE NUMBER: both surfaces collapse the same runs into
 * groups, and a group is only correct over the rows its reader can SEE. A phone
 * reading a smaller page would show as two singles a run of three the browser
 * folded into one — not a crash, not a diff anyone reads, just two clients
 * disagreeing about the same inbox. Same page, same grouping, one literal.
 *
 * THERE IS NO CURSOR ON THIS SURFACE and the web has one. That is a REAL
 * shortfall rather than a design: `MyNotificationsV1.truncated` says so, and the
 * screen has to tell the person where the rest is instead of showing a
 * complete-looking list that is not complete — the shape `MyPetsV1` settled on.
 */
export const MY_NOTIFICATIONS_PAGE_LIMIT = 100;

/**
 * The six tabs the web's inbox filters by, in ITS order
 * (`CATEGORY_ORDER` minus the `all` pseudo-category, which is the absence of a
 * filter rather than a value the column holds).
 *
 * `notifications.category` is nullable `text` with no CHECK, so a row can carry
 * a value that is not in this list or no value at all. Such a row is in the
 * unfiltered list and in no tab — exactly what the web does, where an
 * uncategorised row is "counted in 'all' only".
 */
export const NOTIFICATION_CATEGORIES_V1 = [
  "perdidas",
  "custody",
  "health",
  "adoption",
  "welfare",
  "admin",
] as const;

export type NotificationCategoryV1 = (typeof NOTIFICATION_CATEGORIES_V1)[number];

/** How many non-archived rows one category holds for this caller. */
export type NotificationCategoryCountV1 = {
  category: NotificationCategoryV1;
  count: number;
};

/**
 * The animal a notification is about, when there is one.
 *
 * `publicToken` AND NOT `pets.id`, and it does double duty: it is what the
 * "Ver {nombre}" affordance navigates by, and it is the grouping key — see the
 * header.
 */
export type NotificationPetV1 = {
  publicToken: string;
  name: string;
};

/**
 * The notification's own call to action, when the writer set one.
 *
 * `label` AND `route` COME AS A PAIR OR NOT AT ALL. The web renders the button
 * only when both `cta_label` and `cta_url` are present, and erasure nulls the two
 * together — so a half-filled CTA is not a state this payload can express.
 *
 * `route` IS AN IN-APP PATH, ALREADY RESOLVED, or `null`. The stored `cta_url` is
 * a WEB path (`/mis-mascotas/{token}/eventos/{id}`) written by notification
 * writers that predate the app; the server matches it against
 * `@dim/contract/links` and hands over the native route for the same destination.
 * `null` means the table names no screen for it — most of the web app, on
 * purpose — and a client MUST then render the label as inert text rather than
 * pushing the web path, which would open the app onto a blank stack.
 */
export type NotificationCtaV1 = {
  label: string;
  route: string | null;
};

/** One notification, as the caller's inbox holds it. */
export type MyNotificationV1 = {
  /** `notifications.id`. The handle every command below takes. */
  id: string;
  /** Free text — `notification_type` has no CHECK. Also the grouping key's other half. */
  notificationType: string;
  /** Verbatim, sentinels included — see the header. */
  title: string;
  body: string | null;
  severity: NotificationSeverity;
  /**
   * `null` for a row with no category, or with one this contract version does
   * not name. Both are rows that belong to no tab, which is what the web does.
   */
  category: NotificationCategoryV1 | null;
  /** ISO instant. The display sort's second key. */
  createdAt: string;
  /** `read_at IS NOT NULL`. The instant itself is not carried: nothing renders it. */
  read: boolean;
  pet: NotificationPetV1 | null;
  /**
   * Whether the "Ver {nombre}" affordance may be offered for this row.
   *
   * DECIDED SERVER-SIDE AND NOT DERIVABLE FROM `pet`. A whole family of
   * notification types exists precisely BECAUSE custody left the recipient
   * (`pet_transfer_accepted`, `foster_ended`, `adoption_reversed`, …), and for
   * those the pet page is a guaranteed dead end — the notification confirming you
   * handed your animal over offering, as its only action, a link to "No
   * encontramos esta página" (adversarial review 2026-08-08, S6-F02). The rule is
   * a denylist by TYPE (`lib/domain/notification-pet-link.ts`), shared with the
   * web card, and a client that re-derived it from "do I own this pet" would
   * reproduce the narrower, wrong version that review already rejected.
   *
   * Always `false` when `pet` is `null` — there is nothing to open.
   */
  petLinkAvailable: boolean;
  cta: NotificationCtaV1 | null;
};

/** The inbox. */
export type MyNotificationsV1 = {
  payloadVersion: typeof MY_NOTIFICATIONS_PAYLOAD_VERSION;
  /** The three envelope fields §6 requires on every read. Built by `apiV1Envelope`. */
  issuedAt: string;
  staleAfter: string;
  /**
   * The page, in the SQL's chronological order. A client sorts it for display
   * through `@dim/contract/notifications` — see the header.
   */
  notifications: MyNotificationV1[];
  /**
   * Every category that has at least one row, with its count. A category with
   * none is ABSENT rather than zero, because the web hides an empty tab and a
   * client rendering a zero would be drawing a tab the browser does not.
   */
  categories: NotificationCategoryCountV1[];
  /**
   * Unread rows across the whole VIEW, not just this page — the same scope
   * `total` below carries, and for the same reason.
   *
   * It said "the whole INBOX" until 2026-08-27 and that overclaimed: a `?cat=`
   * read counts the unread of THAT category, because `readInbox` passes the
   * filter to `fetchUnreadNotificationCount`. No client diverges — the web shows
   * exactly the same figure for the same tab — but a reader sizing a badge off
   * this sentence would have expected an inbox-wide number from a filtered call.
   *
   * The part that was never in doubt, and is the reason the field exists: it is
   * NOT the page's. The web learned that the hard way (review C.3) — counting
   * unread over the ≤100-row page understated it for anyone with more than a page
   * of them, and "notifications say fewer than there are" is a first-hand trust
   * symptom. It is an aggregate with the same predicate the list uses.
   */
  unreadCount: number;
  /** Non-archived rows across the whole inbox, by the same predicate. */
  total: number;
  /**
   * Whether the page is shorter than `total`. Derived server-side: a client must
   * not have to know the cap to tell a complete list from a capped one.
   */
  truncated: boolean;
};

/**
 * What `POST /api/v1/me/notifications` answers.
 *
 * `changed` IS HONEST HERE, unlike its namesakes on `/me/transfers` and
 * `/me/caretaker-grants` where it is always `true`. These three commands are
 * idempotent on the STATE — marking a read row read again updates nothing — so
 * the field carries a real answer, and a client can tell "I just cleared 12
 * unread" from "somebody else's tab already did".
 *
 * `unreadCount` RIDES BACK so the screen can correct its badge without a second
 * round trip. It is the same aggregate the read carries, recomputed after the
 * write, and it is the whole inbox's — never the page's.
 *
 * IT IS NULLABLE, AND THE NULL IS NOT AN ERROR. The count is re-read AFTER the
 * write has already committed, so a pooler that degrades between the two leaves
 * the endpoint holding a write that succeeded and a badge it cannot compute.
 * Answering 503 there would have a client retry a mutation that already
 * landed — for `archive`, on a row it can no longer see — so the command
 * succeeds, `changed` is true, and `unreadCount` is `null`, which a client reads
 * as "your tap worked; the badge is stale until the next refresh". A number and
 * "no number" are different facts and this type refuses to spell the second as a
 * sentinel.
 */
export type NotificationCommandAckV1 = {
  command: NotificationCommandV1;
  changed: boolean;
  unreadCount: number | null;
};

/**
 * The three commands, named here so the ack can be typed without
 * `@dim/contract/api` importing the zod entry point.
 *
 * The schema that VALIDATES one is `@dim/contract/input`'s `notification.ts`,
 * and it derives its literals from this list, so the two cannot drift.
 */
export const NOTIFICATION_COMMANDS_V1 = ["mark_read", "mark_all_read", "archive"] as const;

export type NotificationCommandV1 = (typeof NOTIFICATION_COMMANDS_V1)[number];
