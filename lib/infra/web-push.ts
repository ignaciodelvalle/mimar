// Web Push (VAPID) delivery leg — owner-side push, feature-flagged.
//
// ADR 2026-07-18-native-readiness §4: the `notifications` table stays the
// source of truth; Web Push is a best-effort SECOND delivery leg attached to
// the existing transport-agnostic seam (use-cases return `NewNotification[]`,
// the action layer flushes them post-transaction). v1 pushes URGENT rows only
// (avistajes / hallazgos / custodia) — low volume, high value. When native
// arrives, APNs/FCM swaps in behind this same seam.
//
// FAIL-SOFT CONTRACT (ARCH-P, but WITH reportError — never silent):
//   Nothing in this module ever throws to the caller. A push failure must
//   never affect the action that produced the notification: the in-app
//   notification row is already durable; push is opportunistic delivery.
//
// Free-tier constraint: raw Web Push API + VAPID via the `web-push` package.
// No paid push provider, no external queue.
//
// Enablement — BOTH must hold, otherwise every function is a silent no-op:
//   - NEXT_PUBLIC_PUSH_ENABLED = "1" | "true"  (the kill switch, client+server)
//   - NEXT_PUBLIC_VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY set
//     (generate once with: npx web-push generate-vapid-keys)
// Optional: VAPID_SUBJECT (mailto: or https: contact per RFC 8292); falls back
// to NEXT_PUBLIC_SITE_URL so staging/prod work without an extra var.

import "server-only";

import webpush from "web-push";

import { db, pushSubscriptions } from "@/db";
import { sendExpoPushForNotifications } from "@/lib/infra/expo-push";
import { isPushEligible } from "@/lib/infra/push-eligibility";
import { reportError } from "@/lib/infra/report-error";
import { and, eq, isNull } from "drizzle-orm";

/** Plain-data push payload — deliberately transport-agnostic (title/body/url
 * is exactly what APNs/FCM need too, per the ADR's Decision 4). */
export type WebPushPayload = {
  title: string;
  body?: string | null;
  /** In-app destination opened by the service worker's notificationclick. */
  url?: string | null;
  /** Browser-side dedupe: two pushes with the same tag collapse into one
   * displayed notification. Callers pass the row's dedupeKey when they have
   * one, which makes retry double-sends invisible to the user. */
  tag?: string | null;
};

/** The subset of a notifications row the push seam needs. Structurally
 * compatible with NewNotification so flush sites can pass rows through. */
export type PushCandidateRow = {
  userId: string;
  severity?: "info" | "success" | "warning" | "urgent" | null;
  /** Row's notification_type; lets the filter keep pushing types that are
   * time-sensitive without being severity 'urgent' (pet_sighting). */
  notificationType?: string | null;
  title: string;
  body?: string | null;
  ctaUrl?: string | null;
  dedupeKey?: string | null;
};

function flagEnabled(): boolean {
  const flag = process.env.NEXT_PUBLIC_PUSH_ENABLED;
  return flag === "1" || flag === "true";
}

/** True when the feature flag is on AND both VAPID keys are configured. */
export function isWebPushEnabled(): boolean {
  return Boolean(
    flagEnabled() && process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY,
  );
}

function vapidSubject(): string {
  // RFC 8292: subject is a mailto: or https: URL identifying the sender.
  return (
    process.env.VAPID_SUBJECT ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    // Local-dev fallback only; staging/prod always have NEXT_PUBLIC_SITE_URL.
    "mailto:admin@localhost"
  );
}

/**
 * Send a Web Push message to every ACTIVE subscription of one user.
 *
 * Never throws. Per-subscription outcomes:
 *   - success       → last_used_at bumped
 *   - 404/410       → subscription expired/unsubscribed at the push service;
 *                     soft-revoked (revoked_at) so it is never retried
 *   - other failure → reportError, subscription left untouched (transient)
 */
