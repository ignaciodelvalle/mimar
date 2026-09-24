// Analytics metrics — E5 (adoption rate, rabies vaccination rate, custody
// disputes, acquisition trend, death causes).
// Split out of lib/analytics/govt-dashboards.ts (engram refactor/govt-dashboards-split).

import { and, count, countDistinct, desc, eq, gte, sql } from "drizzle-orm";

import { custodyDisputes, analyticsDb as db, disputeHoldsCustodyLock, petEvents, pets } from "@/db";
import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import { amendedPayloadText } from "@/lib/infra/amendment-sql";
import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";
import { DAY_MS, custodyDisputesScopeClause, petsScopeClause } from "./_scope";

// NOTE(E5): The spec references "shelter_adoption" as an acquisition method,
// but the canonical `pet_registered` payload enum is:
//   adopted | purchased | found_stray | gift | born_in_litter | other
// "shelter_adoption" does not exist. The closest is "adopted" (standard shelter
// adoption). `fetchAcquisitionTrend` uses "adopted" as the primary positive bucket.
//
// The `pet_acquired` event type listed in the spec does not exist in this codebase.
// Acquisitions are captured via `pet_registered` events whose payload includes
// `acquisition_method`. All four fetchers below use `pet_registered` for acquisition
// data. TODO(E5-followup): revisit if a distinct `pet_acquired` event type lands.

export type AnalyticsMetrics = {
  /** Total pets in scope with status 'active' or 'lost' (excludes deceased). */
  totalPets: number;
  /**
   * % of pets in scope registered with acquisition_method='adopted' in the last 12 months.
   * Computed as (adopted / total registrations in window) * 100, rounded to integer.
   *
   * NOTE(E5-followup): spec referenced "shelter_adoption"; canonical enum value is "adopted".
   * Using "adopted" as proxy. If a more granular custody_kind='shelter_custody_by_org'
   * distinction is needed, cross-join with the petRegistered payload's custody_kind field.
   */
  adoptionRate: number;
  /**
   * Denominator behind adoptionRate: total acquisitions (pet_registered, 12m)
   * in scope. Exposed so the tile can wire the descriptor's zeroDenominator/
   * smallN guards (prepush-review-3 2026-07-23: without it the guard was dead
   * code and 0/0 rendered as a confident red 0%).
   */
  totalAcquisitions: number;
  /**
   * % of pets in scope with at least one vaccination_administered event where
   * vaccine_name matches rabia/rabies/antirrábica/antirrabica (accent-insensitive).
   * Uses unaccent() so accented forms like "antirrábica" are counted alongside
   * ASCII forms "rabia" and "rabies".
   * Computed as (pets with ≥1 rabia event / totalPets) * 100, rounded to integer.
   * Returns 0 when totalPets = 0.
   */
  rabiesVaccinationRate: number;
  /**
   * Open disputes in scope from the `custody_disputes` table — the SAME source
   * the /gob/disputas queue lists, so the KPI alarm and the queue reconcile.
   */
  custodyDisputes: number;
};

/**
 * Canonical es-AR label for the `rabiesVaccinationRate` field — ALL SPECIES,
 * all-time (no trailing window).
 *
 * DISAMBIGUATION (critique-govt-2026-07-03.md, "Same metric, different
 * numbers" — 54% here vs 42% under the same old label elsewhere): this KPI is
 * DISTINCT from RABIES_COVERAGE_LABEL_ES (lib/analytics/govt-home-kpis.ts),
 * which counts DOGS ONLY over a trailing 12-month window. Full
 * numerator/denominator breakdown of both lives in lib/metrics/kpi-catalog.ts
 * (rabies_vaccination_rate_all_species vs rabies_coverage_dogs_12m).
 *
 * RESOLVED (render-site): app/gob/analytics/AnalyticsScreen.tsx imports and renders
 * this exact constant (`label={RABIES_VACCINATION_RATE_LABEL_ES}`) instead of
 * repeating a similar-looking string — see
 * app/gob/analytics/_components/RegionRankingTable.test.tsx for the regression
 * guard against the old ambiguous "Cobertura antirrábica (mascotas)" copy.
 *
 * C1 rename (2026-07-22, plan-maestro §3c): "Cobertura antirrábica — todas
 * las mascotas (histórico)" still shared the "Cobertura antirrábica" stem
 * with the compliance KPI (rabies_coverage_dogs_12m) — legible only if you
 * read the parenthetical. Renamed to something unmistakable at a glance; see
 * lib/metrics/kpi-catalog.ts (rabies_vaccination_rate_all_species) for the
 * full contract (semaphore: none — this is a historical count, never a
 * legal-verdict color).
 */
