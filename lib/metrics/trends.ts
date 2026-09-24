// Bucketed time-series (trend) projections for the gob dashboards (D1).
//
// WHY THIS EXISTS
// ---------------
// Every gob surface was a snapshot (KPIs + flat tables/bars). The event log is
// inherently temporal, yet nothing showed direction over time. These fetchers
// add per-period buckets the existing chart primitives can render:
//
//   - fetchDeathCausesTrend     → stacked (cause × bucket) for /gob/mortalidad
//   - fetchBitesTrend           → single-series bites/bucket
//   - fetchOutbreakSignalsTrend → single-series outbreak signals/bucket
//   - fetchRabiesCoverageTrend  → single-series % dogs vaccinated/bucket
//
// CONTRACT (all fetchers)
//   - Scope-aware via ProjectionContext: admin universal; govt intersects its
//     jurisdiction pairs (petsScopeClause / petEventsScopeClause).
//   - Bucket granularity is the period's natural unit (week ≤120d, else month),
//     chosen by bucketGranularityFor and pushed to SQL date_trunc().
//   - k-anonymity (k=5) on small per-bucket cells via the pure suppress* helpers
//     in lib/metrics/timeseries.ts. 0-counts are never masked (a true zero is a
//     non-identifying signal the operator needs).
//   - es-AR labels only — raw enums are mapped at the surface (deathCauseLabel).
//
// The SQL grouping lives here; the branching transforms (granularity, pivot,
// suppression) live in the pure, DB-free timeseries.ts module so they are
// unit-tested without a live Postgres.

import { and, count, countDistinct, eq, gte, lte, sql } from "drizzle-orm";

// POOL: analyticsDb (session pooler), NOT the OLTP transaction pooler — these are
// read-only multi-statement bucketed time-series aggregates (feed /admin/programa +
// the /gob trend dashboards). supavisor transaction mode (6543) has a measured >100x
// pathology for this fan-out shape (db/index.ts); session mode serves it normally.
// Locally analyticsDb falls back to DATABASE_URL (identical dev/test).
import { analyticsDb as db, petEvents, pets } from "@/db";
import { amendedPayloadText } from "@/lib/infra/amendment-sql";

import type { AnalyticsPeriod } from "@/lib/analytics/analytics-period";

import type { ProjectionContext } from "./context";
import { petEventsScopeClause, petsScopeClause } from "./scope";
import {
  type BucketGranularity,
  type SeriesBucketRow,
  type StackedSeries,
  bucketGranularityFor,
  dateTruncUnit,
  formatBucketLabel,
  pivotStackedSeries,
  suppressSmallBuckets,
  suppressSmallStackedCells,
  zeroFillLabeledBuckets,
  zeroFillStackedPoints,
} from "./timeseries";

/** True when a govt actor has no jurisdictions — every projection is empty. */
function isEmptyScope(ctx: ProjectionContext): boolean {
  return ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0;
}

/** Shared single-series trend return shape. */
export type SingleSeriesTrend = {
  granularity: BucketGranularity;
  /**
   * SUPPRESSED ≠ ZERO. `suppressSmallBuckets` masks a 1..k-1 bucket to `y: 0`
   * AND flags it `suppressed: true`; this type used to declare only
   * `{ x, y }`, so the flag was structurally erased at the fetcher boundary
   * and every consumer read a privacy mask as a measured zero. The /gob home
   * chart published eleven "0 mordeduras" months under a header that said
   * "11 períodos ocultos (privacidad)", while the SAME suppression in the
   * Panorama CSV/PNG wrote "Protegido (k<5)" — three renderings of one fact,
   * one of them a false epidemiological claim. Carrying the flag in the type
   * is what lets TimeSeriesChart draw a gap and its "Ver datos" table print
   * "oculto (privacidad)" instead of a number nobody measured.
   */
  points: Array<{ x: string; y: number; suppressed?: true }>;
  /** Number of per-bucket cells masked by k-anonymity. */
  suppressedCount: number;
};