export async function sendWebPush(userId: string, payload: WebPushPayload): Promise<void> {
  if (!isWebPushEnabled()) return;

  try {
    const subs = await db
      .select({
        id: pushSubscriptions.id,
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth,
      })
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.revokedAt)));

    if (subs.length === 0) return;

    const body = JSON.stringify({
      title: payload.title,
      body: payload.body ?? null,
      url: payload.url ?? null,
      tag: payload.tag ?? null,
    });
    const options = {
      vapidDetails: {
        subject: vapidSubject(),
        publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY as string,
        privateKey: process.env.VAPID_PRIVATE_KEY as string,
      },
      // Urgent notifications are time-sensitive (a found pet is being held
      // NOW): don't let push services queue them for a day.
      TTL: 60 * 60 * 4,
    };

    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
          options,
        );
        await db
          .update(pushSubscriptions)
          .set({ lastUsedAt: new Date() })
          .where(eq(pushSubscriptions.id, sub.id));
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          // The push service says this registration is gone. Soft-revoke so
          // the send path stops retrying it; the user can re-subscribe from
          // /cuenta at any time.
          await db
            .update(pushSubscriptions)
            .set({ revokedAt: new Date() })
            .where(eq(pushSubscriptions.id, sub.id));
        } else {
          reportError("web-push/send", err, { subscriptionId: sub.id, statusCode });
        }
      }
    }
  } catch (err) {
    // Includes the subscription lookup and the revoke/bump updates: a DB blip
    // in the push leg must never surface to the action (ARCH-P + reportError).
    reportError("web-push/send-all", err, { userId });
  }
}

/**
 * THE SEAM HOOK, AND IT NOW FEEDS TWO CHANNELS. Call after a successful insert
 * into `notifications` with the rows that were written. Filters to severity ===
 * 'urgent' (v1 scope: hallazgos / custodia) PLUS the 'pet_sighting' type — a
 * sighting is warning-severity in the Bandeja (taxonomy: avistaje ≠ hallazgo,
 * it must not style like "someone HAS the pet") but is still a time-sensitive
 * lost-mode signal the owner wants pushed.
 *
 * THE WEB FLAG NO LONGER RETURNS FOR THE WHOLE FUNCTION, and that move is the
 * point of this shape rather than a tidy-up. `isWebPushEnabled()` used to be an
 * early return here, which was correct while this hook had one leg. With a
 * native leg behind the same hook it would have meant that a deployment turning
 * WEB push off also silenced every PHONE — a flag named for one channel deciding
 * for another. Each leg now answers "can I deliver" for itself:
 * `NEXT_PUBLIC_PUSH_ENABLED` + VAPID for the browser, `EXPO_ACCESS_TOKEN` for
 * the device.
 *
 * One behavioural difference, stated because it is real and tiny: the filter now
 * runs even when web push is disabled. It is a pure predicate over an array that
 * is almost always length one, and the alternative is the coupling above.
 *
 * Never throws; cheap no-op when no row qualifies or neither leg is configured.
 */
export async function sendPushForNotifications(rows: PushCandidateRow[]): Promise<void> {
  // The predicate moved to `push-eligibility.ts` and is NOT inlined here any
  // more: two channels that each carry their own copy of "what is worth a lock
  // screen" drift the first time somebody widens one. The extracted function is
  // the same expression this line used to hold.
  const pushable = rows.filter(isPushEligible);
  if (pushable.length === 0) return;

  if (isWebPushEnabled()) {
    for (const row of pushable) {
      await sendWebPush(row.userId, {
        title: row.title,
        body: row.body ?? null,
        url: row.ctaUrl ?? null,
        tag: row.dedupeKey ?? null,
      });
    }
  }

  // SECOND, NOT FIRST, so the web leg's timing is exactly what it was: a slow
  // round trip to Expo must not delay a delivery path that already worked.
  // `sendExpoPushForNotifications` never throws, for the same ARCH-P reason
  // everything else on this seam does not.
  await sendExpoPushForNotifications(pushable);
}
