// Legacy backfill for "one ENO record per case" (migration 0247) — the logic;
// scripts/backfill-eno-case-merge.ts is the CLI around it.
//
// PO rule, 2026-09-25: "A Case may not be duplicated; all information related
// to a single event must be concentrated in a single record for consistency."
// The live enqueue enforces it for every NEW write
// (lib/events/event-outbox-enqueue.ts). Rows written before it are handled
// here, in this order:
//
//   1. KEY EVERY CASE ROW, singletons included. Each un-keyed row a rule puts in
//      a case family gets its case key — built from the row's OWN target
//      jurisdiction (a legacy row is not re-routed after the fact; it stays
//      bound for the authority it was bound for). Keying first is what lets the
//      closure pass below link into an existing record instead of creating one.
//   2. MERGE DUPLICATES. When two or more rows share a key, the record is the
//      row the live enqueue already keyed, else the oldest. The others are NOT
//      deleted — the outbox is retained for audit and read by the on-time
//      metrics — they are marked `status = 'merged'` with `merged_into_id`
//      naming the record. 'merged' is not pending, so the drainer never sends
//      them again, and it is not 'delivered', so the on-time share never counts
//      them (lib/analytics/surveillance-metrics.ts also excludes them from the
//      period total). Each merged row is appended to the record's
//      `linked_sources` with the same shape the live link writes: the record's
//      own previous status and delivered_at, plus the merged row's.
//      Deadline: the EARLIEST of the group — the stricter legal clock binds.
//      Status: the record stays/becomes pending if any member was still pending;
//      a group fully delivered stays delivered (the authority got every part).
//   3. POSITIVE CLOSURES WITH NO ENO ROW (written before 01952b5d7) go through
//      enqueueOutboxForEvent itself — routed by their bite case, keyed, linked
//      into the matching record or creating it. The SLA runs from the close's
//      recorded_at, which is honest: a legacy close is already late.
//
// Every write runs per group / per closure in its own transaction. `petIds`
// narrows the whole run to some animals (tests: the local database is shared).

import { and, eq, inArray, sql } from "drizzle-orm";

import { db, eventNotificationOutbox, petEvents, pets } from "@/db";
import { enqueueOutboxForEvent } from "@/lib/events/event-outbox-enqueue";
import { OUTBOX_RULES, enoCaseKey } from "@/lib/events/event-outbox-rules";

export type BackfillRow = {
  id: string;
  sourceEventId: string;
  targetKind: string;
  status: string;
  slaDueAt: Date;
  deliveredAt: Date | null;
  createdAt: Date;
  payloadSnapshot: unknown;
  targetJurisdictionProvince: string | null;
  targetJurisdictionLocality: string | null;
  enoCaseKey: string | null;
  petId: string;
  eventType: string;
  eventPayload: Record<string, unknown>;
};

export type CaseGroup = { targetKind: string; caseKey: string; rows: BackfillRow[] };

export type EnoCaseBackfillPlan = {
  scanned: number;
  /** Groups of ONE un-keyed row: only the key is written. */
  singletons: CaseGroup[];
  /** Groups of two or more rows: merged into one record. */
  duplicates: CaseGroup[];
  orphanClosures: {
    id: string;
    petId: string;
    eventType: string;
    payload: unknown;
    recordedAt: Date;
  }[];
};

/** The case a row belongs to under TODAY's rules, keyed by the row's own target. */
export function caseKeyForRow(row: BackfillRow): string | null {
  const rules = OUTBOX_RULES[row.eventType as keyof typeof OUTBOX_RULES] ?? [];
  for (const rule of rules) {
    if (rule.target_kind !== row.targetKind || !rule.caseFamily) continue;
    const family = rule.caseFamily(row.eventPayload);
    if (family) {
      return enoCaseKey(family, row.petId, {
        jurisdictionProvince: row.targetJurisdictionProvince,
        jurisdictionLocality: row.targetJurisdictionLocality,
      });
    }
  }
  return null;
}

