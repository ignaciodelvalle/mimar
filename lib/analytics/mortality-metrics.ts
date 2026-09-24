// Mortality & disposal projections for /gob/mortalidad (Item 2).
//
// Pure read-time projection over death_recorded events — no schema, no event
// type, no migration (umbrella D1). disposition_method/facility are read from
// the JSONB payload (payload->>'disposition_method'), never a column.
//
// Metrics (over death_recorded in scope + period):
//   B1 Mortality by cause, by ISO week        → byCauseWeek
//   B2 Disposition-method mix (D3 buckets)    → byBucket
//   B3 Traceable-disposal rate (Ley 5470)     → traceableRate
//   B4 Unknown-disposition rate               → unknownRate
//   B7 Disposal-context splits                → contextSplits
//   B8 Mortality clusters (by locality)       → byLocality (k-anonymity suppressed)
//   B9 Reportable-death share + code mix      → reportableShare / reportableByCode
//
// Deferred (see plan + spec): B5 death→deregistration lag (death_recorded IS the
// terminal/deregistration event — no separate timestamp), B6 under-reporting
// (no external denominator), and the B8 per-death geo heat layer (the
// death_recorded payload carries no location_point; we ship the by-locality
// breakdown instead).
//
// Scope: deaths are anchored to the pet row via INNER JOIN pets ON pets.id =
// pet_events.pet_id and restricted by pets.jurisdictionProvince/Locality through
// petsScopeClause(ctx) — the death payload carries no jurisdiction fields
// (same pattern as fetchDeathCauses). Locality grouping routes through
// suppressSmallCells (k=5) per the privacy policy.

import { and, count, desc, eq, gte, lte, sql } from "drizzle-orm";

// POOL: analyticsDb (session pooler), NOT the OLTP transaction pooler — these are
// read-only multi-statement dashboard aggregates. supavisor transaction mode (6543)
// has a measured >100x pathology for this fan-out shape (db/index.ts); session mode
// serves it normally. Locally analyticsDb falls back to DATABASE_URL (identical dev/test).
import { analyticsDb as db, petEvents, pets } from "@/db";
import { type DispositionBucket, bucketOf } from "@/lib/domain/disposition";
import { K_ANON_MIN, type ProjectionContext, suppressSmallCells } from "@/lib/metrics";
import { petsScopeClause } from "@/lib/metrics/scope";
import type { Cell, SuppressedCells } from "@/lib/metrics/types";

/**
 * Sort locality cells so any k-anon rollup bucket (`isRollup: true`, see the
 * rollup builder below) sorts LAST regardless of its count — qa-triage-
 * 2026-07-23 finding #14. A rollup aggregates many sub-threshold localities
 * (each individually <5 deaths) into one row; its total can legitimately be
 * the largest in the chart purely from summing many small places, which would
 * otherwise make it read as "the #1 locality" in a plain count-desc list. Real
 * (individually-identified) cells keep their original relative order among
 * themselves — this only demotes the rollup, it does not re-rank the rest.
 */
export function sortLocalityCellsRollupLast<T extends Cell & { isRollup?: boolean }>(
  cells: readonly T[],
): T[] {
  return [...cells].sort((a, b) => {
    const aRollup = a.isRollup === true;
    const bRollup = b.isRollup === true;
    if (aRollup === bRollup) return 0;
    return aRollup ? 1 : -1;
  });
}

/**
 * Fold the k-anon-suppressed localities into ONE province-level row, or into
 * nothing when even the fold stays below k.
 *
 * THE ROLLUP IS A CELL TOO, and k applies to it exactly as it applies to the
 * rows it replaces. Folding a single suppressed locality of 2 into a row
 * labelled "(otras localidades) — 2" anonymises nothing: it republishes that
 * locality's exact count under a different name, on a page whose own accessible
 * description promises "Localidades con menos de 5 fallecimientos están ocultas
 * por privacidad (k-anonimato)". Found live 2026-07-28: /gob/mortalidad
 * rendered "Tierra del Fuego (otras localidades) — 2".
 *
 * Below k the honest output is NO ROW. Nothing is lost to the reader:
 * suppressSmallCells still returns `suppressedCount`, so the page can say how
 * many localities were hidden without saying how many deaths they hold.
 *
 * Extracted from the fetcher's inline closure so the privacy rule can be tested
 * without a database — a rule that can only be exercised when the seed happens
 * to contain the right shape is a rule nobody checks.
 *
 * `isRollup` (qa-triage-2026-07-23, finding #14): this cell AGGREGATES many
 * sub-threshold localities, so its count can legitimately be the largest in the
 * chart (Santiago del Estero's rollup hit 1.965 in live seed data) purely from
 * summing small places. The page sorts it last and styles it apart rather than
 * letting it compete for the "biggest bar" spot.
 */