/** Stacked (multi-series) trend return shape. */
export type StackedTrend = {
  granularity: BucketGranularity;
  /**
   * SUPPRESSED ≠ ZERO here too, per (bucket, series) CELL. The fix above closed
   * the single-series hole; this one survived it for another two months because
   * the stacked path carries its flag INSIDE the point (`StackedPoint.suppressed`,
   * a map keyed by series key) rather than beside `y`, so no signature changed
   * when the flag was missing and nothing looked wrong. The concrete cost was
   * `/gob/mortalidad`'s "Ver datos" table printing `0` for a month with 1..4
   * rabies deaths — see the `StackedPoint.suppressed` docblock in ./timeseries.ts.
   */
  series: StackedSeries;
  /**
   * Number of per-(bucket, series) CELLS masked by k-anonymity. This is the
   * card-header disclosure ("N celdas ocultas (privacidad)"); it says that
   * something was hidden, never WHICH cell — that is what the per-cell flag is
   * for, and mistaking the first for the second is what produced the defect
   * above.
   */
  suppressedCount: number;
};

const EMPTY_SINGLE = (granularity: BucketGranularity): SingleSeriesTrend => ({
  granularity,
  points: [],
  suppressedCount: 0,
});

const EMPTY_STACKED = (granularity: BucketGranularity): StackedTrend => ({
  granularity,
  series: { seriesKeys: [], points: [] },
  suppressedCount: 0,
});

// Postgres date_trunc requires its field arg as a string LITERAL — passing the
// unit as a bind param (date_trunc($1, ts)) fails to plan and 500s the query.
// `unit` is a fixed 'week'|'month' enum (dateTruncUnit), re-whitelisted here,
// so inlining it via sql.raw is injection-safe (no user input reaches it).
function truncBucket(unit: "week" | "month") {
  const u = unit === "week" ? "week" : "month";
  return sql<string>`date_trunc(${sql.raw(`'${u}'`)}, ${petEvents.occurredAt})`;
}

// ---------------------------------------------------------------------------
// D1.1 — Death causes per bucket (STACKED) — backs /gob/mortalidad
// ---------------------------------------------------------------------------

/**
 * Deaths grouped by (period bucket, cause) over death_recorded events.
 *
 * Replaces the flat ISO-week×cause table on /gob/mortalidad with a stacked
 * time-series. Scope is anchored to the pet row via INNER JOIN pets and
 * restricted by petsScopeClause(ctx) (the death payload carries no jurisdiction
 * fields — same pattern as fetchMortalityDisposition). Per (bucket, cause) cells
 * below k=5 are masked.
 *
 * KPI tags: NUMERATOR = COUNT death_recorded events per (bucket, cause).
 * DENOMINATOR = n/a (a count series, not a rate). SOURCE = pet_events
 * (death_recorded). CADENCE = ctx.period, bucketed weekly/monthly.
 * SUPPRESSION = k-anon (k=5) per (bucket, cause) cell.
 */
