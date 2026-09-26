// Panorama infrastructure repository — CHOROPLETH layers (rabies/sterilization/
// microchip/ppp/mortality/vet-access/deworming coverage, at locality + province
// grain) plus the territorial index and tendencia (delta) province loaders.
//
// Extracted mechanically from repository.ts (file-size split, behavior-
// preserving): every loader here is unchanged, only moved. Scope-clause,
// event-predicate, and province/geo shaping helpers now live in ./repository-scope.

import {
  type SQL,
  and,
  asc,
  countDistinct,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  lte,
  sql,
} from "drizzle-orm";

import { arLocalities, analyticsDb as db, petEvents, pets } from "@/db";
import {
  PPP_ATTESTED_EVIDENCE,
  fetchMicrochipPenetrationByProvince,
  fetchPppComplianceByProvince,
} from "@/lib/analytics/compliance-metrics";
import { fetchRabiesCoverageByProvince } from "@/lib/analytics/govt-home-kpis";
import { computeJurisdictionIndex } from "@/lib/analytics/territorial-index";
import {
  type DashboardActor,
  type DashboardJurisdiction,
  buildProjectionContext,
  complementarySuppress,
  fetchCrossJurisdictionOutliers,
  rabiesVaccinatedExists,
  suppressSmallCells,
} from "@/lib/metrics";
import { deltaCells } from "@/lib/metrics/anonymity";
import { fetchDewormingCoverage } from "@/lib/metrics/deworming";
import { windows } from "@/lib/metrics/period";
import { fetchSterilizationCoverage } from "@/lib/metrics/population-control";
import {
  VET_ACTIVITY_EVENT_TYPES,
  fetchVetAccessByLocality,
  perThousand,
} from "@/lib/metrics/vet-access";
import type {
  ChoroplethCell,
  ProvinceChoroplethCell,
} from "@/src/modules/panorama/application/build-features";
import {
  aggregateCellsToDepartment,
  provinceCell,
  provinceCellPreDecided,
} from "@/src/modules/panorama/application/build-features";
import type { TimeBasis } from "@/src/modules/panorama/domain/time-scrub";
import type { AggregationLevel } from "@/src/modules/panorama/domain/types";

import {
  type AttributionMode,
  catalogueJoin,
  groupedLocality,
  groupedLocalityId,
  panoramaAttributionMode,
  rollupKey,
} from "./place-attribution";
import {
  PER_LAYER_CAP,
  PROVINCE_ISO,
  type RollupRow,
  eventWindowCol,
  normNameSql,
  petsScope,
  provinceIsoMapSql,
  provinceRepresentativeCentroid,
} from "./repository-scope";

// ---------------------------------------------------------------------------
// Choropleth: per-locality rollups → division polygon fill (scoped) or centroid.
//
// For a single-province scope the map now HAS division polygons (CABA barrios;
// departamentos elsewhere) and fills them by joining these cells to the divisions
// (see components/panorama/division-fill.ts). The centroid circle is retained as
// the fallback for a cell with no polygon match (and for the national view, where
// no divisions are loaded). Each rollup is grouped by (province, locality), joined
// to the ar_localities centroid + department code, then routed through
// suppressSmallCells (k=5).
// Suppressed cells are emitted WITH a flag and WITHOUT the real value so the map
// can render them muted. Visible cells carry the real value.
// ---------------------------------------------------------------------------

/** Shared rollup → suppressed ChoroplethCell[] transform. The numerator counts
 * are passed through suppressSmallCells(k=5): cells with count < 5 are emitted
 * suppressed (no value), the rest carry the real value. */
function toChoroplethCells(rollup: RollupRow[]): {
  cells: ChoroplethCell[];
  suppressedCount: number;
} {
  const primary = suppressSmallCells(rollup, {
    count: (r) => r.count,
    key: (r) => r.key,
  });
  // Complementary suppression (differencing-attack defense): when the SEPARATE
  // province-level choropleth's own total for this province is VISIBLE (not
  // itself k-anon suppressed — see ProvinceChoroplethRows below and
  // `provinceCell` in build-features.ts, task #40), a lone suppressed
  // department here leaks its exact count by subtraction against that total.
  // (The retired premise — "the province total is published unsuppressed,
  // full stop" — must not be re-cited; lib/metrics/anonymity.ts's
  // complementarySuppress docblock records why.) Also suppress the
  // next-smallest visible department in that province so no lone hidden cell
  // survives. Grouped by province — the coarser aggregate an attacker could
  // subtract against.
  const { visible, suppressed } = complementarySuppress(
    primary.visible as unknown as readonly RollupRow[],
    primary.suppressed,
    { group: (r) => r.province, count: (r) => r.count },
  );
  const suppressedCount = suppressed.length;

  const cells: ChoroplethCell[] = [];
  // Visible cells carry the real value. The rows are RollupRow objects that
  // suppressSmallCells / complementarySuppress partitioned.
  for (const r of visible) {
    cells.push({
      key: r.key,
      province: r.province,
      locality: r.locality,
      centroidLat: r.centroidLat,
      centroidLng: r.centroidLng,
      departmentCode: r.departmentCode ?? null,
      departmentName: r.departmentName ?? null,
      value: r.count,
      suppressed: false,
    });
  }
  // Suppressed cells: keep the location AND the department code so the division
  // can still render an OUTLINE (never a fill) for a suppressed departamento;
  // the value is null — the real count never leaves the repository for these.
  for (const r of suppressed) {
    cells.push({
      key: r.key,
      province: r.province,
      locality: r.locality,
      centroidLat: r.centroidLat,
      centroidLng: r.centroidLng,
      departmentCode: r.departmentCode ?? null,
      departmentName: r.departmentName ?? null,
      value: null,
      suppressed: true,
    });
  }
  return { cells, suppressedCount };
}

/** Result envelope for a LOCALITY choropleth loader (centroid graduated symbols). */
export type ChoroplethRows = {
  cells: ChoroplethCell[];
  suppressedCount: number;
  /**
   * Pets matching the metric that have a province but NO locality — counted
   * at province level, invisible at locality level (the rollup filters
   * jurisdiction_locality IS NOT NULL because it can only paint geocodable
   * cells). Surfaced so the UI can disclose the residual instead of letting
   * the two aggregation levels silently disagree (task #44; found when the
   * 2026-07-04 reconciliation pushed deceased counts past the visible layer).
   */
  noLocalityCount: number;
  truncated: boolean;
};

/** Result envelope for a PROVINCE choropleth loader (filled polygons; U5).
 *
 * PROVINCE CELLS **ARE** SUPPRESSIBLE — this comment used to say the opposite
 * ("province cells are large, so there is USUALLY no suppressedCount"). Task #40
 * invalidated that premise: k-anonymity protects the cell's DENOMINATOR, not its
 * population, so a RATE province over 11 dogs is suppressed exactly like a
 * sub-k department (see `provinceCell` in build-features.ts, whose obligatory
 * `denominator` parameter is the enforcement). Every province loader can emit
 * `suppressed: true` cells, and the count is therefore REQUIRED: a fully-hatched
 * province map that reported 0 left the AllSuppressedNotice card and the
 * LayerPanel footer silent — the values were protected, the operator was not
 * told. Required, not optional, so the compiler enumerates the sites. */
export type ProvinceChoroplethRows = {
  cells: ProvinceChoroplethCell[];
  truncated: boolean;
  /** Cells withheld by the k-anon primitives (provinceCell / suppressSmallCells /
   * suppressDelta). The use-case envelope surfaces it so the LayerPanel and the
   * all-suppressed notice can disclose the count. */
  suppressedCount: number;
};

/** Count the k-anon-withheld cells in a province rollup. The cells already carry
 * the decision (`provinceCell` / `provinceCellPreDecided` made it); this only
 * reports it, so the count can never disagree with what the map paints. */
function countSuppressed(cells: readonly ProvinceChoroplethCell[]): number {
  let n = 0;
  for (const c of cells) if (c.suppressed) n++;
  return n;
}

// ---------------------------------------------------------------------------
// U5 — ONE rollup, parametrized by aggregation LEVEL (province | locality).
//
// Both levels share the SAME metric predicate (the `whereExtra` SQL) and the
// SAME scope clause, differing ONLY in the GROUP BY and (for locality) the
// ar_localities centroid join. This is what GUARANTEES the consistency
// invariant the spec asserts: a province total is exactly the sum of its
// localities, because both count the identical set of pets — just grouped
// coarser. Both count COUNT(DISTINCT pets.id) so the locality centroid
// leftJoin fan-out can never make the two disagree.
// ---------------------------------------------------------------------------

