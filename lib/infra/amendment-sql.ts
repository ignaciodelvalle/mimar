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
// Parity contract with overlayAmendments (custody audit C1, 2026-09-26):
//   - EVERY event_amended row targeting the event applies, oldest → newest by
//     (occurred_at, recorded_at, id). Per field that is: the value comes from
//     the LATEST amendment THAT TOUCHES the field. A later amendment that only
//     changed another field does NOT hide it — corrections carry only the
//     fields they changed (the form and the API diff against the already
//     corrected payload), so "only the latest amendment applies" erased the
//     first of two corrections on different fields.
//   - Within one amendment, a field listed twice takes its LAST entry (the TS
//     fold overwrites in array order).
//   - The amendment must be on the SAME pet as the event it targets: a
//     target_event_id pointing at another animal's record is inert.
//   - No amendment touching the field → raw payload value.
//
// Known (accepted) divergence: an amendment whose `new` value is JSON null
// falls back to the raw value here (COALESCE), while the TS overlay would
// project null. Forms never write null corrections for the fields KPIs read,
// and a NULL would silently un-count the event either way.

import { type SQL, sql } from "drizzle-orm";

import { petEvents } from "@/db";

/**
 * SQL expression returning the AMENDED text value of `payload->>'field'` for a
 * pet_events row: the latest `event_amended` correction that touches the field,
 * the raw payload value otherwise.
 *
 * By default the expression references the un-aliased `pet_events` table of
 * the surrounding query (Drizzle-built queries over `petEvents`). Queries that
 * alias pet_events (raw SQL with `pe`, EXISTS subqueries, …) must pass `refs`
 * pointing at their alias, e.g.
 * `{ id: sql`pe.id`, payload: sql`pe.payload`, petId: sql`pe.pet_id` }`.
 *
 * Cost: one correlated probe on the partial expression index
 * `pet_events_amended_target_idx` (migration 0118) per candidate row —
 * amendments are rare, so the probe is cheap.
 */
export function amendedPayloadText(
  field: string,
  refs?: { id: SQL; payload: SQL; petId: SQL },
): SQL {
  const idRef = refs?.id ?? sql`${petEvents.id}`;
  const payloadRef = refs?.payload ?? sql`${petEvents.payload}`;
  const petIdRef = refs?.petId ?? sql`${petEvents.petId}`;
  return sql`COALESCE(
    (
      SELECT amc.value->>'new'
      FROM pet_events am
      CROSS JOIN LATERAL jsonb_array_elements(am.payload->'changes') WITH ORDINALITY amc(value, ord)
      WHERE am.event_type = 'event_amended'
        AND am.payload->>'target_event_id' = ${idRef}::text
        AND am.pet_id = ${petIdRef}
        AND amc.value->>'field' = ${field}
      ORDER BY am.occurred_at DESC, am.recorded_at DESC NULLS LAST, am.id DESC, amc.ord DESC
      LIMIT 1
    ),
    ${payloadRef}->>${field}
  )`;
}