export function rollupSuppressedLocalities(rows: readonly Cell[]): Cell | null {
  const totalSuppressed = rows.reduce((sum, r) => sum + r.count, 0);
  if (totalSuppressed < K_ANON_MIN) return null;
  // Group label: the province of the first suppressed row (all rows in a
  // single-province scope share it; mixed-province scopes still produce a valid
  // coarse rollup label).
  const province = (rows[0] as Cell & { province?: string })?.province ?? "—";
  return {
    key: `${province} (otras localidades)`,
    count: totalSuppressed,
    province,
    isRollup: true,
  } as Cell;
}

const DISPOSITION = sql`(${petEvents.payload}->>'disposition_method')`;
const FACILITY = sql`(${petEvents.payload}->>'facility')`;

/** A non-empty, known facility string. */
const FACILITY_PRESENT = sql`(${FACILITY} IS NOT NULL AND btrim(${FACILITY}) <> '')`;
/** A concrete, known disposition method (not null, not 'unknown'). */
const METHOD_KNOWN = sql`(${DISPOSITION} IS NOT NULL AND ${DISPOSITION} <> 'unknown')`;
/** B3 traceable predicate: known method AND facility present. */
const TRACEABLE = sql`(${METHOD_KNOWN} AND ${FACILITY_PRESENT})`;
/** B4 unknown predicate: method null or 'unknown'. */
const UNKNOWN_DISPOSITION = sql`(${DISPOSITION} IS NULL OR ${DISPOSITION} = 'unknown')`;

export type DispositionBucketRow = { bucket: DispositionBucket; count: number };
export type CauseWeekRow = { week: string; cause: string; count: number };
export type ReportableCodeRow = { code: string; count: number };

export type MortalityDisposition = {
  /** Total death_recorded events in scope + period. */
  total: number;
  /** B2 — count per normalized disposition bucket, desc by count. */
  byBucket: DispositionBucketRow[];
  /** B3 — traceable-disposal rate as a 0–100 percentage. */
  traceableRate: number;
  /** B4 — unknown-disposition rate as a 0–100 percentage. */
  unknownRate: number;
  /** B7 — disposal-context splits as 0–100 percentages. */
  contextSplits: {
    vetConfirmedRate: number;
    deathAtClinicRate: number;
    privateCrematoriumRate: number;
  };
  /** B9 — reportable-death share as a 0–100 percentage. */
  reportableShare: number;
  /** B9 — reportable deaths grouped by disease_code, desc by count. */
  reportableByCode: ReportableCodeRow[];
  /** B1 — deaths grouped by (ISO week, cause), chronological then desc by count. */
  byCauseWeek: CauseWeekRow[];
  /** B8 — deaths grouped by locality, k-anonymity suppressed (rolled to province). */
  byLocality: { value: SuppressedCells; suppressedCount: number };
};

/**
 * Ratio (0–1) → 0–100 percentage, ONE decimal (Math.round(x*1000)/10).
 * Precision survives to the display layer — a 41.9% disposal rate renders as
 * 41,9%, not truncated to 41% here (KPI precision audit 2026-07-07). 0 when the
 * denominator is 0.
 */
