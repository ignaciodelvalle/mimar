// SQL-side amendment overlay (projection-cron audit 2026-07-03 A2).
//
// TypeScript read boundaries project corrections via overlayAmendments
// (lib/infra/amendment.ts). SQL aggregates (govt KPIs, choropleths, trends)
// can't use that helper — they aggregate in the database — so an amended
// payload field (e.g. a vaccine_name corrected from "Séxtuple" to
// "Antirrábica") silently kept its ORIGINAL value in every jurisdiction-level
// number. This module is the SQL twin of overlayAmendments: same semantics,
// applied inside the query.
//
// Parity contract with overlayAmendments:
//   - Only the LATEST event_amended row targeting the event applies
//     (amend-event.ts flattens chains: every amendment targets the original).
//   - If that latest amendment does not touch the requested field, the RAW
//     payload value is used (not an earlier amendment's value).
//   - No amendment → raw payload value.
//
// Known (accepted) divergence: an amendment whose `new` value is JSON null
// falls back to the raw value here (COALESCE), while the TS overlay would
// project null. Forms never write null corrections for the fields KPIs read,
// and a NULL would silently un-count the event either way.

import { type SQL, sql } from "drizzle-orm";

import { petEvents } from "@/db";

/**
 * SQL expression returning the AMENDED text value of `payload->>'field'` for a
 * pet_events row: the latest `event_amended` correction when one touches the
 * field, the raw payload value otherwise.
 *
 * By default the expression references the un-aliased `pet_events` table of
 * the surrounding query (Drizzle-built queries over `petEvents`). Queries that
 * alias pet_events (raw SQL with `pe`, EXISTS subqueries, …) must pass `refs`
 * pointing at their alias, e.g.
 * `{ id: sql`pe.id`, payload: sql`pe.payload` }`.
 *
 * Cost: one correlated probe on the partial expression index
 * `pet_events_amended_target_idx` (migration 0118) per candidate row —
 * amendments are rare, so the probe is cheap.
 */
export function amendedPayloadText(field: string, refs?: { id: SQL; payload: SQL }): SQL {
  const idRef = refs?.id ?? sql`${petEvents.id}`;
  const payloadRef = refs?.payload ?? sql`${petEvents.payload}`;
  return sql`COALESCE(
    (
      SELECT amc.value->>'new'
      FROM (
        SELECT am.payload AS amendment_payload
        FROM pet_events am
        WHERE am.event_type = 'event_amended'
          AND am.payload->>'target_event_id' = ${idRef}::text
        ORDER BY am.occurred_at DESC, am.recorded_at DESC
        LIMIT 1
      ) latest_amendment
      CROSS JOIN LATERAL jsonb_array_elements(latest_amendment.amendment_payload->'changes') amc
      WHERE amc.value->>'field' = ${field}
      LIMIT 1
    ),
    ${payloadRef}->>${field}
  )`;
}
