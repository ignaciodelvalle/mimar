// Rolled-back transaction harness for the pet_events erasure tests (T3-A2b).
//
// Same discipline as __tests__/subject-rights-0208-mutants.test.ts: local
// Supabase is shared by every worktree, so every seeded row, every erasure and
// every mutated rule lives inside ONE transaction that always ends in
// ROLLBACK. Users are inserted straight into auth.users (the
// on_auth_user_created trigger creates the profile), never through the admin
// API, which would commit outside the transaction.

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { db, ownerships, petEvents, pets } from "@/db";
import { generatePublicToken } from "@/lib/infra/publicToken";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Row = Record<string, unknown>;

class RollbackSignal extends Error {
  constructor() {
    super("intentional rollback — __tests__/_helpers/erasure-tx.ts");
  }
}

/** Runs `body` in a transaction that ALWAYS rolls back; returns what it observed. */
export async function inRolledBackTx<T>(body: (tx: Tx) => Promise<T>): Promise<T> {
  let observed: T | undefined;
  let reached = false;
  try {
    await db.transaction(async (tx) => {
      observed = await body(tx);
      reached = true;
      throw new RollbackSignal();
    });
  } catch (err) {
    if (!(err instanceof RollbackSignal)) throw err;
  }
  if (!reached) throw new Error("transaction body did not complete");
  return observed as T;
}

export async function rows(tx: Tx, q: ReturnType<typeof sql>): Promise<Row[]> {
  return (await tx.execute(q)) as unknown as Row[];
}

export async function seedUser(tx: Tx, label: string): Promise<string> {
  const id = randomUUID();
  await tx.execute(
    sql`INSERT INTO auth.users (id, email) VALUES (${id}::uuid, ${`${label}-${id}@dim-test.local`})`,
  );
  return id;
}

/** A pet with an owner ownership; `endedAt` makes it a pet the owner USED to own. */
export async function seedPet(
  tx: Tx,
  ownerUserId: string,
  opts: { startedAt?: Date; endedAt?: Date | null } = {},
): Promise<string> {
  const [pet] = await tx
    .insert(pets)
    .values({
      publicToken: generatePublicToken(),
      name: "A2bFixture",
      species: "dog",
      sex: "female",
      potentiallyDangerousBreed: false,
    })
    .returning({ id: pets.id });
  await tx.insert(ownerships).values({
    petId: pet.id,
    ownerUserId,
    role: "owner",
    startedAt: opts.startedAt ?? new Date(Date.now() - 400 * 86_400_000),
    endedAt: opts.endedAt ?? null,
  });
  return pet.id;
}

export type SeedEvent = {
  petId: string;
  eventType: string;
  recordedByUserId: string | null;
  authorRole: "owner" | "scanner" | "finder" | "vet" | "shelter" | "govt" | "system";
  payload: Record<string, unknown>;
  occurredAt?: Date;
  notes?: string | null;
  locationLat?: string | null;
  locationLng?: string | null;
  extra?: Partial<typeof petEvents.$inferInsert>;
};

export async function insertEvent(tx: Tx, e: SeedEvent): Promise<string> {
  const [row] = await tx
    .insert(petEvents)
    .values({
      petId: e.petId,
      eventType: e.eventType,
      occurredAt: e.occurredAt ?? new Date(Date.now() - 30 * 86_400_000),
      recordedByUserId: e.recordedByUserId,
      authorRole: e.authorRole,
      payload: e.payload,
      notes: e.notes ?? null,
      locationLat: e.locationLat ?? null,
      locationLng: e.locationLng ?? null,
      ...e.extra,
    })
    .returning({ id: petEvents.id });
  return row.id;
}

/** Calls erase_subject_data as the subject themselves (auth.uid() = subject). */
export async function eraseAs(tx: Tx, subject: string): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: subject })}, true)`,
  );
  await tx.execute(sql`SELECT public.erase_subject_data(${subject}::uuid, 'T3-A2b test'::text)`);
}

export type EventSnapshot = {
  id: string;
  event_type: string;
  occurred_at: string;
  payload: Record<string, unknown>;
  notes: string | null;
  location_lat: string | null;
  location_lng: string | null;
  author_role: string;
  recorded_by_user_id: string | null;
};

export async function snapshotEvents(tx: Tx, ids: readonly string[]): Promise<EventSnapshot[]> {
  if (ids.length === 0) return [];
  const found = await rows(
    tx,
    sql`SELECT id::text, event_type, occurred_at::text, payload, notes,
               location_lat::text, location_lng::text, author_role::text,
               recorded_by_user_id::text
          FROM public.pet_events
         WHERE id = ANY(${`{${ids.join(",")}}`}::uuid[])
         ORDER BY id`,
  );
  return found as unknown as EventSnapshot[];
}

/**
 * Every pet_events_mutation_override audit row written IN THIS TRANSACTION, as
 * text. `performed_at >= now()` is exact here: now() is the transaction's start
 * instant and every row the transaction writes carries it, and it rides the
 * (action, performed_at) index instead of scanning millions of override rows
 * the local database has accumulated (see subject-rights-rpcs.test.ts).
 */
export async function overrideAuditText(tx: Tx): Promise<Array<{ eventId: string; text: string }>> {
  const found = await rows(
    tx,
    sql`SELECT payload->>'pet_event_id' AS event_id, payload::text AS t
          FROM public.audit_log
         WHERE action = 'pet_events_mutation_override'
           AND performed_at >= now()`,
  );
  return found.map((r) => ({ eventId: r.event_id as string, text: r.t as string }));
}
