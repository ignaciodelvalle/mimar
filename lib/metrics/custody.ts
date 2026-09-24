// lib/metrics/custody.ts — Paquete F: pipeline de custodia & adopción.
//
// Async fetchers built on ProjectionContext, scoped and period-aware:
//
//   fetchCustodyFunnel(ctx)           → intake→foster→adoption→reversed counts
//   fetchTimeInState(ctx)             → median/p75 days per custody role
//   fetchReturnRate(ctx)              → adoption_reversed / adoption_finalized (null if den=0)
//   fetchFosterPoolUtilization(ctx)   → volunteer pool + active placements
//   fetchShelterOccupancyNational(ctx)→ occupied / capacity / pct (national aggregate)
//   fetchAdoptionTrend(ctx)           → reuses fetchKpiTrend("adoption_finalized", ctx)
//
// PURE HELPERS (unit-testable, DB-free):
// ---------------------------------------
// funnelBarWidths, timeInStateNonNegative, returnRate
//
// EVENT TYPES USED:
//   pet_events.event_type:
//     'shelter_intake_recorded'  → shelter intake
//     'foster_assigned'          → foster placement
//     'adoption_finalized'       → adoption completed
//     'adoption_reversed'        → adoption reversed (devolución)
//
// TABLES / COLUMNS USED:
//   ownerships: role ('shelter_custody' | 'foster'), started_at, ended_at
//   foster_volunteers: status ('active'), available_slots
//   organizations: capacity_total, org_type (shelter)
//
// SCOPE:
//   - pet_events funnel → scoped via petsScopeClause (INNER JOIN pets)
//   - ownerships time-in-state → scoped via petsScopeClause (INNER JOIN pets)
//   - foster_volunteers → scoped via jurisdiction columns where present
//   - shelter occupancy national → aggregate across all shelter orgs (admin global only)

import { and, count, eq, gte, isNull, lte, sql } from "drizzle-orm";

// POOL: analyticsDb (session pooler), NOT the OLTP transaction pooler — these are
// read-only multi-statement dashboard aggregates. supavisor transaction mode (6543)
// has a measured >100x pathology for this fan-out shape (db/index.ts); session mode
// serves it normally. Locally analyticsDb falls back to DATABASE_URL (identical dev/test).
import {
  analyticsDb as db,
  fosterVolunteers,
  organizations,
  ownerships,
  petEvents,
  pets,
} from "@/db";

import type { ProjectionContext } from "./context";
import { jurisdictionPairClause, petsScopeClause } from "./scope";
import type { SingleSeriesTrend } from "./trends";
import { fetchKpiTrend } from "./trends";

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable, DB-free)
// ---------------------------------------------------------------------------

/**
 * Adoption funnel stages, ordered from broadest to narrowest.
 * Each stage count comes from the DB; this type makes the relationship explicit.
 */
export type FunnelCounts = {
  intake: number;
  foster: number;
  adoption: number;
  reversed: number;
};

/**
 * Bar-width percentages for the custody stage chart.
 *
 * The four stages are INDEPENDENT event counts in the period (see
 * fetchCustodyFunnel) — NOT a cohort that narrows from intake. A later stage
 * can legitimately exceed an earlier one (e.g. adoptions of animals whose
 * intake fell outside the window, or that entered via foster/street with no
 * recorded shelter intake). Treating intake as the funnel denominator and
 * clamping at 100% therefore MISREPRESENTS the data: it hides the fact that a
 * downstream stage is larger, painting a false "perfect pipeline".
 *
 * Instead, each bar is scaled to the LARGEST stage so the bars are visually
 * proportional to their raw counts. By construction the widest stage is 100%
 * and no stage ever exceeds it — no clamping, no borrowed denominator. The
 * numeric labels next to each bar show the raw counts; percentages are NOT
 * presented per stage (there is no honest shared denominator). The devolución
 * rate, when shown, is single-sourced from returnRate(reversed, adoption) so it
 * agrees with the "tasa de retorno" KPI on the same screen.
 *
 * @param stages - Raw funnel counts from fetchCustodyFunnel.
 * @returns Bar widths (0–100) proportional to the largest stage; all zeros when
 *          every stage is 0.
 */
