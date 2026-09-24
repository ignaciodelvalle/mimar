// Panorama infrastructure repository — F1 per-unit aggregation loaders for the
// DENSITY + SIGNAL point layers (perdidas, mordeduras, denuncias, zoonosis,
// sintomas, reunificacion), plus the real-sighting-dots loader (Slice 1).
//
// Extracted mechanically from repository.ts (file-size split, behavior-
// preserving): every loader here is unchanged, only moved. Scope-clause,
// event-predicate, and province/geo shaping helpers now live in ./repository-scope.

import { type SQL, and, count, countDistinct, eq, gte, isNotNull, lte, sql } from "drizzle-orm";

import { arLocalities, analyticsDb as db, petEvents, pets, welfareReports } from "@/db";
import {
  type DashboardActor,
  type DashboardJurisdiction,
  buildProjectionContext,
  complementarySuppress,
  fetchReunificationByUnit,
  suppressSmallCells,
} from "@/lib/metrics";
import {
  type AggregatedPointCell,
  type LostPointRow,
  aggregateCellsToDepartment,
} from "@/src/modules/panorama/application/build-features";
import { isNationalDepartmentGrain } from "@/src/modules/panorama/domain/layers";
import type { TimeBasis } from "@/src/modules/panorama/domain/time-scrub";
import type { AggregationLevel } from "@/src/modules/panorama/domain/types";

import {
  PER_LAYER_CAP,
  type RollupRow,
  biteIncidentLocalitySql,
  biteIncidentProvinceSql,
  biteIncidentScope,
  eventWindowCol,
  jurisdictionColumnsScope,
  mordedurasEventPredicate,
  normNameSql,
  perdidasEventPredicate,
  petEventsScope,
  petsScope,
  provinceIsoMapSql,
  provinceRepresentativeCentroid,
  sightingEventPredicate,
} from "./repository-scope";

// ---------------------------------------------------------------------------
// F1 Panorama v2 — per-unit aggregation loaders for DENSITY + SIGNAL layers.
//
// For each density/signal point layer, instead of fetching one row per event
// (which then gets cluster-merged client-side via MapLibre), these loaders
// COUNT(*) GROUP BY (province) or (province, locality) server-side, joining
// ar_localities for the centroid, and apply suppressSmallCells (k=5) at the
// locality level (same privacy invariant as the choropleth loaders).
//
// Result shape: AggregatedPointCell[] — consumed by buildAggregatedPointFeatures.
// BOTH LEVELS APPLY k-anon k=5 (#40b). Province level used to be exempt under the
// "province cells are large" premise, which task #40 retired for the choropleth
// loaders: it is true of a province's POPULATION and false of the DENOMINATOR
// k-anonymity actually protects. On a DENSITY/SIGNAL point layer the plotted count
// IS that denominator, so a province with two bite events published "2" — a group
// of two identifiable animals — while the very same rollup, folded for the
// bivariate axis by toProvinceSignalCells, had been hatching it since the
// bivariate work. Both now take one code path.
// Province level: no centroid join (the province marker is a precomputed
// point-on-surface). Locality level: left-join ar_localities for the centroid.
//
// These loaders are NOT unit-testable without a DB (they depend on @/db). The
// pure build-features transform (buildAggregatedPointFeatures) is fully unit-
// tested in build-features-aggregated.test.ts.
// ---------------------------------------------------------------------------

/** Result envelope for a per-unit aggregated point layer loader (F1). */
export type AggregatedPointRows = {
  cells: AggregatedPointCell[];
  suppressedCount: number;
  /**
   * Events matching scope+period whose HOME jurisdiction has a province but NO
   * locality — counted at province level, invisible at the locality/detail tier
   * (the rollup filters `jurisdiction_locality IS NOT NULL`). Surfaced for the same
   * reconciliation honesty as the choropleth path (WARNING 4): the two aggregation
   * levels must not silently disagree. 0 at province level and for rate loaders.
   */
  noLocalityCount: number;
  truncated: boolean;
  /**
   * PROVINCE-grain fallback for the bivariate "riesgo de brotes" join (task
   * panorama-bivariate-2026-07-21). Populated ONLY by `loadZoonosisByUnit` at
   * `level === "province"` (the national overview — the console's own
   * `resolveDataLevel` never requests "province" once a jurisdiction is
   * drilled, so this is unambiguously the national case). Independent from
   * `cells` above: the STANDALONE zoonosis point layer keeps painting the
   * PO 2026-07-16 department-grain bubbles (`cells`) unchanged; this is a
   * SEPARATE province-level rollup + k=5 pass consumed ONLY by the bivariate
   * signal axis, whose coverage partner (cobertura) is province-grain — the
   * ~500 near-empty department cells were almost all sub-k, so the 3×3 join
   * refused at national scope 100% of the time. Undefined for every other
   * loader / level.
   */
  provinceSignal?: AggregatedPointCell[];
};

/**
 * How a rollup's cells decide k-anon suppression.
 *
 * A DISCRIMINATED UNION, not a boolean, and REQUIRED at every call site on
 * purpose — the `provinceCell(…, denominator)` precedent (build-features.ts):
 * make the compiler, not a reviewer, enumerate the places where the privacy
 * question must be answered. The boolean this replaced spelled the answer
 * `false` at every PROVINCE call site under the retired "province cells are
 * large" premise, and nine loaders published raw sub-k province counts.
 *
 *  · `count`       — the plotted value IS the protected population, so k-anon
 *                    keys off it directly. `grain` only picks the complementary
 *                    suppression group (see below).
 *  · `pre-decided` — an upstream module already applied the rule against a
 *                    denominator this rollup does not carry (the reunificacion
 *                    rate loader). These cells pass through untouched and the
 *                    caller appends its own null-valued suppressed cells.
 */
type CellKAnon = { rule: "count"; grain: AggregationLevel } | { rule: "pre-decided" };

