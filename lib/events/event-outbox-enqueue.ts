// Transactional outbox enqueue helper.
//
// Inserts event_notification_outbox rows inside the SAME database transaction
// as the source event. If the outbox insert fails, the outer transaction rolls
// back — atomicity is the whole point.
//
// Usage (inside a db.transaction callback):
//
//   const [event] = await tx.insert(petEvents).values({...}).returning();
//   await enqueueOutboxForEvent(tx, { id: event.id, eventType, payload }, pet);
//
// The function is a silent no-op when no OUTBOX_RULES match the event type or
// payload — most events never enqueue anything.
//
// Spec: docs/superpowers/plans/2026-05-22-event-trust-tier-1.md §4 C.2

import { eventNotificationOutbox } from "@/db/schema";
import { OUTBOX_RULES } from "./event-outbox-rules";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal Drizzle PgTransaction shape we depend on. */
type DrizzleTx = {
  insert(table: typeof eventNotificationOutbox): {
    values(row: typeof eventNotificationOutbox.$inferInsert): Promise<unknown>;
  };
};

type EventInput = {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
};

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

    await tx.insert(eventNotificationOutbox).values({
      sourceEventId: event.id,
      targetKind: rule.target_kind,
      targetJurisdictionProvince: pet.jurisdictionProvince ?? null,
      targetJurisdictionLocality: pet.jurisdictionLocality ?? null,
      payloadSnapshot: snapshot,
      slaDueAt,
      status: "pending",
      attempts: 0,
    });
  }
}
