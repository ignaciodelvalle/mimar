#!/usr/bin/env tsx
/**
 * Backfill event_places for the historic events that carry no `place`
 * (localidades-por-id D6, design "Backfill": place at time t = pet home per
 * spine at t, method spine_rederived).
 *
 * The plan per pet is lib/place/historic-event-places.ts: the latest
 * registration or jurisdiction move up to each event is the pet's home then;
 * its catalogue row is ONLY what that spine event recorded — a home recorded
 * by name is written UNRESOLVED (locality_id NULL, method 'unresolved'),
 * never matched to a homonym. Events are never touched (P2); only
 * event_places rows are added.
 *
 * Idempotent: rows are inserted ON CONFLICT (event_id) DO NOTHING, and only
 * events without a row are planned. A recorded id the catalogue does not
 * hold is not written (and is counted): a place is never invented.
 *
 *   pnpm place:backfill-event-places              dry run (rolled back), prints counts
 *   pnpm place:backfill-event-places --apply      write (local database)
 *   pnpm place:backfill-event-places --apply --allow-remote   non-local host
 */

import "./_load-env";

import { TransactionRollbackError, asc, eq, sql } from "drizzle-orm";

import { db, petEvents } from "@/db";
import { overlayAmendments } from "@/lib/infra/amendment";
import {
  type HistoricEventPlace,
  planHistoricEventPlaces,
} from "@/lib/place/historic-event-places";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const PET_BATCH = 500;

export type BackfillCounts = {
  petsScanned: number;
  planned: number;
  resolved: number;
  unresolved: number;
  inserted: number;
  skippedUnknownId: number;
};

function targetHost(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? "").hostname;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

async function petsWithUnplacedEvents(tx: Tx, afterPetId: string | null): Promise<string[]> {
  const rows = (await tx.execute(sql`
    select distinct e.pet_id::text as id
      from public.pet_events e
      left join public.event_places p on p.event_id = e.id
     where p.event_id is null
       and e.event_type <> 'event_amended'
       and (${afterPetId}::uuid is null or e.pet_id > ${afterPetId}::uuid)
     order by 1
     limit ${PET_BATCH}
  `)) as unknown as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

async function planForPet(tx: Tx, petId: string): Promise<HistoricEventPlace[]> {
  const raw = await tx
    .select({
      id: petEvents.id,
      eventType: petEvents.eventType,
      occurredAt: petEvents.occurredAt,
      recordedAt: petEvents.recordedAt,
      payload: petEvents.payload,
    })
    .from(petEvents)
    .where(eq(petEvents.petId, petId))
    .orderBy(asc(petEvents.occurredAt), asc(petEvents.recordedAt), asc(petEvents.id));
  const placed = (await tx.execute(sql`
    select event_id::text as id from public.event_places where pet_id = ${petId}::uuid
  `)) as unknown as Array<{ id: string }>;
  return planHistoricEventPlaces(petId, overlayAmendments(raw), new Set(placed.map((p) => p.id)));
}

async function knownLocalityIds(tx: Tx, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = (await tx.execute(sql`
    select id::text as id from public.ar_localities
     where id in (${sql.join(
       ids.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
  `)) as unknown as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

async function insertRows(tx: Tx, rows: HistoricEventPlace[]): Promise<number> {
  if (rows.length === 0) return 0;
  const values = rows.map(
    (r) =>
      sql`(${r.eventId}::uuid, ${r.petId}::uuid, ${r.provinceCode}, ${r.localityId}::uuid, ${r.method}, ${JSON.stringify(r.entered)}::jsonb)`,
  );
  const res = (await tx.execute(sql`
    insert into public.event_places (event_id, pet_id, province_code, locality_id, method, entered)
    values ${sql.join(values, sql`, `)}
    on conflict (event_id) do nothing
    returning event_id
  `)) as unknown as unknown[];
  return res.length;
}

function emptyCounts(): BackfillCounts {
  return {
    petsScanned: 0,
    planned: 0,
    resolved: 0,
    unresolved: 0,
    inserted: 0,
    skippedUnknownId: 0,
  };
}

/** Plan and insert the missing rows of one pet page; returns the page's last pet id. */
async function backfillPage(
  tx: Tx,
  after: string | null,
  counts: BackfillCounts,
): Promise<string | null> {
  const petIds = await petsWithUnplacedEvents(tx, after);
  for (const petId of petIds) {
    counts.petsScanned++;
    const planned = await planForPet(tx, petId);
    const ids = [...new Set(planned.map((r) => r.localityId).filter((v): v is string => !!v))];
    const known = await knownLocalityIds(tx, ids);
    const writable = planned.filter((r) => r.localityId === null || known.has(r.localityId));
    counts.skippedUnknownId += planned.length - writable.length;
    counts.planned += writable.length;
    counts.resolved += writable.filter((r) => r.method === "spine_rederived").length;
    counts.unresolved += writable.filter((r) => r.method === "unresolved").length;
    counts.inserted += await insertRows(tx, writable);
  }
  return petIds.length === 0 ? null : (petIds[petIds.length - 1] ?? null);
}

/** Plan and insert every missing row inside `tx` (one transaction). */
export async function backfillEventPlaces(tx: Tx): Promise<BackfillCounts> {
  const counts = emptyCounts();
  let after: string | null = null;
  for (;;) {
    const last: string | null = await backfillPage(tx, after, counts);
    if (last === null) break;
    after = last;
  }
  return counts;
}

/**
 * Apply mode: one transaction per pet page, so a long run neither holds one
 * giant transaction nor loses finished pages on a late failure. Safe to
 * re-run: only events without a row are planned.
 */
async function applyInPages(): Promise<BackfillCounts> {
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
  console.log(`[place-backfill-event-places] host ${host}${apply ? "" : " (dry run)"}`);
  let counts: BackfillCounts | null = null;
  if (apply) {
    counts = await applyInPages();
  } else {
    try {
      await db.transaction(async (tx) => {
        counts = await backfillEventPlaces(tx);
        throw new DryRun();
      });
    } catch (e) {
      if (!(e instanceof DryRun || e instanceof TransactionRollbackError)) throw e;
    }
  }
  const c = counts as BackfillCounts | null;
  if (!c) throw new Error("the backfill did not run");
  console.log(
    `  pets scanned ${c.petsScanned}; rows planned ${c.planned} (resolved by the spine ${c.resolved}, unresolved ${c.unresolved}); ${apply ? "inserted" : "would insert"} ${c.inserted}; skipped (recorded id not in the catalogue) ${c.skippedUnknownId}`,
  );
}

if (process.argv[1]?.endsWith("place-backfill-event-places.ts")) {
  main()
    .then(() => process.exit(0))
    .catch((e: unknown) => {
      const cause =
        e instanceof Error && e.cause instanceof Error ? ` (cause: ${e.cause.message})` : "";
      console.error(
        `[place-backfill-event-places] ${e instanceof Error ? e.message : String(e)}${cause}`,
      );
      process.exit(1);
    });
}