/**
 * Convert a raw event-count rollup to AggregatedPointCell[], applying the k=5
 * k-anon rule per `kanon`.
 */
function toAggregatedCells(
  rollup: RollupRow[],
  kanon: CellKAnon,
): { cells: AggregatedPointCell[]; suppressedCount: number } {
  if (kanon.rule === "pre-decided") {
    // Suppression already decided upstream against a denominator this rollup does
    // not carry — pass the visible cells through. NOT an exemption: the caller is
    // contractually required to append the suppressed cells (count: null) itself.
    return {
      cells: rollup.map((r) => ({
        key: r.key,
        province: r.province,
        locality: r.locality !== "" ? r.locality : null,
        departmentCode: r.departmentCode ?? null,
        centroidLat: r.centroidLat,
        centroidLng: r.centroidLng,
        count: r.count,
        suppressed: false,
      })),
      suppressedCount: 0,
    };
  }
  const primary = suppressSmallCells(rollup, {
    count: (r) => r.count,
    key: (r) => r.key,
  });
  // Complementary suppression: the differencing-attack defense. A group with a
  // LONE suppressed cell leaks it by subtraction from the published group total,
  // so its smallest visible sibling goes too. The group is the tier ABOVE the
  // cell: a department's siblings are its province's other departments; a
  // PROVINCE's siblings are the other provinces of the scope-wide total (the same
  // "national" group `toProvinceSignalCells` has always used at this grain).
  const { visible, suppressed } = complementarySuppress(
    primary.visible as unknown as readonly RollupRow[],
    primary.suppressed,
    { group: (r) => (kanon.grain === "province" ? "national" : r.province), count: (r) => r.count },
  );
  const suppressedCount = suppressed.length;
  const cells: AggregatedPointCell[] = [];
  for (const r of visible) {
    cells.push({
      key: r.key,
      province: r.province,
      locality: r.locality !== "" ? r.locality : null,
      departmentCode: r.departmentCode ?? null,
      centroidLat: r.centroidLat,
      centroidLng: r.centroidLng,
      count: r.count,
      suppressed: false,
    });
  }
  for (const r of suppressed) {
    cells.push({
      key: r.key,
      province: r.province,
      locality: r.locality !== "" ? r.locality : null,
      departmentCode: r.departmentCode ?? null,
      centroidLat: r.centroidLat,
      centroidLng: r.centroidLng,
      count: null,
      suppressed: true,
    });
  }
  return { cells, suppressedCount };
}

// ---------------------------------------------------------------------------
// pet_events:lost (perdidas) — per-unit aggregation.
//
// Counts lost/sighting events (pet_events where kind in
// 'pet_lost'/'pet_found_sighting') grouped by (province) or (province, locality).
// Applies the SAME scope + period clauses as loadBiteEvents (petEventsScope).
// ---------------------------------------------------------------------------

export async function loadPerdidasByUnit(
  level: AggregationLevel,
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  since: Date,
  asOf?: Date,
  adminProvince?: string,
  adminLocality?: string,
  // task #77 bitemporal: "valid" (occurred_at, default) or "transaction" (recorded_at).
  basis: TimeBasis = "valid",
): Promise<AggregatedPointRows> {
  // pets-table scope + pets-JOIN attribution: lost/sighting events carry NO
  // jurisdiction in their payload, so the pet's home jurisdiction is the unit.
  const scope = petsScope(actor, jurisdictions, adminProvince, adminLocality);
  const tcol = eventWindowCol(basis);
  const conditions: SQL[] = [
    perdidasEventPredicate(),
    gte(tcol, since),
    isNotNull(pets.jurisdictionProvince),
  ];
  if (asOf) conditions.push(lte(tcol, asOf));
  if (scope) conditions.push(sql`(${scope})`);

  if (level === "province") {
    const rows = await db
      .select({
        province: pets.jurisdictionProvince,
        n: countDistinct(petEvents.id),
      })
      .from(petEvents)
      .innerJoin(pets, eq(petEvents.petId, pets.id))
      .where(and(...conditions))
      .groupBy(pets.jurisdictionProvince)
      .limit(PER_LAYER_CAP);
    const rollup: RollupRow[] = rows
      .filter((r) => r.province)
      .map((r) => ({
        key: r.province as string,
        province: r.province as string,
        locality: "",
        ...provinceRepresentativeCentroid(r.province),
        count: r.n,
      }));
    const { cells, suppressedCount } = toAggregatedCells(rollup, {
      rule: "count",
      grain: "province",
    });
    // Province level counts every event in the province — nothing is invisible.
    return {
      cells,
      suppressedCount,
      noLocalityCount: 0,
      truncated: rollup.length >= PER_LAYER_CAP,
    };
  }

  // Locality level: group by (province, locality), left-join ar_localities for centroid.
  const rows = await db
    .select({
      province: pets.jurisdictionProvince,
      locality: pets.jurisdictionLocality,
      centroidLat: sql<string | null>`MIN(${arLocalities.latitude})`,
      centroidLng: sql<string | null>`MIN(${arLocalities.longitude})`,
      // Department roll-up keys (PO "Option A") — pinned deterministically via MIN,
      // same discipline as the centroid, so the fold matches the choropleth path.
      departmentCode: sql<string | null>`MIN(${arLocalities.departmentCode})`,
      departmentName: sql<string | null>`MIN(${arLocalities.departmentName})`,
      n: countDistinct(petEvents.id),
    })
    .from(petEvents)
    .innerJoin(pets, eq(petEvents.petId, pets.id))
    .leftJoin(
      arLocalities,
      and(
        sql`${arLocalities.provinceCode} = ${provinceIsoMapSql(sql`${pets.jurisdictionProvince}`)}`,
        sql`${arLocalities.localityNameNorm} = ${normNameSql(sql`${pets.jurisdictionLocality}`)}`,
        sql`${arLocalities.removedAt} IS NULL`,
      ),
    )
    .where(and(...conditions, isNotNull(pets.jurisdictionLocality)))
    .groupBy(pets.jurisdictionProvince, pets.jurisdictionLocality)
    .limit(PER_LAYER_CAP);
  const rollup: RollupRow[] = rows
    .filter((r) => r.province && r.locality)
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
  // Events whose pet home jurisdiction has a province but NO locality — invisible at
  // the detail tier, counted at province level (WARNING 4 reconciliation). Same
  // predicate + scope as the rollup (conditions already pins isNotNull(province)).
  const [residual] = await db
    .select({ n: countDistinct(petEvents.id) })
    .from(petEvents)
    .innerJoin(pets, eq(petEvents.petId, pets.id))
    .where(and(...conditions, sql`${pets.jurisdictionLocality} IS NULL`));
  const noLocalityCount = residual?.n ?? 0;
  // Detail tier (PO "Option A"): fold the per-locality rollup up to the department
  // (barrio for CABA) BEFORE k-anon, so the DATA + k=5 unit matches the division the
  // map draws. `truncated` still reflects the LOCALITY query cap (the fold only shrinks).
  const { cells, suppressedCount } = toAggregatedCells(aggregateCellsToDepartment(rollup), {
    rule: "count",
    grain: "locality",
  });
  return { cells, suppressedCount, noLocalityCount, truncated: rollup.length >= PER_LAYER_CAP };
}