export async function fetchDeathCausesTrend(
  ctx: ProjectionContext,
  opts?: { species?: string; cause?: string },
): Promise<StackedTrend> {
  const granularity = bucketGranularityFor(ctx.period);
  if (isEmptyScope(ctx)) return EMPTY_STACKED(granularity);

  const unit = dateTruncUnit(granularity);
  const bucket = truncBucket(unit);
  const scope = petsScopeClause(ctx);
  const conditions = [
    eq(petEvents.eventType, "death_recorded"),
    gte(petEvents.occurredAt, ctx.period.since),
    lte(petEvents.occurredAt, ctx.period.until),
  ];
  if (scope) conditions.push(sql`(${scope})`);
  if (opts?.species) conditions.push(eq(pets.species, opts.species));
  if (opts?.cause) {
    conditions.push(sql`COALESCE(${petEvents.payload}->>'cause', 'unknown') = ${opts.cause}`);
  }

  const rows = await db
    .select({
      bucket,
      cause: sql<string>`COALESCE(${petEvents.payload}->>'cause', 'unknown')`,
      n: count(),
    })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(and(...conditions))
    .groupBy(bucket, sql`COALESCE(${petEvents.payload}->>'cause', 'unknown')`)
    .orderBy(bucket);

  const seriesRows: SeriesBucketRow[] = rows.map((r) => {
    const start = new Date(r.bucket);
    return {
      bucketStart: start.toISOString(),
      bucketLabel: formatBucketLabel(start, granularity),
      seriesKey: r.cause,
      count: r.n,
    };
  });

  // Zero-fill BEFORE suppression (dataviz review 2026-07-23 #2) — see
  // finalizeSingleSeries below for the rationale.
  const pivoted = zeroFillStackedPoints(pivotStackedSeries(seriesRows), ctx.period, granularity);
  const { series, suppressedCount } = suppressSmallStackedCells(pivoted, 5);
  return { granularity, series, suppressedCount };
}

// ---------------------------------------------------------------------------
// D1.2 — Bites per bucket (single series) — backs /gob home
// ---------------------------------------------------------------------------

/**
 * Bite incidents (incident_reported, incident_type='bite_inflicted') grouped by
 * period bucket. Scope by the pet's HOME jurisdiction via INNER JOIN pets +
 * petsScopeClause — incident_reported carries NO payload jurisdiction snapshot
 * (only outbreak_signal does), so petEventsScopeClause would evaluate to `false`
 * for every scoped-govt row (the "ghost-payload" bug). The join is
 * many-events→one-pet, so it never fans out the count.
 *
 * KPI tags: trend view of bites_per_10k's numerator (see kpi-catalog.ts) — no
 * census denominator applied here, this is a raw count series. NUMERATOR =
 * COUNT incident_reported (bite_inflicted) per bucket. DENOMINATOR = n/a.
 * SOURCE = pet_events (incident_reported). CADENCE = ctx.period, bucketed.
 * SUPPRESSION = k-anon (k=5).
 */
export async function fetchBitesTrend(ctx: ProjectionContext): Promise<SingleSeriesTrend> {
  const granularity = bucketGranularityFor(ctx.period);
  if (isEmptyScope(ctx)) return EMPTY_SINGLE(granularity);

  const unit = dateTruncUnit(granularity);
  const bucket = truncBucket(unit);
  const scope = petsScopeClause(ctx);
  const conditions = [
    eq(petEvents.eventType, "incident_reported"),
    sql`(${petEvents.payload}->>'incident_type') = ${"bite_inflicted"}`,
    gte(petEvents.occurredAt, ctx.period.since),
    lte(petEvents.occurredAt, ctx.period.until),
  ];
  if (scope) conditions.push(sql`(${scope})`);

  const rows = await db
    .select({
      bucket,
      n: count(),
    })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(and(...conditions))
    .groupBy(bucket)
    .orderBy(bucket);

  return finalizeSingleSeries(rows, granularity, ctx.period);
}

// ---------------------------------------------------------------------------
// D1.3 — Outbreak signals per bucket (single series) — backs /gob/analytics
// ---------------------------------------------------------------------------

/**
 * Outbreak signals (eventType LIKE 'outbreak_%') grouped by period bucket.
 * Scope via petEventsScopeClause (payload jurisdiction fields), matching the
 * existing fetchZoonosisTrend scope semantics.
 *
 * KPI tags: NUMERATOR = COUNT pet_events WHERE event_type LIKE 'outbreak_%'
 * per bucket. DENOMINATOR = n/a. SOURCE = pet_events. CADENCE = ctx.period,
 * bucketed. SUPPRESSION = k-anon (k=5).
 */
