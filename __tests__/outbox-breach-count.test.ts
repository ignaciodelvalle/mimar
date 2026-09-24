// Integration tests — global outbox SLA-breach count (C2).
//
// Regression under test: the /admin/outbox banner derived its breach count from
// the page rows (LIMIT 200 / keyset page), so it SUB-REPORTED when breaches
// existed beyond the visible page — while the nav badge in layout.tsx did a
// global count(*). The two numbers disagreed. countOutboxBreaches() is now the
// single source of truth shared by BOTH surfaces: a global count(*) with the
// exact predicate `status='pending' AND sla_due_at < now()`.

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, eventNotificationOutbox, ownerships, petEvents, pets } from "@/db";
import { countOutboxBreaches } from "@/lib/infra/outbox-queries";
import { withMutationOverride } from "./_helpers/db-overrides";

const TOKEN = "C2-OUTBOX-BREACH";
const MS_PER_HOUR = 60 * 60 * 1000;

let petId: string;
let sourceEventId: string;
const outboxIds: string[] = [];

async function insertOutboxRow(opts: {
  status: "pending" | "delivered" | "failed";
  slaDueAt: Date;
}) {
  const [row] = await db
    .insert(eventNotificationOutbox)
    .values({
      sourceEventId,
      targetKind: "eno_authority",
      slaDueAt: opts.slaDueAt,
      status: opts.status,
    })
    .returning({ id: eventNotificationOutbox.id });
  outboxIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: TOKEN,
      name: "OutboxBreachPet",
      species: "dog",
      sex: "unknown",
      status: "active",
    })
    .returning();
  petId = pet.id;

  const [ev] = await db
    .insert(petEvents)
    .values({
      petId,
      eventType: "credential_scanned",
      occurredAt: new Date(),
      payload: { payload_version: 1, is_self_scan: false, viewer_authenticated: false },
      authorRole: "scanner",
      recordedByUserId: null,
    })
    .returning({ id: petEvents.id });
  sourceEventId = ev.id;
}, 30_000);

afterAll(async () => {
  if (outboxIds.length > 0) {
    await db.delete(eventNotificationOutbox).where(inArray(eventNotificationOutbox.id, outboxIds));
  }
  await withMutationOverride(async (tx) => {
    await tx.delete(ownerships).where(eq(ownerships.petId, petId));
    await tx.delete(petEvents).where(eq(petEvents.petId, petId));
    await tx.delete(pets).where(eq(pets.id, petId));
  });
});

describe("countOutboxBreaches — global, predicate-exact (C2)", () => {
  it("counts every pending row past its SLA deadline, not just a page of them", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 2 * MS_PER_HOUR);
    const future = new Date(now.getTime() + 2 * MS_PER_HOUR);

    const before = await countOutboxBreaches(now);

    // Seed a cohort well beyond any single visible page would never matter here:
    // the count has NO limit. 7 breached + 3 non-breached + 2 delivered.
    const BREACHED = 7;
    for (let i = 0; i < BREACHED; i++) {
      await insertOutboxRow({ status: "pending", slaDueAt: past });
    }
    // pending but still within SLA → NOT a breach
    for (let i = 0; i < 3; i++) {
      await insertOutboxRow({ status: "pending", slaDueAt: future });
    }
    // delivered (even if past SLA) → NOT a breach
    for (let i = 0; i < 2; i++) {
      await insertOutboxRow({ status: "delivered", slaDueAt: past });
    }

    const after = await countOutboxBreaches(now);

    // Exactly the breached rows are added to the global count — the within-SLA
    // and delivered rows are excluded by the predicate.
    expect(after - before).toBe(BREACHED);
  });

  it("returns a number that ignores delivered/failed rows regardless of SLA", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 5 * MS_PER_HOUR);

    const before = await countOutboxBreaches(now);
    await insertOutboxRow({ status: "failed", slaDueAt: past });
    await insertOutboxRow({ status: "delivered", slaDueAt: past });
    const after = await countOutboxBreaches(now);

    expect(after).toBe(before);
  });
});
