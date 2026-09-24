import { and, eq, isNull } from "drizzle-orm";

import { GOVT_BUSINESS_RULE_TYPES, auditLog, db, govtBusinessRules } from "@/db";
import { BUSINESS_RULES_DEFAULTS } from "@/lib/domain/business-rules-defaults";
import { validateRulePayload } from "@/lib/infra/business-rules-validators";
import { runReevalHookIfRegistered } from "@/lib/infra/rule-types-effects";

import type {
  BusinessRuleLegalMetadata,
  CreateBusinessRuleResult,
  CreateBusinessRuleWriterParams,
} from "./types";

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * True when the caller supplied ANY legal-metadata value (migration 0183).
 * Gates the no-op refusal below: a payload identical to the default is still
 * worth a row when it carries an explicit tier or a legal citation — the
 * resolver would NOT return those from the hardcoded default.
 */
function hasLegalMetadata(lm: BusinessRuleLegalMetadata | undefined): boolean {
  if (!lm) return false;
  return (
    lm.requirementLevel != null ||
    lm.legalBasis != null ||
    lm.authority != null ||
    lm.sourceUrl != null ||
    lm.effectiveFrom != null ||
    lm.effectiveUntil != null
  );
}

export async function createBusinessRuleWriter(
  params: CreateBusinessRuleWriterParams,
): Promise<CreateBusinessRuleResult> {
  if (!(GOVT_BUSINESS_RULE_TYPES as readonly string[]).includes(params.ruleType)) {
    return { ok: false, error: "Rule type inválido" };
  }
  const validation = validateRulePayload(params.ruleType, params.rulePayload);
  if (!validation.ok) {
    return { ok: false, error: `Payload inválido: ${validation.error}` };
  }

  // No-op detection: if the proposed payload matches the hardcoded
  // default, refuse to insert — the resolver would return the same
  // value anyway and the row would just add noise. Skipped when legal
  // metadata is present: the tier/citation columns (migration 0183) are
  // resolver output the default cannot supply.
  const defaultPayload = BUSINESS_RULES_DEFAULTS[params.ruleType];
  if (deepEqual(validation.data, defaultPayload) && !hasLegalMetadata(params.legalMetadata)) {
    return {
      ok: true,
      ruleId: null,
      noOp: true,
      reason: "Esta configuración es idéntica al default — no se requiere override.",
    };
  }

  try {
    const ruleId = await db.transaction(async (tx) => {
      // Duplicate detection: existing row for the same (jurisdiction +
      // rule_type) should UPDATE not INSERT. The dedicated `update`
      // action handles that explicitly; here we reject so the admin
      // knows to go through update.
      const [existing] = await tx
        .select({ id: govtBusinessRules.id })
        .from(govtBusinessRules)
        .where(
          and(
            eq(govtBusinessRules.ruleType, params.ruleType),
            eq(govtBusinessRules.jurisdictionCountry, params.jurisdictionCountry),
            params.jurisdictionProvince === null
              ? isNull(govtBusinessRules.jurisdictionProvince)
              : eq(govtBusinessRules.jurisdictionProvince, params.jurisdictionProvince),
            params.jurisdictionLocality === null
              ? isNull(govtBusinessRules.jurisdictionLocality)
              : eq(govtBusinessRules.jurisdictionLocality, params.jurisdictionLocality),
          ),
        )
        .limit(1);
      if (existing) {
        throw new Error(
          "Ya existe una regla para esa combinación de jurisdicción y tipo. Usá editar.",
        );
      }

      const legalMetadata = params.legalMetadata;
      const [created] = await tx
        .insert(govtBusinessRules)
        .values({
          jurisdictionCountry: params.jurisdictionCountry,
          jurisdictionProvince: params.jurisdictionProvince,
          jurisdictionLocality: params.jurisdictionLocality,
          ruleType: params.ruleType,
          rulePayload: validation.data,
          notes: params.notes,
          legalAnchorIds: params.legalAnchorIds.length > 0 ? params.legalAnchorIds : null,
          // Legal-metadata columns (migration 0183). On create, "field not in
          // the form" and "field empty" both mean NULL — there is no prior
          // value to preserve.
          requirementLevel: legalMetadata?.requirementLevel ?? null,
          legalBasis: legalMetadata?.legalBasis ?? null,
          authority: legalMetadata?.authority ?? null,
          sourceUrl: legalMetadata?.sourceUrl ?? null,
          effectiveFrom: legalMetadata?.effectiveFrom ?? null,
          effectiveUntil: legalMetadata?.effectiveUntil ?? null,
          createdByUserId: params.actorUserId,
          updatedByUserId: params.actorUserId,
        })
        .returning({ id: govtBusinessRules.id });

      await tx.insert(auditLog).values({
        actorUserId: params.actorUserId,
        action: "govt_business_rule_created",
        payload: {
          ruleId: created.id,
          ruleType: params.ruleType,
          jurisdiction: {
            country: params.jurisdictionCountry,
            province: params.jurisdictionProvince,
            locality: params.jurisdictionLocality,
          },
          newPayload: validation.data,
          // Same-transaction capture as previous/newPayload (spec RM6) —
          // only present when the caller carried legal metadata, so pre-0183
          // audit rows keep their exact historical shape.
          ...(legalMetadata !== undefined
            ? {
                newLegalMetadata: {
                  requirementLevel: legalMetadata.requirementLevel ?? null,
                  legalBasis: legalMetadata.legalBasis ?? null,
                  authority: legalMetadata.authority ?? null,
                  sourceUrl: legalMetadata.sourceUrl ?? null,
                  effectiveFrom: legalMetadata.effectiveFrom ?? null,
                  effectiveUntil: legalMetadata.effectiveUntil ?? null,
                },
              }
            : {}),
        },
      });

      return created.id;
    });

    // Trigger re-evaluation outside the tx so the tx-bound auditLog row
    // commits even if the reeval errors. Only rule types with a registered
    // reevalHook (lib/infra/rule-types-effects.ts) affect record-level state.
    await runReevalHookIfRegistered(params.ruleType, {
      country: params.jurisdictionCountry,
      province: params.jurisdictionProvince,
      locality: params.jurisdictionLocality,
    });

    return { ok: true, ruleId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "error desconocido" };
  }
}