export async function fetchOutbreakSignalsTrend(
  ctx: ProjectionContext,
): Promise<SingleSeriesTrend> {
  const granularity = bucketGranularityFor(ctx.period);
  if (isEmptyScope(ctx)) return EMPTY_SINGLE(granularity);

  const unit = dateTruncUnit(granularity);
  const bucket = truncBucket(unit);
  const scope = petEventsScopeClause(ctx);
  const conditions = [
    sql`${petEvents.eventType} LIKE ${"outbreak_%"}`,
    gte(petEvents.occurredAt, ctx.period.since),
    lte(petEvents.occurredAt, ctx.period.until),
  ];
  if (scope) conditions.push(sql`(${scope})`);

  const rows = await db
    .select({
      bucket,
      n: count(),
    })
    .from(petEvents)
    .where(and(...conditions))
    .groupBy(bucket)
    .orderBy(bucket);

  return finalizeSingleSeries(rows, granularity, ctx.period);
}

// ---------------------------------------------------------------------------
// D1.4 — Rabies coverage over time (single series, %) — optional surface
// ---------------------------------------------------------------------------

/**
 * Per-bucket count of DISTINCT dogs receiving a rabies vaccination. This is a
 * "vaccinations applied per period" trend (a flow), NOT a recomputed stock
 * coverage ratio per bucket — the active-dog denominator is a "now" snapshot
 * and cannot be meaningfully back-dated per historical bucket without a
 * point-in-time population, which the event log does not carry.
 *
 * Rabies-vaccine match uses the SAME accent-aware regex as fetchRabiesCoverage
 * (~* '(antirr[áa]bica|rabies)') so "is a rabies vaccine" stays consistent.
 * Scope to dogs via INNER JOIN pets + species filter.
 *
 * KPI tags: trend view of rabies_coverage_dogs_12m's numerator (see
 * kpi-catalog.ts) — a FLOW (vaccinations applied per bucket), not a
 * recomputed per-bucket coverage ratio (see caveat above). NUMERATOR = COUNT
 * DISTINCT dogs vaccinated per bucket. DENOMINATOR = n/a. SOURCE = pets,
 * pet_events (vaccination_administered). CADENCE = ctx.period, bucketed.
 * SUPPRESSION = k-anon (k=5).
 */
export async function fetchRabiesVaccinationTrend(
  ctx: ProjectionContext,
): Promise<SingleSeriesTrend> {
  const granularity = bucketGranularityFor(ctx.period);
  if (isEmptyScope(ctx)) return EMPTY_SINGLE(granularity);

  const unit = dateTruncUnit(granularity);
  const bucket = truncBucket(unit);
  // vaccination_administered carries no payload jurisdiction snapshot — scope by
  // the pet's HOME jurisdiction (petsScopeClause) against the pets INNER JOIN
  // already present below. petEventsScopeClause here would be the ghost-payload
  // bug (evaluates to `false` for every scoped-govt row).
  const scope = petsScopeClause(ctx);
  const conditions = [
    eq(petEvents.eventType, "vaccination_administered"),
    // Amendment overlay (audit A2): a corrected vaccine_name counts by its
    // CURRENT value, matching the TS read boundaries.
    sql`(${amendedPayloadText("vaccine_name")}) ~* '(antirr[áa]bica|rabies)'`,
    eq(pets.species, "dog"),
    gte(petEvents.occurredAt, ctx.period.since),
    lte(petEvents.occurredAt, ctx.period.until),
  ];
  if (scope) conditions.push(sql`(${scope})`);

  const rows = await db
    .select({
      bucket,
      n: countDistinct(petEvents.petId),
    })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(and(...conditions))
    .groupBy(bucket)
    .orderBy(bucket);

  return finalizeSingleSeries(rows, granularity, ctx.period);
}

// ---------------------------------------------------------------------------
// D2 — Generic single-series KPI trend — backs sparklines on all KPI tiles
// ---------------------------------------------------------------------------

