// @vitest-environment node
//
// Integration test for the case_events append-only trigger — the sibling of
// __tests__/pet-events-append-only.test.ts.
//
// WHY A LIVE TEST AND NOT A PARSE OF db/triggers.sql
// ---------------------------------------------------------------------------
// Invariant #2 ("events are append-only; corrections are new events") is
// enforced in exactly one place: the `enforce_case_events_append_only` trigger
// in db/triggers.sql. Every OTHER test in this repo touches that guard from the
// far side — dozens of fixtures call `withMutationOverride` to get PAST it — so
// RELAXING the trigger makes those tests pass more easily. The suite cannot
// notice a weakened guard by watching them.
//
// This file watches the guard itself, against the LIVE database:
//   1. UPDATE of an existing case_events row is REFUSED;
//   2. DELETE of that row is REFUSED;
//   3. the accountable override still WORKS.
//
// Assertion 3 is not decoration. Without it the file would still pass on a
// database where the table is empty, the fixture never landed, or the
// connection is dead — a green that proves nothing. It is the non-vacuity
// witness for 1 and 2.
//
// It also catches the failure mode recorded in scripts/check-ledger-honesty.ts
// (errata E-3): a trigger that was never APPLIED to this environment. In CI the
// coverage is complete, because `pnpm db:bootstrap` re-applies db/triggers.sql
// onto the ephemeral stack before this suite runs — so a relaxed trigger.sql
// becomes a relaxed live database, and these assertions go red. Locally,
// triggers.sql is hand-applied (see its header), so an edit to that file only
// reaches this test after a bootstrap; `pnpm check:function-parity` is the
// check that compares file to live body without one.

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditLog, caseEvents, cases, db } from "@/db";
import { withMutationOverride } from "./_helpers/db-overrides";
import { expectDbError } from "./_helpers/expect-db-error";

// Fixture marker — cleanup is scoped to this prefix so a parallel suite (or a
// dev database full of real cases) is never touched.
const CODE = "APPEND-ONLY-CASE-EVENTS";
// One of the 24 canonical province names (migration 0055's check constraint).
const PROVINCE = "Tierra del Fuego";

let caseId: string;
let eventId: string;

async function cleanup(): Promise<void> {
  // Deleting the case cascades into case_events, which the append-only trigger
  // blocks — so teardown is an explicitly opted-in, audited override, exactly
  // like the pet_events fixture.
  await withMutationOverride(async (tx) => {
    await tx.delete(cases).where(eq(cases.publicCode, CODE));
  });
}

beforeAll(async () => {
  await cleanup();

  const [row] = await db
    .insert(cases)
    .values({
      publicCode: CODE,
      caseKind: "welfare_denuncia",
      primarySubjectKind: "general",
      status: "open",
      jurisdictionProvince: PROVINCE,
      jurisdictionLocality: "APPEND-ONLY-CASE-EVENTS-FIXTURE",
    })
    .returning({ id: cases.id });
  caseId = row.id;

  const [event] = await db
    .insert(caseEvents)
    .values({
      caseId,
      entryType: "note",
      occurredAt: new Date(),
      payload: { body: "smoke probe for the case_events append-only trigger" },
    })
    .returning({ id: caseEvents.id });
  eventId = event.id;
});

afterAll(cleanup);

describe("case_events append-only trigger", () => {
  it("rejects db.update(caseEvents) from a normal Drizzle path", async () => {
    // The trigger raises with errcode restrict_violation (23001) and a message
    // mentioning "append-only"; expectDbError matches it on the .cause chain.
    await expectDbError(
      db.update(caseEvents).set({ notes: "should not stick" }).where(eq(caseEvents.id, eventId)),
      { code: "23001", constraint: /case_events is append-only/i },
    );
  });

  it("rejects db.delete(caseEvents) from a normal Drizzle path", async () => {
    await expectDbError(db.delete(caseEvents).where(eq(caseEvents.id, eventId)), {
      code: "23001",
      constraint: /case_events is append-only/i,
    });
  });

  it("the event row is unchanged after the rejected mutations", async () => {
    const [row] = await db.select().from(caseEvents).where(eq(caseEvents.id, eventId));
    expect(row).toBeDefined();
    expect(row.notes).toBe(null);
  });

  it("refuses the override when the bypass flag has NO accountable actor", async () => {
    // The hatch without an actor is the one unaccountable mutation class the
    // trigger exists to refuse — assert the specific message, not just "threw".
    await expectDbError(
      db.transaction(async (tx) => {
        await tx.execute(sql`set local app.allow_event_mutation = 'true'`);
        await tx
          .update(caseEvents)
          .set({ notes: "unaccountable" })
          .where(eq(caseEvents.id, eventId));
      }),
      { code: "23001", constraint: /allow_event_mutation_actor/ },
    );
  });

  it("allows mutation when the accountable escape hatch is set, and self-logs it", async () => {
    // NON-VACUITY WITNESS: if this passes, the database is reachable, the
    // fixture row exists, and the two rejections above were the trigger
    // refusing — not an unreachable DB or a missing row.
    await withMutationOverride(async (tx) => {
      await tx
        .update(caseEvents)
        .set({ notes: "audited correction via escape hatch" })
        .where(eq(caseEvents.id, eventId));
    });

    const [row] = await db.select().from(caseEvents).where(eq(caseEvents.id, eventId));
    expect(row.notes).toBe("audited correction via escape hatch");

    // …and the override left its own accountable trace.
    const [override] = await db
      .select({ actorUserId: auditLog.actorUserId, payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "case_events_mutation_override"),
          sql`${auditLog.payload}->>'case_event_id' = ${eventId}`,
        ),
      )
      .limit(1);
    expect(override).toBeDefined();
    expect(override.actorUserId).not.toBeNull();
    expect((override.payload as { operation?: string }).operation).toBe("UPDATE");
  });

  it("blocks mutations again once the tx holding the escape hatch ends", async () => {
    // SET LOCAL is transaction-scoped: proves the hatch cannot leak into the
    // pooled connection and quietly disarm the guard for later callers.
    await expectDbError(
      db
        .update(caseEvents)
        .set({ notes: "should not stick either" })
        .where(eq(caseEvents.id, eventId)),
      { code: "23001", constraint: /case_events is append-only/i },
    );
  });
});
