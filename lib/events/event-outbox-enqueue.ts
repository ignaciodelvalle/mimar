// Transactional outbox enqueue helper.
//
// Inserts event_notification_outbox rows inside the SAME database transaction
// as the source event. If the outbox insert fails, the outer transaction rolls
// back — atomicity is the whole point.
//
// Usage (inside a db.transaction callback):
//
//   const [event] = await tx.insert(petEvents).values({...}).returning();
//   await enqueueOutboxForEvent(tx, { id: event.id, petId, eventType, payload }, pet);
//
// The function is a silent no-op when no OUTBOX_RULES match the event type or
// payload — most events never enqueue anything.
//
// ONE RECORD PER CASE (PO, 2026-09-25: "A Case may not be duplicated; all
// information related to a single event must be concentrated in a single
// record"). When a rule names the case family a row belongs to
// (`caseFamily`, today only rabies), the row is ROUTED to the bite case's own
// jurisdiction (a bite counts where it happened — eno-target-jurisdiction.ts)
// and keyed per (animal, target jurisdiction) — enoCaseKey. The insert targets
// the unique index
// outbox_eno_case_unique (migration 0247). The FIRST writer of a case inserts
// the row; every LATER writer finds it through ON CONFLICT and appends its
// event to `linked_sources` — same statement, same transaction as its own
// event, so there is no read-then-write window for two writers to race in.
//
// What the link does to the row:
//   - appends { source_event_id, event_type, linked_at, payload_snapshot,
//     previous_status, previous_delivered_at } — the audit trail of the merge;
//   - the deadline becomes the EARLIER of the two, always — a legal clock
//     never moves later, and the stricter window is the one that binds;
//   - a row still PENDING keeps its lease and attempts;
//   - a row already DELIVERED or FAILED is re-opened to pending, due now: the
//     authority was told the first half, and the second half (a confirmation)
//     is exactly what it must receive. The delivery it replaces is kept in the
//     link entry, not erased. (The drainer's success write is conditional on
//     the link count it claimed, so a link that lands mid-delivery is re-sent —
//     app/api/cron/drain-outbox/route.ts.)
// A replay of an event already on the row (as its source or as a link) changes
// nothing — setWhere below.
//
// pet_events are untouched: the outbox is a delivery queue whose status the
// drainer updates anyway, not the append-only spine.
//
// Spec: docs/superpowers/plans/2026-05-22-event-trust-tier-1.md §4 C.2

import { sql } from "drizzle-orm";

import { eventNotificationOutbox } from "@/db/schema";
import { resolveEnoTargetJurisdiction } from "./eno-target-jurisdiction";
import {
  type EventAuthor,
  OUTBOX_RULES,
  type OutboxRule,
  type TargetPlace,
  enoCaseKey,
} from "./event-outbox-rules";
import { eventPlaceTarget } from "./event-place-target";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The Drizzle surface we depend on: a transaction (or the db). A case-keyed
 *  row reads its bite case to route; every other row only inserts. */
type DrizzleTx = Pick<typeof import("@/db").db, "insert" | "select">;

export type EventInput = {
  id: string;
  /** The animal the event is about — rules key their case on it. */
  petId: string;
  eventType: string;
  payload: Record<string, unknown>;
  /**
   * When the fact happened (pet_events.occurred_at). The legal clock starts
   * here unless the rule reads a more specific date from the payload (PO S5).
   * Absent = the enqueue instant, the old behaviour.
   */
  occurredAt?: Date | null;
  /** Who signed it (pet_events author_role / author_verified) — some rules require a vet. */
  author?: EventAuthor;
};

// Column references for the ON CONFLICT clauses. Qualified by the table name,
// which inside DO UPDATE means the EXISTING row; `excluded` is the proposed one.
const existing = (column: string) => sql.raw(`"event_notification_outbox"."${column}"`);

export type PetInput = {
  jurisdictionProvince?: string | null;
  jurisdictionLocality?: string | null;
  /**
   * The snapshot's catalogue row, read in the same transaction as the names
   * (localidades-por-id D3). ABSENT = the caller snapshots no id: the row
   * records no place (method NULL). null = no single row: 'unresolved'.
   */
  localityId?: string | null;
  placeMethod?: string | null;
};

/**
 * When the legal clock starts (PO S5, 2026-09-26): the rule's own date from
 * the payload (a diagnosis date), else the event's occurrence, else `now` —
 * and never later than `now`, so a future-dated entry cannot buy time. A late
 * entry therefore lands with a deadline already in the past: visibly overdue.
 */
export function clockStart(
  rule: OutboxRule,
  event: Pick<EventInput, "payload" | "occurredAt">,
  now: Date,
): Date {
  const start = rule.clockStartsAt?.(event.payload) ?? event.occurredAt ?? now;
  return start.getTime() < now.getTime() ? start : now;
}

/**
 * The target place BY ID, from the same source as the target names: the bite
 * case the row routes to, else the event's own `place`, else the caller's
 * snapshot. Never re-read from the pet here; never a homonym picked by name.
 */