/**
 * Count of `pet_events` with the given `eventType`, bucketed by period
 * (week for ≤120d, month otherwise), scoped to the viewer's jurisdiction.
 *
 * This is the generic building block for KPI sparklines introduced in
 * Dashboards vNext Fase 0.  It intentionally mirrors `fetchBitesTrend` and
 * `fetchOutbreakSignalsTrend`: same `truncBucket` helper (injection-safe
 * date_trunc inliner), same `finalizeSingleSeries`.
 *
 * SCOPE (parameterized by eventType): only `outbreak_signal` carries the payload
 * jurisdiction snapshot, so ONLY that type is scoped via petEventsScopeClause.
 * Every other eventType is scoped by the pet's HOME jurisdiction (petsScopeClause)
 * against the pets INNER JOIN always present below — otherwise petEventsScopeClause
 * would evaluate to `false` for every scoped-govt row (the ghost-payload bug). The
 * join is many-events→one-pet, so it never fans out the count.
 *
 * Usage:
 *   const trend = await fetchKpiTrend("vaccination_administered", ctx);
 *   // trend.points → [{ x: "2026-W03", y: 14 }, …]
 *
 * KPI tags (generic — parameterized by eventType, not a single fixed KPI):
 * NUMERATOR = COUNT pet_events WHERE event_type = <eventType> per bucket.
 * DENOMINATOR = n/a. SOURCE = pet_events. CADENCE = ctx.period, bucketed
 * weekly (≤120d) or monthly. SUPPRESSION = k-anon (k=5) via suppressSmallBuckets.
 *
 * @param eventType - The exact `pet_events.event_type` value to count.
 * @param ctx       - ProjectionContext (actor + scope + period).
 * @param opts      - Optional `species` narrowing (domain-axes work). Omitted →
 *                    identical to the pre-existing unfiltered behavior. Every
 *                    caller today joins `pets`, so this never needs a new join.
 */
export async function fetchKpiTrend(
  eventType: string,
  ctx: ProjectionContext,
  opts?: { species?: string },
): Promise<SingleSeriesTrend> {
  const granularity = bucketGranularityFor(ctx.period);
  if (isEmptyScope(ctx)) return EMPTY_SINGLE(granularity);

  const unit = dateTruncUnit(granularity);
  const bucket = truncBucket(unit);
  // Only outbreak_signal carries the payload jurisdiction snapshot; every other
  // eventType must scope by the pet's home jurisdiction (ghost-payload bug).
  const scope = eventType === "outbreak_signal" ? petEventsScopeClause(ctx) : petsScopeClause(ctx);
  const conditions = [
    eq(petEvents.eventType, eventType),
    gte(petEvents.occurredAt, ctx.period.since),
    lte(petEvents.occurredAt, ctx.period.until),
  ];
  if (scope) conditions.push(sql`(${scope})`);
  if (opts?.species) conditions.push(eq(pets.species, opts.species));

  const rows = await db
    .select({
      bucket,
      n: count(),
    })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(and(...conditions))
    .groupBy(bucket)
    .orderBy(bucket);

  return finalizeSingleSeries(rows, granularity, ctx.period);
}

// ---------------------------------------------------------------------------
// Shared single-series finalizer: label → suppress → return.
// ---------------------------------------------------------------------------

function finalizeSingleSeries(
  rows: Array<{ bucket: string; n: number }>,
  granularity: BucketGranularity,
  period: AnalyticsPeriod,
): SingleSeriesTrend {
  const labeled = rows.map((r) => {
    const start = new Date(r.bucket);
    return { start: start.toISOString(), x: formatBucketLabel(start, granularity), y: r.n };
  });

  // Zero-fill BEFORE suppression (dataviz review 2026-07-23 #2): the SQL
  // GROUP BY drops empty buckets, erasing quiet periods from the categorical
  // axis and compressing the forecast regression's time base. Suppression
  // runs after so genuine zeros stay visible (they are non-identifying).
  const complete = zeroFillLabeledBuckets(labeled, period, granularity).map(({ x, y }) => ({
    x,
    y,
  }));

  const { points, suppressedCount } = suppressSmallBuckets(complete, 5);
  return { granularity, points, suppressedCount };
}