export const RABIES_VACCINATION_RATE_LABEL_ES =
  "Vacunación histórica (todas las especies, sin ventana)";

/**
 * KPI: rabiesVaccinationRate → rabies_vaccination_rate_all_species (see
 * lib/metrics/kpi-catalog.ts); adoptionRate → not yet catalogued (adoption
 * funnel, no ambiguity reported).
 *
 * rabiesVaccinationRate:
 *   NUMERATOR:   COUNT DISTINCT active/lost pets of ANY species with ≥1
 *                vaccination_administered event where
 *                unaccent(vaccine_name) ILIKE unaccent('%rabi%') (amendment-
 *                overlay-aware). NO occurred_at filter — all-time.
 *   DENOMINATOR: COUNT active/lost pets (any species) in scope (totalPets).
 *   SOURCE:      pets, pet_events (vaccination_administered).
 *   CADENCE:     all-time — recomputed per render, not windowed.
 *   SUPPRESSION: none.
 *
 * adoptionRate:
 *   NUMERATOR:   COUNT pet_registered events (trailing 12m, scoped) with
 *                payload.acquisition_method = 'adopted'.
 *   DENOMINATOR: COUNT pet_registered events (trailing 12m, scoped) — ALL
 *                acquisition methods, not just adoptions.
 *   SOURCE:      pet_events (pet_registered).
 *   CADENCE:     trailing 12 months.
 *   SUPPRESSION: none.
 *
 * @param actor - DashboardActor (role + id).
 * @param jurisdictions - Caller's assigned jurisdiction pairs (govt) or ignored (admin).
 * @param opts - since window override + optional admin province/locality drill-down.
 */