function targetPlace(
  payload: Record<string, unknown>,
  routedTo: { place?: TargetPlace },
  pet: PetInput,
): TargetPlace {
  if (routedTo.place) return routedTo.place;
  const place = payload.place as
    | { resolved?: { locality_id?: string; method?: string } | null }
    | undefined;
  if (place && typeof place === "object") {
    const resolved = place.resolved;
    return resolved?.locality_id
      ? { localityId: resolved.locality_id, placeMethod: resolved.method ?? null }
      : { localityId: null, placeMethod: "unresolved" };
  }
  if (!("localityId" in pet) || pet.localityId === undefined) {
    return { localityId: null, placeMethod: null };
  }
  return pet.localityId
    ? { localityId: pet.localityId, placeMethod: pet.placeMethod ?? "catalogue_id" }
    : { localityId: null, placeMethod: pet.placeMethod ?? "unresolved" };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Enqueues zero or more outbox rows for `event` inside `tx`.
 *
 * @param tx       — Drizzle PgTransaction (must be the same tx that inserted the source event).
 * @param event    — Minimal event object: id, eventType, payload.
 * @param pet      — Pet jurisdiction snapshot: the FALLBACK routing. A
 *                   case-keyed row routes by its bite case; any other row by
 *                   the event's own place (PO S10); this only when neither
 *                   names a target.
 * @param now      — Optional: the enqueue instant (defaults to new Date()). The
 *                   legal clock starts at the occurrence (clockStart), never
 *                   later than this.
 */
export async function enqueueOutboxForEvent(
  tx: DrizzleTx,
  event: EventInput,
  pet: PetInput,
  now: Date = new Date(),
  /** Restrict to these rules (the amendment re-evaluation, PO S9); default = all of the type's. */
  only?: readonly OutboxRule[],
): Promise<void> {
  const rules = only ?? OUTBOX_RULES[event.eventType as keyof typeof OUTBOX_RULES] ?? [];

  for (const rule of rules) {
    const slaHours = rule.slaHours(event.payload, event.author);
    if (slaHours === null) continue;

    const slaDueAt = new Date(clockStart(rule, event, now).getTime() + slaHours * 60 * 60 * 1000);
    const snapshot = rule.buildSnapshot ? rule.buildSnapshot(event.payload) : event.payload;

    const family = rule.caseFamily ? rule.caseFamily(event.payload) : null;
    // A case-family row (rabies) follows its bite case; every other row goes
    // to where the event OCCURRED when it carries a place (PO S10), else to
    // the caller's snapshot of the pet's home.
    const target = family
      ? await resolveEnoTargetJurisdiction(tx, event, pet)
      : ((await eventPlaceTarget(tx, event.payload)) ?? pet);
    const caseKey = family ? enoCaseKey(family, event.petId, target) : null;
    const place = targetPlace(event.payload, target as { place?: TargetPlace }, pet);

    const row = {
      sourceEventId: event.id,
      targetKind: rule.target_kind,
      targetJurisdictionProvince: target.jurisdictionProvince ?? null,
      targetJurisdictionLocality: target.jurisdictionLocality ?? null,
      targetLocalityId: place.localityId,
      targetPlaceMethod: place.placeMethod,
      payloadSnapshot: snapshot,
      slaDueAt,
      status: "pending" as const,
      attempts: 0,
      enoCaseKey: caseKey,
    };

    if (caseKey === null) {
      await tx.insert(eventNotificationOutbox).values(row);
      continue;
    }

    const wasPending = sql`${existing("status")} = 'pending'`;
    await tx
      .insert(eventNotificationOutbox)
      .values(row)
      .onConflictDoUpdate({
        target: [eventNotificationOutbox.targetKind, eventNotificationOutbox.enoCaseKey],
        targetWhere: sql`eno_case_key IS NOT NULL`,
        set: {
          linkedSources: sql`${existing("linked_sources")} || jsonb_build_array(jsonb_build_object(
            'source_event_id', excluded.source_event_id,
            'event_type', ${event.eventType}::text,
            'linked_at', now(),
            'payload_snapshot', excluded.payload_snapshot,
            'previous_status', ${existing("status")},
            'previous_delivered_at', ${existing("delivered_at")}
          ))`,
          status: "pending",
          slaDueAt: sql`least(${existing("sla_due_at")}, excluded.sla_due_at)`,
          nextRetryAt: sql`CASE WHEN ${wasPending} THEN ${existing("next_retry_at")} ELSE now() END`,
          attempts: sql`CASE WHEN ${wasPending} THEN ${existing("attempts")} ELSE 0 END`,
          deliveredAt: sql`CASE WHEN ${wasPending} THEN ${existing("delivered_at")} ELSE NULL END`,
          lastError: sql`CASE WHEN ${wasPending} THEN ${existing("last_error")} ELSE NULL END`,
        },
        // Idempotent replay: an event already on this record links nothing.
        setWhere: sql`${existing("source_event_id")} <> excluded.source_event_id
          AND NOT (${existing("linked_sources")} @> jsonb_build_array(
            jsonb_build_object('source_event_id', excluded.source_event_id)))`,
      });
  }
}
