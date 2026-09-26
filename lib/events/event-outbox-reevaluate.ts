// Re-evaluate the legal queue after a correction (PO S9, 2026-09-26).
//
// Correcting a clinical record can change `disease_code`, `sub_kind` or
// `diagnosis_date`. Nothing used to re-read the outbox rules afterwards, so a
// non-ENO disease corrected to rabies stayed silent and a corrected date never
// moved the deadline (health audit #4). The rule now:
//
//   - newly notifiable (the corrected payload fires a rule the original did
//     not) → a row is created — or, for a case family (rabies), merged into
//     the animal's case;
//   - more urgent (the corrected deadline is EARLIER than the one in force) →
//     the existing record's deadline moves earlier and the correction is
//     linked into it (merged, for a case family);
//   - anything else (same or later deadline, or no longer notifiable) →
//     NOTHING. A legal clock never moves later and a record is never deleted:
//     the authority may already hold it.
//
// Runs inside the correction's own transaction: a rollback takes both. The new
// or linked source is the `event_amended` row itself (a real pet_events id, so
// the FK holds and the trail says which correction moved the record).

import { and, eq, sql } from "drizzle-orm";

import { eventNotificationOutbox } from "@/db/schema";

import {
  type EventInput,
  type PetInput,
  clockStart,
  enqueueOutboxForEvent,
} from "./event-outbox-enqueue";
import { type EventAuthor, OUTBOX_RULES } from "./event-outbox-rules";

type Tx = Pick<typeof import("@/db").db, "insert" | "select" | "update">;

const HOUR_MS = 60 * 60 * 1000;

export type OutboxReevaluationInput = {
  /** The corrected (root) event. */
  root: {
    id: string;
    petId: string;
    eventType: string;
    occurredAt: Date;
    author: EventAuthor;
  };
  /** The root's effective payload before this correction, and after it. */
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** The `event_amended` row this correction appended. */
  amendmentEventId: string;
  /** The pet's home snapshot — the fallback routing, as at any enqueue. */
  pet: PetInput;
  now?: Date;
};

export type OutboxReevaluation = "created" | "tightened" | "unchanged";

export async function reevaluateOutboxAfterAmendment(
  tx: Tx,
  input: OutboxReevaluationInput,
): Promise<OutboxReevaluation[]> {
  const now = input.now ?? new Date();
  const rules = OUTBOX_RULES[input.root.eventType as keyof typeof OUTBOX_RULES] ?? [];
  const results: OutboxReevaluation[] = [];

  for (const rule of rules) {
    const afterHours = rule.slaHours(input.after, input.root.author);
    if (afterHours === null) {
      results.push("unchanged");
      continue;
    }
    const at = (payload: Record<string, unknown>, hours: number) =>
      new Date(
        clockStart(rule, { payload, occurredAt: input.root.occurredAt }, now).getTime() +
          hours * HOUR_MS,
      );
    const afterDue = at(input.after, afterHours);
    const beforeHours = rule.slaHours(input.before, input.root.author);
    const beforeDue = beforeHours === null ? null : at(input.before, beforeHours);
    const family = rule.caseFamily?.(input.after) ?? null;

    if (beforeDue !== null && afterDue.getTime() >= beforeDue.getTime()) {
      results.push("unchanged");
      continue;
    }

    const event: EventInput = {
      id: input.amendmentEventId,
      petId: input.root.petId,
      eventType: input.root.eventType,
      payload: input.after,
      occurredAt: input.root.occurredAt,
      author: input.root.author,
    };

    // A case family merges by its key (earliest deadline wins, the correction
    // linked) whether or not a record exists yet.
    if (family !== null || beforeDue === null) {
      await enqueueOutboxForEvent(tx, event, input.pet, now, [rule]);
      results.push(beforeDue === null ? "created" : "tightened");
      continue;
    }

    // An unkeyed record: tighten the root's own row in place, and link the
    // correction into it so the trail says why the deadline moved.
    const tightened = await tx
      .update(eventNotificationOutbox)
      .set({
        slaDueAt: sql`least(${eventNotificationOutbox.slaDueAt}, ${afterDue.toISOString()}::timestamptz)`,
        payloadSnapshot: rule.buildSnapshot ? rule.buildSnapshot(input.after) : input.after,
        linkedSources: sql`${eventNotificationOutbox.linkedSources} || jsonb_build_array(jsonb_build_object(
          'source_event_id', ${input.amendmentEventId}::text,
          'event_type', 'event_amended',
          'linked_at', now(),
          'payload_snapshot', ${JSON.stringify(input.after)}::jsonb,
          'previous_status', ${eventNotificationOutbox.status},
          'previous_sla_due_at', ${eventNotificationOutbox.slaDueAt},
          'previous_payload_snapshot', ${eventNotificationOutbox.payloadSnapshot}
        ))`,
        // The authority must receive the correction: a record already handled
        // is re-opened, exactly as a case merge re-opens it (the enqueue).
        status: "pending",
        nextRetryAt: sql`now()`,
      })
      .where(
        and(
          eq(eventNotificationOutbox.sourceEventId, input.root.id),
          eq(eventNotificationOutbox.targetKind, rule.target_kind),
          sql`${eventNotificationOutbox.status} <> 'merged'`,
        ),
      )
      .returning({ id: eventNotificationOutbox.id });
    if (tightened.length === 0) {
      // The original had no row (written before its rule existed): the
      // correction is the first notice of the case.
      await enqueueOutboxForEvent(tx, event, input.pet, now, [rule]);
    }
    results.push("tightened");
  }
  return results;
}