export async function fetchAnalyticsMetrics(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  opts: {
    since?: Date;
    /**
     * Admin province drill-down (Panorama). Only set when actor.role === "admin"
     * and a province was selected. Never set from govt page code.
     */
    adminProvince?: string;
    adminLocality?: string;
  } = {},
): Promise<AnalyticsMetrics> {
  // Early-return for govt with no assignments.
  if (!hasNationalReadScope(actor.role) && jurisdictions.length === 0) {
    return {
      totalPets: 0,
      adoptionRate: 0,
      totalAcquisitions: 0,
      rabiesVaccinationRate: 0,
      custodyDisputes: 0,
    };
  }

  const since12m = opts.since ?? new Date(Date.now() - 365 * DAY_MS);
  const adminProvince = opts.adminProvince;
  const adminLocality = opts.adminLocality;

  // ONE pets-scope predicate for all three pets-based counts below (C3, ONE
  // VIEWSCOPE): govt jurisdiction pairs OR the admin province/locality drill,
  // resolved by the shared helper. adminProvince/adminLocality are inert for
  // govt actors (their ctx.scope.kind is "jurisdictions", so the admin branch
  // never fires) — the same invariant the hand-rolled `actor.role === "admin"`
  // guards used to spell out at each call site.
  const petsScope = petsScopeClause(actor, jurisdictions, adminProvince, adminLocality);

  // 1. totalPets: active or lost in scope.
  //
  // DELIBERATELY NO pets.deleted_at FILTER, here or in the joins below.
  // Art. 16 (Ley 25.326) retires the animal's IDENTITY, not the fact that it
  // was registered: these are jurisdiction-level aggregates that carry no
  // token, no name, no per-pet row — nothing an erasure is entitled to remove
  // from a census. The repo-wide line is: per-pet surfaces exclude
  // soft-deleted pets; identity-free aggregates include them (same stance as
  // lib/metrics/census.ts). An earlier record claimed this module "aggregates
  // by event, with no roster join" — false (this count reads FROM pets and
  // several sub-queries inner-join it); the join is real, the reason to leave
  // it unfiltered is that aggregates carry no identity.
  const totalConditions = [sql`${pets.status} IN ('active', 'lost')`];
  if (petsScope) totalConditions.push(sql`(${petsScope})`);

  // 2. adoptionRate: pet_registered events with acquisition_method='adopted', last 12m.
  //    Scope via inner join to pets.jurisdictionProvince/Locality.
  //    NOTE(E5-followup): acquisition method is in pet_registered payload, not a separate event.
  const acquisitionConditions = [
    eq(petEvents.eventType, "pet_registered"),
    gte(petEvents.occurredAt, since12m),
  ];
  // Same pets-scope predicate as totalPets — applied to the joined `pets` row.
  // The innerJoin to pets is added below via needsJoin.
  if (petsScope) acquisitionConditions.push(sql`(${petsScope})`);

  // 3. rabiesVaccinationRate: distinct petIds with ≥1 vaccination_administered where
  //    vaccine_name accent-insensitively matches rabia/rabies/antirrábica/antirrabica.
  //    unaccent() strips diacritics on both sides so the pattern '%rabi%' catches:
  //      - "rabia"           → unaccent → "rabia"       → contains "rabi" ✓
  //      - "rabies"          → unaccent → "rabies"      → contains "rabi" ✓
  //      - "antirrábica"     → unaccent → "antirrabica" → contains "rabi" ✓
  //      - "Antirrábica"     → unaccent → "Antirrabica" → ILIKE catches case ✓
  //    Requires the unaccent extension (migration 0070; first referenced in 0055).
  //
  //    NUMERATOR ⊆ DENOMINATOR (review 2026-08-22, H8). The denominator above is
  //    `status IN ('active','lost')`; this numerator used to carry NO status
  //    filter — and for the admin-national case no join to `pets` at all — so it
  //    counted DECEASED animals against a padrón that excludes them. Measured on
  //    the local DB: 20.719/29.014 = 71,4 % on this tile against 18.192/29.014 =
  //    62,7 % on the ranking table rendered directly below it under the same
  //    label, and 500 % in seeded localities where every vaccinated pet had died.
  //    The status filter and the join go together: without an unconditional join
  //    there is no `pets` row to filter on in the national case.
  const rabiesConditions = [
    eq(petEvents.eventType, "vaccination_administered"),
    // Amendment overlay (audit A2): match the CURRENT (corrected) vaccine name.
    sql`unaccent(${amendedPayloadText("vaccine_name")}) ILIKE unaccent(${"%rabi%"})`,
    // Same padrón definition as totalPets — see analytics-ranking.ts, which
    // applies the identical filter and is asserted to agree with this tile.
    sql`${pets.status} IN ('active', 'lost')`,
  ];
  // Same pets-scope predicate again — applied to the joined `pets` row.
  if (petsScope) rabiesConditions.push(sql`(${petsScope})`);

  // 4. custodyDisputes: in-dispute rows in `custody_disputes` — the SAME
  //    source the /gob/disputas queue lists, so the KPI alarm and the queue
  //    always reconcile (count↔queue parity). This previously counted
  //    cases(case_kind='custody_dispute'), a SUPERSET that also includes
  //    location-subject rows with no custody_disputes aggregate (nothing for the
  //    queue to surface) — producing a "9" alarm over an empty queue.
  // In-dispute is open OR escalated (PO decision 2A, 2026-09-22) — the queue
  // uses the SAME predicate, so count↔queue parity survives escalation.
  const disputeConditions = [disputeHoldsCustodyLock()];
  // custody_disputes carries its own jurisdiction columns; the shared helper
  // resolves both the govt pairs and the admin province/locality drill.
  const disputesScope = custodyDisputesScopeClause(
    actor,
    jurisdictions,
    adminProvince,
    adminLocality,
  );
  if (disputesScope) disputeConditions.push(sql`(${disputesScope})`);

  // Whether petEvents sub-queries need an innerJoin to pets for province scoping.
  // Govt always joins (to apply jurisdiction pairs). Admin+province also joins.
  const needsJoin = !hasNationalReadScope(actor.role) || !!adminProvince;

  const [totalRows, acquisitionRows, adoptedRows, rabiesRows, disputeRows] = await Promise.all([
    db
      .select({ n: count() })
      .from(pets)
      .where(and(...totalConditions)),

    // Total registrations in last 12m for adoption-rate denominator.
    needsJoin
      ? db
          .select({ n: count() })
          .from(petEvents)
          .innerJoin(pets, eq(pets.id, petEvents.petId))
          .where(and(...acquisitionConditions))
      : db
          .select({ n: count() })
          .from(petEvents)
          .where(and(...acquisitionConditions)),

    // Adopted registrations in last 12m.
    needsJoin
      ? db
          .select({ n: count() })
          .from(petEvents)
          .innerJoin(pets, eq(pets.id, petEvents.petId))
          .where(
            and(
              ...acquisitionConditions,
              sql`(${petEvents.payload}->>'acquisition_method') = ${"adopted"}`,
            ),
          )
      : db
          .select({ n: count() })
          .from(petEvents)
          .where(
            and(
              ...acquisitionConditions,
              sql`(${petEvents.payload}->>'acquisition_method') = ${"adopted"}`,
            ),
          ),

    // Distinct pet IDs with ≥1 rabia vaccination.
    // The join is UNCONDITIONAL — unlike the acquisition counts above, this one
    // filters on the pet's status, not only on its jurisdiction, so it needs the
    // `pets` row even when the actor is a national admin with no drill-down.
    db
      .select({ n: countDistinct(petEvents.petId) })
      .from(petEvents)
      .innerJoin(pets, eq(pets.id, petEvents.petId))
      .where(and(...rabiesConditions)),

    db
      .select({ n: count() })
      .from(custodyDisputes)
      .where(and(...disputeConditions)),
  ]);

  const totalPets = totalRows[0]?.n ?? 0;
  const totalAcquisitions = acquisitionRows[0]?.n ?? 0;
  const adopted = adoptedRows[0]?.n ?? 0;
  const rabiesVaccinated = rabiesRows[0]?.n ?? 0;
  // Named ...Count to avoid shadowing the imported `custodyDisputes` table used
  // in the query above (block-scoped const would otherwise capture it in TDZ).
  const custodyDisputesCount = disputeRows[0]?.n ?? 0;

  // 1-decimal precision (Math.round(x*1000)/10) so the display can render
  // "41,9%" instead of a fetcher-truncated 41% (KPI precision audit 2026-07-07).
  const adoptionRate =
    totalAcquisitions === 0 ? 0 : Math.round((adopted / totalAcquisitions) * 1000) / 10;
  const rabiesVaccinationRate =
    totalPets === 0 ? 0 : Math.round((rabiesVaccinated / totalPets) * 1000) / 10;

  return {
    totalPets,
    adoptionRate,
    totalAcquisitions,
    rabiesVaccinationRate,
    custodyDisputes: custodyDisputesCount,
  };
}