export function funnelBarWidths(stages: FunnelCounts): {
  intakePct: number;
  fosterPct: number;
  adoptionPct: number;
  reversedPct: number;
} {
  const { intake, foster, adoption, reversed } = stages;
  const max = Math.max(intake, foster, adoption, reversed);
  if (max === 0) {
    return { intakePct: 0, fosterPct: 0, adoptionPct: 0, reversedPct: 0 };
  }
  const width = (n: number) => Math.round((n / max) * 1000) / 10;
  return {
    intakePct: width(intake),
    fosterPct: width(foster),
    adoptionPct: width(adoption),
    reversedPct: width(reversed),
  };
}

/**
 * Guard: time-in-state must be non-negative.
 * Returns the value clamped to 0 when negative (defensive against clock skew or
 * NULL endedAt resolved to now() producing a tiny negative due to microseconds).
 *
 * @param days - Duration in days (may be negative from floating-point rounding).
 */
export function timeInStateNonNegative(days: number): number {
  return Math.max(0, days);
}

/**
 * Return rate: reversed adoptions / finalized adoptions.
 *
 * @param reversed  - Count of adoption_reversed events in period.
 * @param finalized - Count of adoption_finalized events in period.
 * @returns Ratio (0–1+), or null when finalized === 0 (undefined rate).
 */
export function returnRate(reversed: number, finalized: number): number | null {
  if (finalized === 0) return null;
  return reversed / finalized;
}

// ---------------------------------------------------------------------------
// DB-bound types
// ---------------------------------------------------------------------------

/** Custody event funnel counts for the period. */
export type CustodyFunnel = FunnelCounts;

/** Median and p75 time-in-state per custody role. */
export type TimeInStateRow = {
  /** 'shelter_custody' or 'foster' */
  role: string;
  /** Median days in this state (null when no records). */
  medianDays: number | null;
  /** 75th-percentile days in this state (null when no records). */
  p75Days: number | null;
  /** Number of ownership records in scope. */
  n: number;
};

/** Foster volunteer pool utilization summary. */
export type FosterPoolUtilization = {
  /** COUNT of foster_volunteers WHERE status='active'. */
  activeVolunteers: number;
  /** COUNT of foster_volunteers WHERE status='active' AND available_slots>0. */
  withCapacity: number;
  /** COUNT of ownerships WHERE role='foster' AND ended_at IS NULL. */
  activeFosterPlacements: number;
};

/** National shelter occupancy (admin-only: aggregate across all shelter orgs). */
export type ShelterOccupancy = {
  /** SUM of active shelter_custody ownerships (occupied slots). */
  occupied: number;
  /** SUM of organizations.capacity_total for shelter orgs (null when no capacity declared). */
  capacity: number | null;
  /** Occupancy percentage (0–100+), or null when capacity is null. */
  pct: number | null;
};

// ---------------------------------------------------------------------------
// Shared guard
// ---------------------------------------------------------------------------

/** True when a govt actor has no assigned jurisdictions — queries return zeros. */
function isEmptyScope(ctx: ProjectionContext): boolean {
  return ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0;
}

// ---------------------------------------------------------------------------
// fetchCustodyFunnel — shelter_intake_recorded → foster_assigned →
//                      adoption_finalized → adoption_reversed
// ---------------------------------------------------------------------------