/** The supported choropleth metrics.
 *  RATE metrics (rabies-coverage, sterilization-coverage): value = ratePct (0-100).
 *  DENSITY metrics (mortality): value = raw count.
 *  The distinction matters for the divergent choropleth scale: rate layers anchor
 *  at complianceTarget (a percentage), so value MUST be a percentage too. */
export type ChoroplethMetric =
  | "rabies-coverage"
  | "sterilization-coverage"
  | "microchip-penetration"
  | "ppp-compliance"
  | "mortality"
  | "vet-access"
  | "deworming";

/** Build the metric-specific pets predicate for LOCALITY-level loaders.
 * Defined ONCE so province and locality rollups can NEVER drift apart on the
 * numerator definition (U5).
 * For RATE metrics at LOCALITY level (count-density, v1 limitation) this is the
 * numerator predicate. For DENSITY metrics (mortality) this IS the full predicate.
 * Province-level RATE metrics delegate to the canonical fetchers instead of using
 * this predicate — see loadRabiesCoverageByProvince and
 * loadSterilizationCoverageByProvince. */
export function metricPredicate(metric: ChoroplethMetric, signedOnly = false): SQL {
  if (metric === "rabies-coverage") {
    // DOGS in scope with at least one qualifying rabies vaccination in the
    // trailing-12-month window. Uses the SHARED rabiesVaccinatedExists predicate
    // (lib/metrics/rabies.ts) so the locality numerator is the SAME definition as
    // the national KPI, the province breakdown, and the /admin panel (C3).
    // Before C3 this was `ILIKE '%rabi%'` (accent-SENSITIVE → silently missed the
    // canonical form "Antirrábica"), over ALL species and ALL time — three ways
    // adrift from the canonical rabies_coverage_dogs_12m numerator.
    // `signedOnly` (task #78 Part 3) narrows the numerator to vet-signed doses via
    // the same rabiesVaccinatedExists option the KPI uses — one definition.
    const win = windows.trailing12m();
    return sql`(${pets.species} = 'dog' AND ${rabiesVaccinatedExists(sql`${pets.id}`, win, { signedOnly })})`;
  }
  if (metric === "sterilization-coverage") {
    // Pets in scope with at least one sterilization_performed event.
    // Mirrors fetchSterilizationCoverage in lib/metrics/population-control.ts EXACTLY
    // (same EXISTS pattern, same event_type) to guarantee parity between the
    // Panorama choropleth and the /gob/poblacion dashboard number.
    // sterilization_performed is a real event type (confirmed in db/schema.ts +
    // app/actions/pregnancy.ts in the Paquete G implementation).
    return sql`EXISTS (
      SELECT 1 FROM ${petEvents} pe_steril
      WHERE pe_steril.pet_id = ${pets.id}
        AND pe_steril.event_type = 'sterilization_performed'
    )`;
  }
  if (metric === "microchip-penetration") {
    // Active pets with an ACTIVE microchip_iso identification — same numerator
    // as fetchMicrochipPenetration (lib/analytics/compliance-metrics.ts, C1).
    return sql`EXISTS (
      SELECT 1 FROM pet_identifications pi
      WHERE pi.pet_id = ${pets.id}
        AND pi.kind = 'microchip_iso'
        AND pi.status = 'active'
    )`;
  }
  if (metric === "ppp-compliance") {
    // PPP-flagged pets with an attestation THAT COUNTS — the same numerator as
    // fetchDangerousBreedCompliance (C7), and since T4-I1 / #753 that is no
    // longer the same thing as "has an attestation row".
    //
    // THE SHARED FRAGMENT AND NOT A THIRD COPY. This predicate used to spell
    // the numerator out and carry a comment claiming it matched C7; when C7
    // gained the evidence rule, the claim silently became false and this map
    // layer would have shaded a province greener than the KPI tile beside it,
    // in the same console. Importing `PPP_ATTESTED_EVIDENCE` is what makes the
    // comment above true by construction instead of by inspection.
    //
    // The subquery alias is `pe` because the fragment's column references are
    // written against that name (it is inlined into C7's own `EXISTS ... pet_events
    // pe`). Renaming it here is the whole cost of sharing, and an alias
    // mismatch is a Postgres error at query time rather than a wrong number.
    return sql`${pets.potentiallyDangerousBreed} = true AND EXISTS (
      SELECT 1 FROM ${petEvents} pe
      WHERE pe.pet_id = ${pets.id}
        AND pe.event_type = 'dangerous_breed_attested'
        AND ${PPP_ATTESTED_EVIDENCE}
    )`;
  }
  if (metric === "vet-access") {
    // LOCALITY count-density numerator: active pets in scope with ≥1 VETERINARY
    // ACT (VET_ACTIVITY_EVENT_TYPES — the SAME definition the province rate uses
    // via fetchVetAccessByLocality, so the two tiers cannot drift) in the
    // trailing-12m window. This is the count-density interim for the locality
    // tier (the rate view is province-only via loadVetAccessByProvince),
    // mirroring the rabies/sterilization v1 asymmetry.
    const win = windows.trailing12m();
    const types = sql.join(
      VET_ACTIVITY_EVENT_TYPES.map((t) => sql`${t}`),
      sql`, `,
    );
    return sql`EXISTS (
      SELECT 1 FROM ${petEvents} pe_vet
      WHERE pe_vet.pet_id = ${pets.id}
        AND pe_vet.event_type IN (${types})
        AND pe_vet.occurred_at >= ${win.since.toISOString()}
        AND pe_vet.occurred_at <= ${win.until.toISOString()}
    )`;
  }
  if (metric === "deworming") {
    // LOCALITY count-density numerator: active pets in scope with ≥1
    // deworming_administered event in the trailing-12m window. Mirrors
    // fetchDewormingCoverage (lib/metrics/deworming) EXACTLY (same event_type +
    // fixed 12m window) so the locality count and the province rate share one
    // numerator definition. The province RATE is delegated to that fetcher; this
    // predicate is the count-density interim for the drilled-in division.
    const win = windows.trailing12m();
    return sql`EXISTS (
      SELECT 1 FROM ${petEvents} pe_deworm
      WHERE pe_deworm.pet_id = ${pets.id}
        AND pe_deworm.event_type = 'deworming_administered'
        AND pe_deworm.occurred_at >= ${win.since.toISOString()}
        AND pe_deworm.occurred_at <= ${win.until.toISOString()}
    )`;
  }
  // mortality — pets currently in status='deceased'.
  return sql`${pets.status} = 'deceased'`;
}

/** Count metric-matching pets that are invisible to the locality rollup:
 * province set, locality NULL. Same predicate + scope as the rollup so the
 * two numbers reconcile exactly (see choropleth-by-level.test.ts). */
async function countPetsNoLocality(whereExtra: SQL[], scopeClause: SQL | null): Promise<number> {
  const conditions = [
    ...whereExtra,
    isNotNull(pets.jurisdictionProvince),
    sql`${pets.jurisdictionLocality} IS NULL`,
  ];
  if (scopeClause) conditions.push(sql`(${scopeClause})`);
  const [row] = await db
    .select({ n: countDistinct(pets.id) })
    .from(pets)
    .where(and(...conditions));
  return row?.n ?? 0;
}

/**
 * Per-PROVINCE breakdown of the metric's no-locality residual (province set,
 * locality NULL) — the WARNING-4 pets invisible to the department grain. Same
 * `metricPredicate` + `petsScope` as the choropleth loaders, grouped by province,
 * so the numbers reconcile exactly with `countPetsNoLocality` (whose national
 * total is this summed over provinces).
 *
 * Added for the aggregate cube (migration 0139): the TS cube-builder stores each
 * province's residual on the province-grain rows so the cube reader can reproduce
 * the loader's `noLocalityCount` for both the national view (sum) and a
 * province drill (that province's value) WITHOUT a live query. Lives here so the
 * scope-aware SELECT stays inside the repository (the module's single @/db seam).
 */
export async function noLocalityByProvince(
  metric: ChoroplethMetric,
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): Promise<{ province: string; count: number }[]> {
  const scope = petsScope(actor, jurisdictions, adminProvince, adminLocality);
  const conditions = [
    metricPredicate(metric),
    isNotNull(pets.jurisdictionProvince),
    sql`${pets.jurisdictionLocality} IS NULL`,
  ];
  if (scope) conditions.push(sql`(${scope})`);
  const rows = await db
    .select({ province: pets.jurisdictionProvince, n: countDistinct(pets.id) })
    .from(pets)
    .where(and(...conditions))
    .groupBy(pets.jurisdictionProvince);
  return rows
    .filter((r) => r.province !== null)
    .map((r) => ({ province: r.province as string, count: r.n }));
}

