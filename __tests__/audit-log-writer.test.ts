// @vitest-environment node
//
// writeAuditLog — the single write path for audit_log (lib/infra/audit-log.ts).
//
// WHAT THESE TESTS DEFEND
// ---------------------------------------------------------------------------
// The invariant is "every mutating operator/admin action leaves an audit row,
// in the SAME TRANSACTION as the mutation, recording previous and new state".
// Before 2026-08-16 nothing in this repo asserted any part of it. The two
// load-bearing tests here are:
//
//   · "commits with the mutation"  — the row and the mutation land together;
//   · "a rolled-back transaction leaves NO audit row" — THE point of the
//     executor-first signature. If writeAuditLog resolved `db` internally
//     instead of using the executor it was handed, this test is the only thing
//     in the suite that would notice: the row would autocommit and survive a
//     rollback, and the trail would claim a mutation that never happened.
//
// The rest pin the payload contract (before/after ↦ before_values/after_values)
// and the "omit ⇒ byte-identical to a hand-written insert" promise that lets
// the ~60 unconverted call sites migrate one at a time.

import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { auditLog, db, profiles } from "@/db";
import { buildAuditLogValues, writeAuditLog } from "@/lib/infra/audit-log";
import { withAuditMutationOverride } from "./_helpers/db-overrides";
import { expectDbError } from "./_helpers/expect-db-error";

const MARKER = "audit-log-writer-2026-08-16";

/** Any real profile id — audit_log.actor_user_id is a FK. */
async function anyActorId(): Promise<string> {
  const [row] = await db.select({ id: profiles.id }).from(profiles).limit(1);
  if (!row) throw new Error("no profiles row — run `pnpm db:bootstrap` before this suite");
  return row.id;
}

async function markedRows(): Promise<Array<{ id: string; payload: unknown; action: string }>> {
  return db
    .select({ id: auditLog.id, payload: auditLog.payload, action: auditLog.action })
    .from(auditLog)
    .where(sql`${auditLog.payload}->>'test_marker' = ${MARKER}`);
}

afterAll(async () => {
  await withAuditMutationOverride(async (tx) => {
    await tx.execute(sql`delete from audit_log where payload->>'test_marker' = ${MARKER}`);
  });
});

describe("buildAuditLogValues — payload contract (pure)", () => {
  it("folds before/after into before_values/after_values", () => {
    const values = buildAuditLogValues({
      action: "profile_self_updated",
      actorUserId: "a",
      payload: { changed_fields: ["phone"] },
      before: { phone: null },
      after: { phone: "+54 11" },
    });
    expect(values.payload).toEqual({
      changed_fields: ["phone"],
      before_values: { phone: null },
      after_values: { phone: "+54 11" },
    });
  });

  it("distinguishes 'not captured' (omitted) from 'no prior state' (null)", () => {
    const omitted = buildAuditLogValues({ action: "request_viewed" });
    expect(omitted.payload).not.toHaveProperty("before_values");
    expect(omitted.payload).not.toHaveProperty("after_values");

    const explicitNull = buildAuditLogValues({ action: "govt_locality_assigned", before: null });
    expect(explicitNull.payload).toHaveProperty("before_values", null);
  });

  it("defaults every optional FK column to null (a hand-written insert's shape)", () => {
    expect(buildAuditLogValues({ action: "request_viewed" })).toEqual({
      actorUserId: null,
      action: "request_viewed",
      approvalRequestId: null,
      targetUserId: null,
      targetOrganizationId: null,
      targetGovtAssignmentId: null,
      payload: {},
    });
  });
});

describe("writeAuditLog — transactional composition", () => {
  it("writes the row it claims, inside a transaction, and returns its id", async () => {
    const actorUserId = await anyActorId();

    const written = await db.transaction(async (tx) =>
      writeAuditLog(tx, {
        action: "profile_self_updated",
        actorUserId,
        targetUserId: actorUserId,
        payload: { test_marker: MARKER, changed_fields: ["displayName"] },
        before: { displayName: "antes" },
        after: { displayName: "despues" },
      }),
    );

    const [row] = await db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        actorUserId: auditLog.actorUserId,
        targetUserId: auditLog.targetUserId,
        payload: auditLog.payload,
      })
      .from(auditLog)
      .where(eq(auditLog.id, written.id));

    expect(row).toBeDefined();
    expect(row.action).toBe("profile_self_updated");
    expect(row.actorUserId).toBe(actorUserId);
    expect(row.targetUserId).toBe(actorUserId);
    expect(row.payload).toMatchObject({
      test_marker: MARKER,
      changed_fields: ["displayName"],
      before_values: { displayName: "antes" },
      after_values: { displayName: "despues" },
    });
  });

  it("a ROLLED-BACK transaction leaves NO audit row", async () => {
    const actorUserId = await anyActorId();
    const before = await markedRows();

    // Same shape as a real use-case: mutate, audit, then fail. Nothing may
    // survive — least of all a record asserting the mutation happened.
    await expect(
      db.transaction(async (tx) => {
        await tx
          .update(profiles)
          .set({ updatedAt: new Date() })
          .where(eq(profiles.id, actorUserId));
        await writeAuditLog(tx, {
          action: "profile_self_updated",
          actorUserId,
          payload: { test_marker: MARKER, doomed: true },
        });
        throw new Error("boom — simulated failure after the audit write");
      }),
    ).rejects.toThrow("boom");

    const after = await markedRows();
    expect(after).toHaveLength(before.length);
    expect(after.some((r) => (r.payload as { doomed?: boolean }).doomed === true)).toBe(false);
  });

  it("accepts the pooled `db` handle too (audit-only facts with no mutation)", async () => {
    const actorUserId = await anyActorId();
    const written = await writeAuditLog(db, {
      action: "request_viewed",
      actorUserId,
      payload: { test_marker: MARKER },
    });
    const [row] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.id, written.id));
    expect(row).toBeDefined();
  });

  it("does NOT swallow a rejected write — an unknown action surfaces", async () => {
    const actorUserId = await anyActorId();
    await expectDbError(
      writeAuditLog(db, {
        // Deliberate escape past the TS catalog; migration 0184's CHECK is what
        // stops it. A helper that caught this would hide the very failure the
        // constraint exists to make loud.
        action: "no_such_action_2026_08_16" as never,
        actorUserId,
        payload: { test_marker: MARKER },
      }),
      { code: "23514", constraint: "audit_log_action_valid" },
    );
  });
});
