// Server-only: this module queries the DB. A client import is a hard build error.
import "server-only";

// lib/metrics/freshness.ts — "last event ingested" helper for dashboard footers.
//
// DB-BOUND — tsc-only verification; do NOT unit-test with a live DB here.
// The pure formatting logic (date rendering) lives in the component layer.
//
// CONTRACT
// --------
// lastIngestAt(ctx) queries the single MAX(occurred_at) over pet_events,
// scoped to the viewer's jurisdiction by the pet's HOME jurisdiction
// (petsScopeClause against an INNER JOIN pets). It spans ALL event types (no
// eventType filter), so petEventsScopeClause — which only matches the payload
// jurisdiction snapshot outbreak_signal writes — would evaluate to `false` for
// every non-outbreak row of a scoped-govt actor (the ghost-payload bug),
// reporting a stale-or-null freshness. Every pet_event has a pet, so the join
// never drops a row.
//
// Returns:
//   Date  — the timestamp of the most recent event in scope.
//   null  — no matching events exist (empty data window or new installation).

import { and, eq, sql } from "drizzle-orm";

// Heavy read-only analytics — routed through the ANALYTICS pool (session
// pooler in production; see db/index.ts, task #74 dual-pool split).
import { analyticsDb as db, petEvents, pets } from "@/db";

import type { ProjectionContext } from "./context";
import { petsScopeClause } from "./scope";

/**
 * Returns the timestamp of the most recently ingested `pet_events` row
 * that falls within the viewer's jurisdiction scope.
 *
 * Used by `DashboardFreshnessFooter` to render "último evento {date}" on
 * every dashboard, giving operators confidence that the displayed numbers
 * are current.
 *
 * @param ctx - The active ProjectionContext (actor + scope + period).
 * @returns The max `occurred_at` as a Date, or null if no events match.
 */
export async function lastIngestAt(ctx: ProjectionContext): Promise<Date | null> {
  const scope = petsScopeClause(ctx);

  // Build condition list — scope may be null (admin) or a SQL clause (govt).
  const conditions = scope ? [sql`(${scope})`] : [];

  const rows = await db
    .select({
      maxAt: sql<string | null>`max(${petEvents.occurredAt})`,
    })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  const raw = rows[0]?.maxAt;
  if (raw == null) return null;

  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}