// ---------------------------------------------------------------------------
// pet_events:lost (perdidas) — REAL sighting DOTS (panorama-event-points Slice 1).
//
// The near-zoom counterpart to loadPerdidasByUnit: instead of one graduated
// bubble per administrative unit, it returns individual sighting coordinates as
// dots. Used ONLY when the server has authorized points mode (mode=points AND a
// province is resolved — see get-layer-features/route). Governance:
//   - SIGHTINGS ONLY (A3): sightingEventPredicate, NOT perdidasEventPredicate —
//     lost-mark coords are out of Slice 1.
//   - located rows only: isNotNull(locationLat); non-located sightings are counted
//     into the `noCoordCount` residual ("N avistajes sin ubicación exacta"),
//     never plotted as a fake centroid dot (fallback honesty, §5).
//   - SCOPE (A2): petsScope — attribution by the pet's HOME jurisdiction (JOIN
//     pets), the SAME scope as loadPerdidasByUnit. Dots are the operator's OWN
//     cases; a pet homed in province X but sighted in Y plots physically in Y and
//     is visible to the X operator (not a breach — it is X's case). NOT
//     petEventsScope (incident payloads carry no jurisdiction; sightings none).
//   - CAP (A8): PER_LAYER_CAP, ordered occurredAt DESC so a capped result keeps
//     the N MOST RECENT sightings ("mostrando los N más recientes"); scope + cap +
//     client-side MapLibre clustering is the mitigation — no viewport culling.
// ---------------------------------------------------------------------------

/** Result envelope for the real-sighting-dots loader (Slice 1). */
export type PointEventsRows = {
  rows: LostPointRow[];
  /** True when PER_LAYER_CAP clipped the result (the N most recent are kept). */
  truncated: boolean;
  /**
   * Sightings matching scope+period whose columnar coordinate is NULL — surfaced
   * as an honest "sin ubicación exacta" residual, never plotted. ~0 in practice
   * (sightings are written requireCoords:true) but counted for honesty.
   */
  noCoordCount: number;
};

export async function loadPerdidasEvents(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  since: Date,
  asOf?: Date,
  adminProvince?: string,
  adminLocality?: string,
  // task #77 bitemporal: "valid" (occurred_at, default) or "transaction" (recorded_at).
  basis: TimeBasis = "valid",
): Promise<PointEventsRows> {
  // Same pets-table scope + pets-JOIN attribution as loadPerdidasByUnit (A2).
  const scope = petsScope(actor, jurisdictions, adminProvince, adminLocality);
  const tcol = eventWindowCol(basis);
  const base: SQL[] = [sightingEventPredicate(), gte(tcol, since)];
  if (asOf) base.push(lte(tcol, asOf));
  if (scope) base.push(sql`(${scope})`);

  const rows = await db
    .select({
      publicToken: pets.publicToken,
      name: pets.name,
      species: pets.species,
      status: pets.status,
      locationLat: petEvents.locationLat,
      locationLng: petEvents.locationLng,
      occurredAt: petEvents.occurredAt,
      locationSource: sql<string | null>`(${petEvents.payload}->>'location_source')`,
    })
    .from(petEvents)
    .innerJoin(pets, eq(petEvents.petId, pets.id))
    .where(and(...base, isNotNull(petEvents.locationLat)))
    // Most-recent-first (by the active basis) so a capped result keeps the
    // freshest sightings — most-recently-recorded under transaction basis.
    .orderBy(sql`${tcol} DESC`)
    .limit(PER_LAYER_CAP);

  // Residual: in-scope sightings with NO columnar coordinate (honest "sin
  // ubicación exacta" count — never a fake dot). Separate cheap COUNT.
  const [residual] = await db
    .select({ n: count() })
    .from(petEvents)
    .innerJoin(pets, eq(petEvents.petId, pets.id))
    .where(and(...base, sql`${petEvents.locationLat} IS NULL`));

  return {
    rows: rows.map((r) => ({
      publicToken: r.publicToken,
      name: r.name,
      species: r.species,
      status: r.status,
      locationLat: r.locationLat,
      locationLng: r.locationLng,
      lastSeenAt: r.occurredAt ? r.occurredAt.toISOString() : null,
      locationSource: r.locationSource,
    })),
    truncated: rows.length >= PER_LAYER_CAP,
    noCoordCount: residual?.n ?? 0,
  };
}

// ---------------------------------------------------------------------------
// pet_events:bite (mordeduras) — per-unit aggregation.
//
// Counts bite incident events grouped by (province) or (province, locality).
// Mirrors loadBiteEvents in predicate; the aggregation groups rather than fetches
// individual events.
// ---------------------------------------------------------------------------

