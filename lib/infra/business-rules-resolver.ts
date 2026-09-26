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

import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { type GovtBusinessRuleType, type RequirementLevel, db, govtBusinessRules } from "@/db";

import {
  BUSINESS_RULES_DEFAULTS,
  type BusinessRulePayload,
  type BusinessRulePayloadByType,
} from "@/lib/domain/business-rules-defaults";
import { type PlaceReadMode, readPlaceFlag } from "@/lib/place/flags";
import type { ShadowKind } from "@/lib/place/shadow";
import { recordShadowDisagreement } from "@/lib/place/shadow-sink";
import { provinceByName } from "@/lib/reference/ar-provincias";
import { todayIsoInAr } from "@/lib/utils/format";

export interface Jurisdiction {
  country?: string;
  province?: string | null;
  locality?: string | null;
  /**
   * The place's catalogue row (localidades-por-id D4). `null` = known and
   * unresolved: on the id path it takes no locality-level ordinance. Absent =
   * the caller has not been wired; that call keeps the name cascade.
   */
  localityId?: string | null;
}

export type ResolveRuleOptions = {
  /** The parity sweep and the fences ask a path; production reads the flag. */
  mode?: PlaceReadMode;
};

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
    /** The unit the matched row is keyed to (id path), else null. */
    authorityUnitId?: string | null;
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
  options: ResolveRuleOptions = {},
): Promise<ResolvedRule<T>> {
  // A caller that does not pass the place's id cannot take the id path.
  if (jurisdiction.localityId === undefined) {
    return resolveByName(ruleType, jurisdiction, executor);
  }
  const mode = options.mode ?? (await readPlaceFlag("rules"));
  if (mode === "name") return resolveByName(ruleType, jurisdiction, executor);
  if (mode === "id") return resolveById(ruleType, jurisdiction, executor);

  const byName = await resolveByName(ruleType, jurisdiction, executor);
  const byId = await resolveById(ruleType, jurisdiction, executor);
  if ((byName.matchedRow?.id ?? null) !== (byId.matchedRow?.id ?? null)) {
    await recordShadowDisagreement({
      consumer: "rules",
      kind: rulesDisagreementKind(jurisdiction, byName, byId),
      subjectTable: `rules:${ruleType}`,
      subjectKey: `${jurisdiction.province ?? ""}|${jurisdiction.locality ?? ""}|${jurisdiction.localityId ?? "unresolved"}`,
      nameResult: byName.matchedRow ?? [],
      idResult: byId.matchedRow ?? [],
    });
  }
  return byName;
}

/**
 * Why the two cascades picked different rows. The name path matched a row the
 * id path refused because the place is unresolved (unresolved_to_province), or
 * because the row names a homonym (homonym_split); the id path found a unit
 * ordinance the name path could not see (unit_widening, a person keyed it).
 */
function rulesDisagreementKind(
  jurisdiction: Jurisdiction,
  byName: ResolvedRule<GovtBusinessRuleType>,
  byId: ResolvedRule<GovtBusinessRuleType>,
): ShadowKind {
  if (byName.source === "locality" && (jurisdiction.localityId ?? null) === null) {
    return "unresolved_to_province";
  }
  if (byName.source === "locality" && byId.source !== "locality") return "homonym_split";
  if (byId.matchedRow?.authorityUnitId) return "unit_widening";
  return "other";
}

// ---------------------------------------------------------------------------
// THE ID PATH (localidades-por-id D4, flag `rules`)
//
//   1. a row keyed to a unit governing the place, most specific level first
//      (submunicipal > municipal > regional) — source "locality";
//   2. a legacy locality row (unit NULL) by name, that recorded no catalogue
//      row or recorded THIS one — source "locality";
//   3. a row keyed to the place's provincial unit — source "province";
//   4. a legacy province row — source "province";
//   5. country, then the default — as on the name path.
//
// "Never both": a unit-keyed row is never matched by its name pair here, and
// a legacy row never by a unit. An unresolved place (localityId null) skips
// steps 1-2: no locality ordinance is chosen for a place that has no locality
// (P1). With no unit-keyed rows and no recorded ids — every row today — this
// is exactly the name cascade.
// ---------------------------------------------------------------------------

const LEVEL_ORDER = ["submunicipal", "municipal", "regional"] as const;

