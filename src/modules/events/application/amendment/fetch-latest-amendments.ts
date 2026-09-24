// Use-case: fetchLatestAmendmentsForEvents — strangler migration 27/61.
// Moved verbatim from app/actions/amendment.ts.
//
// Pure DB query — no auth (caller is responsible for scoping to pet.id).

import { db, petEvents } from "@/db";
import { and, desc, eq } from "drizzle-orm";

import type { AmendmentSummary } from "./types";

/**
 * Returns the LATEST amendment for each target event ID in the provided set.
 * Used by the libreta and historial projections to show the "Corregido" badge.
 *
 * Pure DB query — no auth (caller is responsible for scoping to pet.id from an already-authenticated context).
 */
// @no-auth-required: pure projection query; caller must scope to pet.id from an already-authenticated context.
export async function fetchLatestAmendmentsForEvents(
  petId: string,
  targetEventIds: string[],
): Promise<Map<string, AmendmentSummary>> {
  if (targetEventIds.length === 0) return new Map();

  // EL-F3: order latest-first with the same (occurred_at, recorded_at, id)
  // tiebreak as the SQL twin (amendment-sql.ts) and overlayAmendments, so a
  // same-occurredAt pair resolves to the NEWEST recorded_at instead of relying
  // on unordered scan order (which previously had no ORDER BY at all).
  const rows = await db
    .select({
      id: petEvents.id,
      occurredAt: petEvents.occurredAt,
      payload: petEvents.payload,
    })
    .from(petEvents)
    .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "event_amended")))
    .orderBy(desc(petEvents.occurredAt), desc(petEvents.recordedAt), desc(petEvents.id));

  // Group by target_event_id; rows are ordered latest-first, so the FIRST row
  // seen per target is the latest amendment.
  const map = new Map<string, AmendmentSummary>();
  for (const row of rows) {
    const p = row.payload as Record<string, unknown>;
    const targetId = typeof p.target_event_id === "string" ? p.target_event_id : null;
    if (!targetId || !targetEventIds.includes(targetId)) continue;
    if (map.has(targetId)) continue;

    map.set(targetId, {
      targetEventId: targetId,
      amendmentId: row.id,
      occurredAt: row.occurredAt,
      reason: typeof p.reason === "string" ? p.reason : null,
      actorRole: typeof p.actor_role === "string" ? p.actor_role : "owner",
      changes: Array.isArray(p.changes)
        ? (p.changes as Array<{ field: string; old: unknown; new: unknown }>)
        : [],
    });
  }

  return map;
}