// ============================================================================

// Acquisition method buckets per E5 spec.
// NOTE(E5): canonical enum in pet_registered payload is:
//   adopted | purchased | found_stray | gift | born_in_litter | other
// Spec-requested "shelter_adoption" maps to "adopted".
// Spec-requested "vecino_helps_stray" maps to "found_stray".
// Spec-requested "private_handover" maps to "purchased" (closest proxy).
// TODO(E5-followup): refine mapping once a `pet_acquired` event with explicit
// method fields is introduced.
const ACQUISITION_METHOD_BUCKET: Record<string, string> = {
  adopted: "shelter_adoption",
  found_stray: "vecino_helps_stray",
  purchased: "private_handover",
  gift: "private_handover",
};

function bucketAcquisitionMethod(raw: string | null): string {
  if (!raw) return "other";
  return ACQUISITION_METHOD_BUCKET[raw] ?? "other";
}

export type AcquisitionTrendPoint = {
  /** Pre-formatted x-axis label, e.g. "Ene 2026". */
  x: string;
  /** Pets acquired in this month + method bucket. */
  y: number;
  /** Method bucket: "shelter_adoption" | "vecino_helps_stray" | "private_handover" | "other". */
  method: string;
  /** ISO date of month start, for sorting. */
  periodStart: string;
};

