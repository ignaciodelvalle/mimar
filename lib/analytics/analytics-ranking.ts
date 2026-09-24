// Cross-region ranking projections for /gob/analytics (Item 22).
//
// Provides:
//   rankByField — pure sort + slice + rank assignment (testable without DB)
//   fetchRegionRanking — DB-backed ranking by rabies coverage per province

import { type SQL, and, count, countDistinct, eq, inArray, sql } from "drizzle-orm";

// POOL: analyticsDb (session pooler), NOT the OLTP transaction pooler — these are
// read-only multi-statement dashboard aggregates. supavisor transaction mode (6543)
// has a measured >100x pathology for this fan-out shape (db/index.ts); session mode
// serves it normally. Locally analyticsDb falls back to DATABASE_URL (identical dev/test).
import { analyticsDb as db, petEvents, pets } from "@/db";
import { amendedPayloadText } from "@/lib/infra/amendment-sql";
import { buildProjectionScope } from "@/lib/metrics/context";
import { planProvinceDisclosure } from "@/lib/metrics/province-disclosure";
import { jurisdictionPairClause, withoutSyntheticRows } from "@/lib/metrics/scope";
import {
  type DashboardActor,
  type DashboardJurisdiction,
  PROVINCE_ISO_MAP,
} from "./govt-dashboards";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export type RankedRow = {
  province: string;
  code: string;
  value: number;
  count: number;
  rank: number;
};

type UnrankedRow = { province: string; code: string; value: number; count: number };

/**
 * Sort `rows` by `field`, take the first `limit`, then assign 1-based rank.
 * `dir: "desc"` = highest first (top performers); `"asc"` = lowest first (worst performers).
 */
export function rankByField(
  rows: UnrankedRow[],
  field: keyof Pick<UnrankedRow, "value" | "count">,
  dir: "asc" | "desc",
  limit: number,
): RankedRow[] {
  const sorted = [...rows].sort((a, b) =>
    dir === "desc" ? b[field] - a[field] : a[field] - b[field],
  );
  return sorted.slice(0, limit).map((r, i) => ({ ...r, rank: i + 1 }));
}

/**
 * Jurisdiction-scope clause for the region ranking's `pets` queries.
 *
 * admin, no province selected → null (universal scope, no restriction).
 * admin + province selected   → province (+ optional locality) predicate
 *   (Panorama-style admin drill-down; additive-only, mirrors petsScopeClause).
 *   Backward-compat: no adminProvince → null, exactly as before.
 * govt  → OR of the actor's assignment pairs via the SHARED jurisdictionPairClause,
 *   so a whole-province assignment (e.g. whole-CABA, locality
 *   "Ciudad Autónoma de Buenos Aires") subsumes its barrio/locality-tagged pets
 *   (Belgrano, Palermo, …) via a province-only predicate. The previous ad-hoc
 *   exact `(province = X AND locality = Y)` clause never matched barrio-tagged
 *   CABA pets, so CABA silently returned 0 rows in the ranking. A barrio-specific
 *   assignment (CABA / Palermo) still keeps the exact pair — no widening.
 *
 * Returns null only when a govt actor has no assignments; fetchRegionRanking
 * early-returns before that, so the govt branch here always yields a clause.
 */
export function regionRankingPetsScope(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): SQL | null {
  // T1-P1: synthetic pets ride out with the scope (lib/metrics/scope.ts).
  return withoutSyntheticRows(
    actor.role,
    "pets",
    regionRankingJurisdictionOnly(actor, jurisdictions, adminProvince, adminLocality),
  );
}

function regionRankingJurisdictionOnly(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): SQL | null {
  if (actor.role !== "govt") {
    if (!adminProvince) return null;
    if (adminLocality) {
      // `and()`'s general signature returns `SQL | undefined`; with two concrete
      // (non-undefined) conditions it always yields a defined SQL — cast to match
      // this function's `SQL | null` contract.
      return and(
        eq(pets.jurisdictionProvince, adminProvince),
        eq(pets.jurisdictionLocality, adminLocality),
      ) as SQL;
    }
    return eq(pets.jurisdictionProvince, adminProvince);
  }
  // synthetic: covered — regionRankingPetsScope wraps this with withoutSyntheticRows.
  return jurisdictionPairClause(
    jurisdictions,
    sql`${pets.jurisdictionProvince}`,
    sql`${pets.jurisdictionLocality}`,
  );
}

// ---------------------------------------------------------------------------
// DB fetcher
// ---------------------------------------------------------------------------

