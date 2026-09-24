"use server";

// Push subscription lifecycle — Web Push v1 (owner-side, feature-flagged).
//
// Thin controllers for the /cuenta "Notificaciones push" card: resolve the
// session user, validate the payload, delegate. Every DB statement lives in
// lib/infra/push-subscription-store.ts — see its header for why the split
// happened and what each one guarantees.
//
// Auth: requireUserOrRedirect on all three. A subscription always belongs to
// the session user, and the store takes `userId` as an explicit argument
// precisely so that scoping is one readable `where` clause rather than an
// assumption spread across files.

import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import {
  isPushSubscriptionActive,
  revokePushSubscription,
  savePushSubscription,
} from "@/lib/infra/push-subscription-store";
import { reportError } from "@/lib/infra/report-error";
import { z } from "zod";

export type PushSubscriptionActionResult = { ok: true } | { ok: false; error: string };

// Shape of PushSubscription.toJSON() (minus expirationTime, which we ignore:
// the push service signals expiry with 410 at send time and the send path
// soft-revokes then).
const subscriptionSchema = z.object({
  // Push service endpoints are always https URLs; cap length defensively.
  endpoint: z.string().url().max(2000).startsWith("https://"),
  keys: z.object({
    p256dh: z.string().min(1).max(500),
    auth: z.string().min(1).max(500),
  }),
});

export async function savePushSubscriptionAction(input: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}): Promise<PushSubscriptionActionResult> {
  const { user } = await requireUserOrRedirect();

  const parsed = subscriptionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "La suscripción recibida no es válida." };
  }

  // Best-effort browser identification for a future device list. Truncated so
  // a forged header can never be a payload-size vector.
  const { headers } = await import("next/headers");
  const userAgent = ((await headers()).get("user-agent") ?? "").slice(0, 300) || null;

  try {
    await savePushSubscription({
      userId: user.id,
      endpoint: parsed.data.endpoint,
      keys: parsed.data.keys,
      userAgent,
    });
    return { ok: true };
  } catch (err) {
    reportError("push/subscribe", err, { userId: user.id });
    return { ok: false, error: "No pudimos activar las notificaciones. Probá de nuevo." };
  }
}

/**
 * The card's detection pass asks the SERVER whether the endpoint the browser is
 * holding is still live — it has to, because `revoked_at` has a second writer
 * the browser cannot see. The store's header spells out the failure.
 */
export async function isPushSubscriptionActiveAction(
  endpoint: string,
): Promise<{ active: boolean }> {
  const { user } = await requireUserOrRedirect();

  if (typeof endpoint !== "string" || endpoint.length === 0) return { active: false };

  try {
    return { active: await isPushSubscriptionActive({ userId: user.id, endpoint }) };
  } catch (err) {
    reportError("push/is-active", err, { userId: user.id });
    // Fail towards OFF. Claiming a subscription is live when we could not check
    // is the exact lie this action exists to stop telling.
    return { active: false };
  }
}

export async function revokePushSubscriptionAction(
  endpoint: string,
): Promise<PushSubscriptionActionResult> {
  const { user } = await requireUserOrRedirect();

  if (typeof endpoint !== "string" || endpoint.length === 0) {
    return { ok: false, error: "La suscripción recibida no es válida." };
  }

  try {
    await revokePushSubscription({ userId: user.id, endpoint, now: new Date() });
    return { ok: true };
  } catch (err) {
    reportError("push/revoke", err, { userId: user.id });
    return { ok: false, error: "No pudimos desactivar las notificaciones. Probá de nuevo." };
  }
}