// Build the per-locality rollup join. `whereExtra` adds the metric-specific
// predicate (e.g. rabies vaccination). `scopeClause` is the pets-scope clause.
//
// EXPORTED for one reason: the cap's determinism contract (largest-first,
// totally ordered) is only observable AT THIS GRAIN. Every loader folds these
// rows to departments and then k-anon-suppresses them, which erases both the
// ordering and the identity of the localities the cap dropped — a test written
// against a loader cannot tell "the cap kept the biggest" from "the cap kept
// whatever". Not part of the module's public surface: it is deliberately absent
// from the ./repository barrel, and no production caller outside this file uses
// it. See __tests__/choropleth-rollup-determinism.test.ts.
export async function rollupPetsPerLocality(
  whereExtra: SQL[],
  scopeClause: SQL | null,
  // localidades-por-id D6: the `panorama` flag picks the attribution path;
  // `mode` / `exec` let the fences ask a path inside a rolled-back transaction.
  opts: { mode?: AttributionMode; exec?: AnalyticsExecutor } = {},
): Promise<RollupRow[]> {
  const conditions = [...whereExtra, isNotNull(pets.jurisdictionLocality)];
  if (scopeClause) conditions.push(sql`(${scopeClause})`);
  const exec = opts.exec ?? db;
  const mode = opts.mode ?? (await panoramaAttributionMode());
  if (mode === "id") return rollupPetsPerLocalityById(exec, conditions);

  // AGGREGATE-THEN-RESOLVE (perf). Aggregate pets by (province, locality) FIRST,
  // with NO ar_localities join, so the expensive metric predicate is evaluated
  // once per pet and the result collapses to ≈one row per raw locality string
  // (~705 for Buenos Aires). Joining ar_localities BEFORE this grouping made the
  // planner nested-loop the whole ar_localities partition for every candidate pet
  // (~millions of unaccent()/regexp evals → ~15-20s, past the 8s budget).
  const agg = exec
    .select({
      province: pets.jurisdictionProvince,
      locality: pets.jurisdictionLocality,
      // COUNT(DISTINCT pets.id) computed pre-join: no ar_localities fan-out can
      // reach it, so the count is exact by construction (no double-counting).
      n: countDistinct(pets.id).as("n"),
    })
    .from(pets)
    .where(and(...conditions))
    .groupBy(pets.jurisdictionProvince, pets.jurisdictionLocality)
    // WHICH localities survive the cap is a PRODUCT decision, not the planner's
    // (PO 2026-08-05). Without an ORDER BY, `LIMIT` keeps whatever rows the
    // aggregate happened to emit first, so the national + department view could
    // serve a DIFFERENT subset on two consecutive loads of the same data — the
    // map flickered cells in and out and nobody could tell a real change from a
    // reshuffle. `n DESC` keeps the LARGEST localities, the ones whose omission
    // would distort the picture most, and makes the truncated set a function of
    // the data alone.
    // The (province, locality) tiebreaker is what actually buys DETERMINISM:
    // counts tie constantly in the tail (dozens of localities at n=1), and
    // `n DESC` alone would still let the planner choose among equals. The pair
    // is the group key, hence unique per row — a total order, no residual
    // ambiguity at the cap boundary.
    // COST: the grouped set is already fully materialized by the aggregate
    // (~1-3k rows), so this adds one top-N sort over it, not a re-scan.
    .orderBy(
      desc(countDistinct(pets.id)),
      asc(pets.jurisdictionProvince),
      asc(pets.jurisdictionLocality),
    )
    .limit(PER_LAYER_CAP)
    .as("agg");

  // RESOLVE. Join ONLY the grouped rows to ar_localities on the sargable
  // normalized-name column (migration 0146): each locality is an index scan on
  // (province_code, locality_name_norm), not a full-partition scan per pet. MIN()
  // still pins ONE deterministic centroid/department per cell — an ambiguous
  // INDEC (province, name) pair matching several rows can no longer inflate the
  // count (already fixed above), only the resolved centroid, unchanged.
  const rows = await exec
    .select({
      province: agg.province,
      locality: agg.locality,
      centroidLat: sql<string | null>`MIN(${arLocalities.latitude})`,
      centroidLng: sql<string | null>`MIN(${arLocalities.longitude})`,
      departmentCode: sql<string | null>`MIN(${arLocalities.departmentCode})`,
      departmentName: sql<string | null>`MIN(${arLocalities.departmentName})`,
      n: agg.n,
    })
    .from(agg)
    .leftJoin(
      arLocalities,
      and(
        sql`${arLocalities.provinceCode} = ${provinceIsoMapSql(sql`${agg.province}`)}`,
        sql`${arLocalities.localityNameNorm} = ${normNameSql(sql`${agg.locality}`)}`,
        sql`${arLocalities.removedAt} IS NULL`,
      ),
    )
    .groupBy(agg.province, agg.locality, agg.n)
    // The subquery's ORDER BY decides WHICH rows survive the cap; it does not
    // survive the join (SQL preserves no ordering across one). Re-stating the
    // same total order here makes the RETURNED array deterministic too, which
    // matters downstream: `complementarySuppress` promotes "the smallest visible
    // sibling", and on a tie it takes whichever the iteration order reaches
    // first. Same rows in the same order → the same cell is promoted on every
    // load.
    .orderBy(desc(agg.n), asc(agg.province), asc(agg.locality));

  return rows
    .filter((r) => r.province !== null && r.locality !== null)
    .map((r) => ({
      key: `${r.province}|${r.locality}`,
      province: r.province as string,
      locality: r.locality as string,
      centroidLat: r.centroidLat,
      centroidLng: r.centroidLng,
      departmentCode: r.departmentCode,
      departmentName: r.departmentName,
      count: r.n,
    }));
}

type AnalyticsExecutor = Pick<typeof db, "select">;

/**
 * The ID PATH of rollupPetsPerLocality (localidades-por-id D6): grouped by
 * catalogue row, joined to ar_localities by id — each homonym is its own
 * cell in its own department; an unresolved pet lands in its province's
 * "Sin localidad" cell on the province's representative point. Same cap and
 * same total order as the name path.
 */
async function rollupPetsPerLocalityById(
  exec: AnalyticsExecutor,
  conditions: SQL[],
): Promise<RollupRow[]> {
  const cols = {
    province: sql`${pets.jurisdictionProvince}`,
    locality: sql`${pets.jurisdictionLocality}`,
    localityId: sql`${pets.localityId}`,
  };
  const groupedName = groupedLocality("id", cols);
  const groupedId = groupedLocalityId("id", cols);
  const agg = exec
    .select({
      province: pets.jurisdictionProvince,
      locality: sql<string>`${groupedName}`.as("locality"),
      localityId: sql<string | null>`${groupedId}`.as("locality_id"),
      n: countDistinct(pets.id).as("n"),
    })
    .from(pets)
    .where(and(...conditions))
    .groupBy(pets.jurisdictionProvince, groupedName, groupedId)
    .orderBy(
      desc(countDistinct(pets.id)),
      asc(pets.jurisdictionProvince),
      asc(groupedName),
      asc(groupedId),
    )
    .limit(PER_LAYER_CAP)
    .as("agg");
  const rows = await exec
    .select({
      province: agg.province,
      locality: agg.locality,
      localityId: agg.localityId,
      centroidLat: sql<string | null>`MIN(${arLocalities.latitude})`,
      centroidLng: sql<string | null>`MIN(${arLocalities.longitude})`,
      departmentCode: sql<string | null>`MIN(${arLocalities.departmentCode})`,
      departmentName: sql<string | null>`MIN(${arLocalities.departmentName})`,
      n: agg.n,
    })
    .from(agg)
    .leftJoin(
      arLocalities,
      catalogueJoin("id", {
        province: sql`${agg.province}`,
        locality: sql`${agg.locality}`,
        localityId: sql`${agg.localityId}`,
      }),
    )
    .groupBy(agg.province, agg.locality, agg.localityId, agg.n)
    .orderBy(desc(agg.n), asc(agg.province), asc(agg.locality), asc(agg.localityId));

  return rows
    .filter((r) => r.province !== null && r.locality !== null)
    .map((r) => {
      const unresolved = r.localityId === null;
      const centroid = unresolved
        ? provinceRepresentativeCentroid(r.province)
        : { centroidLat: r.centroidLat, centroidLng: r.centroidLng };
      return {
        key: rollupKey(r.province as string, r.locality as string, r.localityId),
        province: r.province as string,
        locality: r.locality as string,
        ...centroid,
        departmentCode: r.departmentCode,
        departmentName: r.departmentName,
        count: r.n,
      };
    });
}

/** A raw per-province rollup row before mapping to a ProvinceChoroplethCell. */
type ProvinceRollupRow = {
  province: string;
  count: number;
};

