// Meta-cron — detects stalled or failed crons before they become silent incidents.
//
// GET /api/cron/cron-health
//
// Authentication: `Authorization: Bearer <CRON_SECRET>` (Vercel Cron contract)
// or legacy `x-cron-secret: <CRON_SECRET>` — see lib/cron-auth.ts.
//
// Background (finding R3 in the pre-mortem):
//   If a cron stalls or fails, nobody is alerted. This meta-cron queries the
//   cronRuns table to detect unhealthy crons and records the health summary in
//   its own cronRuns row. Console.warn fires on any unhealthy cron so it
//   surfaces in Vercel function logs.
//
// Strategy:
//   - Each cron has a max-staleness derived from its schedule (daily → 26h).
//   - A cron is UNHEALTHY if: never ran, last run older than max-staleness,
//     or last run status='failed'.
//   - The health summary (healthy/unhealthy lists + per-cron details) is
//     stored in cronRuns.details for the /admin/sistema surface.
//   - Returns: { ok, checked, unhealthy: [...] }
//
// Schedule: added to vercel.json — runs daily at 10:00 UTC.

import { type NextRequest, NextResponse } from "next/server";

import { and, desc, eq, ne } from "drizzle-orm";

import { analyticsDb, cronRuns, db } from "@/db";
import { STUCK_RUNNING_MS } from "@/lib/analytics/admin-metrics";
import { authorizeCronRequest } from "@/lib/domain/cron-auth";
import { sendCronAlert } from "@/lib/infra/cron-alert";
import { CRON_REGISTRY, cronScheduleFor } from "@/lib/infra/cron-registry";

export const dynamic = "force-dynamic";

const CRON_NAME = "cron_health";

// The fleet registry moved to lib/infra/cron-registry.ts (SSOT — projection-
// cron audit 2026-07-03 B2): it had drifted from the routes' CRON_NAME
// constants here, so healthy crons were reported "never_ran" while their
// telemetry accumulated under an unregistered name. The parity fitness test
// (__tests__/cron-registry-parity.test.ts) keeps vercel.json ⇄ registry ⇄
// route constants in lock-step. This meta-cron checks itself too: its own
// PREVIOUS run is subject to the same staleness and last-failed rules. The
// "previous" is load-bearing (C04-3, 2026-09): the lookup used to take the
// latest cron_health row, which is always the 'running' row this very request
// inserted a moment earlier — so the self-check read "ok" every time, and a
// meta-cron that had failed or skipped for days could never report itself.
// The lookup now excludes the current run id.

type CronHealthResult = {
  cronName: string;
  schedule: string;
  healthy: boolean;
  reason: "ok" | "never_ran" | "stale" | "last_failed" | "drift" | "stuck_running";
  lastRunAt: Date | null;
  lastStatus: string | null;
  lastItemsProcessed: number | null;
  ageMs: number | null;
};

