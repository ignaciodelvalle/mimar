// @vitest-environment node
//
// audit_log append-only hatch — migration 0182 (Lote B2).
//
// What these tests defend:
//
//   1. THE BYPASS WITHOUT AN ACTOR IS REFUSED. Before 0182,
//      app.allow_audit_mutation = 'true' alone let a privileged session
//      UPDATE/DELETE audit rows with zero trace — the one unaccountable
//      override class on this table.
//   2. THE OVERRIDE SELF-LOGS. With both GUCs set, the mutation proceeds AND
//      an audit_log_mutation_override row attributed to the actor is written
//      in the same transaction — mirroring the pet_events/case_events hatch.
//   3. The FK-cascade branch (0085) is untouched: this file does not re-test
//      it (admin-fase-0-schema.test.ts owns that pin).

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { auditLog, db } from "@/db";
import { setAuditMutationGucs, withAuditMutationOverride } from "./_helpers/db-overrides";
import { expectDbError } from "./_helpers/expect-db-error";

const MARKER_PAYLOAD = { test_marker: "audit-log-append-only-0182" };

async function insertProbeRow(): Promise<string> {
  const [row] = await db
    .insert(auditLog)
    .values({
      actorUserId: null,
      action: "request_approved",
      payload: MARKER_PAYLOAD,
    })
    .returning({ id: auditLog.id });
  return row.id;
}

afterAll(async () => {
  // Sweep probe rows AND the override rows the trigger wrote about them.
  await withAuditMutationOverride(async (tx) => {
    await tx.execute(
      sql`delete from audit_log where payload->>'test_marker' = 'audit-log-append-only-0182'`,
    );
    await tx.execute(
      sql`delete from audit_log where action = 'audit_log_mutation_override'
          and performed_at > now() - interval '1 hour'`,
    );
  });
});

describe("audit_log append-only — accountable override (0182)", () => {
  it("refuses UPDATE with the bypass flag but NO actor GUC", async () => {
    const id = await insertProbeRow();
    await expectDbError(
      db.transaction(async (tx) => {
        await tx.execute(sql`set local app.allow_audit_mutation = 'true'`);
        await tx
          .update(auditLog)
          .set({ payload: { ...MARKER_PAYLOAD, tampered: true } })
          .where(eq(auditLog.id, id));
      }),
      { constraint: /allow_audit_mutation_actor/ },
    );
  });

  it("refuses DELETE with the bypass flag but NO actor GUC", async () => {
    const id = await insertProbeRow();
    await expectDbError(
      db.transaction(async (tx) => {
        await tx.execute(sql`set local app.allow_audit_mutation = 'true'`);
        await tx.delete(auditLog).where(eq(auditLog.id, id));
      }),
      { constraint: /allow_audit_mutation_actor/ },
    );
  });

  it("permits the mutation with BOTH GUCs and self-logs the override", async () => {
    const id = await insertProbeRow();
    await db.transaction(async (tx) => {
      await setAuditMutationGucs(tx);
      await tx.delete(auditLog).where(eq(auditLog.id, id));
    });

    // The row is gone…
    const [gone] = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.id, id));
    expect(gone).toBeUndefined();

    // …and the override left its own accountable trace.
    const [override] = await db
      .select({ actorUserId: auditLog.actorUserId, payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "audit_log_mutation_override"),
          sql`${auditLog.payload}->>'audit_log_id' = ${id}`,
        ),
      )
      .limit(1);
    expect(override).toBeDefined();
    expect(override.actorUserId).not.toBeNull();
    expect((override.payload as { operation?: string }).operation).toBe("DELETE");
  });
});
