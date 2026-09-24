import { eq } from "drizzle-orm";

import { type GovtBusinessRuleType, auditLog, db, govtBusinessRules } from "@/db";
import { runReevalHookIfRegistered } from "@/lib/infra/rule-types-effects";

import type { DeleteBusinessRuleWriterParams } from "./types";

export async function deleteBusinessRuleWriter(
  params: DeleteBusinessRuleWriterParams,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const reason = params.reason.trim();
  if (reason.length === 0) {
    return { ok: false, error: "Se requiere un motivo para eliminar la regla." };
  }
  // Capture the row scope BEFORE the tx so the post-commit reeval has
  // the jurisdiction even though the row is gone.
  let scope: { country: string; province: string | null; locality: string | null } | null = null;
  let ruleType: GovtBusinessRuleType | null = null;
  try {
    await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(govtBusinessRules)
        .where(eq(govtBusinessRules.id, params.ruleId))
        .limit(1);
      if (!existing) throw new Error("Regla no encontrada");
      scope = {
        country: existing.jurisdictionCountry,
        province: existing.jurisdictionProvince,
        locality: existing.jurisdictionLocality,
      };
      ruleType = existing.ruleType;

      await tx.delete(govtBusinessRules).where(eq(govtBusinessRules.id, params.ruleId));

      await tx.insert(auditLog).values({
        actorUserId: params.actorUserId,
        action: "govt_business_rule_deleted",
        payload: {
          ruleId: params.ruleId,
          ruleType: existing.ruleType,
          jurisdiction: scope,
          previousPayload: existing.rulePayload,
          reason,
        },
      });
    });
    if (ruleType && scope) {
      await runReevalHookIfRegistered(ruleType, scope);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "error desconocido" };
  }
}