function pct(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/**
 * Single fetcher for the /gob/mortalidad dashboard. Jurisdiction-scoped and
 * period-aware via ProjectionContext. Pure SQL/Drizzle.
 *
 * Issues four queries (all over the same scoped death_recorded population):
 *   1. scalar conditional aggregation (total + B3/B4/B7/B9 + bucket counts),
 *   2. B1 by (week, cause),
 *   3. B9 reportable by disease_code,
 *   4. B8 by locality (then suppressSmallCells).
 */
export async function fetchMortalityDisposition(
  ctx: ProjectionContext,
  opts?: {
    /** Optional species narrowing (domain-axes work). */
    species?: string;
    /**
     * Optional death-cause narrowing — one of the deathRecorded event schema's
     * `cause` enum values (lib/events/event-schemas.ts), or "unknown" for
     * events with no recorded cause (matches the COALESCE(...,'unknown') the
     * B1 cause breakdown already applies).
     */
    cause?: string;
  },
): Promise<MortalityDisposition> {
  // Govt with no assignments sees nothing.
  if (ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0) {
    return emptyResult();
  }

  const scope = petsScopeClause(ctx);
  const baseConditions = [
    eq(petEvents.eventType, "death_recorded"),
    gte(petEvents.occurredAt, ctx.period.since),
    lte(petEvents.occurredAt, ctx.period.until),
  ];
  if (scope) baseConditions.push(sql`(${scope})`);
  if (opts?.species) baseConditions.push(eq(pets.species, opts.species));
  if (opts?.cause) {
    baseConditions.push(sql`COALESCE(${petEvents.payload}->>'cause', 'unknown') = ${opts.cause}`);
  }
  // Single shared `where`, reused by every sub-query below (agg, buckets,
  // cause-week, reportable-code, locality) — narrowing it here keeps every
  // tile on the page internally consistent (domain-axes work: don't filter
  // the list but not the headline).
  const where = and(...baseConditions);

  // --- 1. Scalar conditional aggregation (one round-trip) ------------------
  const [agg] = await db
    .select({
      total: count(),
      traceable: sql<number>`count(*) FILTER (WHERE ${TRACEABLE})`.mapWith(Number),
      unknown: sql<number>`count(*) FILTER (WHERE ${UNKNOWN_DISPOSITION})`.mapWith(Number),
      vetConfirmed:
        sql<number>`count(*) FILTER (WHERE (${petEvents.payload}->>'confirmed_by_vet') = 'true')`.mapWith(
          Number,
        ),
      atClinic:
        sql<number>`count(*) FILTER (WHERE (${petEvents.payload}->>'death_at_clinic') = 'true')`.mapWith(
          Number,
        ),
      privateCrematorium:
        sql<number>`count(*) FILTER (WHERE (${petEvents.payload}->>'owner_to_private_crematorium') = 'true')`.mapWith(
          Number,
        ),
      reportable:
        sql<number>`count(*) FILTER (WHERE (${petEvents.payload}->>'is_reportable') = 'true')`.mapWith(
          Number,
        ),
    })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(where);

  const total = agg?.total ?? 0;

  if (total === 0) return emptyResult();

  // --- 2. B2 disposition buckets (group by raw method, fold in JS) ---------
  const methodRows = await db
    .select({
      method: sql<string | null>`${DISPOSITION}`,
      n: count(),
    })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(where)
    .groupBy(sql`${DISPOSITION}`);

  const bucketCounts = new Map<DispositionBucket, number>();
  for (const row of methodRows) {
    const bucket = bucketOf(row.method as never);
    bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + row.n);
  }
  const byBucket: DispositionBucketRow[] = [...bucketCounts.entries()]
    .map(([bucket, c]) => ({ bucket, count: c }))
    .sort((a, b) => b.count - a.count);

  // --- 3. B1 cause by ISO week --------------------------------------------
  const causeWeekRows = await db
    .select({
      week: sql<string>`to_char(date_trunc('week', ${petEvents.occurredAt}), 'IYYY-"W"IW')`,
      cause: sql<string>`COALESCE(${petEvents.payload}->>'cause', 'unknown')`,
      n: count(),
    })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(where)
    .groupBy(
      sql`date_trunc('week', ${petEvents.occurredAt})`,
      sql`COALESCE(${petEvents.payload}->>'cause', 'unknown')`,
    )
    .orderBy(sql`date_trunc('week', ${petEvents.occurredAt})`, desc(count()));
  const byCauseWeek: CauseWeekRow[] = causeWeekRows.map((r) => ({
    week: r.week,
    cause: r.cause,
    count: r.n,
  }));

  // --- 4. B9 reportable by disease_code ------------------------------------
  const codeRows = await db
    .select({
      code: sql<string>`COALESCE(${petEvents.payload}->>'disease_code', 'sin código')`,
      n: count(),
    })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(and(where, sql`(${petEvents.payload}->>'is_reportable') = 'true'`))
    .groupBy(sql`COALESCE(${petEvents.payload}->>'disease_code', 'sin código')`)
    .orderBy(desc(count()));
  const reportableByCode: ReportableCodeRow[] = codeRows.map((r) => ({
    code: r.code,
    count: r.n,
  }));

  // --- 5. B8 deaths by locality (k-anonymity suppressed) -------------------
  const localityRows = await db
    .select({
      province: pets.jurisdictionProvince,
      locality: pets.jurisdictionLocality,
      n: count(),
    })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(where)
    .groupBy(pets.jurisdictionProvince, pets.jurisdictionLocality);

  const cells: Cell[] = localityRows.map((r) => ({
    key: r.locality ?? "—",
    count: r.n,
    province: r.province ?? "—",
  }));

  const suppressed = suppressSmallCells<Cell>(cells, {
    count: (c) => c.count,
    key: (c) => c.key,
    rollup: rollupSuppressedLocalities,
  });

  return {
    total,
    byBucket,
    traceableRate: pct(agg?.traceable ?? 0, total),
    unknownRate: pct(agg?.unknown ?? 0, total),
    contextSplits: {
      vetConfirmedRate: pct(agg?.vetConfirmed ?? 0, total),
      deathAtClinicRate: pct(agg?.atClinic ?? 0, total),
      privateCrematoriumRate: pct(agg?.privateCrematorium ?? 0, total),
    },
    reportableShare: pct(agg?.reportable ?? 0, total),
    reportableByCode,
    byCauseWeek,
    byLocality: { value: suppressed.visible, suppressedCount: suppressed.suppressedCount },
  };
}

