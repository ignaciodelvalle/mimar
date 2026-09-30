// The owner's trip is the owner's — ONE definition for every read of pet_events
// a non-titular viewer can reach (viajes-fase-2, design D8).
//
// WHAT IS PRIVATE. Two `movement_recorded` sub-kinds: `transport_recorded` (the
// corridor, the travel date and, from Phase 4 on, the airline) and `cvi_issued`
// (the certificate that says the animal is about to cross a border). Together
// they say WHEN a household will be away and WHERE it is going. That is not a
// health fact about the animal and no clinic, caretaker, share-link reader,
// public-credential visitor or government surface needs it.
//
// `jurisdiction_changed` is NOT private here: it is the third sub-kind of the
// same event type, it denormalizes `pets.jurisdiction_*`, and the org and gob
// surfaces already read it on purpose. Every other event type keeps exactly
// the visibility it had — this clause is scoped to the two travel keys and
// nothing else.
//
// WHAT ELSE IT HIDES. A correction of a travel row (`event_amended` whose
// `target_event_id` points at one) carries the old and new values of the very
// fields above — a corrected travel date is still a travel date. So the clause
// also drops those corrections, with a correlated lookup of the target, the
// same shape `notReportedClause` uses.
//
// WHO MAY READ THEM: `canAccessTravel` in lib/infra/pet-access.ts — the person
// path, and not as a caretaker (owner, co-owner, foster). A caretaker is often
// the very person keeping the animal while the household is away; an org
// member reaches the pet through custody or a sponsorship, not through the
// trip.
//
// Which reads carry it is fenced by __tests__/travel-private-read-coverage.test.ts.

import { and, eq, isNull, ne, sql } from "drizzle-orm";

import { db, ownerships, petEvents } from "@/db";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The `movement_recorded` sub-kinds only a titular may read. */
export const TRAVEL_PRIVATE_SUB_KINDS = ["transport_recorded", "cvi_issued"] as const;

/**
 * True when an event row IS travel-private: a `movement_recorded` of one of
 * the two travel sub-kinds. Pure — for code that already holds the row.
 *
 * It answers only for the ROOT row. A correction of a travel row is caught by
 * the SQL clause below, which can see the target; code that holds a correction
 * must look its target up before deciding.
 */
export function isTravelPrivateEvent(eventType: string, payload: unknown): boolean {
  if (eventType !== "movement_recorded") return false;
  const subKind = (payload as Record<string, unknown> | null)?.sub_kind;
  return (TRAVEL_PRIVATE_SUB_KINDS as readonly unknown[]).includes(subKind);
}

/**
 * A WHERE fragment excluding every travel-private `pet_events` row and every
 * correction of one.
 *
 * Use inside an `and(...)` whenever the viewer may not read the trip
 * (`!canAccessTravel(...)`). Correlates on the row under test, so it composes
 * with any scoping — `pet_id`, `id`, a type allow-list, or none.
 *
 * FAILS CLOSED. A `movement_recorded` row with no `sub_kind` evaluates to NULL
 * inside the NOT and is dropped rather than shown: no such row can be written
 * (the schema's discriminated union refuses it), and if one ever exists the
 * safe answer is the hidden one.
 *
 * The alias is spelled out (`travel_target`) because the correction lookup is a
 * self-join onto `pet_events`: without it the correlation would bind to the
 * wrong side.
 */
export function notTravelPrivateClause() {
  return sql`NOT (
    (
      ${petEvents.eventType} = 'movement_recorded'
      AND ${petEvents.payload}->>'sub_kind' IN ('transport_recorded', 'cvi_issued')
    )
    OR (
      ${petEvents.eventType} = 'event_amended'
      AND EXISTS (
        SELECT 1
        FROM public.pet_events AS travel_target
        WHERE travel_target.pet_id = ${petEvents.petId}
          AND travel_target.id::text = ${petEvents.payload}->>'target_event_id'
          AND travel_target.event_type = 'movement_recorded'
          AND travel_target.payload->>'sub_kind' IN ('transport_recorded', 'cvi_issued')
      )
    )
  )`;
}

/**
 * Whether `userId` holds the pet as a titular on the PERSON path right now —
 * the database form of `canAccessTravel`, for a caller that was not handed
 * the resolved access (the correction writer, which three doors share).
 *
 * Live rows only; a caretaker row does not count, and neither does an
 * organization's row (it has no `owner_user_id`).
 */
export async function holdsPetAsTravelTitular(
  userId: string,
  petId: string,
  executor: DbOrTx = db,
): Promise<boolean> {
  const rows = await executor
    .select({ one: sql`1` })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.petId, petId),
        eq(ownerships.ownerUserId, userId),
        isNull(ownerships.endedAt),
        ne(ownerships.role, "caretaker"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
