// Reads and writes for `push_subscriptions` — the browser registrations the
// Web Push leg delivers to.
//
// WHY IT IS NOT IN app/actions/push-subscriptions.ts ANY MORE
// ---------------------------------------------------------------------------
// That file is a server-action controller, and `check-action-line-budget.ts`
// holds it to being a thin one: auth guard, validate, delegate. Adding the
// liveness read pushed it past the 150-line threshold, and the fence's own
// message says what to do about that — extract the logic, do not trim comments
// until the number fits. This is that extraction; all three bodies moved, so
// the controller went back to being a controller rather than shrinking by the
// width of one function.
//
// No module under src/modules/ owns push: delivery lives in lib/infra/web-push.ts
// and this is its storage side, so it belongs on the same shelf.
//
// EVERY function here takes `userId` explicitly. None of them resolve the
// session — that is the controller's job, and keeping the boundary sharp is
// what makes "one user can never touch another user's registration" checkable
// by reading a single `where` clause.

import { and, eq, isNull } from "drizzle-orm";

import { db, pushSubscriptions } from "@/db";

export type PushSubscriptionKeys = { p256dh: string; auth: string };

/**
 * Upsert this browser's registration for the user.
 *
 * On endpoint conflict it re-keys, re-owns AND re-activates (`revokedAt: null`).
 * The re-activation is what makes a revoked row recoverable: the person clicks
 * the toggle back on and the same endpoint starts delivering again, with no
 * separate un-revoke path to remember.
 */
export async function savePushSubscription(args: {
  userId: string;
  endpoint: string;
  keys: PushSubscriptionKeys;
  userAgent: string | null;
}): Promise<void> {
  await db
    .insert(pushSubscriptions)
    .values({
      userId: args.userId,
      endpoint: args.endpoint,
      p256dh: args.keys.p256dh,
      auth: args.keys.auth,
      userAgent: args.userAgent,
    })
    .onConflictDoUpdate({
      // Same browser re-subscribing (or a new user on the same browser):
      // re-key, re-own, and re-activate the existing endpoint row.
      target: pushSubscriptions.endpoint,
      set: {
        userId: args.userId,
        p256dh: args.keys.p256dh,
        auth: args.keys.auth,
        userAgent: args.userAgent,
        revokedAt: null,
      },
    });
}

/**
 * Soft-revoke. The row stays for auditability; the send path only ever reads
 * `revoked_at IS NULL`. Scoped to (endpoint, user) so one person can never
 * revoke another's registration.
 */
export async function revokePushSubscription(args: {
  userId: string;
  endpoint: string;
  now: Date;
}): Promise<void> {
  await db
    .update(pushSubscriptions)
    .set({ revokedAt: args.now })
    .where(
      and(eq(pushSubscriptions.endpoint, args.endpoint), eq(pushSubscriptions.userId, args.userId)),
    );
}

/**
 * Does the SERVER still consider this browser's subscription live?
 *
 * WHY THE BROWSER'S ANSWER IS NOT ENOUGH. The /cuenta toggle used to render ON
 * from `pushManager.getSubscription()` plus a granted permission, and never
 * asked. But `revoked_at` has TWO writers: the person toggling off, and the
 * delivery path when the push service answers 410/404 for a dead endpoint. In
 * that second case the browser still holds its subscription object and the
 * permission is still granted — so the switch read ON forever while the server
 * had stopped sending. Someone waiting to hear that their lost pet was seen was
 * being promised, by their own settings screen, that they would be.
 *
 * `false` for an endpoint this user does not own, too: a row belonging to
 * somebody else is not their subscription, and saying "active" about it would
 * confirm it exists.
 */
export async function isPushSubscriptionActive(args: {
  userId: string;
  endpoint: string;
}): Promise<boolean> {
  const [row] = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.endpoint, args.endpoint),
        eq(pushSubscriptions.userId, args.userId),
        isNull(pushSubscriptions.revokedAt),
      ),
    )
    .limit(1);
  return row !== undefined;
}
