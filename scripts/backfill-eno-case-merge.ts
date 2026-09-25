#!/usr/bin/env tsx
/**
 * Legacy backfill for "one ENO record per case" (migration 0247).
 *
 * PO rule, 2026-09-25: "A Case may not be duplicated; all information related
 * to a single event must be concentrated in a single record for consistency."
 * The enqueue now enforces it for every NEW write (lib/events/
 * event-outbox-enqueue.ts). This script handles what was written before:
 *
 *   (a) DUPLICATE GROUPS — event_notification_outbox rows whose source events
 *       belong to the same case under today's rules (a rabies diagnosis, the
 *       outbreak_signal it derived, and the positive close of the same animal's
 *       observation were three rows).
 *   (b) POSITIVE CLOSURES WITH NO ENO ROW — rabies_observation_ended with
 *       outcome positive_rabies written before 01952b5d7, which never enqueued
 *       anything.
 *
 * DRY-RUN BY DEFAULT: lists both and writes nothing.
 *
 *   pnpm backfill:eno-case              # dry-run
 *   pnpm backfill:eno-case -- --apply   # writes (needs migration 0247 applied)
 *
 * --apply, per the same rule the enqueue follows:
 *   (a) the record is the row the new enqueue already keyed, else the OLDEST
 *       row of the group. It takes the case key, the
 *       earliest deadline of the group, and stays/becomes pending if any member
 *       was still pending (a group already fully delivered stays delivered —
 *       the authority received every part). Every other row is appended to its
 *       `linked_sources` — source event, type, snapshot, its status and
 *       delivery time, and the outbox row id it replaced — and then deleted.
 *       Nothing is lost: the link entry IS the deleted row's content. The
 *       outbox is a delivery queue, not the append-only spine; pet_events are
 *       not touched.
 *   (b) each orphan closure goes through enqueueOutboxForEvent itself, so it
 *       links into the animal's existing rabies record or creates it. Its SLA
 *       runs from the close's recorded_at, which is honest: a legacy close is
 *       already past its legal window, and the Cola ENO should say so.
 * Each group and each closure is its own transaction. Re-running is safe:
 * merged groups no longer have duplicates, and a linked closure is found.
 */

import "./_load-env";

import { and, eq, inArray, sql } from "drizzle-orm";

import { db, eventNotificationOutbox, petEvents, pets } from "@/db";
import { enqueueOutboxForEvent } from "@/lib/events/event-outbox-enqueue";
import { OUTBOX_RULES } from "@/lib/events/event-outbox-rules";

type OutboxRow = {
  id: string;
  sourceEventId: string;
  targetKind: string;
  status: string;
  slaDueAt: Date;
  deliveredAt: Date | null;
  createdAt: Date;
  payloadSnapshot: unknown;
  petId: string;
  eventType: string;
  eventPayload: Record<string, unknown>;
};

export type CaseGroup = { targetKind: string; caseKey: string; rows: OutboxRow[] };

/** The case a row belongs to under TODAY's rules — the same caseKey the enqueue uses. */
export function caseKeyForRow(row: OutboxRow): string | null {
  const rules = OUTBOX_RULES[row.eventType as keyof typeof OUTBOX_RULES] ?? [];
  for (const rule of rules) {
    if (rule.target_kind !== row.targetKind || !rule.caseKey) continue;
    const key = rule.caseKey(row.eventPayload, { petId: row.petId });
    if (key) return key;
  }
  return null;
}