/** The two numbers the /gob home mortality card actually renders. */
export type MortalityHeadline = { total: number; traceableRate: number };

/**
 * /gob home shows ONLY `total` + `traceableRate` (both derived from the scalar
 * aggregation query #1), yet fetchMortalityDisposition runs FIVE sequential
 * queries (agg + method + cause-week + code + locality). This runs just the
 * first, cutting 4 serial round-trips off every home render (perf audit
 * 2026-07-19 qw#2). The full fetcher stays for /gob/mortalidad.
 */
export async function fetchMortalityHeadline(ctx: ProjectionContext): Promise<MortalityHeadline> {
  if (ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0) {
    return { total: 0, traceableRate: 0 };
  }
  const scope = petsScopeClause(ctx);
  const baseConditions = [
    eq(petEvents.eventType, "death_recorded"),
    gte(petEvents.occurredAt, ctx.period.since),
    lte(petEvents.occurredAt, ctx.period.until),
  ];
  if (scope) baseConditions.push(sql`(${scope})`);
  const [agg] = await db
    .select({
      total: count(),
      traceable: sql<number>`count(*) FILTER (WHERE ${TRACEABLE})`.mapWith(Number),
    })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(and(...baseConditions));
  const total = agg?.total ?? 0;
  return { total, traceableRate: pct(agg?.traceable ?? 0, total) };
}

/**
 * Prior-period death_recorded total, for the /gob/mortalidad deltaV2 chip.
 *
 * Mirrors fetchMortalityHeadline's `total` query EXACTLY (same event type,
 * same petsScopeClause scope) but shifted one full period back — same pattern
 * as campaign-metrics.ts' fetchPrevTotals: prevUntil = ctx.period.since,
 * prevSince = since − duration, where duration = ctx.period.until −
 * ctx.period.since. Consumed via formatDelta (lib/analytics/campaign-metrics.ts)
 * for an honest "vs período anterior" comparison scoped identically to the
 * headline value.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
export async function fetchPrevMortalityTotal(
  ctx: ProjectionContext,
  opts?: { species?: string; cause?: string },
): Promise<number> {
  if (ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0) {
    return 0;
  }

  const scope = petsScopeClause(ctx);
  const duration = ctx.period.until.getTime() - ctx.period.since.getTime();
  const prevSince = new Date(ctx.period.since.getTime() - duration);
  const prevUntil = ctx.period.since;

  const conditions = [
    eq(petEvents.eventType, "death_recorded"),
    gte(petEvents.occurredAt, prevSince),
    lte(petEvents.occurredAt, prevUntil),
  ];
  if (scope) conditions.push(sql`(${scope})`);
  if (opts?.species) conditions.push(eq(pets.species, opts.species));
  if (opts?.cause) {
    conditions.push(sql`COALESCE(${petEvents.payload}->>'cause', 'unknown') = ${opts.cause}`);
  }

  const [row] = await db
    .select({ n: count() })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(and(...conditions));

  return row?.n ?? 0;
}

function emptyResult(): MortalityDisposition {
  const empty = suppressSmallCells<Cell>([], {
    count: (c) => c.count,
    key: (c) => c.key,
  });
  return {
    total: 0,
    byBucket: [],
    traceableRate: 0,
    unknownRate: 0,
    contextSplits: { vetConfirmedRate: 0, deathAtClinicRate: 0, privateCrematoriumRate: 0 },
    reportableShare: 0,
    reportableByCode: [],
    byCauseWeek: [],
    byLocality: { value: empty.visible, suppressedCount: 0 },
  };
}