export async function loadMordedurassByUnit(
  level: AggregationLevel,
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  since: Date,
  asOf?: Date,
  adminProvince?: string,
  adminLocality?: string,
  // task #77 bitemporal: "valid" (occurred_at, default) or "transaction" (recorded_at).
  basis: TimeBasis = "valid",
): Promise<AggregatedPointRows> {
  // A bite counts where it OCCURRED — the incident_reported payload carries the
  // incident's own jurisdiction_province/_locality (event-schemas.ts), with the
  // pet's home as the field-by-field fallback the bite case uses too
  // (biteIncidentProvinceSql, repository-scope.ts). The map unit is that place.
  const scope = biteIncidentScope(actor, jurisdictions, adminProvince, adminLocality);
  const provinceExpr = biteIncidentProvinceSql();
  const localityExpr = biteIncidentLocalitySql();
  const tcol = eventWindowCol(basis);
  const conditions: SQL[] = [
    mordedurasEventPredicate(),
    gte(tcol, since),
    sql`${provinceExpr} IS NOT NULL`,
  ];
  if (asOf) conditions.push(lte(tcol, asOf));
  if (scope) conditions.push(sql`(${scope})`);

  if (level === "province") {
    const rows = await db
      .select({
        province: provinceExpr,
        n: countDistinct(petEvents.id),
      })
      .from(petEvents)
      .innerJoin(pets, eq(petEvents.petId, pets.id))
      .where(and(...conditions))
      .groupBy(provinceExpr)
      .limit(PER_LAYER_CAP);
    const rollup: RollupRow[] = rows
      .filter((r) => r.province)
      .map((r) => ({
        key: r.province as string,
        province: r.province as string,
        locality: "",
        ...provinceRepresentativeCentroid(r.province),
        count: r.n,
      }));
    const { cells, suppressedCount } = toAggregatedCells(rollup, {
      rule: "count",
      grain: "province",
    });
    // Province level counts every event in the province — nothing is invisible.
    return {
      cells,
      suppressedCount,
      noLocalityCount: 0,
      truncated: rollup.length >= PER_LAYER_CAP,
    };
  }

  const rows = await db
    .select({
      province: provinceExpr,
      locality: localityExpr,
      centroidLat: sql<string | null>`MIN(${arLocalities.latitude})`,
      centroidLng: sql<string | null>`MIN(${arLocalities.longitude})`,
      // Department roll-up keys (PO "Option A") — pinned deterministically via MIN,
      // same discipline as the centroid, so the fold matches the choropleth path.
      departmentCode: sql<string | null>`MIN(${arLocalities.departmentCode})`,
      departmentName: sql<string | null>`MIN(${arLocalities.departmentName})`,
      n: countDistinct(petEvents.id),
    })
    .from(petEvents)
    .innerJoin(pets, eq(petEvents.petId, pets.id))
    .leftJoin(
      arLocalities,
      and(
        sql`${arLocalities.provinceCode} = ${provinceIsoMapSql(provinceExpr)}`,
        sql`${arLocalities.localityNameNorm} = ${normNameSql(localityExpr)}`,
        sql`${arLocalities.removedAt} IS NULL`,
      ),
    )
    .where(and(...conditions, sql`${localityExpr} IS NOT NULL`))
    .groupBy(provinceExpr, localityExpr)
    .limit(PER_LAYER_CAP);
  const rollup: RollupRow[] = rows
    .filter((r) => r.province && r.locality)
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
  // Bites whose incident place has a province but NO locality — invisible at
  // the detail tier, counted at province level (WARNING 4 reconciliation). Same
  // predicate + scope as the rollup (conditions already pins isNotNull(province)).
  const [residual] = await db
    .select({ n: countDistinct(petEvents.id) })
    .from(petEvents)
    .innerJoin(pets, eq(petEvents.petId, pets.id))
    .where(and(...conditions, sql`${localityExpr} IS NULL`));
  const noLocalityCount = residual?.n ?? 0;
  // Detail tier (PO "Option A"): fold the per-locality rollup up to the department
  // (barrio for CABA) BEFORE k-anon, so the DATA + k=5 unit matches the division the
  // map draws. `truncated` still reflects the LOCALITY query cap (the fold only shrinks).
  const { cells, suppressedCount } = toAggregatedCells(aggregateCellsToDepartment(rollup), {
    rule: "count",
    grain: "locality",
  });
  return { cells, suppressedCount, noLocalityCount, truncated: rollup.length >= PER_LAYER_CAP };
}

// ---------------------------------------------------------------------------
// welfare_reports (denuncias) — per-unit aggregation (COARSE).
//
// Counts welfare reports grouped by (province) or (province, locality), joining
// ar_localities for the unit centroid. The exact report coordinate is NEVER used
// here — the entire loader uses jurisdiction columns (not lat/lng) for grouping.
// Mirrors loadDenunciaCentroids in scope + moderation filter.
// ---------------------------------------------------------------------------

