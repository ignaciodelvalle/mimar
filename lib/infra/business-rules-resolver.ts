// Cascading resolver for govt business rules.
// Spec 2026-05-19-govt-business-rules-poc-design §4.3.
//
// Order: locality > province > country > hardcoded defaults.
// The first matching row wins; if none, the typed default from
// BUSINESS_RULES_DEFAULTS is returned.
//
// EFFECTIVE WINDOW (jurisdiction-compliance, T6 review M2). Migration 0183
// added `effective_from` / `effective_until`; the console collects them on all
// 13 rule forms ("Vigente desde" / "Vigente hasta") and the audit trail records
// them — but NOTHING read them, so an admin who marked an ordinance superseded
// kept seeing it gate the obligation and print as the citation forever. A row
// outside its window is now SKIPPED, and the cascade falls through to the next
// level (locality → province → country → default) exactly as if the row did
// not exist. Scope note: this is render-time evaluation against TODAY, which is
// v1's stated behavior. Re-judging a past EVENT against the law in force on its
// own date (historical re-judgment) stays deferred to v2.

import { and, eq, gte, isNull, lte, or } from "drizzle-orm";

import { type GovtBusinessRuleType, type RequirementLevel, db, govtBusinessRules } from "@/db";

import {
  BUSINESS_RULES_DEFAULTS,
  type BusinessRulePayload,
  type BusinessRulePayloadByType,
} from "@/lib/domain/business-rules-defaults";
import { todayIsoInAr } from "@/lib/utils/format";

export interface Jurisdiction {
  country?: string;
  province?: string | null;
  locality?: string | null;
}

/**
 * Information about which row (if any) supplied the resolved rule and
 * what jurisdiction level matched. Useful for the govt read-only
 * dashboard ("origen de la regla").
 */
