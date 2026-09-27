import { eq } from "drizzle-orm";

import { type GovtBusinessRuleType, auditLog, db, govtBusinessRules } from "@/db";
import { runReevalHookIfRegistered } from "@/lib/infra/rule-types-effects";

import type { BusinessRuleExecutor } from "./create-business-rule";
import { assertRuleWritable, ruleWriterErrorMessage } from "./rule-authority";
import type { DeleteBusinessRuleWriterParams } from "./types";

// ORDER MATTERS (jurisdiction-admin security review L1). The audit row is
// written BEFORE the delete, inside the same transaction: the audit guard
// (0269) then reads the rule's place from the LIVE row through `ruleId`, not
// only from the payload this writer built. And the payload's `jurisdiction`
// snapshot carries every place column of the row — authority_unit_id and
// locality_id too, not just the three names — so a deleted rule's history
// still says where it applied once the row is gone. A delete carries no actor
// column, so the audit row is the only database-side record of who did it.

export async function deleteBusinessRuleWriter(
  params: DeleteBusinessRuleWriterParams,
  exec: BusinessRuleExecutor = db,
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
    await exec.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(govtBusinessRules)
        .where(eq(govtBusinessRules.id, params.ruleId))
        .for("update")
        .limit(1);
      if (!existing) throw new Error("Regla no encontrada");
      // Who may delete THIS rule (jurisdiction-admin Phase 4): its STORED
      // place, locked above.
      await assertRuleWritable(tx, params.actorUserId, existing);
      scope = {
        country: existing.jurisdictionCountry,
        province: existing.jurisdictionProvince,
        locality: existing.jurisdictionLocality,
      };
      ruleType = existing.ruleType;
      // Every place column of the row (L1), read here and only recorded: the
      // audit payload is a snapshot, never a write of the rule's columns.
      const jurisdictionSnapshot = {
        ...scope,
        authorityUnitId: existing.authorityUnitId,
        localityId: existing.localityId,
      };

      await tx.insert(auditLog).values({
        actorUserId: params.actorUserId,
        action: "govt_business_rule_deleted",
        payload: {
          ruleId: params.ruleId,
          ruleType: existing.ruleType,
          jurisdiction: jurisdictionSnapshot,
          previousPayload: existing.rulePayload,
          reason,
        },
      });

      await tx.delete(govtBusinessRules).where(eq(govtBusinessRules.id, params.ruleId));
    });
    if (ruleType && scope) {
      await runReevalHookIfRegistered(ruleType, scope);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: ruleWriterErrorMessage(err) };
  }
}
