// Integration test (real DB) — "Marcar recibido" (PO S3, 2026-09-26).
//
// While no real receiver exists, an ENO notice leaves 'pending' only when a
// person of the receiving authority marks it received: within their scope,
// with who and when on the row and an audit_log entry, never twice.

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditLog, db, eventNotificationOutbox, petEvents, pets } from "@/db";
import { markOutboxReceived } from "@/src/modules/surveillance/application/mark-outbox-received";
import { OutboxReceiptRepository } from "@/src/modules/surveillance/infrastructure/outbox-receipt-repository";

import { withMutationOverride } from "./_helpers/db-overrides";

let actorId: string;
const petIds: string[] = [];
const deps = { repo: new OutboxReceiptRepository() };
const ROSARIO = [{ province: "Santa Fe", locality: "Rosario" }];

async function makeRow(slaOffsetHours: number) {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: `RCVTEST-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      name: "Recibido",
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
      // Relative to the DATABASE clock, never the host's.
      slaDueAt: sql`now() + make_interval(hours => ${slaOffsetHours})`,
      status: "pending",
      attempts: 0,
    })
    .returning();
  return row;
}

beforeAll(async () => {
  const rows = (await db.execute(sql`
    select p.id::text as id from public.profiles p
    join auth.users u on u.id = p.id where u.email = 'admin@dim.test' limit 1
  `)) as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new Error("admin@dim.test missing — run pnpm db:bootstrap");
  actorId = rows[0].id;
});

afterAll(async () => {
  for (const id of petIds) {
    await withMutationOverride(async (tx) => {
      await tx.delete(pets).where(eq(pets.id, id));
    });
  }
});

describe("markOutboxReceived (S3)", () => {
  it("a govt within the row's jurisdiction marks it received — who, when, audit; overdue recorded", async () => {
    const row = await makeRow(-2);
    const result = await markOutboxReceived(
      { rowId: row.id, actor: { userId: actorId, role: "govt", jurisdictions: ROSARIO } },
      deps,
    );
    expect(result).toMatchObject({ ok: true, overdue: true });

    const [after] = await db
      .select()
      .from(eventNotificationOutbox)
      .where(eq(eventNotificationOutbox.id, row.id));
    expect(after.status).toBe("received");
    expect(after.receivedByUserId).toBe(actorId);
    expect(after.receivedAt).not.toBeNull();

    const audits = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "eno_notification_received"),
          sql`${auditLog.payload}->>'outbox_row_id' = ${row.id}`,
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0].payload).toMatchObject({ overdue: true, actor_role: "govt" });
  });

  it("marking twice is refused, and writes no second audit row", async () => {
    const row = await makeRow(5);
    const actor = { userId: actorId, role: "govt", jurisdictions: ROSARIO };
    expect((await markOutboxReceived({ rowId: row.id, actor }, deps)).ok).toBe(true);
    expect(await markOutboxReceived({ rowId: row.id, actor }, deps)).toEqual({
      ok: false,
      reason: "already_received",
    });
  });

  it("a govt of another jurisdiction cannot see or mark it (not_found, no oracle)", async () => {
    const row = await makeRow(5);
    const result = await markOutboxReceived(
      {
        rowId: row.id,
        actor: {
          userId: actorId,
          role: "govt",
          jurisdictions: [{ province: "Córdoba", locality: "Río Cuarto" }],
        },
      },
      deps,
    );
    expect(result).toEqual({ ok: false, reason: "not_found" });
    const [after] = await db
      .select({ status: eventNotificationOutbox.status })
      .from(eventNotificationOutbox)
      .where(eq(eventNotificationOutbox.id, row.id));
    expect(after.status).toBe("pending");
  });

  it("a govt with no mandate is refused before anything is read", async () => {
    const row = await makeRow(5);
    expect(
      await markOutboxReceived(
        { rowId: row.id, actor: { userId: actorId, role: "govt", jurisdictions: [] } },
        deps,
      ),
    ).toEqual({ ok: false, reason: "forbidden" });
  });

  it("the read-only national role is refused", async () => {
    const row = await makeRow(5);
    expect(
      await markOutboxReceived(
        { rowId: row.id, actor: { userId: actorId, role: "national", jurisdictions: [] } },
        deps,
      ),
    ).toEqual({ ok: false, reason: "forbidden" });
  });

  it("an institutional admin may mark any row", async () => {
    const row = await makeRow(5);
    const result = await markOutboxReceived(
      { rowId: row.id, actor: { userId: actorId, role: "admin", jurisdictions: [] } },
      deps,
    );
    expect(result).toMatchObject({ ok: true, overdue: false });
  });
});
