// update-schedule-rule.ts — schedule rule update writer (strangler 24/61).
// Moved verbatim from app/actions/schedule-rules.ts.

import { eq } from "drizzle-orm";

import { db, serviceOfferings, serviceScheduleRules } from "@/db";
import { UpdateScheduleRuleInput } from "@/lib/reference/scheduling-schemas";

import type { ScheduleRuleResult } from "./types";

export async function updateScheduleRuleForOrg(
  actorUserId: string,
  ruleId: string,
  orgId: string,
  input: {
    daysOfWeek?: number[];
    startTimeLocal?: string;
    endTimeLocal?: string;
    effectiveFrom?: string;
    effectiveUntil?: string | null;
  },
): Promise<ScheduleRuleResult> {
  const parsed = UpdateScheduleRuleInput.safeParse(input);
  if (!parsed.success) {
    return { error: `Datos inválidos: ${parsed.error.issues[0]?.message ?? "error"}` };
  }

  // Verify ownership via offering.
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
    return { error: "No tenés permiso para editar esta regla." };
  }

  const updates: Partial<typeof serviceScheduleRules.$inferInsert> = {};
  if (parsed.data.daysOfWeek !== undefined) {
    updates.daysOfWeek = parsed.data.daysOfWeek.map((d) => d as unknown as number);
  }
  if (parsed.data.startTimeLocal !== undefined) updates.startTimeLocal = parsed.data.startTimeLocal;
  if (parsed.data.endTimeLocal !== undefined) updates.endTimeLocal = parsed.data.endTimeLocal;
  if (parsed.data.effectiveFrom !== undefined) updates.effectiveFrom = parsed.data.effectiveFrom;
  if ("effectiveUntil" in parsed.data) updates.effectiveUntil = parsed.data.effectiveUntil ?? null;
  updates.updatedAt = new Date();

  try {
    await db.update(serviceScheduleRules).set(updates).where(eq(serviceScheduleRules.id, ruleId));
  } catch (err) {
    return {
      error: `No se pudo actualizar la regla: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  return { ok: true };
}
