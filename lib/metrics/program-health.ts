// lib/metrics/program-health.ts — Paquete H: salud operativa del programa.
//
// Fetchers for /admin/programa (executive summary) and /admin/sistema extensions.
//
// SCHEMA NOTE — alert_subscriptions:
//   The alerts/subscriptions feature requires a new `alert_subscriptions` table.
//   This has NOT been implemented. A "Próximamente" placeholder appears in the UI.
//   DO NOT build the table or migration until the product decision is made.
//
// Fetchers implemented here (all NO-SCHEMA — reads existing tables only):
//   fetchDataQuality(ctx)              → completeness + orphan counts
//   fetchCrossJurisdictionOutliers(ctx) → per-province coverage vs targets
//   fetchPiiOversight(ctx)             → top PII actors from audit_log
//
// Reused from other modules (import, not reimplemented):
//   fetchEnoSla(ctx)    ← lib/surveillance-metrics.ts
//   fetchQueueHealth()  ← lib/admin-metrics.ts
//   fetchCronRuns()     ← lib/admin-metrics.ts
//
// PURE helpers (unit-tested, DB-free):
//   isOutlier(rate, target, warnBand?)   → boolean
//   completeness({ total, missingAny })  → number (0–100 percentage)
//
// Pattern B: population-level SQL aggregates, jurisdiction-scoped, period-aware.
// k-anon: skip provinces with denominator < 5 (K_ANON_MIN).

import { and, count, desc, gte, inArray, sql } from "drizzle-orm";

// POOL: analyticsDb (session pooler), NOT the OLTP transaction pooler — these are
// read-only multi-statement dashboard aggregates (fetchDataQuality / outliers / PII
// oversight feed /admin/programa + /gob/programa). supavisor transaction mode (6543)
// has a measured >100x pathology for this fan-out shape (db/index.ts); session mode
// serves it normally. Locally analyticsDb falls back to DATABASE_URL (identical dev/test).
import { auditLog, analyticsDb as db, govtAssignments, pets } from "@/db";
import { activePetsCondition, petsScopeClause } from "@/lib/metrics";

import { ANONYMITY_K } from "./anonymity";
import type { ProjectionContext } from "./context";
import { rabiesVaccinatedExists } from "./rabies";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum province denominator — provinces with fewer active pets are skipped.
 *
 * DERIVED from ANONYMITY_K (2026-08-17). The guards below are hand-written
 * comparisons rather than `suppressSmallCells` calls (they skip a province
 * outright instead of partitioning cells), so nothing structural kept this
 * number equal to the shared floor — it was equal by coincidence and a comment.
 * `mortality-metrics.ts` fed it straight into `suppressSmallCells`, which now
 * applies ANONYMITY_K unconditionally; had the two ever diverged, the same
 * province would have been "too small" on one screen and publishable on another.
 */
export const K_ANON_MIN = ANONYMITY_K;

/** Maximum PII oversight rows returned (top actors by count). */
const PII_OVERSIGHT_TOP_N = 20;

// ---------------------------------------------------------------------------
// PURE helpers — unit-tested, no DB dependency
// ---------------------------------------------------------------------------

/**
 * Returns true when a rate is below the outlier threshold (rate < target).
 *
 * Higher-is-better metrics (coverage, penetration) are outliers when they
 * fall BELOW the target. An optional warnBand (0–1) defines a "warn" zone:
 *   danger → rate < target * (1 - warnBand)
 *   warn   → rate >= target * (1 - warnBand) AND rate < target
 * isOutlier returns true for BOTH danger and warn when warnBand is omitted.
 *
 * @param rate     - Observed rate (0–100 percentage).
 * @param target   - Programme target (0–100 percentage).
 * @param warnBand - Optional fraction of target defining the warn zone (0–1).
 *                   If omitted, any value below target is an outlier.
 */
export function isOutlier(rate: number, target: number, warnBand?: number): boolean {
  if (warnBand === undefined) {
    // No band — anything below target is an outlier.
    return rate < target;
  }
  // With warn band: outlier if below target (covers both warn and danger).
  return rate < target;
}

/**
 * Data completeness as a whole-number percentage (0–100).
 *
 * Formula: ((total - missingAny) / total) * 100, rounded to nearest integer.
 * Returns 100 when total is 0 (empty population → nothing is missing).
 *
 * @param total      - Total active pets in scope.
 * @param missingAny - Pets missing at least one required field.
 */
