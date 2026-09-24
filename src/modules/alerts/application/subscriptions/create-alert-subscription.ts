// Create alert subscription use-case.
//
// Pure writer — caller must already have verified the actor is admin.

import { type AlertSubscription, alertSubscriptions, db } from "@/db";

import { type CreateAlertSubscriptionInput, CreateAlertSubscriptionSchema } from "./types";

/**
 * Create an alert subscription for a given actor user.
 * Caller must already have verified the actor is admin.
 */
export async function createAlertSubscriptionForUser(
  actorUserId: string,
  input: CreateAlertSubscriptionInput,
): Promise<AlertSubscription | { error: string }> {
  const parsed = CreateAlertSubscriptionSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  }

  const { metricKey, direction, threshold, jurisdictionProvince, jurisdictionLocality, label } =
    parsed.data;

  const [row] = await db
    .insert(alertSubscriptions)
    .values({
      actorUserId,
      metricKey,
      direction,
      threshold: String(threshold),
      jurisdictionProvince: jurisdictionProvince ?? null,
      jurisdictionLocality: jurisdictionLocality ?? null,
      label: label ?? null,
      isActive: true,
    })
    .returning();

  if (!row) return { error: "Error al crear la suscripción" };
  return row;
}
