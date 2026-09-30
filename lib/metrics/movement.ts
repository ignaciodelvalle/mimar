// lib/metrics/movement.ts — jurisdictional mobility / CVI volume.
//
// Surfaces the `movement_recorded` event (previously reaching NO dashboard) as an
// epidemiological mobility signal on /gob/vigilancia. Pet movement is a disease
// vector (a moved animal carries its exposure into a new jurisdiction), so the
// volume of registered movements — and its composition — is a surveillance axis.
//
// `movement_recorded` is a discriminated union over `sub_kind`:
//   jurisdiction_changed — domestic relocation (denormalizes pets.jurisdiction*)
//   cvi_issued           — Certificado Veterinario Internacional emitted
//   transport_recorded   — cross-border transport along a corridor
//
// SCOPE: movement_recorded carries NO payload jurisdiction snapshot (only
// outbreak_signal does), so scope is by the pet's HOME jurisdiction via
// petsScopeClause against the pets JOIN — never petEventsScopeClause. Note a
// jurisdiction_changed move denormalizes the pet's home to the DESTINATION, so a
// scoped operator sees inbound relocations once the pet has landed in their zone.
//
// TRAVEL COUNTS ARE SMALL-CELL SUPPRESSED (viajes-fase-2, design D8). A
// cvi_issued or transport_recorded row says a household is about to be away;
// in a small jurisdiction "1 CVI this quarter" points at one family. So those
// two counts publish only at or above ANONYMITY_K, and never with a field
// breakdown — no corridor, no date, no airline, ever. `total` is withheld
// whenever it would let a reader subtract its way back to a suppressed count.

import { and, count, eq, gte, lte, sql } from "drizzle-orm";

import { analyticsDb as db, petEvents, pets } from "@/db";

import { ANONYMITY_K } from "./anonymity";
import type { ProjectionContext } from "./context";
import { petsScopeClause } from "./scope";

/** True when a govt actor has no assigned jurisdictions — queries return zeros. */
function isEmptyScope(ctx: ProjectionContext): boolean {
  return ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0;
}

export type MovementCorridorsResult = {
  /**
   * All movement_recorded events in the period + scope. NULL when publishing
   * it would reveal a suppressed travel count by subtraction.
   */
  total: number | null;
  /** sub_kind='jurisdiction_changed' — domestic relocations. */
  jurisdictionChanged: number;
  /**
   * sub_kind='cvi_issued' — international veterinary certificates emitted.
   * NULL when suppressed (0 < n < ANONYMITY_K).
   */
  cviIssued: number | null;
  /**
   * sub_kind='transport_recorded' — cross-border transport events. NULL when
   * suppressed (0 < n < ANONYMITY_K).
   */
  transportRecorded: number | null;
};

/** A positive count below the anonymity floor — the one a reader may not see. */
function isProtectedCount(n: number): boolean {
  return n > 0 && n < ANONYMITY_K;
}

/**
 * Apply the travel small-cell rule to RAW counts (viajes-fase-2, D8). Pure, and
 * exported so the rule is tested without a database.
 *
 * Each travel count below the floor becomes null. `total` survives only when
 * what it hides is not itself protected: `total − jurisdictionChanged −
 * (published travel counts)` is the sum of the suppressed cells, so one
 * suppressed cell alone, or two summing below the floor, withholds `total`
 * too. `jurisdictionChanged` is not a travel fact and is never suppressed here.
 */
export function suppressTravelCounts(raw: {
  total: number;
  jurisdictionChanged: number;
  cviIssued: number;
  transportRecorded: number;
}): MovementCorridorsResult {
  const cviHidden = isProtectedCount(raw.cviIssued);
  const transportHidden = isProtectedCount(raw.transportRecorded);
  const hiddenSum = (cviHidden ? raw.cviIssued : 0) + (transportHidden ? raw.transportRecorded : 0);
  return {
    total: isProtectedCount(hiddenSum) ? null : raw.total,
    jurisdictionChanged: raw.jurisdictionChanged,
    cviIssued: cviHidden ? null : raw.cviIssued,
    transportRecorded: transportHidden ? null : raw.transportRecorded,
  };
}

/**
 * How a suppressed count reads on screen: "<5", the convention the admin
 * intelligence panels already use. A published count reads as itself.
 */
export function formatMovementCount(n: number | null): string {
  return n === null ? `<${ANONYMITY_K}` : n.toLocaleString("es-AR");
}

/**
 * KPI: movement_volume (see lib/metrics/kpi-catalog.ts)
 *
 * NUMERATOR:   COUNT movement_recorded events in ctx.period, scoped, decomposed
 *              by payload.sub_kind (jurisdiction_changed / cvi_issued /
 *              transport_recorded).
 * DENOMINATOR: n/a — absolute counts (a flow volume, not a ratio).
 * SOURCE:      pets, pet_events (movement_recorded).
 * CADENCE:     matches the caller's ProjectionContext period.
 * SUPPRESSION: cvi_issued / transport_recorded below ANONYMITY_K publish as
 *              null, and total with them when it would reveal one by
 *              subtraction (suppressTravelCounts). jurisdiction_changed: none.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
export async function fetchMovementCorridors(
  ctx: ProjectionContext,
): Promise<MovementCorridorsResult> {
  const empty: MovementCorridorsResult = {
    total: 0,
    jurisdictionChanged: 0,
    cviIssued: 0,
    transportRecorded: 0,
  };
  if (isEmptyScope(ctx)) return empty;

  const scope = petsScopeClause(ctx);

  const conditions = [
    eq(petEvents.eventType, "movement_recorded"),
    gte(petEvents.occurredAt, ctx.period.since),
    lte(petEvents.occurredAt, ctx.period.until),
  ];
  if (scope) conditions.push(sql`(${scope})`);

  // Single pass: total + per-sub_kind sub-counts via conditional aggregation.
  const rows = await db
    .select({
      total: count(),
      jurisdictionChanged:
        sql<number>`count(*) filter (where (${petEvents.payload}->>'sub_kind') = 'jurisdiction_changed')`.mapWith(
          Number,
        ),
      cviIssued:
        sql<number>`count(*) filter (where (${petEvents.payload}->>'sub_kind') = 'cvi_issued')`.mapWith(
          Number,
        ),
      transportRecorded:
        sql<number>`count(*) filter (where (${petEvents.payload}->>'sub_kind') = 'transport_recorded')`.mapWith(
          Number,
        ),
    })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(and(...conditions));

  const row = rows[0];
  return suppressTravelCounts({
    total: row?.total ?? 0,
    jurisdictionChanged: row?.jurisdictionChanged ?? 0,
    cviIssued: row?.cviIssued ?? 0,
    transportRecorded: row?.transportRecorded ?? 0,
  });
}