// Build the per-PROVINCE rollup. NO ar_localities join (provinces need no
// centroid — the basemap polygon is the geometry) and NO locality requirement.
// This returns RAW counts by design: k-anon is applied downstream by
// `provinceCell`, which needs the raw count as the denominator to decide with.
// Same metric predicate + scope as the locality rollup, grouped by province only
// — so the province total equals the sum of its localities.
async function rollupPetsPerProvince(
  whereExtra: SQL[],
  scopeClause: SQL | null,
): Promise<ProvinceRollupRow[]> {
  const conditions = [...whereExtra, isNotNull(pets.jurisdictionProvince)];
  if (scopeClause) conditions.push(sql`(${scopeClause})`);

  const rows = await db
    .select({
      province: pets.jurisdictionProvince,
      // COUNT(DISTINCT pets.id) to mirror the locality rollup exactly (no join
      // here, but keeping DISTINCT makes the two provably identical in count).
      n: countDistinct(pets.id),
    })
    .from(pets)
    .where(and(...conditions))
    .groupBy(pets.jurisdictionProvince)
    .limit(PER_LAYER_CAP);

  return rows
    .filter((r) => r.province !== null)
    .map((r) => ({ province: r.province as string, count: r.n }));
}

/**
 * The event types whose GROWTH means the situation got worse.
 *
 * Tendencia used to count every pet_event, and the four biggest types are
 * registry activity — pet_registered (66.858), vaccination_administered
 * (48.250), microchip_implanted (30.339), sterilization_performed (28.733), i.e.
 * ~174k of ~200k events. Growth there is GOOD, but the layer declares inverted
 * polarity ("more than before = warning pole"), so while adoption ramps the map
 * painted all 24 provinces as deteriorating (measured 2026-07-25: 24 up, 0
 * down). PO decision: restrict the delta to incidents (2026-07-25).
 *
 * HONEST LIMIT, measured on the same data — do not read this as "fixed":
 *   all events, raw            24 up / 0 down
 *   incidents only, raw        23 up / 1 down   ← this change
 *   incidents per padrón       18 up / 6 down
 * Incident REPORTING also grows with registry adoption, so the restriction
 * makes the metric mean the right thing without removing the confound. Only
 * normalising by the registered population does that, and it changes the
 * layer's unit from a count delta to a RATE delta — a product call, pending.
 */
const TENDENCIA_INCIDENT_EVENTS = [
  "incident_reported",
  "outbreak_signal",
  "disease_reported",
] as const;

/** Map a raw province density rollup to ProvinceChoroplethCell[] (resolve ISO
 * code + label). Provinces whose name has no ISO code are dropped — the basemap
 * can only fill a polygon it can join by code.
 *
 * k-anon (#40): on a DENSITY layer the value IS the population, so the count is
 * both the number painted and the denominator k protects — a province with
 * fewer than k registered/deceased pets is a group small enough to re-identify,
 * and publishing "3" names three animals. Suppressed cells stay in the array
 * (value null) so the map hatches them. */
function toProvinceChoroplethCells(rollup: ProvinceRollupRow[]): ProvinceChoroplethCell[] {
  const cells: ProvinceChoroplethCell[] = [];
  for (const r of rollup) {
    const code = PROVINCE_ISO[r.province];
    if (!code) continue;
    cells.push(provinceCell(code, r.province, r.count, r.count));
  }
  return cells;
}

// metrics:rabies-coverage (cobertura) — count of pets in scope with a valid
// rabies vaccination, at the LOCALITY level (centroid graduated symbols, k-anon).
// V1 LIMITATION: locality level uses count-density (not ratePct) because rate-by-
// locality needs k-anonymised num/den (both arms exposed → privacy leakage risk when
// suppressed). The divergent-vs-meta rendering is PROVINCE-ONLY (province choropleth
// renders ratePct; locality renders count). This is a known v1 limitation; a future
// version should provide k-anon'd num+den at locality level for rate rendering.
export async function loadRabiesCoverage(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
  // task #78 Part 3: narrow the numerator to vet-signed doses (panorama toggle).
  verifiedOnly = false,
): Promise<ChoroplethRows> {
  const scope = petsScope(actor, jurisdictions, adminProvince, adminLocality);
  const predicate = metricPredicate("rabies-coverage", verifiedOnly);
  const [rollup, noLocalityCount] = await Promise.all([
    rollupPetsPerLocality([predicate], scope),
    countPetsNoLocality([predicate], scope),
  ]);
  // Detail tier (PO "Option A"): fold the per-locality rollup up to the
  // department — the barrio for CABA — so the DATA + k-anon unit matches the
  // division polygon the map actually draws. k=5 then applies at the department,
  // which clears the threshold far more often than the near-always-suppressed
  // locality cells did. `truncated` still reflects the LOCALITY query cap (the
  // fold only reduces the cell count).
  const { cells, suppressedCount } = toChoroplethCells(aggregateCellsToDepartment(rollup));
  return { cells, suppressedCount, noLocalityCount, truncated: rollup.length >= PER_LAYER_CAP };
}

// metrics:sterilization-coverage (esterilizacion) — count of sterilized pets at the
// LOCALITY level (centroid graduated symbols, k-anon).
// V1 LIMITATION: locality level uses count-density (not ratePct) — same reason as
// loadRabiesCoverage above. The divergent-vs-meta rendering is PROVINCE-ONLY in v1;
// rate-by-locality (k-anon'd num/den) is deferred. See loadSterilizationCoverageByProvince
// for the correct rate rendering at province level.
export async function loadSterilizationCoverage(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): Promise<ChoroplethRows> {
  const scope = petsScope(actor, jurisdictions, adminProvince, adminLocality);
  const [rollup, noLocalityCount] = await Promise.all([
    rollupPetsPerLocality([metricPredicate("sterilization-coverage")], scope),
    countPetsNoLocality([metricPredicate("sterilization-coverage")], scope),
  ]);
  // Detail tier (PO "Option A"): fold the per-locality rollup up to the
  // department — the barrio for CABA — so the DATA + k-anon unit matches the
  // division polygon the map actually draws. k=5 then applies at the department,
  // which clears the threshold far more often than the near-always-suppressed
  // locality cells did. `truncated` still reflects the LOCALITY query cap (the
  // fold only reduces the cell count).
  const { cells, suppressedCount } = toChoroplethCells(aggregateCellsToDepartment(rollup));
  return { cells, suppressedCount, noLocalityCount, truncated: rollup.length >= PER_LAYER_CAP };
}

// metrics:microchip-penetration (microchip) — count of chipped pets at the
// LOCALITY level (centroid graduated symbols, k-anon). Same v1 count-density
// limitation as rabies/sterilization above (rate-by-locality deferred).
export async function loadMicrochipCoverage(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): Promise<ChoroplethRows> {
  const scope = petsScope(actor, jurisdictions, adminProvince, adminLocality);
  const [rollup, noLocalityCount] = await Promise.all([
    rollupPetsPerLocality([metricPredicate("microchip-penetration")], scope),
    countPetsNoLocality([metricPredicate("microchip-penetration")], scope),
  ]);
  // Detail tier (PO "Option A"): fold the per-locality rollup up to the
  // department — the barrio for CABA — so the DATA + k-anon unit matches the
  // division polygon the map actually draws. k=5 then applies at the department,
  // which clears the threshold far more often than the near-always-suppressed
  // locality cells did. `truncated` still reflects the LOCALITY query cap (the
  // fold only reduces the cell count).
  const { cells, suppressedCount } = toChoroplethCells(aggregateCellsToDepartment(rollup));
  return { cells, suppressedCount, noLocalityCount, truncated: rollup.length >= PER_LAYER_CAP };
}

// metrics:ppp-compliance (ppp) — count of attested PPP-flagged pets at the
// LOCALITY level (centroid graduated symbols, k-anon). Same v1 count-density
// limitation as rabies/sterilization above (rate-by-locality deferred).
export async function loadPppCompliance(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): Promise<ChoroplethRows> {
  const scope = petsScope(actor, jurisdictions, adminProvince, adminLocality);
  const [rollup, noLocalityCount] = await Promise.all([
    rollupPetsPerLocality([metricPredicate("ppp-compliance")], scope),
    countPetsNoLocality([metricPredicate("ppp-compliance")], scope),
  ]);
  // Detail tier (PO "Option A"): fold the per-locality rollup up to the
  // department — the barrio for CABA — so the DATA + k-anon unit matches the
  // division polygon the map actually draws. k=5 then applies at the department,
  // which clears the threshold far more often than the near-always-suppressed
  // locality cells did. `truncated` still reflects the LOCALITY query cap (the
  // fold only reduces the cell count).
  const { cells, suppressedCount } = toChoroplethCells(aggregateCellsToDepartment(rollup));
  return { cells, suppressedCount, noLocalityCount, truncated: rollup.length >= PER_LAYER_CAP };
}

