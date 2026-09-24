import { eq } from "drizzle-orm";

import { auditLog, db, govtBusinessRules } from "@/db";
import { validateRulePayload } from "@/lib/infra/business-rules-validators";
import { runReevalHookIfRegistered } from "@/lib/infra/rule-types-effects";

import type { UpdateBusinessRuleWriterParams } from "./types";

export async function updateBusinessRuleWriter(
  params: UpdateBusinessRuleWriterParams,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(govtBusinessRules)
        .where(eq(govtBusinessRules.id, params.ruleId))
        .limit(1);
      if (!existing) throw new Error("Regla no encontrada");

      const validation = validateRulePayload(existing.ruleType, params.rulePayload);
      if (!validation.ok) throw new Error(`Payload inválido: ${validation.error}`);

      // Legal-metadata columns (migration 0183). Per-field semantics:
      // `undefined` = the form did not carry the field → leave the column
      // untouched (a form without the tier select must never erase a
      // backfilled tier); `null` = present-but-empty → clear it.
      const legalMetadata = params.legalMetadata;
      const nextLegalMetadata = {
        requirementLevel:
          legalMetadata?.requirementLevel !== undefined
            ? legalMetadata.requirementLevel
            : existing.requirementLevel,
        legalBasis:
          legalMetadata?.legalBasis !== undefined ? legalMetadata.legalBasis : existing.legalBasis,
        authority:
          legalMetadata?.authority !== undefined ? legalMetadata.authority : existing.authority,
        sourceUrl:
          legalMetadata?.sourceUrl !== undefined ? legalMetadata.sourceUrl : existing.sourceUrl,
        effectiveFrom:
          legalMetadata?.effectiveFrom !== undefined
            ? legalMetadata.effectiveFrom
            : existing.effectiveFrom,
        effectiveUntil:
          legalMetadata?.effectiveUntil !== undefined
            ? legalMetadata.effectiveUntil
            : existing.effectiveUntil,
      };

      await tx
        .update(govtBusinessRules)
        .set({
          rulePayload: validation.data,
          notes: params.notes,
          legalAnchorIds: params.legalAnchorIds.length > 0 ? params.legalAnchorIds : null,
          ...(legalMetadata !== undefined ? nextLegalMetadata : {}),
          // BASELINE DETACH (T6 review M3). The legal-baseline seed protects
          // only rows with `baseline_version IS NULL` (spec BD2), and it used
          // to be the sole writer of the column — so a legal reviewer's
          // correction to a seeded row kept its baseline tag and the next
          // same-version re-seed overwrote it, leaving an audit row that looked
          // like routine seed maintenance. An admin-edited row is no longer
          // pristine baseline: clearing the tag makes it admin-authored, which
          // is exactly what BD2 already promises to protect.
          baselineVersion: null,
          updatedByUserId: params.actorUserId,
          updatedAt: new Date(),
        })
        .where(eq(govtBusinessRules.id, params.ruleId));

      await tx.insert(auditLog).values({
        actorUserId: params.actorUserId,
        action: "govt_business_rule_updated",
        payload: {
          ruleId: params.ruleId,
          ruleType: existing.ruleType,
          jurisdiction: {
            country: existing.jurisdictionCountry,
            province: existing.jurisdictionProvince,
            locality: existing.jurisdictionLocality,
          },
          previousPayload: existing.rulePayload,
          newPayload: validation.data,
          // Same-transaction capture as previous/newPayload (spec RM6) —
          // only present when the caller carried legal metadata, so pre-0183
          // audit rows keep their exact historical shape.
          ...(legalMetadata !== undefined
            ? {
                previousLegalMetadata: {
                  requirementLevel: existing.requirementLevel,
                  legalBasis: existing.legalBasis,
                  authority: existing.authority,
                  sourceUrl: existing.sourceUrl,
                  effectiveFrom: existing.effectiveFrom,
                  effectiveUntil: existing.effectiveUntil,
                },
                newLegalMetadata: nextLegalMetadata,
              }
            : {}),
        },
      });
    });
    // Reeval after commit. Look up the row again to read jurisdiction
    // — we don't want to thread it through the closure.
    const [updated] = await db
      .select()
      .from(govtBusinessRules)
      .where(eq(govtBusinessRules.id, params.ruleId))
      .limit(1);
    if (updated) {
      await runReevalHookIfRegistered(updated.ruleType, {
        country: updated.jurisdictionCountry,
        province: updated.jurisdictionProvince,
        locality: updated.jurisdictionLocality,
      });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "error desconocido" };
  }
}
