// create-schedule-rule.ts — schedule rule creation writer (strangler 24/61).
// Moved verbatim from app/actions/schedule-rules.ts.

import { eq } from "drizzle-orm";

import { db, serviceOfferings, serviceScheduleRules } from "@/db";
import { CreateScheduleRuleInput } from "@/lib/reference/scheduling-schemas";

import type { ScheduleRuleResult } from "./types";

export async function createScheduleRuleForOrg(
  actorUserId: string,
  orgId: string,
  input: {
    serviceOfferingId: string;
    daysOfWeek: number[];
    startTimeLocal: string;
    endTimeLocal: string;
    effectiveFrom: string;
    effectiveUntil: string | null;
  },
): Promise<ScheduleRuleResult> {
  const parsed = CreateScheduleRuleInput.safeParse(input);
  if (!parsed.success) {
    return { error: `Datos inválidos: ${parsed.error.issues[0]?.message ?? "error"}` };
  }

  // Verify offering belongs to org and is approved.
  const [offering] = await db
    .select({
      id: serviceOfferings.id,
      status: serviceOfferings.status,
      organizationId: serviceOfferings.organizationId,
    })
    .from(serviceOfferings)
    .where(eq(serviceOfferings.id, parsed.data.serviceOfferingId))
    .limit(1);

  if (!offering) return { error: "Servicio no encontrado." };
  if (offering.organizationId !== orgId)
    return { error: "El servicio no pertenece a tu organización." };
  if (offering.status !== "approved") {
    return { error: "Solo se pueden crear reglas de agenda para servicios aprobados." };
  }

  try {
    await db.insert(serviceScheduleRules).values({
      serviceOfferingId: parsed.data.serviceOfferingId,
      daysOfWeek: parsed.data.daysOfWeek.map((d) => d as unknown as number),
      startTimeLocal: parsed.data.startTimeLocal,
      endTimeLocal: parsed.data.endTimeLocal,
      effectiveFrom: parsed.data.effectiveFrom,
      effectiveUntil: parsed.data.effectiveUntil ?? null,
      status: "active",
    });
  } catch (err) {
    return {
      error: `No se pudo crear la regla: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  return { ok: true };
}