// metrics:mortality (mortalidad) — count of pets in scope currently in
// status='deceased', at the LOCALITY level (centroid graduated symbols, k-anon).
export async function loadMortality(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): Promise<ChoroplethRows> {
  const scope = petsScope(actor, jurisdictions, adminProvince, adminLocality);
  const [rollup, noLocalityCount] = await Promise.all([
    rollupPetsPerLocality([metricPredicate("mortality")], scope),
    countPetsNoLocality([metricPredicate("mortality")], scope),
  ]);
  // Detail tier (PO "Option A"): fold the per-locality rollup up to the
  // department — the barrio for CABA — so the DATA + k-anon unit matches the
  // division polygon the map actually draws. k=5 then applies at the department,
  // which clears the threshold far more often than the near-always-suppressed
  // locality cells did. `truncated` still reflects the LOCALITY query cap (the
  // fold only reduces the cell count).
  const { cells, suppressedCount } = toChoroplethCells(aggregateCellsToDepartment(rollup));
  return { cells, suppressedCount, noLocalityCount, truncated: rollup.length >= PER_LAYER_CAP };
}

// metrics:vet-access (acceso-veterinario) — count of active pets with a vet visit
// in the trailing-12m window, at the LOCALITY level (centroid graduated symbols,
// k-anon), folded to the department (PO "Option A"). This is the count-density
// interim for the locality tier; the per-1.000 RATE is province-only (see
// loadVetAccessByProvince), the same asymmetry rabies/sterilization document.
export async function loadVetAccess(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): Promise<ChoroplethRows> {
  const scope = petsScope(actor, jurisdictions, adminProvince, adminLocality);
  const [rollup, noLocalityCount] = await Promise.all([
    rollupPetsPerLocality([metricPredicate("vet-access")], scope),
    countPetsNoLocality([metricPredicate("vet-access")], scope),
  ]);
  const { cells, suppressedCount } = toChoroplethCells(aggregateCellsToDepartment(rollup));
  return { cells, suppressedCount, noLocalityCount, truncated: rollup.length >= PER_LAYER_CAP };
}

// metrics:deworming (antiparasitario) — count of active pets with a deworming in
// the trailing-12m window, at the LOCALITY level (centroid graduated symbols,
// k-anon), folded to the department. Count-density interim; the coverage RATE is
// province-only (see loadDewormingCoverageByProvince), same asymmetry as the
// sterilization tier this clones.
export async function loadDewormingCoverage(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): Promise<ChoroplethRows> {
  const scope = petsScope(actor, jurisdictions, adminProvince, adminLocality);
  const [rollup, noLocalityCount] = await Promise.all([
    rollupPetsPerLocality([metricPredicate("deworming")], scope),
    countPetsNoLocality([metricPredicate("deworming")], scope),
  ]);
  const { cells, suppressedCount } = toChoroplethCells(aggregateCellsToDepartment(rollup));
  return { cells, suppressedCount, noLocalityCount, truncated: rollup.length >= PER_LAYER_CAP };
}

// U5: PROVINCE-level loaders. Used when the aggregation toggle is on "Provincia".
//
// RATE METRICS (rabies-coverage, sterilization-coverage): delegate to the canonical
// dashboard fetchers so the choropleth uses THE SAME denominator as the KPI tiles:
//   - sterilization: fetchSterilizationCoverage.byProvince → denominator = active pets
//     (activePetsCondition from lib/metrics/population). Numerator = active pets with
//     EXISTS sterilization_performed.
//   - rabies: fetchRabiesCoverageByProvince → denominator = DOGS only (species='dog').
//     Numerator = distinct dogs with a qualifying rabies vaccination event.
//
// The generic all-pets rollup (rollupRatePerProvince, previously used here) was
// rejected: it used COUNT(*) = ALL pets as the denominator, diverging from the
// canonical metrics (off by deceased pets for sterilization; off by all non-dog
// species for rabies). Parity is now guaranteed by reuse, not by local approximation.
//
// DENSITY metrics (mortality): keep raw count rollup (density, not a rate).

// metrics:rabies-coverage (cobertura) — per-province rabies rate via the canonical
// dogs-based fetcher. Delegates to fetchRabiesCoverageByProvince (lib/govt-home-kpis).
// value = ratePct (dogs-based %, matching the national KPI definition).
export async function loadRabiesCoverageByProvince(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
  // task #78 Part 3: narrow the numerator to vet-signed doses (panorama toggle).
  verifiedOnly = false,
): Promise<ProvinceChoroplethRows> {
  const ctx = buildProjectionContext(actor, jurisdictions, windows.trailing12m(), {
    adminProvince,
    adminLocality,
    verifiedOnly,
  });
  const byProvince = await fetchRabiesCoverageByProvince(ctx);
  const cells: ProvinceChoroplethCell[] = [];
  for (const r of byProvince) {
    const code = PROVINCE_ISO[r.province];
    if (!code) continue;
    // k-anon denominator = `total` (DOGS in scope), never `ratePct`: a province
    // with 3 dogs publishes 100% and the value alone looks large.
    cells.push(provinceCell(code, r.province, r.ratePct, r.total));
  }
  return {
    cells,
    truncated: byProvince.length >= PER_LAYER_CAP,
    suppressedCount: countSuppressed(cells),
  };
}

// metrics:sterilization-coverage (esterilizacion) — per-province sterilization rate
// via the canonical active-pets-based fetcher. Delegates to fetchSterilizationCoverage
// (lib/metrics/population-control). value = ratePct (active-pets denominator, matching
// /gob/poblacion). Parity guaranteed by reuse.
// V1 NOTE: locality-level sterilization coverage uses count-density (see
// loadSterilizationCoverage below) — rate-by-locality needs k-anonymised num/den
// which is deferred to v2.
export async function loadSterilizationCoverageByProvince(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): Promise<ProvinceChoroplethRows> {
  const ctx = buildProjectionContext(actor, jurisdictions, windows.trailing12m(), {
    adminProvince,
    adminLocality,
  });
  const { byProvince } = await fetchSterilizationCoverage(ctx);
  const cells: ProvinceChoroplethCell[] = [];
  for (const r of byProvince) {
    const code = PROVINCE_ISO[r.province];
    if (!code) continue;
    // The fetcher already applied the D.10 viewer-aware rule (lib/metrics/
    // province-disclosure.ts) and a withheld row has no numbers left to hand
    // `provinceCell` — carry that decision through instead of re-deriving it.
    // Panorama's verdict is UNCHANGED: D.10 only withholds a FOREIGN province
    // whose `total` is sub-k, and `provinceCell` withholds exactly that same
    // cell from that same denominator. Rows the fetcher kept are still decided
    // here, on `total`.
    if (r.suppressed) {
      cells.push(provinceCellPreDecided(code, r.province, null, true));
      continue;
    }
    // k-anon denominator = `total` (ACTIVE pets in scope), never `ratePct`.
    cells.push(provinceCell(code, r.province, r.ratePct, r.total));
  }
  return {
    cells,
    truncated: byProvince.length >= PER_LAYER_CAP,
    suppressedCount: countSuppressed(cells),
  };
}

// metrics:microchip-penetration (microchip) — per-province microchip rate via
// the canonical fetcher. Delegates to fetchMicrochipPenetrationByProvince
// (lib/analytics/compliance-metrics). value = ratePct (active-pets denominator,
// matching the C1 KPI). Parity guaranteed by reuse.
export async function loadMicrochipCoverageByProvince(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): Promise<ProvinceChoroplethRows> {
  const ctx = buildProjectionContext(actor, jurisdictions, windows.trailing12m(), {
    adminProvince,
    adminLocality,
  });
  const byProvince = await fetchMicrochipPenetrationByProvince(ctx);
  const cells: ProvinceChoroplethCell[] = [];
  for (const r of byProvince) {
    const code = PROVINCE_ISO[r.province];
    if (!code) continue;
    // k-anon denominator = `active` (ACTIVE pets in scope), never `ratePct`.
    cells.push(provinceCell(code, r.province, r.ratePct, r.active));
  }
  return {
    cells,
    truncated: byProvince.length >= PER_LAYER_CAP,
    suppressedCount: countSuppressed(cells),
  };
}