/**
 * Acquisition trend — 12 months rolling, grouped by (month, acquisition_method_bucket).
 * Source: pet_registered events with acquisition_method in payload.
 * Rows without acquisition_method in the payload are excluded (null method).
 *
 * NOTE(E5): uses pet_registered events, not a separate pet_acquired event (which
 * does not exist in this codebase). Scope is via pets.jurisdictionProvince/Locality.
 */
export async function fetchAcquisitionTrend(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  opts: { since?: Date; adminProvince?: string; adminLocality?: string } = {},
): Promise<AcquisitionTrendPoint[]> {
  if (!hasNationalReadScope(actor.role) && jurisdictions.length === 0) return [];

  const since12m = opts.since ?? new Date(Date.now() - 365 * DAY_MS);

  const conditions = [
    eq(petEvents.eventType, "pet_registered"),
    gte(petEvents.occurredAt, since12m),
    // Exclude rows with null acquisition_method.
    sql`(${petEvents.payload}->>'acquisition_method') IS NOT NULL`,
  ];

  // ONE pets-scope predicate: govt jurisdiction pairs OR the admin
  // province/locality drill (Panorama-style), resolved by the shared helper —
  // same call as fetchAnalyticsMetrics/fetchPerdidasMetrics. Backward-compat:
  // admin with no drill → null → unrestricted, exactly as before.
  const petsScope = petsScopeClause(actor, jurisdictions, opts.adminProvince, opts.adminLocality);
  if (petsScope) conditions.push(sql`(${petsScope})`);

  // Whether the petEvents query needs an innerJoin to pets for province scoping.
  // Govt always joins (jurisdiction pairs); admin+adminProvince also joins.
  const needsJoin = !hasNationalReadScope(actor.role) || !!opts.adminProvince;

  const baseQuery = needsJoin
    ? db
        .select({
          month: sql<string>`date_trunc('month', ${petEvents.occurredAt})`,
          method: sql<string>`(${petEvents.payload}->>'acquisition_method')`,
          n: count(),
        })
        .from(petEvents)
        .innerJoin(pets, eq(pets.id, petEvents.petId))
        .where(and(...conditions))
        .groupBy(
          sql`date_trunc('month', ${petEvents.occurredAt})`,
          sql`(${petEvents.payload}->>'acquisition_method')`,
        )
        .orderBy(sql`date_trunc('month', ${petEvents.occurredAt})`)
    : db
        .select({
          month: sql<string>`date_trunc('month', ${petEvents.occurredAt})`,
          method: sql<string>`(${petEvents.payload}->>'acquisition_method')`,
          n: count(),
        })
        .from(petEvents)
        .where(and(...conditions))
        .groupBy(
          sql`date_trunc('month', ${petEvents.occurredAt})`,
          sql`(${petEvents.payload}->>'acquisition_method')`,
        )
        .orderBy(sql`date_trunc('month', ${petEvents.occurredAt})`);

  const rows = await baseQuery;

  return rows.map((r) => {
    const d = new Date(r.month);
    // UTC pin: same date_trunc('month') bucket-boundary rationale as above.
    // 2-digit year: matches timeseries.ts's formatBucketLabel ("sept 25") —
    // axis-format unification, visual review 2026-07-23 #13.
    const monthLabel = d.toLocaleString("es-AR", {
      month: "short",
      year: "2-digit",
      timeZone: "UTC",
    });
    return {
      x: monthLabel,
      y: r.n,
      method: bucketAcquisitionMethod(r.method),
      periodStart: d.toISOString(),
    };
  });
}

