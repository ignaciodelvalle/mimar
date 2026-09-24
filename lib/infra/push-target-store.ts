import "server-only";

import { db, pushTargets } from "@/db";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";

/**
 * Reads and writes for `push_targets` — the native (Expo) push destinations.
 *
 * WHY A STORE AND NOT DRIZZLE CALLS AT THE CALL SITES. Three of the four
 * operations below encode a rule that is easy to get subtly wrong and
 * impossible to see wrong from the outside: the registration upsert's conflict
 * target, the fact that revocation is an UPDATE and never a DELETE, and the
 * `revoked_at IS NULL` filter the send path depends on. Spread across a route
 * handler and a sender, those three become three places to forget. Here they
 * are one place to read.
 *
 * NOTHING IN THIS FILE CATCHES. A database failure in the push leg is the
 * caller's to swallow — `web-push.ts` wraps its whole send in one try/catch for
 * exactly that reason (ARCH-P: a blip in a best-effort second delivery leg must
 * never surface to the action that wrote the notification). A store that
 * swallowed its own errors would make that impossible to honour, because the
 * caller could no longer tell a failed write from a successful no-op.
 */

/** What the app sends when it registers or refreshes a device. */
export type PushTargetRegistration = {
  userId: string;
  /** The install identity the app minted once and keeps in expo-secure-store. */
  deviceId: string;
  expoPushToken: string;
  platform: "ios" | "android";
  appVersion?: string | null;
};

/** One active destination, as the sender needs it. */
export type ActivePushTarget = {
  id: string;
  expoPushToken: string;
};

/**
 * Register or refresh one device, keyed on `device_id`.
 *
 * THE CONFLICT TARGET IS `device_id`, NOT THE TOKEN, and that is the whole
 * design. Expo tokens rotate; conflicting on the token would insert a second row
 * on every rotation and leave the first orphaned with no install identity to
 * reconcile against. One install is one row, for the life of the install.
 *
 * `user_id` IS IN THE UPDATE SET ON PURPOSE. If a second person signs in on the
 * same phone, the row's owner flips to them and the first person stops receiving
 * pushes there. That is correct: the device's lock screen belongs to whoever is
 * signed in on it, not to whoever signed in first. Leaving `user_id` out of the
 * SET would keep delivering the first person's notifications to a phone that is
 * now somebody else's — the failure this line exists to prevent.
 *
 * `revoked_at` IS CLEARED. Re-registering is how a person turns push back on
 * after a sign-out revoked the row; without this, a device could be revoked once
 * and never speak again.
 */
export async function registerPushTarget(input: PushTargetRegistration): Promise<void> {
  await db
    .insert(pushTargets)
    .values({
      userId: input.userId,
      deviceId: input.deviceId,
      expoPushToken: input.expoPushToken,
      platform: input.platform,
      appVersion: input.appVersion ?? null,
    })
    .onConflictDoUpdate({
      target: pushTargets.deviceId,
      set: {
        userId: input.userId,
        expoPushToken: input.expoPushToken,
        platform: input.platform,
        appVersion: input.appVersion ?? null,
        revokedAt: null,
      },
    });
}

/**
 * Sign-out: stop delivering to this device.
 *
 * SCOPED BY `user_id` AS WELL AS `device_id`, which is not redundant. Without
 * it, anybody who learned a device_id could silence somebody else's phone by
 * calling the unregister endpoint with it. With it, the statement matches
 * nothing unless the caller is the row's current owner.
 *
 * An UPDATE, never a DELETE: the row keeps an auditable trail, the purge in
 * `data-lifecycle.ts` removes it after the TTL, and `erase_subject_data` removes
 * it immediately on an art. 16 request. The table has no DELETE policy at all,
 * so a client could not delete it even if this function tried.
 *
 * Returns the number of rows revoked — 0 is a legitimate answer (already
 * revoked, or never registered) and the caller must not treat it as an error.
 */
export async function revokePushTarget(userId: string, deviceId: string): Promise<number> {
  const rows = await db
    .update(pushTargets)
    .set({ revokedAt: new Date() })
    .where(and(eq(pushTargets.userId, userId), eq(pushTargets.deviceId, deviceId)))
    .returning({ id: pushTargets.id });
  return rows.length;
}

/**
 * "Cerrar sesión en todos los dispositivos": stop delivering to EVERY device
 * this person has, not just the one asking.
 *
 * WHY THIS EXISTS AT ALL, AND WHY IT IS NOT `revokePushTarget` IN A LOOP. The
 * per-device revoke above is driven by the app that holds the install id, which
 * means it can only ever reach the phone in the caller's hand. The act this one
 * serves is the opposite act: somebody whose phone was LOST OR STOLEN opens
 * miMAR on another device and asks for every session to die. Before this,
 * exactly the sessions died — and the stolen phone kept its live `push_targets`
 * row, so every urgent notification carried on lighting up a lock screen in
 * somebody else's pocket. That is the feature failing at the one moment it is
 * for.
 *
 * SOFT, LIKE EVERY OTHER REVOCATION HERE. The rows keep their trail until the
 * nightly purge, and the recovery is the ordinary one: the next sign-in on any
 * of those devices re-registers and clears `revoked_at`. A person who finds the
 * phone under the car seat signs in again and push works, without a reinstall.
 *
 * ALREADY-REVOKED ROWS ARE FILTERED OUT rather than re-stamped, so the returned
 * count answers "how many live devices did this silence" and a second call
 * answers 0 — which is the honest answer, and the one a caller can log.
 */