// metrics:ppp-compliance (ppp) — per-province PPP registry compliance via the
// canonical fetcher. Delegates to fetchPppComplianceByProvince
// (lib/analytics/compliance-metrics). value = ratePct (PPP-flagged-pets
// denominator, matching the C7 KPI). Parity guaranteed by reuse.
export async function loadPppComplianceByProvince(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): Promise<ProvinceChoroplethRows> {
  const ctx = buildProjectionContext(actor, jurisdictions, windows.trailing12m(), {
    adminProvince,
    adminLocality,
  });
  const byProvince = await fetchPppComplianceByProvince(ctx);
  const cells: ProvinceChoroplethCell[] = [];
  for (const r of byProvince) {
    const code = PROVINCE_ISO[r.province];
    if (!code) continue;
    // k-anon denominator = `flaggedCount` (PPP-flagged pets), never `ratePct`.
    // This is the SMALLEST denominator on the board: PPP-flagged pets are a rare
    // subset, so most provinces sit near k and the value is a compliance rate
    // about a handful of identifiable owners of a dangerous-breed dog.
    cells.push(provinceCell(code, r.province, r.ratePct, r.flaggedCount));
  }
  return {
    cells,
    truncated: byProvince.length >= PER_LAYER_CAP,
    suppressedCount: countSuppressed(cells),
  };
}

export async function loadMortalityByProvince(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): Promise<ProvinceChoroplethRows> {
  const scope = petsScope(actor, jurisdictions, adminProvince, adminLocality);
  const rollup = await rollupPetsPerProvince([metricPredicate("mortality")], scope);
  const cells = toProvinceChoroplethCells(rollup);
  return {
    cells,
    truncated: rollup.length >= PER_LAYER_CAP,
    suppressedCount: countSuppressed(cells),
  };
}

/**
 * The mortality rollup BEFORE province k-anon — RAW national counts.
 *
 * Exists for exactly one caller: the PUBLIC open-data `mortalidad` dataset,
 * which runs its OWN province suppression (`suppressDensityProvinces`, same
 * k=5, same denominator criterion) and needs the raw counts to do it PROPERLY.
 * Its rule is STRICTLY STRONGER than the map's: on top of the k=5 small-cell
 * rule it applies COMPLEMENTARY suppression — if exactly one province is
 * suppressed nationally, the next-smallest visible one is suppressed too, so the
 * hidden count cannot be recovered by subtracting the visible provinces from the
 * national total.
 *
 * Feeding that pipeline the already-suppressed map cells would have SILENTLY
 * WEAKENED the public file: with the sub-k rows nulled, `complementarySuppress`
 * sees zero suppressed cells and promotes no complement, and the differencing
 * defence quietly stops firing. Same k, same criterion, raw input — that is what
 * "aligned" means here, not "pre-suppressed twice".
 *
 * NOT a general-purpose export. Any other consumer must go through
 * `loadMortalityByProvince` and get the suppressed cells.
 */
export async function loadMortalityRawRollupByProvince(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
): Promise<ProvinceRollupRow[]> {
  const scope = petsScope(actor, jurisdictions);
  return rollupPetsPerProvince([metricPredicate("mortality")], scope);
}

// metrics:vet-access (acceso-veterinario) — per-PROVINCE visits-per-1.000-active-pets
// RATE via the canonical fetcher. Delegates to fetchVetAccessByLocality
// (lib/metrics/vet-access) and folds its k-anon survivors up to the province:
// sum visits + active pets, then recompute per1k with the SAME perThousand helper
// (parity with /gob/analytics by reuse). value = per1k (a magnitude, not a %; the
// layer renders on a sequential scale — there is no legal access target to anchor
// a divergent one). NOTE: k-anon-suppressed localities (<5 active pets) are dropped
// upstream, so a province rate is computed over its NON-suppressed localities only —
// a negligible bias at province grain (suppressed cells are, by construction, tiny),
// documented here so the number is never mistaken for a full-population rate.
export async function loadVetAccessByProvince(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): Promise<ProvinceChoroplethRows> {
  const ctx = buildProjectionContext(actor, jurisdictions, windows.trailing12m(), {
    adminProvince,
    adminLocality,
  });
  const { localities } = await fetchVetAccessByLocality(ctx);
  const byProvince = new Map<string, { visits: number; activePets: number }>();
  for (const r of localities) {
    const acc = byProvince.get(r.province) ?? { visits: 0, activePets: 0 };
    acc.visits += r.visits;
    acc.activePets += r.activePets;
    byProvince.set(r.province, acc);
  }
  const cells: ProvinceChoroplethCell[] = [];
  for (const [province, agg] of byProvince) {
    const code = PROVINCE_ISO[province];
    if (!code) continue;
    // k-anon denominator = `activePets`, the base the per-1.000 rate is taken
    // over. In practice this rarely bites (the locality fold upstream already
    // dropped sub-k localities, so a surviving province carries >= k), but the
    // rate is only SOUND because that is true — asserting it here is what keeps
    // it true if the upstream fold ever changes. This loader is NOT in the #40
    // handover's table of nine; the compiler found it as a tenth site.
    cells.push(
      provinceCell(code, province, perThousand(agg.visits, agg.activePets), agg.activePets),
    );
  }
  return { cells, truncated: false, suppressedCount: countSuppressed(cells) };
}

// metrics:tendencia — per-PROVINCE two-window event delta.
//
//   value = Δ = events(current window) − events(prior equivalent window)
//
// Both windows count ALL pet events (no type predicate) attributed to the pet's
// home province (pets JOIN — same attribution as the mordeduras/perdidas
// loaders). current = [since, until]; prior = the equal-length window ending
// where the current one starts: [since − len, since). `asOf` shifts `until`
// (temporal replay); `basis` picks occurred_at vs recorded_at.
//
// k-anon DIFFERENCING RULE (viz-suite wave 0): both windows go RAW into
// deltaCells — a cell with a protected (0 < n < 5) count in EITHER window
// publishes NO delta (suppressed; disclosed via suppressedCount). A count of
// exactly 0 is not protected, so "+N desde cero" stays as public as the visible
// current window. Suppressed cells emit NO cell at all (no-data on the map) —
// never a value the single-window rule protects.
export async function loadTendenciaByProvince(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  since: Date,
  asOf?: Date,
  adminProvince?: string,
  adminLocality?: string,
  basis: TimeBasis = "valid",
): Promise<ProvinceChoroplethRows> {
  const until = asOf ?? new Date();
  const priorSince = new Date(since.getTime() - (until.getTime() - since.getTime()));
  const scope = petsScope(actor, jurisdictions, adminProvince, adminLocality);
  const tcol = eventWindowCol(basis);

  const countWindow = async (from: Date, to: Date, openUpper: boolean) => {
    const conditions: SQL[] = [
      gte(tcol, from),
      openUpper ? lt(tcol, to) : lte(tcol, to),
      isNotNull(pets.jurisdictionProvince),
      inArray(petEvents.eventType, TENDENCIA_INCIDENT_EVENTS),
    ];
    if (scope) conditions.push(sql`(${scope})`);
    const rows = await db
      .select({ province: pets.jurisdictionProvince, n: countDistinct(petEvents.id) })
      .from(petEvents)
      .innerJoin(pets, eq(petEvents.petId, pets.id))
      .where(and(...conditions))
      .groupBy(pets.jurisdictionProvince)
      .limit(PER_LAYER_CAP);
    return rows.filter((r) => r.province).map((r) => ({ province: r.province as string, n: r.n }));
  };

  // Half-open prior window [priorSince, since) so no event is double-counted at
  // the boundary; the current window keeps the resolver's inclusive [since, until].
  const current = await countWindow(since, until, false);
  const prior = await countWindow(priorSince, since, true);

  const cells: ProvinceChoroplethCell[] = [];
  for (const c of deltaCells(current, prior, { key: (r) => r.province, count: (r) => r.n })) {
    const code = PROVINCE_ISO[c.key];
    if (!code) continue;
    const suppressed = c.suppressed || c.delta === null;
    // #40: a suppressed delta used to `continue` — the cell VANISHED. That is
    // itself a disclosure channel (a province that drops out between two frames
    // announces that one of its windows crossed k) and it made the map stipple
    // the province as "sin datos", i.e. "nadie reportó incidentes acá" — the
    // opposite of the truth, which is "hubo tan pocos que no se pueden publicar".
    // The cell is now EMITTED with a null value so the render hatches it.
    cells.push(provinceCellPreDecided(code, c.key, c.delta, suppressed));
  }
  // Counted off the EMITTED cells, not off the delta rows: a province with no ISO
  // code paints nothing, so counting it would disclose a cell that is not there.
  return { cells, truncated: false, suppressedCount: countSuppressed(cells) };
}

/** Active/lost pets — the live population every coverage share is taken over.
 *  Mirrors activePetsCondition (lib/metrics/population) without its ctx-bound
 *  scope clause, which this file supplies separately via petsScope. */
const ACTIVE_PETS: SQL = sql`${pets.status} IN ('active', 'lost')`;

