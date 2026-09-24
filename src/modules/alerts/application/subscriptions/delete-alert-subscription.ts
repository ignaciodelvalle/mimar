// Delete alert subscription use-case.
//
// Pure writer — caller must already have verified the actor is admin.

import { and, eq } from "drizzle-orm";

import { alertSubscriptions, db } from "@/db";

/**
 * Delete an alert subscription. Ownership check: the row's actorUserId must
 * match the caller's userId OR the caller must be admin (checked by role in DB).
 *
 * For simplicity v1: caller passes their own userId; the WHERE clause enforces
 * ownership. Admin users can delete any subscription by calling this with the
 * target actorUserId (resolved from the row), but this action only deletes rows
 * where actorUserId = the provided userId.
 *
 * A stricter "admin deletes any" path is available by not filtering on
 * actorUserId — but v1 admin only deletes their own subs from the UI.
 */
export async function deleteAlertSubscriptionForUser(
  actorUserId: string,
  id: string,
): Promise<{ ok: true } | { error: string }> {
  // Verify the row exists and belongs to the caller.
  const [existing] = await db
    .select({ id: alertSubscriptions.id, actorUserId: alertSubscriptions.actorUserId })
    .from(alertSubscriptions)
    .where(eq(alertSubscriptions.id, id))
    .limit(1);

  if (!existing) return { error: "Suscripción no encontrada" };

  // Ownership check: only the owner may delete (admin writes own rows via this action).
  if (existing.actorUserId !== actorUserId) {
    return { error: "No tenés permiso para eliminar esta suscripción" };
  }

  await db
    .delete(alertSubscriptions)
    .where(and(eq(alertSubscriptions.id, id), eq(alertSubscriptions.actorUserId, actorUserId)));

  return { ok: true };
}