export async function loadDenunciasByUnit(
  level: AggregationLevel,
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  since: Date,
  asOf?: Date,
  adminProvince?: string,
  adminLocality?: string,
): Promise<AggregatedPointRows> {
  const scope = jurisdictionColumnsScope(
    actor,
    jurisdictions,
    "welfareReports",
    adminProvince,
    adminLocality,
  );
  const conditions: SQL[] = [
    gte(welfareReports.createdAt, since),
    // Same moderation filter as loadDenunciaCentroids.
    sql`(${welfareReports.flaggedAt} IS NULL OR ${welfareReports.moderationResolvedAt} IS NOT NULL)`,
    isNotNull(welfareReports.jurisdictionProvince),
  ];
  if (asOf) conditions.push(lte(welfareReports.createdAt, asOf));
  if (scope) conditions.push(sql`(${scope})`);

  if (level === "province") {
    const rows = await db
      .select({
        province: welfareReports.jurisdictionProvince,
        n: countDistinct(welfareReports.id),
      })
      .from(welfareReports)
      .where(and(...conditions))
      .groupBy(welfareReports.jurisdictionProvince)
      .limit(PER_LAYER_CAP);
    const rollup: RollupRow[] = rows
      .filter((r) => r.province)
      .map((r) => ({
        key: r.province as string,
        province: r.province as string,
        locality: "",
        ...provinceRepresentativeCentroid(r.province),
        count: r.n,
      }));
    const { cells, suppressedCount } = toAggregatedCells(rollup, {
      rule: "count",
      grain: "province",
    });
    // Province level counts every event in the province — nothing is invisible.
    return {
      cells,
      suppressedCount,
      noLocalityCount: 0,
      truncated: rollup.length >= PER_LAYER_CAP,
    };
  }

  const rows = await db
    .select({
      province: welfareReports.jurisdictionProvince,
      locality: welfareReports.jurisdictionLocality,
      centroidLat: sql<string | null>`MIN(${arLocalities.latitude})`,
      centroidLng: sql<string | null>`MIN(${arLocalities.longitude})`,
      // countDistinct: homonymous localities (same normalized name within a
      // province) make the arLocalities join fan out, so count() over-counts.
      n: countDistinct(welfareReports.id),
      // Department roll-up keys (PO "Option A") — pinned deterministically via MIN.
      departmentCode: sql<string | null>`MIN(${arLocalities.departmentCode})`,
      departmentName: sql<string | null>`MIN(${arLocalities.departmentName})`,
    })
    .from(welfareReports)
    .leftJoin(
      arLocalities,
      and(
        sql`${arLocalities.provinceCode} = ${provinceIsoMapSql(sql`${welfareReports.jurisdictionProvince}`)}`,
        sql`${arLocalities.localityNameNorm} = ${normNameSql(sql`${welfareReports.jurisdictionLocality}`)}`,
        sql`${arLocalities.removedAt} IS NULL`,
      ),
    )
    .where(and(...conditions, isNotNull(welfareReports.jurisdictionLocality)))
    .groupBy(welfareReports.jurisdictionProvince, welfareReports.jurisdictionLocality)
    .limit(PER_LAYER_CAP);
  const rollup: RollupRow[] = rows
    .filter((r) => r.province && r.locality)
    .map((r) => ({
      key: `${r.province as string}|${r.locality as string}`,
      province: r.province as string,
      locality: r.locality as string,
      centroidLat: r.centroidLat,
      centroidLng: r.centroidLng,
      departmentCode: r.departmentCode,
      departmentName: r.departmentName,
      count: r.n,
    }));
  // Reports with a province but NO locality — invisible at the detail tier, counted
  // at province level (WARNING 4 reconciliation). Same predicate + scope as the rollup.
  const [residual] = await db
    .select({ n: countDistinct(welfareReports.id) })
    .from(welfareReports)
    .where(and(...conditions, sql`${welfareReports.jurisdictionLocality} IS NULL`));
  const noLocalityCount = residual?.n ?? 0;
  // Detail tier (PO "Option A"): fold the per-locality rollup up to the department
  // (barrio for CABA) BEFORE k-anon, so the DATA + k=5 unit matches the division the
  // map draws. `truncated` still reflects the LOCALITY query cap (the fold only shrinks).
  const { cells, suppressedCount } = toAggregatedCells(aggregateCellsToDepartment(rollup), {
    rule: "count",
    grain: "locality",
  });
  return { cells, suppressedCount, noLocalityCount, truncated: rollup.length >= PER_LAYER_CAP };
}

// ---------------------------------------------------------------------------
// outbreak_signals (zoonosis) — per-unit aggregation (SIGNAL).
//
// Counts outbreak_signal pet_events grouped by the payload jurisdiction SNAPSHOT
// (pet_jurisdiction_province / pet_jurisdiction_locality) — the ONLY event type
// that legitimately carries jurisdiction in its payload (see petEventsScopeClause
// jsdoc; the schema snapshots it at signal time so surveillance aggregates hold
// even if the pet later moves). Previously grouped by flat payload province/locality
// that no outbreak_signal writer emits — only the raw-insert seed produced them, so
// real signals were invisible on the choropleth. Joins ar_localities for the unit
// centroid. Mirrors loadOutbreakSignals in scope + period clauses.
// ---------------------------------------------------------------------------

/**
 * Fold a per-(province, locality) rollup up to PROVINCE grain (sum counts —
 * each event lives in exactly one locality, so summing is exact, never an
 * estimate) and apply k=5 suppression at THAT grain (task
 * panorama-bivariate-2026-07-21 — the bivariate join's province-grain
 * fallback; see `AggregatedPointRows.provinceSignal`).
 *
 * Complementary suppression groups ALL rows into ONE national bucket — NOT
 * per-province like the department fold's `group: r => r.province` (there,
 * many department siblings share a province to protect against; here, each
 * row IS a province, so the sibling pool is the whole country). This defends
 * against the SAME differencing attack one level up: `loadZoonosisSignalScopeTotal`
 * publishes the unsuppressed NATIONAL sum for the KPI, so a lone suppressed
 * province would otherwise be recoverable as `nationalTotal − Σ(visible
 * provinces)`. With ≥2 provinces suppressed the subtraction is ambiguous
 * (textbook complementary-suppression logic), so only the n===1 case needs
 * (and gets) a promoted sibling.
 *
 * Never lowers k, never fabricates a count: a suppressed province still
 * carries `count: null` — its exact value is as unrecoverable here as at
 * department grain, just aggregated over a coarser (larger, safer) unit.
 *
 * #40b: the rule itself now lives in `toAggregatedCells({rule:"count",
 * grain:"province"})` — the SAME code path every province point loader takes,
 * so the bivariate fallback and the standalone layers can no longer disagree
 * about whether a province is protected. This function only does the fold.
 */