export type RegionRankingRow = RankedRow & {
  /**
   * Rabies vaccination coverage as a percentage (0-100).
   * Computed as (petsWithRabiesVaccine / totalPets) * 100, rounded to integer.
   * Null if totalPets = 0 for this province.
   *
   * A row that REACHES a consumer always has this populated: withheld provinces
   * never enter `top`/`bottom` (see `fetchRegionRanking`). The nullability is the
   * historical zero-denominator case, kept so a renderer must still confront it
   * instead of `?? 0`-ing a confident zero onto the screen.
   */
  coveragePct: number | null;
};

export type RegionRankingResult = {
  /** Top 5 provinces by rabies vaccination coverage (highest first). */
  top: RegionRankingRow[];
  /** Bottom 5 provinces by rabies vaccination coverage (lowest first). */
  bottom: RegionRankingRow[];
  /**
   * Cursor red-team 2026-07-23 (claim #2) — distinct provinces WITH DATA in
   * this scope (totalRows.length after the >0-pets filter), NOT top.length or
   * bottom.length (both are min(this, 5) and can silently be the SAME set —
   * a single-province govt scope, e.g. whole-CABA, has exactly 1 row, so top
   * and bottom both resolve to that one province: it reads as
   * simultaneously "best" AND "worst", which is not a ranking at all. The
   * render site (RegionRankingTable) uses this to decide whether best/worst
   * framing is honest for the current scope.
   *
   * RA-3 finding C7: this counts PUBLISHABLE provinces only. A scope holding 5
   * provinces of which 3 are withheld can rank 2, and "Mayor"/"Menor" over 2 rows
   * is the same dishonesty claim #2 named — so the withheld ones must not prop
   * the count up.
   */
  totalProvinces: number;
  /**
   * Provinces withheld by the D.10 rule (RA-3 finding C7). The render site MUST
   * announce this number via `provinceSuppressionNotice` — #40's own follow-up
   * shipped a fully hatched map with `suppressedCount: 0`, hiding the data and
   * telling nobody, which is strictly worse than publishing it because an
   * operator reads absence as "no pasa nada acá".
   */
  suppressedCount: number;
};

/**
 * Compute per-province rabies vaccination coverage and return the top / bottom 5.
 *
 * Source:
 *  - Denominator: pets with status 'active' or 'lost' per province.
 *  - Numerator: distinct pet IDs with ≥1 vaccination_administered where
 *    vaccine_name accent-insensitively matches "%rabi%" (same unaccent logic
 *    as fetchAnalyticsMetrics).
 *
 * Scope: admin sees all provinces; govt sees only their assigned provinces.
 * When a province has 0 active/lost pets it is excluded from the ranking
 * (coveragePct would be undefined / divide-by-zero).
 *
 * SUPPRESSION (RA-3 finding C7, fixed 2026-07-31). This fetcher published
 * `coveragePct` per province with no k-anon and no notice, and threw the
 * denominator away: 3 dogs / 1 vaccinated shipped a confident "33%", 1 dog / 0
 * doses shipped "0%". A RATE REVEALS ITS DENOMINATOR — the retired premise
 * ("province cells are large") is true of a province's population and false of
 * its padrón, which is exactly why `provinceCell`'s denominator parameter is
 * obligatory and why `ProvinceDenominatorRow` demands one here too. `bottom`
 * sorts ASCENDING, so the smallest padrones surfaced FIRST: the sub-k cells were
 * the ones most likely to be on screen.
 *
 * The rule is `planProvinceDisclosure` — the SAME decider /gob/censo and
 * /gob/poblacion use, not a second k. Consequences, in order:
 *  · k is applied to the DENOMINATOR (`count`), never to the rate. The rate is
 *    the thing the denominator makes safe to publish.
 *  · D.10 SURVIVES: a govt operator's own province is never a candidate, so a
 *    3-pet jurisdiction still sees its own row. Blanket k here would have blinded
 *    an operator about their own administrados AND put this surface at odds with
 *    /gob/censo for the same viewer in the same session.
 *  · An admin — including one drilled in via `?province=` — owns no province at
 *    this grain, so every cell is foreign and ordinary k applies.
 *  · A withheld province is EXCLUDED from `top`/`bottom` rather than ranked with
 *    a null: a rank is a statement about a value, and there is no value to state.
 *    Its absence is not a channel because `suppressedCount` announces it out
 *    loud, in the same words every other tier uses, and the notice's stated
 *    reason ("menos de k mascotas") is exactly why it left.
 */
