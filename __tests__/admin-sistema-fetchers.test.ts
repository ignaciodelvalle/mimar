// /admin/sistema crash canary — clickthrough audit 2026-07-03 (digest
// 1282362471, confirmed by two independent browser passes).
//
// The page's data fetchers all resolved, but the RENDER crashed:
// fetchGovtActivity declared lastActionAt as Date while the raw-sql
// MAX() aggregate arrives as a string at runtime, and
// sortGovtActivityByActivity called .getTime() on it. A fetch-only test
// cannot catch that class, so this canary runs the page's exact data path
// INCLUDING the sort, and pins the runtime shape of the declared types.

import { inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { cronRuns, db } from "@/db";
import {
  STUCK_RUNNING_MS,
  fetchCronHealth,
  fetchCronRuns,
  fetchDecisionsMetrics,
  fetchFailedCronNames,
  fetchGovtActivity,
  fetchQueueHealth,
  fetchUserMetrics,
  sortGovtActivityByActivity,
} from "@/lib/analytics/admin-metrics";
import { fetchEnoSla } from "@/lib/analytics/surveillance-metrics";
import { buildProjectionContext } from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";

describe("/admin/sistema data path", () => {
  it("all six page fetchers resolve", async () => {
    const adminCtx = buildProjectionContext({ role: "admin" }, [], windows.trailing12m());
    const results = await Promise.allSettled([
      fetchUserMetrics(),
      fetchQueueHealth(),
      fetchDecisionsMetrics(),
      fetchGovtActivity(),
      fetchCronRuns(),
      fetchEnoSla(adminCtx),
    ]);
    const names = [
      "fetchUserMetrics",
      "fetchQueueHealth",
      "fetchDecisionsMetrics",
      "fetchGovtActivity",
      "fetchCronRuns",
      "fetchEnoSla",
    ];
    const failures = results
      .map((r, i) => ({ name: names[i], r }))
      .filter((x) => x.r.status === "rejected")
      .map((x) => `${x.name}: ${(x.r as PromiseRejectedResult).reason}`);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("govt activity rows carry REAL Dates and survive the page's sort", async () => {
    const rows = await fetchGovtActivity();
    for (const row of rows) {
      expect(
        row.lastActionAt === null || row.lastActionAt instanceof Date,
        `${row.displayName}: lastActionAt must be Date|null, got ${typeof row.lastActionAt}`,
      ).toBe(true);
    }
    // The exact call that crashed the page — must not throw.
    expect(() => sortGovtActivityByActivity(rows)).not.toThrow();
  });

  // Crons-down banner data path (operator-trust T3). The DISTINCT ON query runs
  // against the shared local DB; pin that it resolves to a string[] whose
  // members are a subset of the cron names fetchCronRuns reports as failed.
  it("fetchFailedCronNames returns the latest-failed cron names (stuck runs included, C-b)", async () => {
    const [failed, all] = await Promise.all([fetchFailedCronNames(), fetchCronRuns()]);
    expect(Array.isArray(failed)).toBe(true);
    for (const name of failed) {
      expect(typeof name).toBe("string");
    }
    // C-b: the banner counts BOTH latest-failed and stuck-at-running rows.
    const downFromRuns = new Set(
      all
        .filter(
          (c) =>
            c.lastStatus === "failed" ||
            (c.lastStatus === "running" &&
              c.lastRunAt !== null &&
              Date.now() - c.lastRunAt.getTime() > STUCK_RUNNING_MS),
        )
        .map((c) => c.cronName),
    );
    expect(new Set(failed)).toEqual(downFromRuns);
  });

  // C-b: a run orphaned at 'running' (hard kill at maxDuration) used to render
  // a green "Saludable" pill for up to 26 hours — the staleness window was the
  // only thing that eventually caught it. Seed one stuck and one fresh running
  // row and pin the split verdict.
  it("fetchCronHealth: stuck 'running' is unhealthy; a fresh 'running' is not (C-b)", async () => {
    const stuckStart = new Date(Date.now() - STUCK_RUNNING_MS - 5 * 60 * 1000);
    const freshStart = new Date(Date.now() - 30 * 1000);
    const [stuckRow] = await db
      .insert(cronRuns)
      .values({ cronName: "vaccine_due", status: "running", startedAt: stuckStart })
      .returning({ id: cronRuns.id });
    const [freshRow] = await db
      .insert(cronRuns)
      .values({ cronName: "purge_scan_events", status: "running", startedAt: freshStart })
      .returning({ id: cronRuns.id });

    try {
      const rows = await fetchCronHealth();
      const stuck = rows.find((r) => r.cronName === "vaccine_due");
      const fresh = rows.find((r) => r.cronName === "purge_scan_events");
      expect(stuck?.healthy).toBe(false);
      expect(stuck?.reason).toBe("stuck_running");
      // A job genuinely mid-flight must NOT false-positive.
      expect(fresh?.reason).not.toBe("stuck_running");
    } finally {
      await db.delete(cronRuns).where(inArray(cronRuns.id, [stuckRow.id, freshRow.id]));
    }
  });
});