/**
 * Counts custody pipeline events in the projection period, scoped to the
 * viewer's jurisdiction via pet JOIN + petsScopeClause.
 *
 * Each stage is an INDEPENDENT count of events in the period — not a
 * "cohort following the same animals". This matches how all other event
 * funnel surfaces (mortalidad Disposición) work in this codebase.
 *
 * KPI tags: NUMERATOR = COUNT per stage of shelter_intake_recorded /
 * foster_assigned / adoption_finalized / adoption_reversed events in the ctx
 * period. DENOMINATOR = n/a (each stage an independent event count, not a
 * cohort-following ratio). SOURCE = pet_events. CADENCE = ctx.period.
 * SUPPRESSION = none.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
export async function fetchCustodyFunnel(
  ctx: ProjectionContext,
  opts?: { species?: string },
): Promise<CustodyFunnel> {
  const empty: CustodyFunnel = { intake: 0, foster: 0, adoption: 0, reversed: 0 };
  if (isEmptyScope(ctx)) return empty;

  const scope = petsScopeClause(ctx);

  const eventTypes = [
    "shelter_intake_recorded",
    "foster_assigned",
    "adoption_finalized",
    "adoption_reversed",
  ] as const;

  const results = await Promise.all(
    eventTypes.map((eventType) => {
      const conditions = [
        eq(petEvents.eventType, eventType),
        gte(petEvents.occurredAt, ctx.period.since),
        lte(petEvents.occurredAt, ctx.period.until),
      ];
      if (scope) conditions.push(sql`(${scope})`);
      if (opts?.species) conditions.push(eq(pets.species, opts.species));

      return db
        .select({ n: count() })
        .from(petEvents)
        .innerJoin(pets, eq(pets.id, petEvents.petId))
        .where(and(...conditions))
        .then((rows) => rows[0]?.n ?? 0);
    }),
  );

  return {
    intake: results[0],
    foster: results[1],
    adoption: results[2],
    reversed: results[3],
  };
}

/**
 * Prior-period adoption_finalized count, for the /gob/adopciones deltaV2 chip.
 *
 * Mirrors fetchCustodyFunnel's "adoption" stage EXACTLY (same event type, same
 * petsScopeClause scope, same admin drill-down via ctx.adminProvince/Locality)
 * but shifted one full period back — same pattern as campaign-metrics.ts'
 * fetchPrevTotals: prevUntil = ctx.period.since, prevSince = since − duration,
 * where duration = ctx.period.until − ctx.period.since. Consumed via
 * formatDelta (lib/analytics/campaign-metrics.ts) for an honest "vs período
 * anterior" comparison scoped identically to the headline value.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
export async function fetchPrevAdoptionCount(
  ctx: ProjectionContext,
  opts?: { species?: string },
): Promise<number> {
  if (isEmptyScope(ctx)) return 0;

  const scope = petsScopeClause(ctx);
  const duration = ctx.period.until.getTime() - ctx.period.since.getTime();
  const prevSince = new Date(ctx.period.since.getTime() - duration);
  const prevUntil = ctx.period.since;

  const conditions = [
    eq(petEvents.eventType, "adoption_finalized"),
    gte(petEvents.occurredAt, prevSince),
    lte(petEvents.occurredAt, prevUntil),
  ];
  if (scope) conditions.push(sql`(${scope})`);
  if (opts?.species) conditions.push(eq(pets.species, opts.species));

  const [row] = await db
    .select({ n: count() })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(and(...conditions));

  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// fetchTimeInState — median + p75 days per ownerships role
// ---------------------------------------------------------------------------

/**
 * Median and p75 time-in-state per custody role (shelter_custody, foster),
 * computed directly in Postgres via percentile_cont WITHIN GROUP.
 *
 * Duration = EXTRACT(epoch FROM COALESCE(ended_at, now()) - started_at) / 86400
 * (active ownerships use now() as the upper bound).
 *
 * Scoped by INNER JOIN pets + petsScopeClause. Results are clamped via
 * timeInStateNonNegative to guard against floating-point edge cases.
 *
 * KPI tags: NUMERATOR = percentile_cont(0.5 / 0.75) of ownerships duration
 * per role. DENOMINATOR = n/a (a distribution statistic, not a ratio). SOURCE
 * = ownerships. CADENCE = ownerships overlapping ctx.period. SUPPRESSION = none.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
export async function fetchTimeInState(
  ctx: ProjectionContext,
  opts?: { species?: string },
): Promise<TimeInStateRow[]> {
  if (isEmptyScope(ctx)) return [];

  const scope = petsScopeClause(ctx);

  // Build the WHERE clause: role IN ('shelter_custody','foster') + optional scope.
  const conditions = [
    sql`${ownerships.role} IN ('shelter_custody', 'foster')`,
    // Include ownerships that OVERLAP the period: started before period end
    // and either ended after period start or still active.
    lte(ownerships.startedAt, ctx.period.until),
    // Bind the date as an ISO string — a raw JS Date in sql`` crashes
    // postgres-js (prepare:false). lte() above binds its Date safely.
    sql`(${ownerships.endedAt} IS NULL OR ${ownerships.endedAt} >= ${ctx.period.since.toISOString()})`,
  ];
  if (scope) conditions.push(sql`(${scope})`);
  if (opts?.species) conditions.push(eq(pets.species, opts.species));

  const rows = await db
    .select({
      role: ownerships.role,
      medianDays: sql<number | null>`
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(epoch FROM COALESCE(${ownerships.endedAt}, NOW()) - ${ownerships.startedAt}) / 86400.0
        )
      `,
      p75Days: sql<number | null>`
        percentile_cont(0.75) WITHIN GROUP (
          ORDER BY EXTRACT(epoch FROM COALESCE(${ownerships.endedAt}, NOW()) - ${ownerships.startedAt}) / 86400.0
        )
      `,
      n: count(),
    })
    .from(ownerships)
    .innerJoin(pets, eq(pets.id, ownerships.petId))
    .where(and(...conditions))
    .groupBy(ownerships.role);

  return rows.map((r) => ({
    role: r.role,
    medianDays: r.medianDays != null ? timeInStateNonNegative(Number(r.medianDays)) : null,
    p75Days: r.p75Days != null ? timeInStateNonNegative(Number(r.p75Days)) : null,
    n: r.n,
  }));
}

// ---------------------------------------------------------------------------
// fetchReturnRate — adoption_reversed / adoption_finalized in period
// ---------------------------------------------------------------------------

/**
 * Return rate: fraction of finalized adoptions that were subsequently reversed.
 *
 * Both numerator and denominator are event counts in the projection period —
 * they are NOT guaranteed to represent the same cohort (a reversal in-period
 * may refer to an adoption that was finalized before the period start).
 * This matches the "events in window" approach used elsewhere.
 *
 * KPI: custody_return_rate (see lib/metrics/kpi-catalog.ts)
 *
 * NUMERATOR:   COUNT adoption_reversed events in the ctx period.
 * DENOMINATOR: COUNT adoption_finalized events in the SAME period — null when 0.
 * SOURCE:      pet_events (adoption_finalized, adoption_reversed).
 * CADENCE:     matches the caller's ProjectionContext period.
 * SUPPRESSION: none.
 *
 * @param ctx - ProjectionContext.
 * @returns returnRate (0–1+) or null when adoption_finalized === 0.
 */