export async function fetchRegionRanking(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  opts: { adminProvince?: string; adminLocality?: string } = {},
): Promise<RegionRankingResult> {
  if (actor.role === "govt" && jurisdictions.length === 0) {
    return { top: [], bottom: [], totalProvinces: 0, suppressedCount: 0 };
  }

  // Build scope filter for the pets table (whole-province subsumption included).
  const petsScope = regionRankingPetsScope(
    actor,
    jurisdictions,
    opts.adminProvince,
    opts.adminLocality,
  );

  // 1. Total active+lost pets per province.
  const totalConditions = [sql`${pets.status} IN ('active', 'lost')`];
  if (petsScope) totalConditions.push(sql`(${petsScope})`);

  const totalRows = await db
    .select({ province: pets.jurisdictionProvince, n: count() })
    .from(pets)
    .where(and(...totalConditions))
    .groupBy(pets.jurisdictionProvince);

  if (totalRows.length === 0) return { top: [], bottom: [], totalProvinces: 0, suppressedCount: 0 };

  const provinceNames = totalRows
    .filter((r) => r.province !== null)
    .map((r) => r.province as string);

  // 2. Distinct pets with ≥1 rabies vaccination, restricted to provinces we found above.
  const rabiesConditions = [
    eq(petEvents.eventType, "vaccination_administered"),
    // Amendment overlay (audit A2): rank provinces by the CURRENT vaccine name.
    sql`unaccent(${amendedPayloadText("vaccine_name")}) ILIKE unaccent(${"%rabi%"})`,
    sql`${pets.status} IN ('active', 'lost')`,
    inArray(pets.jurisdictionProvince, provinceNames),
  ];
  if (petsScope) rabiesConditions.push(sql`(${petsScope})`);

  const rabiesRows = await db
    .select({ province: pets.jurisdictionProvince, n: countDistinct(petEvents.petId) })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(and(...rabiesConditions))
    .groupBy(pets.jurisdictionProvince);

  const rabiesByProvince = new Map<string, number>();
  for (const r of rabiesRows) {
    if (r.province) rabiesByProvince.set(r.province, r.n);
  }

  // 3. Build candidate rows — only provinces with totalPets > 0.
  const candidates: UnrankedRow[] = totalRows
    .filter((r) => r.province !== null && r.n > 0)
    .map((r) => {
      const prov = r.province as string;
      const total = r.n;
      const vaccinated = rabiesByProvince.get(prov) ?? 0;
      const coveragePct = Math.round((vaccinated / total) * 100);
      return {
        province: prov,
        code: PROVINCE_ISO_MAP[prov] ?? "",
        value: coveragePct,
        count: total,
      };
    });

  // 4. Apply the D.10 verdict and rank what survives.
  return applyRankingDisclosure(actor, jurisdictions, candidates);
}

/**
 * The pure half of `fetchRegionRanking` — raw per-province (rate, padrón) rows
 * in, D.10 verdict + ranked result out.
 *
 * Exported for the same two reasons `applyCoverageDisclosure` and
 * `applyRegistryDisclosure` are: the rule becomes unit-testable without Postgres,
 * and the test pins the SAME function production runs rather than a re-statement
 * of it that can drift.
 */
export function applyRankingDisclosure(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  candidates: readonly UnrankedRow[],
): RegionRankingResult {
  // THE D.10 VERDICT (RA-3 C7), decided on the DENOMINATOR by the shared rule.
  // `count` is the province's active/lost padrón: the base
  // `ProvinceDenominatorRow.denominator` is contracted to carry, and the exact
  // quantity a published rate hands back. `buildProjectionScope` is the one scope
  // model (context.ts) — this file does not define a second one, and deliberately
  // does not consult `adminProvince`: an admin drill is a URL parameter, not an
  // assignment, so it narrows the rows and changes nothing about the verdict.
  const plan = planProvinceDisclosure(
    { scope: buildProjectionScope(actor, jurisdictions) },
    candidates.map((r) => ({ province: r.province, denominator: r.count })),
  );

  // Withheld provinces leave the ranking entirely — see the fetcher docblock.
  const unranked = candidates.filter((r) => !plan.withheld.has(r.province));

  const topRanked = rankByField([...unranked], "value", "desc", 5);
  const bottomRanked = rankByField([...unranked], "value", "asc", 5);

  function toResult(rows: RankedRow[]): RegionRankingRow[] {
    return rows.map((r) => ({ ...r, coveragePct: r.value }));
  }

  return {
    top: toResult(topRanked),
    bottom: toResult(bottomRanked),
    totalProvinces: unranked.length,
    suppressedCount: plan.suppressedCount,
  };
}
