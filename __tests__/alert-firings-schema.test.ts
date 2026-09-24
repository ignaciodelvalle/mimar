// __tests__/alert-firings-schema.test.ts — K0 additive smoke test (migration 0111).
//
// Live integration test against the local Postgres stack. Verifies the new
// alert_firings table exists with its FKs, default status, CHECK constraints,
// and a basic insert/select round-trip. Additive only — does not touch any
// existing table.
//
// Requires: local Supabase stack running + migration 0111 applied.

import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  type AlertFiringStatus,
  type AlertMetricKey,
  type NewAlertFiring,
  alertFirings,
  db,
} from "@/db";
import { expectDbError } from "./_helpers/expect-db-error";

const insertedIds: string[] = [];

async function insertFiring(overrides: Partial<NewAlertFiring> = {}): Promise<string> {
  const [row] = await db
    .insert(alertFirings)
    .values({
      metricKey: "active_zoonosis",
      direction: "above",
      threshold: "10",
      observedValue: "17",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
      ...overrides,
    })
    .returning();
  insertedIds.push(row.id);
  return row.id;
}

afterEach(async () => {
  if (insertedIds.length > 0) {
    await db.delete(alertFirings).where(inArray(alertFirings.id, insertedIds));
    insertedIds.length = 0;
  }
});

describe("alert_firings — K0 schema smoke (migration 0111)", () => {
  it("the table exists in the public schema", async () => {
    const rows = (await db.execute(
      sql`select to_regclass('public.alert_firings') as reg`,
    )) as unknown as Array<{ reg: string | null }>;
    expect(rows[0]?.reg).toBe("alert_firings");
  });

  it("inserts a row and defaults status to 'disparada'", async () => {
    const id = await insertFiring();
    const [row] = await db.select().from(alertFirings).where(eq(alertFirings.id, id));
    expect(row).toBeDefined();
    expect(row.status).toBe("disparada");
    expect(row.metricKey).toBe("active_zoonosis");
    expect(Number(row.observedValue)).toBe(17);
    expect(row.firedAt).toBeInstanceOf(Date);
    // Lifecycle columns start null.
    expect(row.acknowledgedAt).toBeNull();
    expect(row.investigationCode).toBeNull();
    expect(row.resolvedAt).toBeNull();
  });

  it("allows a null subscription_id (firing survives subscription deletion)", async () => {
    const id = await insertFiring({ subscriptionId: null });
    const [row] = await db
      .select({ subscriptionId: alertFirings.subscriptionId })
      .from(alertFirings)
      .where(eq(alertFirings.id, id));
    expect(row.subscriptionId).toBeNull();
  });

  it("rejects an unknown status via the CHECK constraint", async () => {
    await expectDbError(
      db
        .insert(alertFirings)
        .values({
          metricKey: "active_zoonosis",
          direction: "above",
          threshold: "10",
          observedValue: "17",
          // Deliberately invalid runtime value to exercise the DB CHECK.
          status: "bogus" as unknown as AlertFiringStatus,
        })
        .returning(),
      { code: "23514", constraint: /alert_firings_status_valid/ },
    );
  });

  it("rejects an unknown metric_key via the CHECK constraint", async () => {
    await expectDbError(
      db
        .insert(alertFirings)
        .values({
          // Deliberately invalid runtime value to exercise the DB CHECK.
          metricKey: "not_a_metric" as unknown as AlertMetricKey,
          direction: "above",
          threshold: "10",
          observedValue: "17",
        })
        .returning(),
      { code: "23514", constraint: /alert_firings_metric_key_valid/ },
    );
  });

  it("rejects a subscription_id that does not exist (FK constraint)", async () => {
    await expectDbError(
      db
        .insert(alertFirings)
        .values({
          subscriptionId: "00000000-0000-0000-0000-000000000000",
          metricKey: "active_zoonosis",
          direction: "above",
          threshold: "10",
          observedValue: "17",
        })
        .returning(),
      { code: "23503" },
    );
  });
});
