// Mandating-jurisdiction classifier for the obligation rule types
// (jurisdiction-compliance WU4a, spec MN1/MN3 — design ADR-5).
//
// Answers ONE question for the compliance metrics: "does this (province,
// locality) pair carry an ACTUAL legal mandate for this obligation?" — the
// denominator basis for the `*_compliance_mandated` KPI family
// (lib/analytics/compliance-metrics.ts, lib/metrics/kpi-catalog-compliance.ts).
//
// WHY AN IN-MEMORY CASCADE (and not resolveBusinessRuleForJurisdictions):
// the metrics classify EVERY distinct pet jurisdiction in scope — potentially
// hundreds of (province, locality) pairs. The batch resolver issues up to 3
// sequential SELECTs per pair; this module loads the rule type's rows ONCE
// (small table) and mirrors the same locality > province > country cascade in
// memory. The cascade MUST stay semantically identical to resolveBusinessRule
// (lib/infra/business-rules-resolver.ts) — pinned by the parity test in
// __tests__/mandated-denominator-cascade.test.ts.
//
// MANDATE SEMANTICS (deliberate, and STRICTER than the owner surface):
//   - No matched row at any cascade tier → NOT mandated. The microchip default
//     (`{required: true}`) keeps gating the owner-facing compliance card ON
//     (behavior-preserving, OR5), but it NEVER puts a jurisdiction into the
//     mandated DENOMINATOR: "donde es obligatorio" is a claim about resolved
//     law, not about our fallback — same posture as
//     deriveCredentialRegistryClaim (ADR-7), where the default cannot back a
//     public claim either. (RG2 — flipping that default to `{required: false}`
//     — is PARKED, not cancelled: PO-ratified, then reverted in 88689beb
//     because the ar-v1 baseline carries no microchip rows to seed. Restore
//     with `git cherry-pick 96277c05` once ar-v2 does. THIS module's semantics
//     do not depend on which way the default points.)
//   - rabies_vaccination / sterilization: mandated iff the matched row's
//     requirement_level is EXPLICITLY 'mandatory'. A matched row with a NULL
//     tier claims nothing — the owner surface falls back to the pre-tier
//     rendering there (obligationRuleInfo), but the metric does not invent a
//     mandate from a row that never stated one.
//   - microchip_required: the OR5 consumer gate (microchipObligationApplies)
//     applied to the MATCHED row — tier supersedes, boolean payload governs
//     tier-less rows, so backfilled and legacy-form rows classify identically
//     to the profile gate.
//
// CASCADE CORRECTNESS (the highest metric-bug risk, spec MN3 scenario): a
// `not_regulated` locality override under a `mandatory` province row must
// EXCLUDE that locality from the mandated denominator — the most specific row
// wins, exactly as in resolveBusinessRule. Dedicated test required (T4.10).

import { and, eq, gte, isNull, lte, or } from "drizzle-orm";

import { type RequirementLevel, analyticsDb, govtBusinessRules } from "@/db";
import { microchipObligationApplies } from "@/lib/domain/business-rules-defaults";
import { todayIsoInAr } from "@/lib/utils/format";

/** The three per-pet obligation rule types the mandated KPIs read (OR1). */
export type ObligationRuleType = "microchip_required" | "rabies_vaccination" | "sterilization";

/** The subset of a govt_business_rules row the classifier needs. */
export type ObligationRuleRow = {
  province: string | null;
  locality: string | null;
  requirementLevel: RequirementLevel | null;
  payload: unknown;
};

/**
 * Pure cascade pick — locality > province > country; the FIRST matching row
 * wins, `null` when nothing matches. Mirrors resolveBusinessRule's candidate
 * order (parity-tested); rows are pre-filtered to one rule type + country AR.
 */
export function pickObligationRule(
  rows: readonly ObligationRuleRow[],
  province: string | null,
  locality: string | null,
): ObligationRuleRow | null {
  if (province !== null && locality !== null) {
    const localityRow = rows.find((r) => r.province === province && r.locality === locality);
    if (localityRow) return localityRow;
  }
  if (province !== null) {
    const provinceRow = rows.find((r) => r.province === province && r.locality === null);
    if (provinceRow) return provinceRow;
  }
  return rows.find((r) => r.province === null && r.locality === null) ?? null;
}

/** Does the MATCHED row (never the default) constitute an actual mandate? */
export function rowMandates(ruleType: ObligationRuleType, row: ObligationRuleRow | null): boolean {
  if (row === null) return false;
  if (ruleType === "microchip_required") {
    return microchipObligationApplies({
      requirementLevel: row.requirementLevel,
      payload: (row.payload ?? {}) as { required?: boolean },
    });
  }
  return row.requirementLevel === "mandatory";
}

export type MandatingClassifier = {
  /** True when the resolved rule for (province, locality) is an actual mandate. */
  isMandated: (province: string | null, locality: string | null) => boolean;
  /** Rule rows loaded for the type — 0 means no jurisdiction can be mandated. */
  ruleCount: number;
};

/** Pure classifier over pre-fetched rows — unit-testable without Postgres. */
export function buildMandatingClassifier(
  ruleType: ObligationRuleType,
  rows: readonly ObligationRuleRow[],
): MandatingClassifier {
  return {
    isMandated: (province, locality) =>
      rowMandates(ruleType, pickObligationRule(rows, province, locality)),
    ruleCount: rows.length,
  };
}

/**
 * Resolve which jurisdictions mandate `ruleType`, reading the resolved tier
 * from govt_business_rules (WU1 columns). One SELECT over the type's rows
 * (country AR — pets carry no country column and the registry is AR-scoped),
 * then the in-memory cascade above. Routed through the ANALYTICS pool like
 * every sibling in lib/analytics.
 */
export async function resolveMandatingJurisdictions(
  ruleType: ObligationRuleType,
): Promise<MandatingClassifier> {
  const today = todayIsoInAr();
  const rows = await analyticsDb
    .select({
      province: govtBusinessRules.jurisdictionProvince,
      locality: govtBusinessRules.jurisdictionLocality,
      requirementLevel: govtBusinessRules.requirementLevel,
      payload: govtBusinessRules.rulePayload,
    })
    .from(govtBusinessRules)
    .where(
      and(
        eq(govtBusinessRules.ruleType, ruleType),
        eq(govtBusinessRules.jurisdictionCountry, "AR"),
        // Same effective window as resolveBusinessRule (T6 review M2) — the
        // parity contract at the top of this file is SEMANTIC, so a row the
        // owner surface no longer applies must not keep its jurisdiction in the
        // mandated denominator. NULL bounds = no bound. AR calendar day.
        or(isNull(govtBusinessRules.effectiveFrom), lte(govtBusinessRules.effectiveFrom, today)),
        or(isNull(govtBusinessRules.effectiveUntil), gte(govtBusinessRules.effectiveUntil, today)),
      ),
    );
  return buildMandatingClassifier(ruleType, rows);
}
