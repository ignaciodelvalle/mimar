// Integration tests for fetchPetStatusDrift (lib/analytics/admin-metrics.ts)
// — the /admin/sistema drift-card loader (projection-cron audit 2026-07-03 B3).
//
// The reconcile-pet-status cron records drift in cronRuns.details and the
// cron-health meta-cron flags divergent > 0 as reason='drift'; this loader is
// the read side that makes both visible in the admin UI. Fixtures seed
// cron_runs rows directly (the cron routes themselves are exercised by their
// own route tests) and are timestamped in the future so they are guaranteed
// to be the "latest" run even when local dev data exists.

import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cronRuns, db } from "@/db";
import { fetchPetStatusDrift } from "@/lib/analytics/admin-metrics";

const insertedIds: string[] = [];

// Slightly in the future so these rows outrank any real local cron runs.
const RECONCILE_AT = new Date(Date.now() + 60_000);
const HEALTH_AT = new Date(Date.now() + 61_000);

beforeAll(async () => {
  const rows = await db
    .insert(cronRuns)
    .values([
      {
        cronName: "reconcile_pet_status",
        startedAt: RECONCILE_AT,
        finishedAt: RECONCILE_AT,
        status: "ok",
        itemsProcessed: 42,
        details: {
          scanned: 42,
          divergent: 3,
          earlyStop: false,
          sample: [
            {
              petId: "p1",
              publicToken: "AR-DRIFT-01",
              cached: "active",
              derived: "deceased",
              driftedColumns: ["status", "deceasedAt"],
            },
            {
              petId: "p2",
              publicToken: "AR-DRIFT-02",
              cached: "lost",
              derived: "active",
              driftedColumns: ["status"],
            },
            // Non-status divergence: status matches (both "active") but the pet
            // is genuinely divergent on estimatedWeightKg. Before the fix the
            // card rendered this as "cache active → log active", which looked
            // like a mislabelled non-divergent row. driftedColumns makes it honest.
            {
              petId: "p3",
              publicToken: "AR-DRIFT-03",
              cached: "active",
              derived: "active",
              driftedColumns: ["estimatedWeightKg"],
            },
          ],
        },
      },
      {
        cronName: "cron_health",
        startedAt: HEALTH_AT,
        finishedAt: HEALTH_AT,
        status: "ok",
        itemsProcessed: 2,
        details: {
          checked: 2,
          all: [
            { cronName: "reconcile_pet_status", healthy: false, reason: "drift" },
            { cronName: "vaccine_due", healthy: true, reason: "ok" },
          ],
        },
      },
    ])
    .returning({ id: cronRuns.id });
  for (const r of rows) insertedIds.push(r.id);
});

afterAll(async () => {
  await db.delete(cronRuns).where(inArray(cronRuns.id, insertedIds));
});

describe("fetchPetStatusDrift", () => {
  it("surfaces the latest reconcile run: scanned, divergent count and sample tokens", async () => {
    const drift = await fetchPetStatusDrift();
    expect(drift.reconcile).not.toBeNull();
    expect(drift.reconcile?.scanned).toBe(42);
    expect(drift.reconcile?.divergent).toBe(3);
    expect(drift.reconcile?.earlyStop).toBe(false);
    expect(drift.reconcile?.sample.map((s) => s.publicToken)).toEqual([
      "AR-DRIFT-01",
      "AR-DRIFT-02",
      "AR-DRIFT-03",
    ]);
    expect(drift.reconcile?.sample[0]?.cached).toBe("active");
    expect(drift.reconcile?.sample[0]?.derived).toBe("deceased");
  });

  it("surfaces driftedColumns so a non-status divergence is not a mislabelled identical pair", async () => {
    const drift = await fetchPetStatusDrift();
    const sample = drift.reconcile?.sample ?? [];
    expect(sample[0]?.driftedColumns).toEqual(["status", "deceasedAt"]);
    // The pet whose status matches (active→active) is still honestly divergent:
    // its driftedColumns names the field that actually diverged.
    const nonStatus = sample.find((s) => s.publicToken === "AR-DRIFT-03");
    expect(nonStatus?.cached).toBe("active");
    expect(nonStatus?.derived).toBe("active");
    expect(nonStatus?.driftedColumns).toEqual(["estimatedWeightKg"]);
  });

  it("surfaces the meta-cron semantic verdict for the reconcile cron", async () => {
    const drift = await fetchPetStatusDrift();
    expect(drift.metaCheck).not.toBeNull();
    expect(drift.metaCheck?.healthy).toBe(false);
    expect(drift.metaCheck?.reason).toBe("drift");
  });

  it("a newer clean run supersedes the divergent one", async () => {
    const newerAt = new Date(Date.now() + 120_000);
    const [row] = await db
      .insert(cronRuns)
      .values({
        cronName: "reconcile_pet_status",
        startedAt: newerAt,
        finishedAt: newerAt,
        status: "ok",
        itemsProcessed: 50,
        details: { scanned: 50, divergent: 0, earlyStop: false },
      })
      .returning({ id: cronRuns.id });
    insertedIds.push(row.id);

    const drift = await fetchPetStatusDrift();
    expect(drift.reconcile?.divergent).toBe(0);
    expect(drift.reconcile?.sample).toEqual([]);
  });
});
