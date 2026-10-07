// Integration test (real DB) — /admin/outbox "Reintentar" leaves an audit row
// (plan maestro A12, migration 0287).
//
// A retry re-queues a notice an authority may then receive twice. Until
// 2026-10-07 the action was baselined debt in
// scripts/audit-log-coverage-baseline.json: the row went back to pending and
// nothing recorded who asked. Now `outbox_row_retry_requested` is written in
// the transaction that re-queues it, with the admin as actor; a refused retry
// (a merged legacy duplicate) writes nothing.

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const actor = { id: "" };
vi.mock("@/lib/infra/auth-guards", () => ({
  requireAdminOrRedirect: vi.fn(async () => ({ user: { id: actor.id } })),
}));

import { retryOutboxRowAction } from "@/app/admin/outbox/actions";
import { auditLog, db, eventNotificationOutbox, petEvents, pets } from "@/db";

import { withMutationOverride } from "./_helpers/db-overrides";

const petIds: string[] = [];

async function makeRow(status: "failed" | "merged") {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: `RTYTEST-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      name: "Reintento",
      species: "dog",
      sex: "female",
      status: "active",
      jurisdictionCountry: "AR",
      jurisdictionProvince: "Santa Fe",
      jurisdictionLocality: "Rosario",
    })
    .returning();
  petIds.push(pet.id);
  const [event] = await db
    .insert(petEvents)
    .values({
      petId: pet.id,
      eventType: "note_added",
      occurredAt: new Date(),
      recordedAt: new Date(),
      authorRole: "system",
      authorVerified: false,
      payload: { category: "system", text: "fixture" },
    })
    .returning();
  const [row] = await db
    .insert(eventNotificationOutbox)
    .values({
      sourceEventId: event.id,
      targetKind: "govt_webhook",
      targetJurisdictionProvince: "Santa Fe",
      targetJurisdictionLocality: "Rosario",
      payloadSnapshot: { disease_code: "leptospirosis" },
      slaDueAt: sql`now() + make_interval(hours => 24)`,
      status,
      attempts: 3,
    })
    .returning();
  return row;
}

async function retryAudit(rowId: string) {
  return db
    .select({ actorUserId: auditLog.actorUserId, payload: auditLog.payload })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "outbox_row_retry_requested"),
        sql`${auditLog.payload} ->> 'outbox_row_id' = ${rowId}`,
      ),
    );
}

beforeAll(async () => {
  const rows = (await db.execute(sql`
    select p.id::text as id from public.profiles p
    join auth.users u on u.id = p.id where u.email = 'admin@dim.test' limit 1
  `)) as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new Error("admin@dim.test missing — run pnpm db:bootstrap");
  actor.id = rows[0].id;
});

afterAll(async () => {
  for (const id of petIds) {
    await withMutationOverride(async (tx) => {
      await tx.delete(pets).where(eq(pets.id, id));
    });
  }
});

describe("retryOutboxRowAction — audited", () => {
  it("re-queues a failed row and records who asked, with the status before and after", async () => {
    const row = await makeRow("failed");
    const res = await retryOutboxRowAction(row.id);
    expect(res.error).toBeUndefined();
    expect(typeof res.scheduledAt).toBe("string");

    const [after] = await db
      .select({ status: eventNotificationOutbox.status })
      .from(eventNotificationOutbox)
      .where(eq(eventNotificationOutbox.id, row.id));
    expect(after.status).toBe("pending");

    const audit = await retryAudit(row.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].actorUserId).toBe(actor.id);
    expect(audit[0].payload).toMatchObject({
      outbox_row_id: row.id,
      before_values: { status: "failed" },
      after_values: { status: "pending", next_retry_at: res.scheduledAt },
    });
  });

  it("a refused retry (merged duplicate) changes nothing and writes no audit row", async () => {
    const row = await makeRow("merged");
    const res = await retryOutboxRowAction(row.id);
    expect(res.error).toBeTruthy();

    const [after] = await db
      .select({
        status: eventNotificationOutbox.status,
        nextRetryAt: eventNotificationOutbox.nextRetryAt,
      })
      .from(eventNotificationOutbox)
      .where(eq(eventNotificationOutbox.id, row.id));
    expect(after).toEqual({ status: "merged", nextRetryAt: row.nextRetryAt });
    expect(await retryAudit(row.id)).toEqual([]);
  });
});