/**
 * The ACTIVE-pet universe **as of `t`**, read from the spine rather than the
 * cache columns (PO decision D3, 2026-07-28).
 *
 * A replay used to move only the numerator: events were filtered to
 * [since, asOf] while the denominator stayed today's `pets.status`. So a pet
 * registered yesterday joined the denominator of a replay from six months ago,
 * and a pet that died last week was missing from a replay in which it was
 * alive. The screen claimed a replay the data supported by halves.
 *
 * Two facts, both from the event log:
 *   · it existed at t — a pet_registered event at or before t;
 *   · it was not dead at t — the LAST status_changed at or before t did not
 *     leave it deceased (no transition at all means it is still as registered).
 *
 * Deliberately NOT `pets.created_at` / `pets.status`: those are operational
 * caches, and a temporal replay decided by a column that only knows "now" is
 * the defect this closes, not a cheaper way to fix it.
 *
 * Only used when a cut is actually requested — the live view's population IS
 * today's, so it keeps the plain indexed predicate above.
 */
function activePetsAsOf(t: Date): SQL {
  // Bound as an ISO string, the convention this file already uses two hundred
  // lines up (`win.since.toISOString()`): the driver will not bind a Date
  // inside a raw template.
  const at = t.toISOString();
  return sql`
    EXISTS (
      SELECT 1 FROM ${petEvents} reg
      WHERE reg.pet_id = ${pets.id}
        AND reg.event_type = 'pet_registered'
        AND reg.occurred_at <= ${at}::timestamptz
    )
    AND COALESCE(
      (
        SELECT sc.payload->>'to_status' FROM ${petEvents} sc
        WHERE sc.pet_id = ${pets.id}
          AND sc.event_type = 'status_changed'
          AND sc.occurred_at <= ${at}::timestamptz
        -- THREE keys, not one. lib/projections/pet-status.ts declares the
        -- canonical order — "latest wins by occurredAt, then recordedAt, then
        -- id" — and delegates the sorting to its caller. This replay is a
        -- caller, and it honoured only the first key: with two status events at
        -- the SAME instant, LIMIT 1 returned whichever row the scan happened
        -- to hand back, so a pet could replay as lost here and active in the
        -- projection. Measured on staging 2026-08-01: 49 tied groups, 1 of them
        -- carrying CONTRADICTORY statuses (DIM-BLUE-0010, lost vs active at the
        -- same timestamp) — small today, and silently wrong rather than loud.
        -- Same shape as the /perdidas superset bug found this morning: an ORDER
        -- BY that does not totally order, with a LIMIT on top.
        ORDER BY sc.occurred_at DESC, sc.recorded_at DESC, sc.id DESC
        LIMIT 1
      ),
      'active'
    ) IN ('active', 'lost')
  `;
}

// metrics:vet-desert (desierto-veterinario) — per-PROVINCE SHARE OF ACTIVE PETS
// WITH NO VETERINARY ACT IN THE PERIOD.
//
//   value = 100 × (activePets − attendedPets) / activePets   (one decimal, 0-100)
//     activePets   = pets in scope with status active/lost.
//     attendedPets = DISTINCT pets of that universe with ≥1 event of
//                    VET_ACTIVITY_EVENT_TYPES inside [since, until].
//
// WHY A SHARE AND NOT A RECENCY (PO decision, 2026-07-26). This loader used to
// return "days since the LAST veterinary act anywhere in the province", capped
// at the window length. That is a MAX over thousands of pets, so it pins to
// whichever pole the event volume implies and can never discriminate at
// province grain: measured with the `vet_visit_logged`-only predicate, 23 of 24
// provinces sat exactly at the 90-day cap; measured with the full act set, 20
// sat at 0 days and 4 at 1 — two distinct values nationally. Widening the
// predicate only moved the saturation to the opposite pole, and "no hay
// desierto en ninguna parte" is a FALSE REASSURANCE, worse on a government
// console than the false alarm it replaced.
//
// The per-pet framing does discriminate. Measured the same day over 90 days:
// 24,6% (Mendoza) → 80,7% (Salta), all 24 provinces distinct, with the expected
// geography (the AMBA/Centro core best served, the NOA/NEA provinces worst).
//
// NO CENSORING BOUND. The old value carried `censoredAtMax: 90` because the cap
// meant "we stopped looking", not "90 days passed". A share has no such bound:
// 100% is a MEASUREMENT ("none of the active pets was attended"), 0% is another
// one, and every value between them is ordered. The registry entry therefore
// dropped `censoredAtMax` rather than translating it — see layers.ts.
//
// THE WINDOW IS A REAL FLOOR. The recency deliberately had none (an act from
// years back still set the value). A share of "sin atención EN EL PERÍODO" must
// bound both ends, so acts before `since` do not count. `asOf` moves `until`,
// replaying the share as of t.
//
// k-anon: the unit's ACTIVE-PET UNIVERSE is the protected dimension AND now the
// denominator (same as fetchVetAccessByLocality) — a scoped province universe
// with < k active pets gets NO cell (suppressSmallCells; reported via
// suppressedCount), so the share can never characterize a handful of
// identifiable pets.
export async function loadVetDesertByProvince(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  since: Date,
  asOf?: Date,
  adminProvince?: string,
  adminLocality?: string,
): Promise<ProvinceChoroplethRows> {
  const until = asOf ?? new Date();
  const scope = petsScope(actor, jurisdictions, adminProvince, adminLocality);

  // Denominator + k-anon dimension: ACTIVE pets per province. Deceased pets are
  // excluded on purpose — a share of "mascotas sin atención" that counted them
  // would inflate every province by its mortality history.
  // The denominator travels with the numerator when a cut is requested (D3).
  const universe = await rollupPetsPerProvince([asOf ? activePetsAsOf(until) : ACTIVE_PETS], scope);
  const { visible, suppressed } = suppressSmallCells(universe, {
    count: (r) => r.count,
    key: (r) => r.province,
  });

  // Numerator complement: DISTINCT active pets with ≥1 veterinary act inside the
  // period. COUNT DISTINCT, not COUNT — one pet visited five times is ONE pet
  // attended, and counting acts would let a single heavily-treated animal erase
  // a province's desert.
  const conditions: SQL[] = [
    // The SAME universe predicate as the denominator above. Left on today's
    // ACTIVE_PETS, the numerator silently dropped any pet that had been
    // attended before the cut and died after it — so the replay under-counted
    // attention exactly where the denominator had just been taught to include
    // it. A share whose two halves describe different populations is not a
    // share.
    asOf ? activePetsAsOf(until) : ACTIVE_PETS,
    inArray(petEvents.eventType, VET_ACTIVITY_EVENT_TYPES),
    gte(petEvents.occurredAt, since),
    lte(petEvents.occurredAt, until),
    isNotNull(pets.jurisdictionProvince),
  ];
  if (scope) conditions.push(sql`(${scope})`);
  const rows = await db
    .select({
      province: pets.jurisdictionProvince,
      attended: countDistinct(pets.id),
    })
    .from(petEvents)
    .innerJoin(pets, eq(petEvents.petId, pets.id))
    .where(and(...conditions))
    .groupBy(pets.jurisdictionProvince)
    .limit(PER_LAYER_CAP);
  const attendedByProvince = new Map<string, number>();
  for (const r of rows) {
    if (r.province) attendedByProvince.set(r.province, r.attended);
  }

  const cells: ProvinceChoroplethCell[] = [];
  for (const r of visible as unknown as ProvinceRollupRow[]) {
    const code = PROVINCE_ISO[r.province];
    if (!code) continue;
    if (r.count <= 0) continue; // no live population → no share to publish
    const attended = Math.min(attendedByProvince.get(r.province) ?? 0, r.count);
    const pct = Math.round(((r.count - attended) / r.count) * 100 * 10) / 10;
    // Denominator = the same active-pet universe suppressSmallCells just cleared,
    // so this never re-suppresses; naming it keeps the fence honest.
    cells.push(provinceCell(code, r.province, pct, r.count));
  }
  // #40, same defect as tendencia: the sub-k provinces used to be COUNTED and
  // then dropped, so the map stippled them as "sin datos" — "nadie reportó acá"
  // over a province whose real reading is "hay tan pocas mascotas activas que la
  // proporción identificaría a sus dueños". Emit them present-and-suppressed.
  for (const r of suppressed) {
    const code = PROVINCE_ISO[r.province];
    if (!code) continue;
    // Zero nuance (same rule as provinceCell): a province with NO active pets is
    // a genuine data gap, not a protected group — hatching it would dress an
    // empty padrón as a privacy decision. It stays absent → stippled "sin datos".
    if (r.count <= 0) continue;
    cells.push(provinceCellPreDecided(code, r.province, null, true));
  }
  // Counted off the EMITTED cells rather than off `suppressSmallCells` directly:
  // an empty-padrón province (count 0) is skipped above as a genuine data gap, and
  // the primitive would still have it in its suppressed bucket — reporting it would
  // dress a coverage hole as a privacy withholding.
  return { cells, truncated: false, suppressedCount: countSuppressed(cells) };
}

