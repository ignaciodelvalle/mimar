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

import { and, count, eq, gte, lte, sql } from "drizzle-orm";

import { analyticsDb as db, petEvents, pets } from "@/db";

import type { ProjectionContext } from "./context";
import { petsScopeClause } from "./scope";

/** True when a govt actor has no assigned jurisdictions — queries return zeros. */
function isEmptyScope(ctx: ProjectionContext): boolean {
  return ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0;
}

export type MovementCorridorsResult = {
  /** All movement_recorded events in the period + scope. */
  total: number;
  /** sub_kind='jurisdiction_changed' — domestic relocations. */
  jurisdictionChanged: number;
  /** sub_kind='cvi_issued' — international veterinary certificates emitted. */
  cviIssued: number;
  /** sub_kind='transport_recorded' — cross-border transport events. */
  transportRecorded: number;
};

/**
 * KPI: movement_volume (see lib/metrics/kpi-catalog.ts)
 *
 * NUMERATOR:   COUNT movement_recorded events in ctx.period, scoped, decomposed
 *              by payload.sub_kind (jurisdiction_changed / cvi_issued /
 *              transport_recorded).
 * DENOMINATOR: n/a — absolute counts (a flow volume, not a ratio).
 * SOURCE:      pets, pet_events (movement_recorded).
 * CADENCE:     matches the caller's ProjectionContext period.
 * SUPPRESSION: none — jurisdiction-level totals, not locality-grouped.
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
  return {
    total: row?.total ?? 0,
    jurisdictionChanged: row?.jurisdictionChanged ?? 0,
    cviIssued: row?.cviIssued ?? 0,
    transportRecorded: row?.transportRecorded ?? 0,
  };
}