function toProvinceSignalCells(rollup: readonly RollupRow[]): AggregatedPointCell[] {
  const byProvince = new Map<string, number>();
  for (const r of rollup) {
    byProvince.set(r.province, (byProvince.get(r.province) ?? 0) + r.count);
  }
  const provinceRows: RollupRow[] = Array.from(byProvince, ([province, n]) => ({
    key: province,
    province,
    locality: "",
    departmentCode: null,
    ...provinceRepresentativeCentroid(province),
    count: n,
  }));
  return toAggregatedCells(provinceRows, { rule: "count", grain: "province" }).cells;
}

export async function loadZoonosisByUnit(
  level: AggregationLevel,
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  since: Date,
  asOf?: Date,
  adminProvince?: string,
  adminLocality?: string,
  // task #77 bitemporal: "valid" (occurred_at, default) or "transaction" (recorded_at).
  basis: TimeBasis = "valid",
): Promise<AggregatedPointRows> {
  const scope = petEventsScope(actor, jurisdictions, adminProvince, adminLocality);
  const tcol = eventWindowCol(basis);
  const conditions: SQL[] = [
    eq(petEvents.eventType, "outbreak_signal"),
    gte(tcol, since),
    isNotNull(sql`(${petEvents.payload}->>'pet_jurisdiction_province')`),
  ];
  if (asOf) conditions.push(lte(tcol, asOf));
  if (scope) conditions.push(sql`(${scope})`);

  // PO decision (2026-07-16): zoonosis is a NATIONAL_DEPARTMENT_GRAIN layer
  // (isNationalDepartmentGrain), so the national/province request renders one
  // graduated symbol per DEPARTMENT — NOT a single fixed point per province — via
  // the SAME department-grain build the drilled (level="locality") path uses below.
  // `level` therefore no longer forks the grain for zoonosis; the national-vs-drilled
  // scope narrowing comes from petEventsScope / adminProvince, never from `level`.
  // The province one-point-per-province rollup is retained only as the fallback for a
  // hypothetical NON-department-grain signal loader routed through here (dead for
  // zoonosis, which is always a member of the set).
  if (level === "province" && !isNationalDepartmentGrain("zoonosis")) {
    const rows = await db
      .select({
        province: sql<string>`(${petEvents.payload}->>'pet_jurisdiction_province')`,
        n: countDistinct(petEvents.id),
      })
      .from(petEvents)
      .where(and(...conditions))
      .groupBy(sql`(${petEvents.payload}->>'pet_jurisdiction_province')`)
      .limit(PER_LAYER_CAP);
    const rollup: RollupRow[] = rows
      .filter((r) => r.province)
      .map((r) => ({
        key: r.province,
        province: r.province,
        locality: "",
        ...provinceRepresentativeCentroid(r.province),
        count: r.n,
      }));
    const { cells, suppressedCount } = toAggregatedCells(rollup, {
      rule: "count",
      grain: "province",
    });
    // Province level counts every event in the province — nothing is invisible.
    return {
      cells,
      suppressedCount,
      noLocalityCount: 0,
      truncated: rollup.length >= PER_LAYER_CAP,
    };
  }

  const rows = await db
    .select({
      province: sql<string>`(${petEvents.payload}->>'pet_jurisdiction_province')`,
      locality: sql<string>`(${petEvents.payload}->>'pet_jurisdiction_locality')`,
      centroidLat: sql<string | null>`MIN(${arLocalities.latitude})`,
      centroidLng: sql<string | null>`MIN(${arLocalities.longitude})`,
      // Department roll-up keys (PO "Option A") — pinned deterministically via MIN.
      departmentCode: sql<string | null>`MIN(${arLocalities.departmentCode})`,
      departmentName: sql<string | null>`MIN(${arLocalities.departmentName})`,
      n: countDistinct(petEvents.id),
    })
    .from(petEvents)
    .leftJoin(
      arLocalities,
      and(
        sql`${arLocalities.provinceCode} = ${provinceIsoMapSql(sql`(${petEvents.payload}->>'pet_jurisdiction_province')`)}`,
        sql`${arLocalities.localityNameNorm} = ${normNameSql(sql`(${petEvents.payload}->>'pet_jurisdiction_locality')`)}`,
        sql`${arLocalities.removedAt} IS NULL`,
      ),
    )
    .where(and(...conditions, isNotNull(sql`(${petEvents.payload}->>'pet_jurisdiction_locality')`)))
    .groupBy(
      sql`(${petEvents.payload}->>'pet_jurisdiction_province')`,
      sql`(${petEvents.payload}->>'pet_jurisdiction_locality')`,
    )
    .limit(PER_LAYER_CAP);
  const rollup: RollupRow[] = rows
    .filter((r) => r.province && r.locality)
    .map((r) => ({
      key: `${r.province}|${r.locality}`,
      province: r.province,
      locality: r.locality,
      centroidLat: r.centroidLat,
      centroidLng: r.centroidLng,
      departmentCode: r.departmentCode,
      departmentName: r.departmentName,
      count: r.n,
    }));
  // Signals whose payload jurisdiction snapshot has a province but NO locality —
  // invisible at the detail tier, counted at province level (WARNING 4).
  const [residual] = await db
    .select({ n: countDistinct(petEvents.id) })
    .from(petEvents)
    .where(and(...conditions, sql`(${petEvents.payload}->>'pet_jurisdiction_locality') IS NULL`));
  const noLocalityCount = residual?.n ?? 0;
  // Detail tier (PO "Option A") AND, since 2026-07-16, the NATIONAL overview for
  // zoonosis (isNationalDepartmentGrain): fold the per-locality rollup up to the
  // department (barrio for CABA) BEFORE k-anon, so the DATA + k=5 unit matches the
  // division the map draws. At national this yields ~500 department cells countrywide
  // (< PER_LAYER_CAP); at a drilled province, that province's departments. k=5 stays
  // the privacy floor — coarser-than-locality is strictly more anonymising, so a lone
  // department signal (count < 5) is suppressed, never rendered raw. `truncated` still
  // reflects the LOCALITY query cap (the fold only shrinks).
  const { cells, suppressedCount } = toAggregatedCells(aggregateCellsToDepartment(rollup), {
    rule: "count",
    grain: "locality",
  });
  // Bivariate province-grain fallback (task panorama-bivariate-2026-07-21): ONLY
  // at the national overview (level="province" — the console's resolveDataLevel
  // never requests this once a jurisdiction is drilled in, so this IS the national
  // case). Folds the SAME raw pre-suppression `rollup` straight to province (skips
  // the department step entirely) and suppresses at k=5 there — 24 provinces
  // instead of ~500 departments, so a real signal clears k almost everywhere
  // instead of almost nowhere. Independent of `cells` above: the STANDALONE
  // zoonosis point layer keeps its PO 2026-07-16 department bubbles untouched.
  const provinceSignal = level === "province" ? toProvinceSignalCells(rollup) : undefined;
  return {
    cells,
    suppressedCount,
    noLocalityCount,
    truncated: rollup.length >= PER_LAYER_CAP,
    provinceSignal,
  };
}