/** Rows grouped by (target_kind, case key); only groups of two or more. Oldest first. */
export function duplicateGroups(rows: OutboxRow[]): CaseGroup[] {
  const groups = new Map<string, CaseGroup>();
  for (const row of rows) {
    const caseKey = caseKeyForRow(row);
    if (!caseKey) continue;
    const id = `${row.targetKind}|${caseKey}`;
    const group = groups.get(id) ?? { targetKind: row.targetKind, caseKey, rows: [] };
    group.rows.push(row);
    groups.set(id, group);
  }
  return [...groups.values()]
    .filter((g) => g.rows.length > 1)
    .map((g) => ({
      ...g,
      rows: [...g.rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    }));
}

async function hasCaseColumns(): Promise<boolean> {
  const result = await db.execute(sql`
    select count(*)::int as n from information_schema.columns
    where table_name = 'event_notification_outbox'
      and column_name in ('eno_case_key', 'linked_sources')`);
  const rows =
    (result as unknown as { rows?: { n: number }[] }).rows ??
    (result as unknown as { n: number }[]);
  return Number(rows[0]?.n ?? 0) === 2;
}

async function loadOutboxRows(): Promise<OutboxRow[]> {
  // Explicit columns only: the dry-run must work before 0247 is applied.
  const rows = await db
    .select({
      id: eventNotificationOutbox.id,
      sourceEventId: eventNotificationOutbox.sourceEventId,
      targetKind: eventNotificationOutbox.targetKind,
      status: eventNotificationOutbox.status,
      slaDueAt: eventNotificationOutbox.slaDueAt,
      deliveredAt: eventNotificationOutbox.deliveredAt,
      createdAt: eventNotificationOutbox.createdAt,
      payloadSnapshot: eventNotificationOutbox.payloadSnapshot,
      petId: petEvents.petId,
      eventType: petEvents.eventType,
      eventPayload: petEvents.payload,
    })
    .from(eventNotificationOutbox)
    .innerJoin(petEvents, eq(petEvents.id, eventNotificationOutbox.sourceEventId));
  return rows.map((r) => ({
    ...r,
    eventPayload: (r.eventPayload ?? {}) as Record<string, unknown>,
  }));
}

async function loadLinkedEventIds(withColumns: boolean): Promise<Set<string>> {
  if (!withColumns) return new Set();
  const result = await db.execute(sql`
    select distinct link->>'source_event_id' as id
    from event_notification_outbox, jsonb_array_elements(linked_sources) as link`);
  const rows =
    (result as unknown as { rows?: { id: string }[] }).rows ??
    (result as unknown as { id: string }[]);
  return new Set(rows.map((r) => r.id));
}

async function loadPositiveClosures() {
  return db
    .select({
      id: petEvents.id,
      petId: petEvents.petId,
      eventType: petEvents.eventType,
      payload: petEvents.payload,
      recordedAt: petEvents.recordedAt,
    })
    .from(petEvents)
    .where(
      and(
        eq(petEvents.eventType, "rabies_observation_ended"),
        sql`${petEvents.payload}->>'outcome' = 'positive_rabies'`,
      ),
    );
}

async function loadKeyedRowIds(withColumns: boolean): Promise<Set<string>> {
  if (!withColumns) return new Set();
  const result = await db.execute(
    sql`select id from event_notification_outbox where eno_case_key is not null`,
  );
  const rows =
    (result as unknown as { rows?: { id: string }[] }).rows ??
    (result as unknown as { id: string }[]);
  return new Set(rows.map((r) => r.id));
}

async function mergeGroup(group: CaseGroup, keyedRowIds: Set<string>): Promise<void> {
  // A row the new enqueue already keyed IS the record (it may carry links of
  // its own); otherwise the oldest one.
  const keeper = group.rows.find((r) => keyedRowIds.has(r.id)) ?? group.rows[0];
  const others = group.rows.filter((r) => r.id !== keeper.id);
  const anyPending = group.rows.some((r) => r.status === "pending");
  const earliestSla = new Date(Math.min(...group.rows.map((r) => r.slaDueAt.getTime())));
  const links = others.map((r) => ({
    source_event_id: r.sourceEventId,
    event_type: r.eventType,
    linked_at: new Date().toISOString(),
    payload_snapshot: r.payloadSnapshot,
    previous_status: r.status,
    previous_delivered_at: r.deliveredAt?.toISOString() ?? null,
    merged_from_outbox_row_id: r.id,
    merged_by: "scripts/backfill-eno-case-merge.ts",
  }));

  await db.transaction(async (tx) => {
    await tx.delete(eventNotificationOutbox).where(
      inArray(
        eventNotificationOutbox.id,
        others.map((r) => r.id),
      ),
    );
    await tx
      .update(eventNotificationOutbox)
      .set({
        enoCaseKey: group.caseKey,
        linkedSources: sql`${eventNotificationOutbox.linkedSources} || ${JSON.stringify(links)}::jsonb`,
        slaDueAt: earliestSla,
        ...(anyPending && keeper.status !== "pending"
          ? { status: "pending" as const, nextRetryAt: new Date(), deliveredAt: null, attempts: 0 }
          : {}),
      })
      .where(eq(eventNotificationOutbox.id, keeper.id));
  });
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const withColumns = await hasCaseColumns();
  console.log(
    `[backfill-eno-case-merge] mode=${apply ? "APPLY" : "dry-run"}  migration_0247=${withColumns ? "applied" : "absent"}`,
  );
  if (apply && !withColumns) {
    console.error("  --apply needs migration 0247 (eno_case_key, linked_sources). Aborting.");
    process.exit(1);
  }

  const rows = await loadOutboxRows();
  const groups = duplicateGroups(rows);
  const keyedSources = new Set(rows.map((r) => r.sourceEventId));
  const linked = await loadLinkedEventIds(withColumns);
  const closures = await loadPositiveClosures();
  const orphanClosures = closures.filter((c) => !keyedSources.has(c.id) && !linked.has(c.id));

  console.log(`  outbox rows scanned: ${rows.length}`);
  console.log(
    `  (a) duplicate case groups: ${groups.length}  (rows to fold: ${groups.reduce((n, g) => n + g.rows.length - 1, 0)})`,
  );
  for (const g of groups) {
    console.log(
      `      ${g.targetKind} ${g.caseKey}: ${g.rows.map((r) => `${r.eventType}/${r.status}`).join(", ")}`,
    );
  }
  console.log(
    `  (b) positive closures scanned: ${closures.length}; without an ENO row: ${orphanClosures.length}`,
  );
  for (const c of orphanClosures) {
    console.log(`      event=${c.id} pet=${c.petId} recorded_at=${c.recordedAt.toISOString()}`);
  }

  if (!apply) {
    console.log("  dry-run: nothing written. Re-run with --apply to merge and create.");
    return;
  }

  const keyedRowIds = await loadKeyedRowIds(withColumns);
  for (const g of groups) await mergeGroup(g, keyedRowIds);
  for (const c of orphanClosures) {
    await db.transaction(async (tx) => {
      const [pet] = await tx
        .select({
          jurisdictionProvince: pets.jurisdictionProvince,
          jurisdictionLocality: pets.jurisdictionLocality,
        })
        .from(pets)
        .where(eq(pets.id, c.petId));
      await enqueueOutboxForEvent(
        tx,
        {
          id: c.id,
          petId: c.petId,
          eventType: c.eventType,
          payload: (c.payload ?? {}) as Record<string, unknown>,
        },
        pet ?? {},
        c.recordedAt,
      );
    });
  }
  console.log(
    `  applied: ${groups.length} group(s) merged, ${orphanClosures.length} closure(s) enqueued.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill-eno-case-merge] FATAL:", err);
    process.exit(1);
  });