export function completeness({
  total,
  missingAny,
}: {
  total: number;
  missingAny: number;
}): number {
  if (total === 0) return 100;
  return Math.round(((total - missingAny) / total) * 100);
}

/**
 * Counts DISTINCT provinces with at least one below-target metric.
 *
 * `fetchCrossJurisdictionOutliers` returns one row per (province × metric)
 * combination, so filtering to `isOutlier` rows and taking `.length` counts
 * COMBINATIONS, not provinces — a province with 2 below-target metrics
 * contributes 2 rows. That combination count is the right value for the
 * outliers table's "N de M combinaciones bajo meta" caption, but it is NOT
 * the right value for a KPI labeled "Provincias en alerta": it routinely
 * exceeds Argentina's ~24 provinces, which is dishonest under that label.
 *
 * This helper collapses the outlier rows to distinct `province` values, so
 * the result is always ≤ the total number of provinces represented in `rows`.
 */
export function countAlertedProvinces(
  rows: readonly Pick<OutlierRow, "province" | "isOutlier">[],
): number {
  return new Set(rows.filter((r) => r.isOutlier).map((r) => r.province)).size;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DataQuality = {
  /** Total active pets in scope. */
  total: number;
  /** Active pets with jurisdiction_locality IS NULL. */
  missingLocality: number;
  /** Active pets with sex = 'unknown'. */
  missingSex: number;
  /** Active pets with no active microchip_iso identification. */
  missingChip: number;
  /**
   * Active pets with NO ownerships row (orphaned — no active owner on record).
   * Orphan pets are a data-quality signal: they were registered but the owner
   * association is absent.
   */
  orphans: number;
  /**
   * Percentage of active pets that have NONE of the missing fields.
   * 0–100 whole-number percentage.
   */
  completenessPct: number;
};

export type OutlierMetric = "rabies" | "sterilization" | "microchip";

export type OutlierRow = {
  /** Province name (jurisdiction_province). */
  province: string;
  /** Which metric this row tracks. */
  metric: OutlierMetric;
  /** Observed coverage rate (0–100 percentage). */
  rate: number;
  /** Programme target for this metric (0–100 percentage). */
  target: number;
  /** Gap from target (target − rate). Positive = below target. */
  gap: number;
  /** True when rate < target (province is below benchmark). */
  isOutlier: boolean;
  /**
   * The population `rate` was divided by, in THIS province: active pets for
   * microchip/sterilization (all species), active DOGS for rabies. A measured
   * count from the same aggregate, never an estimate.
   *
   * WHY IT TRAVELS (metric-honesty audit, PO 2026-09-16). It used not to, and
   * the impact-ranking render sites had to supply a population from somewhere
   * else — both of them reached for `estimateDogPopulation(censusPopulations[p])`,
   * i.e. INDEC's human census × a CANINE ratio, and applied it to all three
   * rows. For `rabies` that is coherent (a dog gap over a dog population). For
   * the other two it is a category error: the gap fraction is all-species and
   * the population is dogs only, and the cell then printed "~N mascotas sin
   * chip" off a denominator that contains no cats.
   *
   * Sending the rate's OWN base along is what lets a consumer multiply a gap by
   * the population that gap is actually a fraction of. It also removes an
   * assumption rather than replacing it with another: `ESTIMATED_DOGS_PER_INHABITANT`
   * is, in census.ts's own words, "an explicit ASSUMPTION, not a measured
   * national figure" extrapolated from CABA and of a kind OPS/PANAFTOSA
   * "explicitly discourages", while this number is simply counted.
   *
   * Always >= K_ANON_MIN for a row that exists (the guards below skip smaller
   * provinces), so a consumer never divides by or ranks on a tiny base.
   */
  denominator: number;
};

export type PiiOversightRow = {
  /** actor_user_id (UUID) or null when the user was deleted. */
  actorUserId: string | null;
  /** Audit log action (e.g. 'pii_queried', 'welfare_location_viewed'). */
  action: string;
  /** Surface extracted from payload->>'surface' (may be null). */
  surface: string | null;
  /** Number of matching audit_log rows in the period. */
  count: number;
  /** Most recent audit_log.performed_at for this (actor, action, surface) group. */
  lastAt: Date;
};

// ---------------------------------------------------------------------------
// Shared guard
// ---------------------------------------------------------------------------

function isEmptyScope(ctx: ProjectionContext): boolean {
  return ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0;
}

// ---------------------------------------------------------------------------
// fetchDataQuality
// ---------------------------------------------------------------------------

/**
 * Data completeness scorecard for active pets in scope.
 *
 * Counts four missing-field signals + orphan detection:
 *   missingLocality — jurisdiction_locality IS NULL
 *   missingSex      — sex = 'unknown'
 *   missingChip     — no active microchip_iso identification (EXISTS pattern)
 *   orphans         — active pets with NO ownerships row (LEFT JOIN ... IS NULL)
 *
 * completenessPct: % of active pets with none of {missingLocality, missingSex,
 * missingChip} — orphans are a separate structural signal, not a profile field.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
/**
 * KPI: data_quality_completeness (see lib/metrics/kpi-catalog.ts)
 *
 * NUMERATOR:   COUNT active/lost pets with NONE of: jurisdiction_locality IS
 *              NULL, sex = 'unknown', missing active microchip_iso
 *              (completenessPct only — orphans is a separate structural signal).
 * DENOMINATOR: COUNT active/lost pets in scope.
 * SOURCE:      pets, pet_identifications, ownerships.
 * CADENCE:     point-in-time snapshot.
 * SUPPRESSION: none.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
export async function fetchDataQuality(ctx: ProjectionContext): Promise<DataQuality> {
  const empty: DataQuality = {
    total: 0,
    missingLocality: 0,
    missingSex: 0,
    missingChip: 0,
    orphans: 0,
    completenessPct: 100,
  };
  if (isEmptyScope(ctx)) return empty;

  const activeCond = activePetsCondition(ctx);
  const scope = petsScopeClause(ctx);

  // EXISTS subquery: active microchip_iso identification (mirrors compliance-metrics.ts C1).
  const hasActiveChip = sql`EXISTS (
    SELECT 1 FROM pet_identifications pi
    WHERE pi.pet_id = ${pets.id}
      AND pi.kind = 'microchip_iso'
      AND pi.status = 'active'
  )`;

  // EXISTS subquery: at least one ownerships row (any role, any status).
  // Orphan = active pet with NO ownership row at all.
  const hasOwnership = sql`EXISTS (
    SELECT 1 FROM ownerships o
    WHERE o.pet_id = ${pets.id}
  )`;

  // A single aggregate query computes all five counts.
  // completenessPct uses pets that have none of the three profile gaps.
  const [row] = await db
    .select({
      total: count(),
      missingLocality: sql<number>`COUNT(*) FILTER (WHERE ${pets.jurisdictionLocality} IS NULL)::int`,
      missingSex: sql<number>`COUNT(*) FILTER (WHERE ${pets.sex} = 'unknown')::int`,
      missingChip: sql<number>`COUNT(*) FILTER (WHERE NOT (${hasActiveChip}))::int`,
      orphans: sql<number>`COUNT(*) FILTER (WHERE NOT (${hasOwnership}))::int`,
      // "complete" = has locality AND sex != 'unknown' AND has active chip.
      complete: sql<number>`COUNT(*) FILTER (WHERE
        ${pets.jurisdictionLocality} IS NOT NULL
        AND ${pets.sex} <> 'unknown'
        AND (${hasActiveChip})
      )::int`,
    })
    .from(pets)
    .where(scope ? and(activeCond, sql`(${scope})`) : activeCond);

  const total = row?.total ?? 0;
  const complete = Number(row?.complete ?? 0);

  return {
    total,
    missingLocality: Number(row?.missingLocality ?? 0),
    missingSex: Number(row?.missingSex ?? 0),
    missingChip: Number(row?.missingChip ?? 0),
    orphans: Number(row?.orphans ?? 0),
    completenessPct: completeness({ total, missingAny: total - complete }),
  };
}

// ---------------------------------------------------------------------------
// fetchCrossJurisdictionOutliers
// ---------------------------------------------------------------------------

/**
 * Per-province coverage for three metrics vs programme targets.
 *
 * Metrics:
 *   rabies       — active dogs with ≥1 vaccination_administered event in scope
 *   sterilization — active pets with ≥1 sterilization_performed event in scope
 *   microchip    — active pets with an active microchip_iso identification
 *
 * For each province: rate = numerator / denominator (active pets or dogs).
 * isOutlier = rate < target. Provinces with < K_ANON_MIN active pets are skipped.
 *
 * Reuses EXISTS patterns from lib/compliance-metrics.ts (C1) and
 * lib/metrics/population-control.ts (sterilization).
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
/**
 * KPI: not yet in lib/metrics/kpi-catalog.ts (per-province table, reuses the
 * SAME rabies definition as rabies_coverage_dogs_12m — see below — plus two
 * metrics not otherwise catalogued: microchip and sterilization per province).
 *
 * rabies rows:
 *   NUMERATOR:   COUNT DISTINCT active dogs with a rabies vaccination event
 *                matching /(antirr[áa]bica|rabies)/i — IDENTICAL definition
 *                to rabies_coverage_dogs_12m (fetchRabiesCoverage), grouped
 *                by province instead of aggregated nationally.
 *   DENOMINATOR: COUNT active dogs in the province (skipped if < K_ANON_MIN).
 * microchip rows:
 *   NUMERATOR:   COUNT active pets with an active microchip_iso identification.
 *   DENOMINATOR: COUNT active pets in the province.
 * sterilization rows:
 *   NUMERATOR:   COUNT active pets with ≥1 sterilization_performed event.
 *   DENOMINATOR: COUNT active pets in the province.
 * SOURCE:      pets, pet_events (vaccination_administered, sterilization_performed),
 *              pet_identifications.
 * CADENCE:     point-in-time (microchip/sterilization) / matches ctx.period (rabies).
 * SUPPRESSION: k-anon — provinces with < K_ANON_MIN (5) active pets/dogs are omitted.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
export async function fetchCrossJurisdictionOutliers(
  ctx: ProjectionContext,
  // ADR-8 (jurisdiction-compliance WU4b): gob RSC callers may inject the
  // jurisdiction-resolved targets for the three metrics this table judges
  // (resolveJurisdictionTargets values). Omitted → the flat national TARGETS,
  // byte-identical for every admin/* caller (JT5). This module never resolves
  // jurisdiction rules itself — injection keeps it target-source-agnostic.
  injectedTargets?: {
    MICROCHIP_PENETRATION_PCT: number;
    STERILIZATION_COVERAGE_PCT: number;
    RABIES_COVERAGE_PCT: number;
  },
): Promise<OutlierRow[]> {
  if (isEmptyScope(ctx)) return [];

  // Import targets at call time — avoids circular-module risk during tests.
  const { TARGETS: FLAT_TARGETS } = await import("./targets");
  const TARGETS = injectedTargets ?? FLAT_TARGETS;

  const activeCond = activePetsCondition(ctx);

  // EXISTS: active microchip_iso (C1 pattern).
  const hasActiveChip = sql`EXISTS (
    SELECT 1 FROM pet_identifications pi
    WHERE pi.pet_id = ${pets.id}
      AND pi.kind = 'microchip_iso'
      AND pi.status = 'active'
  )`;

  // EXISTS: sterilization_performed event (Paquete G pattern).
  const hasSterilization = sql`EXISTS (
    SELECT 1 FROM pet_events pe
    WHERE pe.pet_id = ${pets.id}
      AND pe.event_type = 'sterilization_performed'
  )`;

  // EXISTS: rabies vaccination event (for dogs only — compliance-metrics.ts C1 analog).
  // Uses the SHARED rabiesVaccinatedExists predicate (lib/metrics/rabies.ts): the
  // same anchored accent-aware regex on the amended vaccine_name AND the same
  // "currently-valid" condition (next_due_at expiry, with a trailing-12m proxy
  // fallback — issue #52) as fetchRabiesCoverage, the province breakdown and the
  // Panorama choropleth. Before C3 this EXISTS had the regex but NO time window,
  // so the panel read ALL-TIME coverage (~54%) while the KPI read the
  // last-12-months figure (~42%) — the same-label/different-number drift.
  //
  // ONE AXIS STILL DIFFERS — the WINDOW, and it is deliberate. fetchRabiesCoverage
  // anchors a FIXED trailing 12 months ending at ctx.period.until (the legal
  // cadence is annual regardless of what period the operator is looking at);
  // this table passes ctx.period.since/until, i.e. the SELECTED period, because
  // "provinces below target during the period you are reviewing" is the question
  // an alerts table answers. On the default view (trailing12m) the two windows
  // are byte-identical; off-default the period is labelled on screen. Do not
  // "fix" this into parity without changing what the table means — but do not
  // read the sentence above as claiming the windows are always equal either.
  // (Audit 2026-08-12: the earlier wording claimed unqualified parity, which
  // sent a reviewer hunting for a divergence bug that was really this choice.)
  //
  // The DECEASED axis, which used to differ, no longer does: this query filters
  // activeCond and the choropleth numerator now filters pets.status the same way.
  const hasRabiesVax = rabiesVaccinatedExists(sql`${pets.id}`, {
    since: ctx.period.since,
    until: ctx.period.until,
  });

  // One query: per-province aggregates for all three numerators.
  const rows = await db
    .select({
      province: pets.jurisdictionProvince,
      totalPets: count(),
      // Dogs only (rabies denominator).
      totalDogs: sql<number>`COUNT(*) FILTER (WHERE ${pets.species} = 'dog')::int`,
      chipped: sql<number>`COUNT(*) FILTER (WHERE (${hasActiveChip}))::int`,
      sterilized: sql<number>`COUNT(*) FILTER (WHERE (${hasSterilization}))::int`,
      vaccinated: sql<number>`COUNT(*) FILTER (WHERE ${pets.species} = 'dog' AND (${hasRabiesVax}))::int`,
    })
    .from(pets)
    .where(activeCond)
    .groupBy(pets.jurisdictionProvince)
    .orderBy(sql`count(*) desc`);

  const result: OutlierRow[] = [];

  for (const r of rows) {
    if (r.province === null) continue;

    const province = r.province;
    const totalPets = r.totalPets;
    const totalDogs = Number(r.totalDogs);
    const chipped = Number(r.chipped);
    const sterilized = Number(r.sterilized);
    const vaccinated = Number(r.vaccinated);

    // k-anon guard: skip provinces with tiny denominators.
    if (totalPets < K_ANON_MIN) continue;

    // Microchip metric (denominator: all active pets).
    const chipRate = totalPets > 0 ? Math.round((chipped / totalPets) * 1000) / 10 : 0;
    result.push({
      province,
      metric: "microchip",
      rate: chipRate,
      target: TARGETS.MICROCHIP_PENETRATION_PCT,
      gap: Math.round((TARGETS.MICROCHIP_PENETRATION_PCT - chipRate) * 10) / 10,
      isOutlier: chipRate < TARGETS.MICROCHIP_PENETRATION_PCT,
      denominator: totalPets,
    });

    // Sterilization metric (denominator: all active pets).
    const sterilRate = totalPets > 0 ? Math.round((sterilized / totalPets) * 1000) / 10 : 0;
    result.push({
      province,
      metric: "sterilization",
      rate: sterilRate,
      target: TARGETS.STERILIZATION_COVERAGE_PCT,
      gap: Math.round((TARGETS.STERILIZATION_COVERAGE_PCT - sterilRate) * 10) / 10,
      isOutlier: sterilRate < TARGETS.STERILIZATION_COVERAGE_PCT,
      denominator: totalPets,
    });

    // Rabies vaccination metric (denominator: active dogs only; skip if < K_ANON_MIN dogs).
    if (totalDogs >= K_ANON_MIN) {
      const rabiesRate = Math.round((vaccinated / totalDogs) * 1000) / 10;
      result.push({
        province,
        metric: "rabies",
        rate: rabiesRate,
        target: TARGETS.RABIES_COVERAGE_PCT,
        gap: Math.round((TARGETS.RABIES_COVERAGE_PCT - rabiesRate) * 10) / 10,
        isOutlier: rabiesRate < TARGETS.RABIES_COVERAGE_PCT,
        denominator: totalDogs,
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// fetchPiiOversight
// ---------------------------------------------------------------------------

/**
 * Aggregate view of PII-sensitive audit log actions in the analysis period.
 *
 * Actions included: 'pii_queried', 'welfare_location_viewed'.
 * Groups by (actor_user_id, action, payload->>'surface').
 * Returns top PII_OVERSIGHT_TOP_N rows ordered by count desc.
 *
 * Scope behaviour:
 *  - ctx.scope.kind === "global" (admin): no actor filter — platform-wide view.
 *  - ctx.scope.kind === "jurisdictions" (govt): restricts to actors who hold an
 *    active govt_assignment matching one of the caller's jurisdictions. This
 *    closes the cross-tenant leak where a govt user could previously see PII
 *    actions from actors in other provinces.
 *
 * Read-only aggregate on existing audit_log + govt_assignments — no schema changes.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
/**
 * KPI: not yet in lib/metrics/kpi-catalog.ts (an oversight ledger, not a
 * rate/coverage KPI — documented here directly for completeness).
 *
 * NUMERATOR:   COUNT audit_log rows grouped by (actor_user_id, action, surface)
 *              WHERE action IN ('pii_queried', 'welfare_location_viewed').
 * DENOMINATOR: n/a — top-N ranked counts, not a ratio.
 * SOURCE:      audit_log, govt_assignments (for govt scope actor filtering).
 * CADENCE:     since ctx.period.since (no upper bound — "since X" not "in window").
 * SUPPRESSION: top PII_OVERSIGHT_TOP_N (20) rows only; no k-anon — and this one
 *              genuinely is exempt, unlike the province rollups #40b re-triaged.
 *              k-anonymity protects DATA SUBJECTS grouped into a jurisdiction
 *              cell. These rows group by (actor_user_id, action, surface): the
 *              unit is a named STAFF ACTOR whose identifiability is the entire
 *              point of an oversight ledger, and the govt filter above already
 *              restricts it to actors assigned to the viewer's jurisdictions.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
export async function fetchPiiOversight(ctx: ProjectionContext): Promise<PiiOversightRow[]> {
  const { since } = ctx.period;

  // Build the actor filter for govt scope.
  // For admin (global scope) we skip the subquery entirely so the planner can
  // use the existing audit_log indexes without an extra join.
  let actorFilter: ReturnType<typeof sql> | undefined;

  if (ctx.scope.kind === "jurisdictions") {
    const { jurisdictions } = ctx.scope;

    if (jurisdictions.length === 0) {
      // Govt with zero assignments — matches nothing.
      return [];
    }

    // Collect user_ids from govt_assignments that match any of the caller's
    // jurisdiction pairs and are not revoked.
    const assignedUserIds = (
      await db
        .selectDistinct({ userId: govtAssignments.userId })
        .from(govtAssignments)
        .where(
          and(
            sql`${govtAssignments.revokedAt} IS NULL`,
            sql`(${govtAssignments.jurisdictionProvince}, ${govtAssignments.jurisdictionLocality}) IN (${sql.join(
              jurisdictions.map((j) => sql`(${j.province}, ${j.locality})`),
              sql`, `,
            )})`,
          ),
        )
    ).map((r) => r.userId);

    if (assignedUserIds.length === 0) return [];

    actorFilter = inArray(auditLog.actorUserId, assignedUserIds) as unknown as ReturnType<
      typeof sql
    >;
  }

  const rows = await db
    .select({
      actorUserId: auditLog.actorUserId,
      action: auditLog.action,
      surface: sql<string | null>`${auditLog.payload}->>'surface'`,
      count: sql<number>`COUNT(*)::int`,
      // Raw-sql aggregates arrive as strings at runtime (see admin-metrics.ts,
      // digest 1282362471) — coerced in the map below so the declared Date
      // shape is actually true.
      lastAt: sql<string | Date>`MAX(${auditLog.performedAt})`,
    })
    .from(auditLog)
    .where(
      and(
        // Filter to PII-sensitive actions. Using sql literal to avoid the strict
        // AuditLogAction union type — the values are correct per schema catalog.
        sql`${auditLog.action} IN ('pii_queried', 'welfare_location_viewed')`,
        gte(auditLog.performedAt, since),
        actorFilter,
      ),
    )
    .groupBy(auditLog.actorUserId, auditLog.action, sql`${auditLog.payload}->>'surface'`)
    .orderBy(desc(sql<number>`COUNT(*)`))
    .limit(PII_OVERSIGHT_TOP_N);

  return rows.map((r) => ({
    actorUserId: r.actorUserId,
    action: r.action,
    surface: r.surface,
    count: Number(r.count),
    lastAt: r.lastAt instanceof Date ? r.lastAt : new Date(r.lastAt),
  }));
}