export interface ResolvedRule<T extends GovtBusinessRuleType> {
  payload: BusinessRulePayload<T>;
  source: "default" | "country" | "province" | "locality";
  /**
   * Requirement tier + legal provenance (migration 0183) carried by the
   * matched row. All optional and ABSENT on the `default` path: when no row
   * matches anywhere in the cascade, nothing is claimed about the
   * jurisdiction's law — the tier is "not established", NEVER a hardcoded
   * `mandatory`. Consumers with a pre-tier boolean gate (microchip_required)
   * fall back to their payload semantics via
   * `microchipObligationApplies` (lib/domain/business-rules-defaults.ts).
   */
  requirementLevel?: RequirementLevel | null;
  legalBasis?: string | null;
  authority?: string | null;
  sourceUrl?: string | null;
  effectiveFrom?: string | null;
  effectiveUntil?: string | null;
  baselineVersion?: string | null;
  matchedRow: {
    id: string;
    country: string;
    province: string | null;
    locality: string | null;
  } | null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Tx | typeof db;

/**
 * Find the most-specific business rule row for `ruleType` that applies
 * to `jurisdiction`. Falls back to the hardcoded default when nothing
 * matches.
 */
export async function resolveBusinessRule<T extends GovtBusinessRuleType>(
  ruleType: T,
  jurisdiction: Jurisdiction,
  executor: Executor = db,
): Promise<ResolvedRule<T>> {
  const country = jurisdiction.country ?? "AR";
  const province = jurisdiction.province ?? null;
  const locality = jurisdiction.locality ?? null;
  // The Argentine calendar day, not the server's UTC one: at 22:00 in Buenos
  // Aires `toISOString()` already says tomorrow, which would activate a
  // future-dated rule (or expire a live one) hours early.
  const today = todayIsoInAr();

  const candidates: {
    country: string;
    province: string | null;
    locality: string | null;
    source: ResolvedRule<T>["source"];
  }[] = [
    { country, province, locality, source: "locality" },
    { country, province, locality: null, source: "province" },
    { country, province: null, locality: null, source: "country" },
  ];

  for (const c of candidates) {
    // Skip the "locality" candidate when there's no locality input —
    // that lookup is identical to the "province" one.
    if (c.source === "locality" && locality === null) continue;
    if (c.source === "province" && province === null) continue;

    const [row] = await executor
      .select()
      .from(govtBusinessRules)
      .where(
        and(
          eq(govtBusinessRules.ruleType, ruleType),
          eq(govtBusinessRules.jurisdictionCountry, c.country),
          c.province === null
            ? isNull(govtBusinessRules.jurisdictionProvince)
            : eq(govtBusinessRules.jurisdictionProvince, c.province),
          c.locality === null
            ? isNull(govtBusinessRules.jurisdictionLocality)
            : eq(govtBusinessRules.jurisdictionLocality, c.locality),
          // Effective window (M2). NULL on either end means "no bound" — a row
          // with no dates always applies, which is every pre-0183 row. Both
          // bounds are INCLUSIVE: "vigente hasta el 31/12" governs the 31st.
          or(isNull(govtBusinessRules.effectiveFrom), lte(govtBusinessRules.effectiveFrom, today)),
          or(
            isNull(govtBusinessRules.effectiveUntil),
            gte(govtBusinessRules.effectiveUntil, today),
          ),
        ),
      )
      .limit(1);
    if (row) {
      return {
        payload: row.rulePayload as BusinessRulePayload<T>,
        source: c.source,
        requirementLevel: row.requirementLevel,
        legalBasis: row.legalBasis,
        authority: row.authority,
        sourceUrl: row.sourceUrl,
        effectiveFrom: row.effectiveFrom,
        effectiveUntil: row.effectiveUntil,
        baselineVersion: row.baselineVersion,
        matchedRow: {
          id: row.id,
          country: row.jurisdictionCountry,
          province: row.jurisdictionProvince,
          locality: row.jurisdictionLocality,
        },
      };
    }
  }

  return {
    payload: BUSINESS_RULES_DEFAULTS[ruleType] as BusinessRulePayloadByType[T],
    source: "default",
    matchedRow: null,
  };
}

/**
 * Canonical string key for a jurisdiction — stable across `undefined`/`null`
 * normalization so batch-resolution maps can be looked up by re-deriving the
 * key from the same jurisdiction object.
 */
export function canonicalJurisdictionKey(jurisdiction: Jurisdiction): string {
  return [
    jurisdiction.country ?? "AR",
    jurisdiction.province ?? "",
    jurisdiction.locality ?? "",
  ].join("|");
}

/**
 * Batch variant (movilidad-jurisdiccional Fase 1, design D3): resolve ONE
 * rule type across N jurisdictions, keyed by canonicalJurisdictionKey.
 * Each jurisdiction goes through the same locality > province > country >
 * default cascade as resolveBusinessRule. Duplicate jurisdictions are
 * deduped — one cascade per distinct key.
 *
 * Sequential ONLY on a transaction executor: drizzle tx executors are not safe
 * under concurrent queries. On the pool (`db`, the default and what every
 * dashboard caller passes) the distinct jurisdictions are resolved in PARALLEL
 * — T6 review MINOR 8: the owner dashboard used to fan its per-jurisdiction
 * resolution out with Promise.all, and routing it through this batch helper
 * serialized it into ~3 sequential cascades per distinct jurisdiction on the
 * owner's hottest read. The tx-safety constraint is real, but it does not
 * apply to the pool.
 */
export async function resolveBusinessRuleForJurisdictions<T extends GovtBusinessRuleType>(
  ruleType: T,
  jurisdictions: Jurisdiction[],
  executor: Executor = db,
): Promise<Map<string, ResolvedRule<T>>> {
  const distinct = new Map<string, Jurisdiction>();
  for (const jurisdiction of jurisdictions) {
    const key = canonicalJurisdictionKey(jurisdiction);
    if (!distinct.has(key)) distinct.set(key, jurisdiction);
  }
  const entries = [...distinct.entries()];

  if (executor === db) {
    const rules = await Promise.all(
      entries.map(([, jurisdiction]) => resolveBusinessRule(ruleType, jurisdiction, executor)),
    );
    return new Map(entries.map(([key], i) => [key, rules[i]]));
  }

  const resolved = new Map<string, ResolvedRule<T>>();
  for (const [key, jurisdiction] of entries) {
    resolved.set(key, await resolveBusinessRule(ruleType, jurisdiction, executor));
  }
  return resolved;
}
