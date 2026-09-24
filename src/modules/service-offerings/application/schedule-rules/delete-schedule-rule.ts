// delete-schedule-rule.ts — schedule rule soft-delete writer (strangler 24/61).
// Moved verbatim from app/actions/schedule-rules.ts.

import { eq } from "drizzle-orm";

import { db, serviceOfferings, serviceScheduleRules } from "@/db";

import type { ScheduleRuleResult } from "./types";

// Soft-delete: sets status='archived'. Hard delete is forbidden because
// materialized time_slots carry a nullable FK back to the rule via rule_id.
export async function deleteScheduleRuleForOrg(
  actorUserId: string,
  ruleId: string,
  orgId: string,
): Promise<ScheduleRuleResult> {
  const [rule] = await db
    .select({
      id: serviceScheduleRules.id,
      serviceOfferingId: serviceScheduleRules.serviceOfferingId,
    })
    .from(serviceScheduleRules)
    .where(eq(serviceScheduleRules.id, ruleId))
    .limit(1);

  if (!rule) return { error: "Regla no encontrada." };

  const [offering] = await db
    .select({ organizationId: serviceOfferings.organizationId })
    .from(serviceOfferings)
    .where(eq(serviceOfferings.id, rule.serviceOfferingId))
    .limit(1);

  if (!offering || offering.organizationId !== orgId) {
    return { error: "No tenés permiso para eliminar esta regla." };
  }

  try {
    await db
      .update(serviceScheduleRules)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(serviceScheduleRules.id, ruleId));
  } catch (err) {
    return {
      error: `No se pudo eliminar la regla: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  return { ok: true };
}
