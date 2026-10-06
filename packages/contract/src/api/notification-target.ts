// `GET /api/v1/me/notifications/{id}/target` — where one notification leads,
// decided NOW, for the person reading it.
//
// WHY A SEPARATE READ AND NOT A FIELD ON THE INBOX
// ---------------------------------------------------------------------------
// The answer depends on state that moves after the notification was written: a
// transfer accepted, a membership ended, a custody episode closed. Resolving it
// for a hundred inbox rows on every inbox read would cost a hundred access
// checks for rows nobody taps. The tap asks, and the answer is fresh.
//
// It is also what makes a push survive a store release. A push payload carries
// `notificationId`; the app asks this endpoint at tap time, so the route comes
// from the server that knows today's rules — never from a table baked into a
// build that may be months old.
//
// NEVER A DEAD END. Every outcome names somewhere the viewer can actually go.
// When the case or the pet is gone for this viewer, the outcome is `explain`
// and `appRoute` is the app's explanation screen, which prints `reasonCopy`.

import type { NotificationTargetReason } from "../notifications/copy.ts";
import type { NotificationDestination, NotificationPendingActor } from "../notifications/kinds.ts";

export const NOTIFICATION_TARGET_PAYLOAD_VERSION = 1;

/** Short: the answer reflects access state that can change at any moment. */
export const NOTIFICATION_TARGET_STALE_AFTER_MS = 15_000;

/**
 * What the resolver landed on. `external` is a writer's link to an outside
 * site (an official information page): `webHref` / `appRoute` still name the
 * explanation, and the outside address rides in `externalUrl` — a redirect
 * never leaves the origin.
 */
export const NOTIFICATION_TARGET_OUTCOMES = [
  "case",
  "pet",
  "section",
  "explain",
  "external",
] as const;
export type NotificationTargetOutcomeV1 = (typeof NOTIFICATION_TARGET_OUTCOMES)[number];

/**
 * The in-app explanation screen, per notification. The ONE app route this
 * contract hands out that is not a match from `@dim/contract/links`; spelled
 * here so the server and the app cannot disagree about it.
 */
export function notificationExplanationAppRoute(notificationId: string): string {
  return `/aviso/${encodeURIComponent(notificationId)}`;
}

/** The web explanation page, per notification. */
export function notificationExplanationWebPath(notificationId: string): string {
  return `/notificaciones/${encodeURIComponent(notificationId)}`;
}

/** The web redirect every web CTA goes through. */
export function notificationOpenWebPath(notificationId: string): string {
  return `/notificaciones/${encodeURIComponent(notificationId)}/abrir`;
}

export type NotificationTargetV1 = {
  payloadVersion: typeof NOTIFICATION_TARGET_PAYLOAD_VERSION;
  issuedAt: string;
  staleAfter: string;
  notificationId: string;
  notificationType: string;
  outcome: NotificationTargetOutcomeV1;
  /** What the registry says to try first, for a client that wants to label the button. */
  primaryDestination: NotificationDestination;
  /**
   * The web path a browser opens. For `explain` it is the explanation page
   * itself (`/notificaciones/{id}`).
   */
  webHref: string;
  /**
   * The in-app route to push. NEVER null: a destination with no native screen
   * resolves to the explanation screen, with `webOnly: true`.
   */
  appRoute: string;
  /**
   * `true` when `appRoute` is the explanation screen standing in for a
   * destination that exists only on the web (an org or authority console). The
   * screen then offers to open `webHref` in the browser.
   */
  webOnly: boolean;
  reason: NotificationTargetReason;
  /** es-AR, built by the server. `null` when the destination opened normally. */
  reasonCopy: string | null;
  /** es-AR «who must act» sentence, or `null` when nothing is pending. */
  actorCopy: string | null;
  pendingActor: NotificationPendingActor;
  /** The outside address, only for `external` (absolute http(s), validated). */
  externalUrl: string | null;
  /** The writer's button label for that address, when it set one. */
  externalLabel: string | null;
  /** Verbatim from the row, so the explanation screen needs no second read. */
  title: string;
  body: string | null;
};
