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
// record"). When a rule names the case a row notifies (`caseKey`, today only
// rabies — per animal), the insert targets the unique index
// outbox_eno_case_unique (migration 0247). The FIRST writer of a case inserts
// the row; every LATER writer finds it through ON CONFLICT and appends its
// event to `linked_sources` — same statement, same transaction as its own
// event, so there is no read-then-write window for two writers to race in.
//
// What the link does to the row:
//   - appends { source_event_id, event_type, linked_at, payload_snapshot,
//     previous_status, previous_delivered_at } — the audit trail of the merge;
//   - a row still PENDING keeps its lease and attempts, and its deadline
//     becomes the EARLIER of the two (a later writer never extends a legal
//     clock that is already running);
//   - a row already DELIVERED or FAILED is re-opened to pending, due now,
//     with the new writer's deadline: the authority was told the first half,
//     and the second half (a confirmation) is exactly what it must receive.
//     The delivery it replaces is kept in the link entry, not erased.
// A replay of an event already on the row (as its source or as a link) changes
// nothing — setWhere below.
//
// pet_events are untouched: the outbox is a delivery queue whose status the
// drainer updates anyway, not the append-only spine.
//
// Spec: docs/superpowers/plans/2026-05-22-event-trust-tier-1.md §4 C.2

import { sql } from "drizzle-orm";

import { eventNotificationOutbox } from "@/db/schema";
import { OUTBOX_RULES } from "./event-outbox-rules";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The Drizzle surface we depend on: a transaction (or the db) that can insert. */
type DrizzleTx = Pick<typeof import("@/db").db, "insert">;

type EventInput = {
  id: string;
  /** The animal the event is about — rules key their case on it. */
  petId: string;
  eventType: string;
  payload: Record<string, unknown>;
};

// Column references for the ON CONFLICT clauses. Qualified by the table name,
// which inside DO UPDATE means the EXISTING row; `excluded` is the proposed one.
const existing = (column: string) => sql.raw(`"event_notification_outbox"."${column}"`);

type PetInput = {
  jurisdictionProvince?: string | null;
  jurisdictionLocality?: string | null;
};

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Enqueues zero or more outbox rows for `event` inside `tx`.
 *
 * @param tx       — Drizzle PgTransaction (must be the same tx that inserted the source event).
 * @param event    — Minimal event object: id, eventType, payload.
 * @param pet      — Pet jurisdiction snapshot for routing metadata.
 * @param now      — Optional: override "now" for deterministic tests (defaults to new Date()).
 */
export async function enqueueOutboxForEvent(
  tx: DrizzleTx,
  event: EventInput,
  pet: PetInput,
  now: Date = new Date(),
): Promise<void> {
  const rules = OUTBOX_RULES[event.eventType as keyof typeof OUTBOX_RULES] ?? [];

  for (const rule of rules) {
    const slaHours = rule.slaHours(event.payload);
    if (slaHours === null) continue;

    const slaDueAt = new Date(now.getTime() + slaHours * 60 * 60 * 1000);
    const snapshot = rule.buildSnapshot ? rule.buildSnapshot(event.payload) : event.payload;

    const caseKey = rule.caseKey ? rule.caseKey(event.payload, { petId: event.petId }) : null;

    const row = {
      sourceEventId: event.id,
      targetKind: rule.target_kind,
      targetJurisdictionProvince: pet.jurisdictionProvince ?? null,
      targetJurisdictionLocality: pet.jurisdictionLocality ?? null,
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
          slaDueAt: sql`CASE WHEN ${wasPending}
            THEN least(${existing("sla_due_at")}, excluded.sla_due_at)
            ELSE excluded.sla_due_at END`,
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
