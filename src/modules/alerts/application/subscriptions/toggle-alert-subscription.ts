// Toggle alert subscription use-case.
//
// Pure writer — caller must already have verified the actor is admin.

import { and, eq } from "drizzle-orm";

import { alertSubscriptions, db } from "@/db";

/**
 * Toggle is_active for a subscription. Owner-only.
 */
export async function toggleAlertSubscriptionForUser(
  actorUserId: string,
  id: string,
  isActive: boolean,
): Promise<{ ok: true } | { error: string }> {
  const [existing] = await db
    .select({ id: alertSubscriptions.id, actorUserId: alertSubscriptions.actorUserId })
    .from(alertSubscriptions)
    .where(eq(alertSubscriptions.id, id))
    .limit(1);

  if (!existing) return { error: "Suscripción no encontrada" };
  if (existing.actorUserId !== actorUserId) {
    return { error: "No tenés permiso para modificar esta suscripción" };
  }

  await db
    .update(alertSubscriptions)
    .set({ isActive, updatedAt: new Date() })
    .where(and(eq(alertSubscriptions.id, id), eq(alertSubscriptions.actorUserId, actorUserId)));

  return { ok: true };
}