export async function revokeAllPushTargetsForUser(userId: string): Promise<number> {
  const rows = await db
    .update(pushTargets)
    .set({ revokedAt: new Date() })
    .where(and(eq(pushTargets.userId, userId), isNull(pushTargets.revokedAt)))
    .returning({ id: pushTargets.id });
  return rows.length;
}

/**
 * The send path's read: every device this person has that is still live.
 *
 * `revoked_at IS NULL` is the filter `push_targets_user_active_idx` is partial
 * on, so this is an index scan over the live population only.
 */
export async function activePushTargetsForUser(userId: string): Promise<ActivePushTarget[]> {
  return db
    .select({ id: pushTargets.id, expoPushToken: pushTargets.expoPushToken })
    .from(pushTargets)
    .where(and(eq(pushTargets.userId, userId), isNull(pushTargets.revokedAt)));
}

/**
 * Delivery was ACCEPTED. Same contract as the web leg's `last_used_at` bump,
 * plus the receipt id that makes the second half of the send possible.
 *
 * "ACCEPTED" AND NOT "DELIVERED", and the distinction is the whole reason the
 * second argument exists. A `status: "ok"` ticket means Expo took the message,
 * not that a phone got it — Expo has not talked to FCM or APNs yet. What
 * happened downstream is in the RECEIPT, fetched later by this id, and that is
 * where `DeviceNotRegistered` arrives in the ordinary case. Writing the id here
 * costs nothing: it rides on an UPDATE this function was already making.
 *
 * ONE ID PER DEVICE, OVERWRITTEN. Three pushes in an evening leave only the
 * third id, and that is deliberate — see migration 0223. The signal being
 * chased is persistent (an uninstalled app does not reinstall itself between
 * two sends), so the newest receipt answers the same question the older ones
 * would have, about the most recent attempt.
 *
 * `receiptId` IS OPTIONAL so that `last_used_at` keeps its old meaning for any
 * caller that has no id to offer. Passing none leaves whatever was pending
 * alone rather than clearing it: a bump is not an answer.
 */
export async function markPushTargetUsed(id: string, receiptId?: string): Promise<void> {
  await db
    .update(pushTargets)
    .set(
      receiptId === undefined
        ? { lastUsedAt: new Date() }
        : { lastUsedAt: new Date(), pendingReceiptId: receiptId, pendingReceiptAt: new Date() },
    )
    .where(eq(pushTargets.id, id));
}

/** One device whose receipt has not been read yet. */
export type PendingReceipt = {
  targetId: string;
  receiptId: string;
  /** When the id was written. `null` only for a row written before 0223. */
  pendingSince: Date | null;
};

/**
 * The reconciliation job's read: devices with a receipt still owed.
 *
 * OLDEST FIRST, which is not cosmetic. Expo keeps receipts for roughly 24 hours
 * and answers nothing for an id past that, so the oldest pending ids are the
 * ones about to become unanswerable. A job that ran out of budget after a
 * newest-first scan would lose exactly the rows it could still have learned
 * something from.
 *
 * `limit` IS THE CALLER'S, not a constant here. The job batches under a cron
 * budget and Expo caps how many ids one request may carry; both of those are
 * the caller's to know, and a number chosen here would be a third copy of a
 * limit that can move.
 */
export async function pendingPushReceipts(limit: number): Promise<PendingReceipt[]> {
  const rows = await db
    .select({
      id: pushTargets.id,
      receiptId: pushTargets.pendingReceiptId,
      pendingSince: pushTargets.pendingReceiptAt,
    })
    .from(pushTargets)
    .where(isNotNull(pushTargets.pendingReceiptId))
    .orderBy(asc(pushTargets.pendingReceiptAt))
    .limit(limit);
  // The `isNotNull` filter is what makes the narrowing true; the map is what
  // makes the TYPE say so, rather than pushing a `string | null` at the SDK.
  return rows.flatMap((row) =>
    row.receiptId === null
      ? []
      : [{ targetId: row.id, receiptId: row.receiptId, pendingSince: row.pendingSince }],
  );
}

/**
 * This receipt has been dealt with — answered, or aged out of Expo's retention.
 *
 * IT CLEARS RATHER THAN MARKING DONE, because "pending" is expressed as "the
 * column is set" (migration 0223) and a second state column would be a
 * duplicate of the same fact with nothing keeping the two in agreement.
 *
 * SCOPED BY THE RECEIPT ID AS WELL AS THE ROW, and that is not redundant. A
 * send that lands WHILE the nightly job is running writes a newer id onto the
 * same row; clearing by row alone would erase an id that has never been asked
 * about, and that message's answer — possibly the `DeviceNotRegistered` this
 * whole path exists for — would be lost with no trace. Matching the id means a
 * row that moved on is left exactly as it is.
 */
export async function clearPendingPushReceipt(targetId: string, receiptId: string): Promise<void> {
  await db
    .update(pushTargets)
    .set({ pendingReceiptId: null, pendingReceiptAt: null })
    .where(and(eq(pushTargets.id, targetId), eq(pushTargets.pendingReceiptId, receiptId)));
}

/**
 * Expo said `DeviceNotRegistered`: the app was uninstalled, or the token was
 * invalidated. Soft-revoke so the send path stops trying.
 *
 * This is the analog of the web leg's 404/410 handling, and like it, it is NOT
 * an error — it is the ordinary end of an install's life. The caller must not
 * `reportError` on this path, or every uninstall becomes a logged incident.
 *
 * Scoped by id because the sender already holds the row it just failed to
 * deliver to; no user scoping is needed or wanted here, since this runs
 * server-side on the sender's own read.
 */
export async function revokePushTargetById(id: string): Promise<void> {
  await db.update(pushTargets).set({ revokedAt: new Date() }).where(eq(pushTargets.id, id));
}