export async function GET(req: NextRequest): Promise<NextResponse> {
  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------
  const authError = authorizeCronRequest(req);
  if (authError) {
    return NextResponse.json({ ok: false, error: authError.error }, { status: authError.status });
  }

  const start = Date.now();

  // ---------------------------------------------------------------------------
  // Start cronRuns telemetry row
  // ---------------------------------------------------------------------------
  const [run] = await db
    .insert(cronRuns)
    .values({ cronName: CRON_NAME, status: "running" })
    .returning();

  let cronStatus: "ok" | "failed" = "ok";
  const results: CronHealthResult[] = [];

  try {
    // -------------------------------------------------------------------------
    // Check each cron: fetch its latest run and evaluate staleness/status.
    // -------------------------------------------------------------------------
    const now = Date.now();

    for (const entry of CRON_REGISTRY) {
      // POOL: the per-cron read loop runs ~22 sequential SELECTs. On the OLTP
      // transaction pooler (6543) that many-statement shape hits supavisor's
      // measured >100x pathology (db/index.ts) — the loop stalls past the
      // function budget and the meta-cron throws → 500 → the fleet-caído banner.
      // Route the READS through the session pooler (analyticsDb); the telemetry
      // writes (insert/update below) stay on the OLTP `db`. Each SELECT is a fast
      // indexed single-row lookup, well within analyticsDb's 15s backstop.
      const [latest] = await analyticsDb
        .select({
          startedAt: cronRuns.startedAt,
          finishedAt: cronRuns.finishedAt,
          status: cronRuns.status,
          itemsProcessed: cronRuns.itemsProcessed,
          details: cronRuns.details,
        })
        .from(cronRuns)
        // `ne(id, run.id)`: never evaluate the row this request just inserted
        // (only ever matches for entry.cronName === CRON_NAME; see the header).
        .where(and(eq(cronRuns.cronName, entry.cronName), ne(cronRuns.id, run.id)))
        .orderBy(desc(cronRuns.startedAt))
        .limit(1);

      if (!latest) {
        results.push({
          cronName: entry.cronName,
          schedule: cronScheduleFor(entry),
          healthy: false,
          reason: "never_ran",
          lastRunAt: null,
          lastStatus: null,
          lastItemsProcessed: null,
          ageMs: null,
        });
        continue;
      }

      const ageMs = now - latest.startedAt.getTime();

      if (latest.status === "failed") {
        results.push({
          cronName: entry.cronName,
          schedule: cronScheduleFor(entry),
          healthy: false,
          reason: "last_failed",
          lastRunAt: latest.startedAt,
          lastStatus: latest.status,
          lastItemsProcessed: latest.itemsProcessed,
          ageMs,
        });
        continue;
      }

      // C-b: a run stuck at 'running' past the orphan threshold pages — the
      // ONLY thing that used to catch a hard-killed run was the staleness
      // window (up to 26h of silence). Mirrors fetchCronHealth's branch so the
      // human is paged with the same verdict the UI shows.
      if (latest.status === "running" && ageMs > STUCK_RUNNING_MS) {
        results.push({
          cronName: entry.cronName,
          schedule: cronScheduleFor(entry),
          healthy: false,
          reason: "stuck_running",
          lastRunAt: latest.startedAt,
          lastStatus: latest.status,
          lastItemsProcessed: latest.itemsProcessed,
          ageMs,
        });
        continue;
      }

      if (ageMs > entry.maxStalenessMs) {
        results.push({
          cronName: entry.cronName,
          schedule: cronScheduleFor(entry),
          healthy: false,
          reason: "stale",
          lastRunAt: latest.startedAt,
          lastStatus: latest.status,
          lastItemsProcessed: latest.itemsProcessed,
          ageMs,
        });
        continue;
      }

      // Drift gate (projection-cron audit 2026-07-03 B3): reconcile-pet-status
      // DETECTED cache↔events divergence and logged it, but a clean exit code
      // meant nobody was alerted. divergent > 0 is an unhealthy state — the
      // pet-status cache disagrees with the event log somewhere.
      if (entry.cronName === "reconcile_pet_status") {
        const divergent = Number(
          (latest.details as Record<string, unknown> | null)?.divergent ?? 0,
        );
        if (Number.isFinite(divergent) && divergent > 0) {
          results.push({
            cronName: entry.cronName,
            schedule: cronScheduleFor(entry),
            healthy: false,
            reason: "drift",
            lastRunAt: latest.startedAt,
            lastStatus: latest.status,
            lastItemsProcessed: latest.itemsProcessed,
            ageMs,
          });
          continue;
        }
      }

      results.push({
        cronName: entry.cronName,
        schedule: cronScheduleFor(entry),
        healthy: true,
        reason: "ok",
        lastRunAt: latest.startedAt,
        lastStatus: latest.status,
        lastItemsProcessed: latest.itemsProcessed,
        ageMs,
      });
    }

    const unhealthy = results.filter((r) => !r.healthy);
    const healthy = results.filter((r) => r.healthy);

    if (unhealthy.length > 0) {
      // An unhealthy fleet is itself a failure: mark this meta-run failed so it
      // returns HTTP 500 (review 23 item 6) instead of a green ok:true that
      // hides a stalled/failed cron. Previously this only console.warn'd.
      cronStatus = "failed";
      for (const u of unhealthy) {
        console.warn(
          `[cron/cron-health] UNHEALTHY cron detected — name=${u.cronName} reason=${u.reason} lastRunAt=${u.lastRunAt?.toISOString() ?? "never"} lastStatus=${u.lastStatus ?? "none"}`,
        );
      }
      // Page a human (review 23 item 2 / Cursor #3). Best-effort; no-op when
      // CRON_ALERT_WEBHOOK is unset.
      await sendCronAlert({
        job: CRON_NAME,
        severity: "critical",
        error: `${unhealthy.length} unhealthy cron(s)`,
        details: {
          unhealthy: unhealthy.map((u) => ({
            cronName: u.cronName,
            reason: u.reason,
            lastRunAt: u.lastRunAt?.toISOString() ?? null,
            lastStatus: u.lastStatus,
          })),
        },
      });
    } else {
      console.info(
        `[cron/cron-health] all crons healthy — checked=${results.length} healthy=${healthy.length}`,
      );
    }

    const durationMs = Date.now() - start;

    // -------------------------------------------------------------------------
    // Finalize cronRuns row
    // -------------------------------------------------------------------------
    await db
      .update(cronRuns)
      .set({
        status: cronStatus,
        finishedAt: new Date(),
        itemsProcessed: results.length,
        details: {
          checked: results.length,
          healthyCount: healthy.length,
          unhealthyCount: unhealthy.length,
          unhealthy: unhealthy.map((u) => ({
            cronName: u.cronName,
            reason: u.reason,
            lastRunAt: u.lastRunAt?.toISOString() ?? null,
            lastStatus: u.lastStatus,
            ageMs: u.ageMs,
          })),
          all: results.map((r) => ({
            cronName: r.cronName,
            schedule: r.schedule,
            healthy: r.healthy,
            reason: r.reason,
            lastRunAt: r.lastRunAt?.toISOString() ?? null,
            lastStatus: r.lastStatus,
            lastItemsProcessed: r.lastItemsProcessed,
            ageMs: r.ageMs,
          })),
          durationMs,
        },
      })
      .where(eq(cronRuns.id, run.id));

    return NextResponse.json(
      {
        ok: cronStatus === "ok",
        checked: results.length,
        unhealthy: unhealthy.map((u) => ({
          cronName: u.cronName,
          reason: u.reason,
          lastRunAt: u.lastRunAt?.toISOString() ?? null,
          lastStatus: u.lastStatus,
        })),
      },
      { status: cronStatus === "ok" ? 200 : 500 },
    );
  } catch (err) {
    cronStatus = "failed";
    console.error("[cron/cron-health] fatal error:", err);

    await db
      .update(cronRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        details: {
          error: err instanceof Error ? err.message : String(err),
        },
      })
      .where(eq(cronRuns.id, run.id));

    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