export async function fetchReturnRate(
  ctx: ProjectionContext,
  opts?: { species?: string },
): Promise<number | null> {
  if (isEmptyScope(ctx)) return null;

  const scope = petsScopeClause(ctx);

  const makeConditions = (eventType: string) => {
    const conds = [
      eq(petEvents.eventType, eventType),
      gte(petEvents.occurredAt, ctx.period.since),
      lte(petEvents.occurredAt, ctx.period.until),
    ];
    if (scope) conds.push(sql`(${scope})`);
    if (opts?.species) conds.push(eq(pets.species, opts.species));
    return conds;
  };

  const [adoptionRows, reversedRows] = await Promise.all([
    db
      .select({ n: count() })
      .from(petEvents)
      .innerJoin(pets, eq(pets.id, petEvents.petId))
      .where(and(...makeConditions("adoption_finalized"))),
    db
      .select({ n: count() })
      .from(petEvents)
      .innerJoin(pets, eq(pets.id, petEvents.petId))
      .where(and(...makeConditions("adoption_reversed"))),
  ]);

  const adoption = adoptionRows[0]?.n ?? 0;
  const reversed = reversedRows[0]?.n ?? 0;
  return returnRate(reversed, adoption);
}

// ---------------------------------------------------------------------------
// fetchFosterPoolUtilization — volunteer pool + active placements
// ---------------------------------------------------------------------------

