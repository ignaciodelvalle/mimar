#!/usr/bin/env tsx
/**
 * Backfill the target place of the outbox rows queued before the enqueue
 * snapshotted it (localidades-por-id; the live writer is c20e9163c).
 *
 * The plan per row is lib/place/outbox-target-backfill.ts: the bite case of
 * the event's animal bound for the row's exact target names, else the source
 * event's own place (event_places), each only when it names exactly the row's
 * (province, locality). An unresolved source stays unresolved; disagreeing or
 * missing sources leave the row as it is (NULL/NULL, "not recorded"). The pet's
 * current home is never read. Only rows whose target_place_method is NULL are
 * touched, so a rerun changes nothing; no row's status or delivery changes.
 *
 *   pnpm place:backfill-outbox-targets              dry run (rolled back), prints counts
 *   pnpm place:backfill-outbox-targets --apply      write (local database)
 *   pnpm place:backfill-outbox-targets --apply --allow-remote   non-local host
 */

import "./_load-env";

import { TransactionRollbackError, sql } from "drizzle-orm";

import { db } from "@/db";
import { type TargetSource, planOutboxTarget } from "@/lib/place/outbox-target-backfill";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const PAGE = 500;

export type OutboxBackfillCounts = {
  scanned: number;
  resolved: number;
  unresolved: number;
  undecided: number;
  updated: number;
};

type Row = {
  id: string;
  targetProvince: string | null;
  targetLocality: string | null;
  petId: string;
  sourceEventId: string;
};

function targetHost(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? "").hostname;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

async function pageOfRows(tx: Tx, afterId: string | null): Promise<Row[]> {
  return (await tx.execute(sql`
    select o.id::text as id, o.target_jurisdiction_province as "targetProvince",
           o.target_jurisdiction_locality as "targetLocality",
           e.pet_id::text as "petId", o.source_event_id::text as "sourceEventId"
      from public.event_notification_outbox o
      join public.pet_events e on e.id = o.source_event_id
     where o.target_place_method is null
       and (${afterId}::uuid is null or o.id > ${afterId}::uuid)
     order by o.id
     limit ${PAGE}
  `)) as unknown as Row[];
}

async function sourcesFor(tx: Tx, row: Row): Promise<TargetSource[]> {
  const cases = (await tx.execute(sql`
    select 'case' as source, jurisdiction_province as province,
           jurisdiction_locality as locality, locality_id::text as "localityId",
           place_method as method
      from public.cases
     where primary_pet_id = ${row.petId}::uuid and case_kind = 'bite_incident'
  `)) as unknown as TargetSource[];
  const events = (await tx.execute(sql`
    select 'event' as source, entered->>'province' as province,
           entered->>'locality' as locality, locality_id::text as "localityId", method
      from public.event_places
     where event_id = ${row.sourceEventId}::uuid
  `)) as unknown as TargetSource[];
  return [...cases, ...events];
}

async function backfillPage(
  tx: Tx,
  after: string | null,
  counts: OutboxBackfillCounts,
): Promise<string | null> {
  const rows = await pageOfRows(tx, after);
  for (const row of rows) {
    counts.scanned++;
    const plan = planOutboxTarget(row, await sourcesFor(tx, row));
    if (!plan) {
      counts.undecided++;
      continue;
    }
    if (plan.localityId === null) counts.unresolved++;
    else counts.resolved++;
    const done = (await tx.execute(sql`
      update public.event_notification_outbox
         set target_locality_id = ${plan.localityId}::uuid,
             target_place_method = ${plan.placeMethod}
       where id = ${row.id}::uuid and target_place_method is null
      returning id
    `)) as unknown as unknown[];
    counts.updated += done.length;
  }
  return rows.length === 0 ? null : ((rows[rows.length - 1] as Row).id ?? null);
}

function emptyCounts(): OutboxBackfillCounts {
  return { scanned: 0, resolved: 0, unresolved: 0, undecided: 0, updated: 0 };
}

/** Every page inside `tx` (the dry run, and tests). */
export async function backfillOutboxTargets(tx: Tx): Promise<OutboxBackfillCounts> {
  const counts = emptyCounts();
  let after: string | null = null;
  for (;;) {
    const last: string | null = await backfillPage(tx, after, counts);
    if (last === null) break;
    after = last;
  }
  return counts;
}

async function applyInPages(): Promise<OutboxBackfillCounts> {
  const counts = emptyCounts();
  let after: string | null = null;
  for (;;) {
    const last: string | null = await db.transaction((tx) => backfillPage(tx, after, counts));
    if (last === null) break;
    after = last;
  }
  return counts;
}

class DryRun extends Error {}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const host = targetHost();
  if (!LOCAL_HOSTS.has(host) && !process.argv.includes("--allow-remote")) {
    throw new Error(`refusing ${host}: a non-local database needs --allow-remote`);
  }
  console.log(`[place-backfill-outbox-targets] host ${host}${apply ? "" : " (dry run)"}`);
  let counts: OutboxBackfillCounts | null = null;
  if (apply) {
    counts = await applyInPages();
  } else {
    try {
      await db.transaction(async (tx) => {
        counts = await backfillOutboxTargets(tx);
        throw new DryRun();
      });
    } catch (e) {
      if (!(e instanceof DryRun || e instanceof TransactionRollbackError)) throw e;
    }
  }
  const c = counts as OutboxBackfillCounts | null;
  if (!c) throw new Error("the backfill did not run");
  console.log(
    `  rows scanned ${c.scanned}; resolved ${c.resolved}; unresolved ${c.unresolved}; undecided (no single matching source) ${c.undecided}; ${apply ? "updated" : "would update"} ${c.updated}`,
  );
}

if (process.argv[1]?.endsWith("place-backfill-outbox-targets.ts")) {
  main()
    .then(() => process.exit(0))
    .catch((e: unknown) => {
      console.error(
        `[place-backfill-outbox-targets] ${e instanceof Error ? e.message : String(e)}`,
      );
      process.exit(1);
    });
}