// metrics:deworming (antiparasitario) — per-PROVINCE deworming coverage RATE via
// the canonical fetcher. Delegates to fetchDewormingCoverage (lib/metrics/deworming),
// whose byProvince breakdown shares the active-pets denominator with /gob/poblacion.
// value = ratePct (0-100). Parity guaranteed by reuse — clones
// loadSterilizationCoverageByProvince with the deworming fetcher swapped in.
export async function loadDewormingCoverageByProvince(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): Promise<ProvinceChoroplethRows> {
  const ctx = buildProjectionContext(actor, jurisdictions, windows.trailing12m(), {
    adminProvince,
    adminLocality,
  });
  const { byProvince } = await fetchDewormingCoverage(ctx);
  const cells: ProvinceChoroplethCell[] = [];
  for (const r of byProvince) {
    const code = PROVINCE_ISO[r.province];
    if (!code) continue;
    // k-anon denominator = `total` (ACTIVE pets in scope), never `ratePct`.
    cells.push(provinceCell(code, r.province, r.ratePct, r.total));
  }
  return {
    cells,
    truncated: byProvince.length >= PER_LAYER_CAP,
    suppressedCount: countSuppressed(cells),
  };
}

// metrics:territorial-index (indice-territorial) — per-PROVINCE composite index
// (0-100). PROVINCE-ONLY by design and NOT a ChoroplethMetric: it is not a pets
// predicate but the unweighted mean of the rabies/sterilization/microchip
// target-attainments computed by computeJurisdictionIndex over ≤24 provinces.
// Delegates to the SAME two functions /admin/inteligencia composes
// (fetchCrossJurisdictionOutliers → computeJurisdictionIndex), so the map and that
// table paint one number.
// value = score (0-100, sequential fill; not a compliance rate).
//
// ─────────────────────────────────────────────────────────────────────────────
// #40 — THE ONE LAYER DELIBERATELY EXCLUDED FROM PROVINCE k-ANON, AND THE GAP
// THAT LEAVES. Read this before "fixing" it.
//
// It is excluded because it has NO DENOMINATOR TO EXCLUDE IT BY. The score is a
// COMPOSITE: the unweighted mean of the rabies / sterilization / microchip
// target-attainments. Each component had its own denominator upstream, and
// JurisdictionIndexRow does not carry any of them — by the time a score reaches
// this loader, "how many animals is this about" is gone. `provinceCell` demands
// a denominator precisely so that this question cannot be skipped, and the only
// way to satisfy it here would be to INVENT one. A guessed denominator is worse
// than a declared gap: it would suppress the wrong provinces and, worse, it
// would make every other province look deliberately cleared when it was not.
//
// WHAT PROTECTS IT TODAY (verified 2026-07-30, program-health.ts:384): the
// upstream fetcher skips any province with `totalPets < K_ANON_MIN`, and
// K_ANON_MIN is 5 — the SAME k. So no sub-k province reaches this map.
//
// THE RESIDUAL GAP, stated plainly: that upstream protection DROPS the row
// instead of marking it. So a sub-k province produces no cell, and the D.5(b)
// stipple then paints it as "sin datos" — which reads as "nobody reported here"
// when the truth is "too few animals to publish". It is the same defect this
// task fixed for tendencia and desierto veterinario, and it is NOT fixed here:
// closing it means teaching fetchCrossJurisdictionOutliers to RETURN its
// suppressed provinces instead of skipping them, which changes a shape that
// /admin/inteligencia also reads. That is a separate change with its own blast
// radius, not a line to sneak into this one.
// ─────────────────────────────────────────────────────────────────────────────
export async function loadTerritorialIndexByProvince(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): Promise<ProvinceChoroplethRows> {
  const ctx = buildProjectionContext(actor, jurisdictions, windows.trailing12m(), {
    adminProvince,
    adminLocality,
  });
  const indexRows = computeJurisdictionIndex(await fetchCrossJurisdictionOutliers(ctx));
  const cells: ProvinceChoroplethCell[] = [];
  for (const r of indexRows) {
    const code = PROVINCE_ISO[r.province];
    if (!code) continue;
    // NOT `provinceCell` — see the excluded-by-design block above. Every row
    // that gets here already cleared k upstream, so `suppressed: false` is a
    // statement of fact about these rows, not a claim that the layer is exempt.
    cells.push(provinceCellPreDecided(code, r.province, r.score, false));
  }
  // Structurally 0 — every cell above is built `suppressed: false` (the upstream
  // fetcher DROPS its sub-k provinces rather than marking them; that residual gap
  // is the block above, not something a count here can disclose). Derived from the
  // cells anyway so it can never drift from what the map paints.
  return {
    cells,
    truncated: indexRows.length >= PER_LAYER_CAP,
    suppressedCount: countSuppressed(cells),
  };
}

/**
 * U5 single entry point: rollup a choropleth metric at the requested LEVEL.
 * Reused by the Panorama use-case AND available to the dashboard distribution
 * widgets so both share ONE source of numbers (spec §U5.4). Province returns
 * filled-polygon cells; locality returns centroid cells. BOTH apply k-anon k=5 —
 * province via `provinceCell` (denominator-driven, task #40), locality via
 * `suppressSmallCells`.
 *
 * RATE vs DENSITY routing:
 *  - RATE metrics (rabies-coverage, sterilization-coverage): province level emits
 *    ratePct values (0-100) by delegating to the canonical dashboard fetchers
 *    (fetchRabiesCoverageByProvince / fetchSterilizationCoverage.byProvince).
 *    This guarantees parity with the KPI tiles — dogs-based denominator for
 *    rabies, active-pets denominator for sterilization.
 *    Locality level emits count-density (v1 limitation — rate-by-locality deferred).
 *  - DENSITY metrics (mortality): both levels emit raw count.
 */
export function loadChoroplethByLevel(
  metric: ChoroplethMetric,
  level: "province",
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
  verifiedOnly?: boolean,
): Promise<ProvinceChoroplethRows>;
export function loadChoroplethByLevel(
  metric: ChoroplethMetric,
  level: "locality",
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
  verifiedOnly?: boolean,
): Promise<ChoroplethRows>;
export function loadChoroplethByLevel(
  metric: ChoroplethMetric,
  level: AggregationLevel,
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
  // task #78 Part 3: "solo firmado por matrícula" numerator narrowing. Honored
  // ONLY by the rabies-coverage metric (the toggle is rabies-specific); the
  // sterilization/mortality loaders ignore it.
  verifiedOnly = false,
): Promise<ChoroplethRows | ProvinceChoroplethRows> {
  if (level === "province") {
    if (metric === "rabies-coverage")
      return loadRabiesCoverageByProvince(
        actor,
        jurisdictions,
        adminProvince,
        adminLocality,
        verifiedOnly,
      );
    if (metric === "sterilization-coverage")
      return loadSterilizationCoverageByProvince(
        actor,
        jurisdictions,
        adminProvince,
        adminLocality,
      );
    if (metric === "microchip-penetration")
      return loadMicrochipCoverageByProvince(actor, jurisdictions, adminProvince, adminLocality);
    if (metric === "ppp-compliance")
      return loadPppComplianceByProvince(actor, jurisdictions, adminProvince, adminLocality);
    if (metric === "vet-access")
      return loadVetAccessByProvince(actor, jurisdictions, adminProvince, adminLocality);
    if (metric === "deworming")
      return loadDewormingCoverageByProvince(actor, jurisdictions, adminProvince, adminLocality);
    return loadMortalityByProvince(actor, jurisdictions, adminProvince, adminLocality);
  }
  // Locality level.
  if (metric === "rabies-coverage")
    return loadRabiesCoverage(actor, jurisdictions, adminProvince, adminLocality, verifiedOnly);
  if (metric === "sterilization-coverage")
    return loadSterilizationCoverage(actor, jurisdictions, adminProvince, adminLocality);
  if (metric === "microchip-penetration")
    return loadMicrochipCoverage(actor, jurisdictions, adminProvince, adminLocality);
  if (metric === "ppp-compliance")
    return loadPppCompliance(actor, jurisdictions, adminProvince, adminLocality);
  if (metric === "vet-access")
    return loadVetAccess(actor, jurisdictions, adminProvince, adminLocality);
  if (metric === "deworming")
    return loadDewormingCoverage(actor, jurisdictions, adminProvince, adminLocality);
  return loadMortality(actor, jurisdictions, adminProvince, adminLocality);
}