/**
 * FORECAST-A-META: reconstruct a per-month adoption-RATE series from
 * fetchAcquisitionTrend's ALREADY-FETCHED (month, method) rows — zero new
 * query. This is the ONE catalog KPI (acquisition_adoption_rate,
 * lib/metrics/kpi-catalog.ts) that qualifies for a forecast-to-target line:
 * unlike a stock coverage ratio (rabies/microchip), both this rate's
 * numerator (shelter_adoption count) and denominator (total count, all
 * methods) are FLOW quantities that resolve within the SAME month bucket, so
 * a per-bucket ratio is honestly backdatable from data already in hand.
 *
 * Mirrors adoptionRate's own definition (fetchAnalyticsMetrics, this file):
 * NUMERATOR = pet_registered with acquisition_method='adopted' (bucketed to
 * "shelter_adoption"); DENOMINATOR = pet_registered, ALL acquisition methods,
 * same window. A month with zero registrations of any method is OMITTED
 * (not a fabricated 0%) — the regression fits only months with real data.
 *
 * @param points - fetchAcquisitionTrend's raw (month × method) rows.
 * @returns Chronological {period, value} percent-rate series for
 *   lib/metrics/forecast-to-target.ts's `trend` input.
 */
export function acquisitionAdoptionRateSeries(
  points: AcquisitionTrendPoint[],
): Array<{ period: string; value: number }> {
  const byMonth = new Map<string, { label: string; adopted: number; total: number }>();

  for (const p of points) {
    const bucket = byMonth.get(p.periodStart) ?? { label: p.x, adopted: 0, total: 0 };
    bucket.total += p.y;
    if (p.method === "shelter_adoption") bucket.adopted += p.y;
    byMonth.set(p.periodStart, bucket);
  }

  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([, b]) => b.total > 0)
    .map(([, b]) => ({ period: b.label, value: (b.adopted / b.total) * 100 }));
}

// ============================================================================

export type DeathCauseRow = {
  /** Cause label from deathRecorded payload, e.g. "natural", "disease", "accident". */
  cause: string;
  /** Count of death_recorded events with this cause in the last 12 months. */
  count: number;
};

/**
 * Top 10 death causes ordered by count desc, last 12 months.
 * Source: death_recorded events, payload field `cause`.
 * Scope via inner join to pets.jurisdictionProvince/Locality.
 *
 * NOTE(E5): `cause` enum in deathRecorded schema:
 *   known | unknown | natural | disease | accident | euthanasia | sudden | violent | other
 */
export async function fetchDeathCauses(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  opts: { since?: Date; adminProvince?: string; adminLocality?: string } = {},
): Promise<DeathCauseRow[]> {
  if (!hasNationalReadScope(actor.role) && jurisdictions.length === 0) return [];

  const since12m = opts.since ?? new Date(Date.now() - 365 * DAY_MS);

  const conditions = [
    eq(petEvents.eventType, "death_recorded"),
    gte(petEvents.occurredAt, since12m),
  ];

  // ONE pets-scope predicate (govt pairs OR admin drill) — see
  // fetchAcquisitionTrend above. Backward-compat: admin with no drill → null.
  const petsScope = petsScopeClause(actor, jurisdictions, opts.adminProvince, opts.adminLocality);
  if (petsScope) conditions.push(sql`(${petsScope})`);

  // Govt always joins (jurisdiction pairs); admin+adminProvince also joins.
  const needsJoin = !hasNationalReadScope(actor.role) || !!opts.adminProvince;

  const rows = await (needsJoin
    ? db
        .select({
          cause: sql<string>`COALESCE((${petEvents.payload}->>'cause'), 'unknown')`,
          n: count(),
        })
        .from(petEvents)
        .innerJoin(pets, eq(pets.id, petEvents.petId))
        .where(and(...conditions))
        .groupBy(sql`COALESCE((${petEvents.payload}->>'cause'), 'unknown')`)
        .orderBy(desc(count()))
        .limit(10)
    : db
        .select({
          cause: sql<string>`COALESCE((${petEvents.payload}->>'cause'), 'unknown')`,
          n: count(),
        })
        .from(petEvents)
        .where(and(...conditions))
        .groupBy(sql`COALESCE((${petEvents.payload}->>'cause'), 'unknown')`)
        .orderBy(desc(count()))
        .limit(10));

  return rows.map((r) => ({ cause: r.cause, count: r.n }));
}