/**
 * Foster pool utilization: active volunteers, those with open slots, and
 * current active foster placements (ownerships.role='foster', ended_at IS NULL).
 *
 * foster_volunteers is scoped by jurisdiction columns when the ctx is
 * jurisdiction-scoped (province + locality filter on the volunteer table).
 * When the scope is global (admin) no filtering is applied.
 *
 * KPI tags: NUMERATOR = COUNT foster_volunteers (active / active+capacity) +
 * COUNT ownerships (role='foster', ended_at IS NULL). DENOMINATOR = n/a
 * (absolute counts). SOURCE = foster_volunteers, ownerships. CADENCE =
 * point-in-time snapshot. SUPPRESSION = none.
 *
 * @param ctx - ProjectionContext.
 */
export async function fetchFosterPoolUtilization(
  ctx: ProjectionContext,
): Promise<FosterPoolUtilization> {
  const empty: FosterPoolUtilization = {
    activeVolunteers: 0,
    withCapacity: 0,
    activeFosterPlacements: 0,
  };
  if (isEmptyScope(ctx)) return empty;

  // Jurisdiction filter for foster_volunteers (using jurisdiction columns).
  const volunteerScopeConditions: ReturnType<typeof sql>[] = [];
  if (ctx.scope.kind === "jurisdictions") {
    const { jurisdictions } = ctx.scope;
    if (jurisdictions.length === 0) return empty;
    // jurisdictionPairClause applies whole-province subsumption — see
    // lib/metrics/scope.ts. Found via authz-subsumption fence hardening
    // (2026-07-22) — same bug class as commit 68501bb4.
    // synthetic: exempt — foster_volunteers carry no seed marker (T1-P1 report).
    volunteerScopeConditions.push(
      jurisdictionPairClause(
        [...jurisdictions],
        sql`${fosterVolunteers.jurisdictionProvince}`,
        sql`${fosterVolunteers.jurisdictionLocality}`,
      ) ?? sql`false`,
    );
  }

  const petsScope = petsScopeClause(ctx);

  const [volunteerRows, placementRows] = await Promise.all([
    // Active volunteers and those with capacity — from foster_volunteers table.
    db
      .select({
        activeVolunteers: sql<number>`COUNT(*) FILTER (WHERE ${fosterVolunteers.status} = 'active')::int`,
        withCapacity: sql<number>`COUNT(*) FILTER (WHERE ${fosterVolunteers.status} = 'active' AND ${fosterVolunteers.availableSlots} > 0)::int`,
      })
      .from(fosterVolunteers)
      .where(volunteerScopeConditions.length > 0 ? and(...volunteerScopeConditions) : undefined),

    // Active foster placements — from ownerships (scoped via pets JOIN).
    db
      .select({ n: count() })
      .from(ownerships)
      .innerJoin(pets, eq(pets.id, ownerships.petId))
      .where(
        and(
          eq(ownerships.role, "foster"),
          isNull(ownerships.endedAt),
          ...(petsScope ? [sql`(${petsScope})`] : []),
        ),
      ),
  ]);

  return {
    activeVolunteers: volunteerRows[0]?.activeVolunteers ?? 0,
    withCapacity: volunteerRows[0]?.withCapacity ?? 0,
    activeFosterPlacements: placementRows[0]?.n ?? 0,
  };
}