/**
 * Coherence hybrid (cowork round 2, H1): the SCOPE-WIDE total of `outbreak_signal`
 * events in [since, asOf] — the SAME population `loadZoonosisByUnit` aggregates into
 * map cells, but summed across the whole scope (no grouping, no k-anon). This is the
 * number the "Zoonosis / señales" PRIMARY KPI must show so that
 *   KPI primary == Σ(map cells before suppression) == Σ(Registros value column)
 * at the same (scope, period, asOf, basis). Distinct-by-event-id, byte-identical
 * base predicate to the layer loader above (outbreak_signal + occurred/recorded in
 * window + payload province present + the SAME petEventsScope), so the KPI can never
 * desync from the map the way the composite "activas" fetcher did (it mixed live
 * rabies-observation + open-bite stock arms that the scrubber can't move).
 */
export async function loadZoonosisSignalScopeTotal(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  since: Date,
  asOf?: Date,
  adminProvince?: string,
  adminLocality?: string,
  basis: TimeBasis = "valid",
): Promise<number> {
  const scope = petEventsScope(actor, jurisdictions, adminProvince, adminLocality);
  const tcol = eventWindowCol(basis);
  const conditions: SQL[] = [
    eq(petEvents.eventType, "outbreak_signal"),
    gte(tcol, since),
    isNotNull(sql`(${petEvents.payload}->>'pet_jurisdiction_province')`),
  ];
  if (asOf) conditions.push(lte(tcol, asOf));
  if (scope) conditions.push(sql`(${scope})`);
  const [row] = await db
    .select({ n: countDistinct(petEvents.id) })
    .from(petEvents)
    .where(and(...conditions));
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// pet_events:symptom (sintomas) — per-unit aggregation (DENSITY).
// Groups symptom_observed by the pet's home jurisdiction (pets table) —
// symptom_observed carries no flat jurisdiction of its own in its payload,
// same attribution rule as perdidas/mordeduras.
// ---------------------------------------------------------------------------

export async function loadSintomasByUnit(
  level: AggregationLevel,
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  since: Date,
  asOf?: Date,
  adminProvince?: string,
  adminLocality?: string,
  // task #77 bitemporal: "valid" (occurred_at, default) or "transaction" (recorded_at).
  basis: TimeBasis = "valid",
): Promise<AggregatedPointRows> {
  const scope = petsScope(actor, jurisdictions, adminProvince, adminLocality);
  const tcol = eventWindowCol(basis);
  const conditions: SQL[] = [
    eq(petEvents.eventType, "symptom_observed"),
    gte(tcol, since),
    isNotNull(pets.jurisdictionProvince),
  ];
  if (asOf) conditions.push(lte(tcol, asOf));
  if (scope) conditions.push(sql`(${scope})`);

  if (level === "province") {
    const rows = await db
      .select({
        province: pets.jurisdictionProvince,
        n: countDistinct(petEvents.id),
      })
      .from(petEvents)
      .innerJoin(pets, eq(pets.id, petEvents.petId))
      .where(and(...conditions))
      .groupBy(pets.jurisdictionProvince)
      .limit(PER_LAYER_CAP);
    const rollup: RollupRow[] = rows
      .filter((r) => r.province)
      .map((r) => ({
        key: r.province as string,
        province: r.province as string,
        locality: "",
        ...provinceRepresentativeCentroid(r.province),
        count: r.n,
      }));
    const { cells, suppressedCount } = toAggregatedCells(rollup, {
      rule: "count",
      grain: "province",
    });
    // Province level counts every event in the province — nothing is invisible.
    return {
      cells,
      suppressedCount,
      noLocalityCount: 0,
      truncated: rollup.length >= PER_LAYER_CAP,
    };
  }

  const rows = await db
    .select({
      province: pets.jurisdictionProvince,
      locality: pets.jurisdictionLocality,
      centroidLat: sql<string | null>`MIN(${arLocalities.latitude})`,
      centroidLng: sql<string | null>`MIN(${arLocalities.longitude})`,
      // Department roll-up keys (PO "Option A") — pinned deterministically via MIN.
      departmentCode: sql<string | null>`MIN(${arLocalities.departmentCode})`,
      departmentName: sql<string | null>`MIN(${arLocalities.departmentName})`,
      n: countDistinct(petEvents.id),
    })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .leftJoin(
      arLocalities,
      and(
        sql`${arLocalities.provinceCode} = ${provinceIsoMapSql(sql`${pets.jurisdictionProvince}`)}`,
        sql`${arLocalities.localityNameNorm} = ${normNameSql(sql`${pets.jurisdictionLocality}`)}`,
        sql`${arLocalities.removedAt} IS NULL`,
      ),
    )
    .where(and(...conditions, isNotNull(pets.jurisdictionLocality)))
    .groupBy(pets.jurisdictionProvince, pets.jurisdictionLocality)
    .limit(PER_LAYER_CAP);
  const rollup: RollupRow[] = rows
    .filter((r) => r.province && r.locality)
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
  // Events whose pet home jurisdiction has a province but NO locality — invisible at
  // the detail tier, counted at province level (WARNING 4 reconciliation). Same
  // predicate + scope as the rollup (conditions already pins isNotNull(province)).
  const [residual] = await db
    .select({ n: countDistinct(petEvents.id) })
    .from(petEvents)
    .innerJoin(pets, eq(petEvents.petId, pets.id))
    .where(and(...conditions, sql`${pets.jurisdictionLocality} IS NULL`));
  const noLocalityCount = residual?.n ?? 0;
  // Detail tier (PO "Option A"): fold the per-locality rollup up to the department
  // (barrio for CABA) BEFORE k-anon, so the DATA + k=5 unit matches the division the
  // map draws. `truncated` still reflects the LOCALITY query cap (the fold only shrinks).
  const { cells, suppressedCount } = toAggregatedCells(aggregateCellsToDepartment(rollup), {
    rule: "count",
    grain: "locality",
  });
  return { cells, suppressedCount, noLocalityCount, truncated: rollup.length >= PER_LAYER_CAP };
}

// ---------------------------------------------------------------------------
// metrics:reunification (reunificacion) — per-unit aggregation (SIGNAL).
// Graduated-symbol count encodes the reunification ratePct (0–100) per unit.
// The k-anon suppression happens INSIDE fetchReunificationByUnit (lib/metrics/
// reunification-rollups.ts), keyed on the lostEpisodes DENOMINATOR — never on
// ratePct (the bug this port deliberately does not reproduce). This loader
// does NOT re-suppress; it only resolves centroids for the already-visible
// units, via the SAME shared leftJoin-arLocalities pattern every other
// per-unit loader in this file uses (one grouped query, not an N+1 per-unit
// centroid loop).
// ---------------------------------------------------------------------------

export async function loadReunificacionByUnit(
  level: AggregationLevel,
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  since: Date,
  asOf?: Date,
  adminProvince?: string,
  adminLocality?: string,
): Promise<AggregatedPointRows> {
  const ctx = buildProjectionContext(
    actor,
    jurisdictions,
    { since, until: asOf ?? new Date() },
    { adminProvince, adminLocality },
  );
  const { byUnit, suppressedCount } = await fetchReunificationByUnit(ctx, level);
  if (byUnit.length === 0) {
    // Rate loader: the graduated symbol encodes a ratePct, not a summable count, so
    // there is no province-vs-detail count residual to reconcile (WARNING 4 N/A).
    return { cells: [], suppressedCount, noLocalityCount: 0, truncated: false };
  }

  // KA6 + #40b: k-anon-suppressed cells arrive flagged (suppressed:true) at BOTH
  // grains, so we can render them as the honest hatch category — split them out
  // from the visible units, which alone carry a real ratePct into the
  // graduated-symbol rollup.
  //
  // The `ratePct !== null` guard is the compiler-forced half of that split, and it
  // DROPS rather than coerces: `?? 0` here would publish a confident "0% de
  // reunificación" for a protected unit — a false zero that both asserts something
  // untrue and leaks that the unit crossed k. A null on a row not flagged
  // `suppressed` would mean the split above missed it; no cell is better than a lie.
  const visibleUnits = byUnit.filter(
    (u): u is typeof u & { ratePct: number } => !u.suppressed && u.ratePct !== null,
  );
  const suppressedUnits = byUnit.filter((u) => u.suppressed);

  const rollup: RollupRow[] = visibleUnits.map((u) => {
    if (level === "province") {
      // Province marker: precomputed point-on-surface lookup (no DB round trip
      // needed — the point depends only on the province's own geometry, not on
      // which localities happen to have data). See provinceRepresentativeCentroid.
      return {
        key: u.province,
        province: u.province,
        locality: u.locality ?? "",
        ...provinceRepresentativeCentroid(u.province),
        // The value plotted IS the ratePct — the graduated symbol encodes the
        // reunification rate, not an event count (spec: dataType "signal").
        count: u.ratePct,
      };
    }
    // Locality level: the fetcher folded the unit to its departamento/partido
    // (barrio in CABA) and resolved that unit's centroid + INDEC department code,
    // so consume them directly (no per-locality centroid re-resolution). The
    // departmentCode threads to the map's unit-history drill (match by CODE).
    return {
      key: `${u.province}|${u.departmentCode ?? u.locality}`,
      province: u.province,
      locality: u.locality ?? "",
      centroidLat: u.centroidLat ?? null,
      centroidLng: u.centroidLng ?? null,
      departmentCode: u.departmentCode ?? null,
      count: u.ratePct,
    };
  });

  // `pre-decided`: fetchReunificationByUnit already ran the k=5 rule against the
  // lostEpisodes DENOMINATOR (the plotted value here is a ratePct, which is NOT a
  // population and must never be fed to a count-based threshold). The suppressed
  // units it flagged are appended below as null-valued hatch cells.
  const { cells } = toAggregatedCells(rollup, { rule: "pre-decided" });
  // KA6: append the suppressed department cells as null-valued hatch cells (the real
  // ratePct never leaves fetchReunificationByUnit), so a suppressed reunificacion
  // unit renders as the distinct "suprimido" category, not vanish as plain no-data.
  for (const u of suppressedUnits) {
    cells.push({
      key: `${u.province}|${u.departmentCode ?? u.locality}`,
      province: u.province,
      locality: u.locality !== "" ? (u.locality ?? null) : null,
      departmentCode: u.departmentCode ?? null,
      centroidLat: u.centroidLat ?? null,
      centroidLng: u.centroidLng ?? null,
      count: null,
      suppressed: true,
    });
  }
  // Rate loader — ratePct per unit, no count residual to reconcile (WARNING 4 N/A).
  return { cells, suppressedCount, noLocalityCount: 0, truncated: false };
}