async function resolveById<T extends GovtBusinessRuleType>(
  ruleType: T,
  jurisdiction: Jurisdiction,
  executor: Executor,
): Promise<ResolvedRule<T>> {
  const country = jurisdiction.country ?? "AR";
  const province = jurisdiction.province ?? null;
  const locality = jurisdiction.locality ?? null;
  const localityId = jurisdiction.localityId ?? null;
  const provinceCode = province ? (provinceByName(province)?.code ?? null) : null;
  const today = todayIsoInAr();
  const inWindow = and(
    or(isNull(govtBusinessRules.effectiveFrom), lte(govtBusinessRules.effectiveFrom, today)),
    or(isNull(govtBusinessRules.effectiveUntil), gte(govtBusinessRules.effectiveUntil, today)),
  );

  const units = (await executor.execute(sql`
    select unit_id::text as "unitId", level
      from public.authority_units_for_place(${localityId}::uuid, ${provinceCode})
  `)) as unknown as Array<{ unitId: string; level: string }>;

  const byUnit = async (unitIds: string[]) => {
    if (unitIds.length === 0) return [];
    return executor
      .select()
      .from(govtBusinessRules)
      .where(
        and(
          eq(govtBusinessRules.ruleType, ruleType),
          inArray(govtBusinessRules.authorityUnitId, unitIds),
          inWindow,
        ),
      );
  };

  // 1. unit ordinances below the province, most specific level first.
  if (localityId !== null) {
    const localUnits = units.filter((u) => u.level !== "provincial");
    const rows = await byUnit(localUnits.map((u) => u.unitId));
    for (const level of LEVEL_ORDER) {
      const unitIds = new Set(localUnits.filter((u) => u.level === level).map((u) => u.unitId));
      const row = rows.find((r) => r.authorityUnitId && unitIds.has(r.authorityUnitId));
      if (row) return fromRow<T>(row, "locality");
    }
  }

  // 2. a legacy locality row by name — only one that is not pinned to another row.
  if (localityId !== null && province !== null && locality !== null) {
    const [row] = await executor
      .select()
      .from(govtBusinessRules)
      .where(
        and(
          eq(govtBusinessRules.ruleType, ruleType),
          eq(govtBusinessRules.jurisdictionCountry, country),
          eq(govtBusinessRules.jurisdictionProvince, province),
          eq(govtBusinessRules.jurisdictionLocality, locality),
          isNull(govtBusinessRules.authorityUnitId),
          or(isNull(govtBusinessRules.localityId), eq(govtBusinessRules.localityId, localityId)),
          inWindow,
        ),
      )
      .limit(1);
    if (row) return fromRow<T>(row, "locality");
  }

  // 3. the provincial unit's ordinance.
  const provincial = units.filter((u) => u.level === "provincial").map((u) => u.unitId);
  const [provincialRow] = await byUnit(provincial);
  if (provincialRow) return fromRow<T>(provincialRow, "province");

  // 4-5. legacy province, then country: the name cascade's own steps, legacy rows only.
  const tail: { province: string | null; source: ResolvedRule<T>["source"] }[] = [
    { province, source: "province" },
    { province: null, source: "country" },
  ];
  for (const c of tail) {
    if (c.source === "province" && c.province === null) continue;
    const [row] = await executor
      .select()
      .from(govtBusinessRules)
      .where(
        and(
          eq(govtBusinessRules.ruleType, ruleType),
          eq(govtBusinessRules.jurisdictionCountry, country),
          c.province === null
            ? isNull(govtBusinessRules.jurisdictionProvince)
            : eq(govtBusinessRules.jurisdictionProvince, c.province),
          isNull(govtBusinessRules.jurisdictionLocality),
          isNull(govtBusinessRules.authorityUnitId),
          inWindow,
        ),
      )
      .limit(1);
    if (row) return fromRow<T>(row, c.source);
  }

  return {
    payload: BUSINESS_RULES_DEFAULTS[ruleType] as BusinessRulePayloadByType[T],
    source: "default",
    matchedRow: null,
  };
}

function fromRow<T extends GovtBusinessRuleType>(
  row: typeof govtBusinessRules.$inferSelect,
  source: ResolvedRule<T>["source"],
): ResolvedRule<T> {
  return {
    payload: row.rulePayload as BusinessRulePayload<T>,
    source,
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
      authorityUnitId: row.authorityUnitId,
    },
  };
}

/** The name cascade — the only path before localidades-por-id D4. */
async function resolveByName<T extends GovtBusinessRuleType>(
  ruleType: T,
  jurisdiction: Jurisdiction,
  executor: Executor,
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