// ---------------------------------------------------------------------------
// fetchShelterOccupancyNational — aggregate across all shelter orgs
// ---------------------------------------------------------------------------

/**
 * National shelter occupancy: SUM of active shelter_custody ownerships vs
 * SUM of organizations.capacity_total for shelter-type orgs.
 *
 * This is an ADMIN-ONLY metric (national aggregate). When the ctx scope is
 * jurisdiction-scoped the function still runs but the pet join scopes it to
 * the assigned jurisdictions (useful for a gob view of their territory).
 *
 * Reuses lib/org-census.ts mental model (active shelter_custody ownerships
 * = occupied slots) but aggregates NATIONALLY rather than per-org.
 *
 * KPI: shelter_occupancy_national (see lib/metrics/kpi-catalog.ts)
 *
 * NUMERATOR:   SUM active ownerships WHERE role='shelter_custody' AND ended_at IS NULL.
 * DENOMINATOR: SUM organizations.capacity_total for org_type='shelter' — null
 *              when no capacity declared.
 * SOURCE:      ownerships, organizations.
 * CADENCE:     point-in-time snapshot.
 * SUPPRESSION: none.
 *
 * @param ctx - ProjectionContext.
 */
export async function fetchShelterOccupancyNational(
  ctx: ProjectionContext,
): Promise<ShelterOccupancy> {
  const empty: ShelterOccupancy = { occupied: 0, capacity: null, pct: null };
  if (isEmptyScope(ctx)) return empty;

  const petsScope = petsScopeClause(ctx);

  // Active shelter_custody ownerships (occupied slots).
  const occupiedConditions = [
    eq(ownerships.role, "shelter_custody"),
    isNull(ownerships.endedAt),
    ...(petsScope ? [sql`(${petsScope})`] : []),
  ];

  const [occupiedRows, capacityRows] = await Promise.all([
    db
      .select({ occupied: count() })
      .from(ownerships)
      .innerJoin(pets, eq(pets.id, ownerships.petId))
      .where(and(...occupiedConditions)),

    // SUM of capacity_total for shelter orgs (all, not scoped — capacity is org config).
    db
      .select({
        totalCapacity: sql<number | null>`SUM(${organizations.capacityTotal})`,
      })
      .from(organizations)
      .where(eq(organizations.orgType, "shelter")),
  ]);

  const occupied = occupiedRows[0]?.occupied ?? 0;
  const rawCapacity = capacityRows[0]?.totalCapacity;
  const capacity = rawCapacity != null ? Number(rawCapacity) : null;
  const pct =
    capacity != null && capacity > 0 ? Math.round((occupied / capacity) * 1000) / 10 : null;

  return { occupied, capacity, pct };
}

// ---------------------------------------------------------------------------
// fetchAdoptionTrend — reuses fetchKpiTrend("adoption_finalized", ctx)
// ---------------------------------------------------------------------------

/**
 * Adoption trend: bucketed counts of adoption_finalized events in the period.
 *
 * Directly reuses fetchKpiTrend from lib/metrics/trends.ts — same
 * petEventsScopeClause, same date_trunc, same k-anonymity suppression.
 *
 * KPI tags: trend view of adoption_finalized events — see fetchKpiTrend
 * (lib/metrics/trends.ts) for the shared NUMERATOR/SOURCE/CADENCE/SUPPRESSION.
 *
 * @param ctx - ProjectionContext.
 */
export async function fetchAdoptionTrend(
  ctx: ProjectionContext,
  opts?: { species?: string },
): Promise<SingleSeriesTrend> {
  return fetchKpiTrend("adoption_finalized", ctx, opts);
}