export async function planEnoCaseBackfill(
  opts: { petIds?: string[] } = {},
): Promise<EnoCaseBackfillPlan> {
  const petFilter = opts.petIds ? inArray(petEvents.petId, opts.petIds) : undefined;

  const loaded = await db
    .select({
      id: eventNotificationOutbox.id,
      sourceEventId: eventNotificationOutbox.sourceEventId,
      targetKind: eventNotificationOutbox.targetKind,
      status: eventNotificationOutbox.status,
      slaDueAt: eventNotificationOutbox.slaDueAt,
      deliveredAt: eventNotificationOutbox.deliveredAt,
      createdAt: eventNotificationOutbox.createdAt,
      payloadSnapshot: eventNotificationOutbox.payloadSnapshot,
      targetJurisdictionProvince: eventNotificationOutbox.targetJurisdictionProvince,
      targetJurisdictionLocality: eventNotificationOutbox.targetJurisdictionLocality,
      enoCaseKey: eventNotificationOutbox.enoCaseKey,
      linkedSources: eventNotificationOutbox.linkedSources,
      petId: petEvents.petId,
      eventType: petEvents.eventType,
      eventPayload: petEvents.payload,
    })
    .from(eventNotificationOutbox)
    .innerJoin(petEvents, eq(petEvents.id, eventNotificationOutbox.sourceEventId))
    .where(petFilter);

  const live = loaded.filter((r) => r.status !== "merged");
  const groups = new Map<string, CaseGroup>();
  for (const r of live) {
    const row: BackfillRow = {
      ...r,
      eventPayload: (r.eventPayload ?? {}) as Record<string, unknown>,
    };
    const caseKey = row.enoCaseKey ?? caseKeyForRow(row);
    if (!caseKey) continue;
    const id = `${row.targetKind}|${caseKey}`;
    const group = groups.get(id) ?? { targetKind: row.targetKind, caseKey, rows: [] };
    group.rows.push(row);
    groups.set(id, group);
  }
  const all = [...groups.values()].map((g) => ({
    ...g,
    rows: [...g.rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
  }));

  // Every event already on some record — as its source or as a link.
  const onARecord = new Set<string>();
  for (const r of loaded) {
    onARecord.add(r.sourceEventId);
    for (const l of Array.isArray(r.linkedSources) ? r.linkedSources : []) {
      const id = (l as { source_event_id?: unknown }).source_event_id;
      if (typeof id === "string") onARecord.add(id);
    }
  }
  const closures = await db
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
        petFilter,
      ),
    );

  return {
    scanned: loaded.length,
    singletons: all.filter((g) => g.rows.length === 1 && g.rows[0].enoCaseKey === null),
    duplicates: all.filter((g) => g.rows.length > 1),
    orphanClosures: closures.filter((c) => !onARecord.has(c.id)),
  };
}

async function keySingleton(group: CaseGroup): Promise<void> {
  await db
    .update(eventNotificationOutbox)
    .set({ enoCaseKey: group.caseKey })
    .where(eq(eventNotificationOutbox.id, group.rows[0].id));
}

async function mergeGroup(group: CaseGroup): Promise<void> {
  const keeper = group.rows.find((r) => r.enoCaseKey !== null) ?? group.rows[0];
  const others = group.rows.filter((r) => r.id !== keeper.id);
  const anyPending = group.rows.some((r) => r.status === "pending");
  const reopen = anyPending && keeper.status !== "pending";
  const earliestSla = new Date(Math.min(...group.rows.map((r) => r.slaDueAt.getTime())));
  const linkedAt = new Date().toISOString();
  const links = others.map((r) => ({
    source_event_id: r.sourceEventId,
    event_type: r.eventType,
    linked_at: linkedAt,
    payload_snapshot: r.payloadSnapshot,
    // The RECORD's state before this link — the same meaning the live link
    // gives these two fields.
    previous_status: keeper.status,
    previous_delivered_at: keeper.deliveredAt?.toISOString() ?? null,
    // And the merged row's own delivery, kept rather than erased.
    merged_from_outbox_row_id: r.id,
    merged_row_status: r.status,
    merged_row_delivered_at: r.deliveredAt?.toISOString() ?? null,
    merged_by: "scripts/backfill-eno-case-merge.ts",
  }));

  await db.transaction(async (tx) => {
    // Mark first: a merged row that carried the key must release it before
    // the record takes it (unique index outbox_eno_case_unique).
    await tx
      .update(eventNotificationOutbox)
      .set({ status: "merged", mergedIntoId: keeper.id, enoCaseKey: null })
      .where(
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
        ...(reopen
          ? {
              status: "pending" as const,
              nextRetryAt: sql`now()`,
              deliveredAt: null,
              attempts: 0,
              lastError: null,
            }
          : {}),
      })
      .where(eq(eventNotificationOutbox.id, keeper.id));
  });
}

export async function applyEnoCaseBackfill(plan: EnoCaseBackfillPlan): Promise<void> {
  for (const g of plan.singletons) await keySingleton(g);
  for (const g of plan.duplicates) await mergeGroup(g);
  for (const c of plan.orphanClosures) {
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
}
