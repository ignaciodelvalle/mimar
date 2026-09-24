// Single-source-of-truth denominator definitions for Pattern-B aggregate fetchers.
//
// These functions return composable Drizzle SQL fragments, not full queries.
// Fetchers build their numerators on top of these base-population clauses,
// guaranteeing that rates computed against different numerators share the same
// denominator definition.
//
// D7 (spec invariant): Pattern B reads pets.status / pets.species (denormalized
// columns) rather than replaying events per pet. This is correct and intentional
// at population scale — the per-pet event replay (Pattern A) is too slow for
// dashboard aggregates. The lag risk is owned, not accidental.

import { and, eq, sql } from "drizzle-orm";

import { petEvents, pets } from "@/db";

import type { ProjectionContext } from "./context";
import { petEventsScopeClause, petsScopeClause } from "./scope";

/**
 * Base condition: pets in scope with status 'active' or 'lost' (excludes deceased).
 * Reads pets.status — denormalized, authoritative for aggregates (D7).
 *
 * Returns a Drizzle SQL expression suitable for use in .where(and(...conditions)).
 */
export function activePetsCondition(ctx: ProjectionContext) {
  const scope = petsScopeClause(ctx);
  const base = sql`${pets.status} IN ('active', 'lost')`;
  return scope ? and(base, sql`(${scope})`) : base;
}

/**
 * Base condition: dogs in scope (activePets + species='dog').
 * Reads pets.species — denormalized, authoritative for aggregates (D7).
 */
export function dogsInScopeCondition(ctx: ProjectionContext) {
  const scope = petsScopeClause(ctx);
  const base = and(sql`${pets.status} IN ('active', 'lost')`, eq(pets.species, "dog"));
  return scope ? and(base, sql`(${scope})`) : base;
}

/**
 * Base condition for pet_events queries: scope to the ctx jurisdiction.
 * Optionally narrows to a specific eventType and/or a time window.
 *
 * ⚠️ WARNING — VALID ONLY FOR outbreak_signal-family QUERIES. The scope here is
 * petEventsScopeClause, which matches the payload jurisdiction snapshot that ONLY
 * `outbreak_signal` writes. Applied to any OTHER event type for a scoped-govt
 * actor it evaluates to `false` for every real row and returns ZERO results (the
 * "ghost-payload" bug — see the petEventsScopeClause jsdoc in ./scope.ts). This
 * helper only builds a WHERE condition and cannot add a join, so it CANNOT be
 * fixed here for non-outbreak types. Callers over other event types MUST instead
 * `.innerJoin(pets, eq(pets.id, petEvents.petId))` and scope with petsScopeClause.
 * (No production caller today; a test exercises it with an admin ctx, where the
 * scope resolves to null and this hazard does not apply.)
 *
 * @param eventType - If provided, adds `eventType = ?` to the conditions.
 * @param window    - If provided, adds `occurredAt >= window.since` to the conditions.
 */
export function petEventsInScopeCondition(
  ctx: ProjectionContext,
  opts: {
    eventType?: string;
    window?: { since: Date; until?: Date };
  } = {},
) {
  const scope = petEventsScopeClause(ctx);
  const parts = [];
  if (opts.eventType) parts.push(eq(petEvents.eventType, opts.eventType));
  if (opts.window) {
    // Bind dates as ISO strings — a raw JS Date interpolated into sql`` crashes
    // postgres-js (prepare:false) with ERR_INVALID_ARG_TYPE. The comparison
    // casts the ISO string to timestamptz.
    parts.push(sql`${petEvents.occurredAt} >= ${opts.window.since.toISOString()}`);
    if (opts.window.until) {
      parts.push(sql`${petEvents.occurredAt} <= ${opts.window.until.toISOString()}`);
    }
  }
  if (scope) parts.push(sql`(${scope})`);
  return parts.length === 0 ? undefined : and(...parts);
}
