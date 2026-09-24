// Two telemetry defects in the cron fleet's own bookkeeping (review 2026-09).
//
// C04-3 — cron-health evaluated ITSELF against the 'running' row the same
//   request had just inserted, so its self-check read "ok" on every run: a
//   meta-cron that had failed yesterday could never say so. The route now
//   excludes the current run id from its lookup.
//
// C04-4 — refresh-cube wrote its own cron_runs row by hand: a failed build was
//   recorded but never ALERTED, and a builder THROW left the row 'running'. It
//   now runs inside withCronRun with a `failed` flag.
//
// Both are driven through the real route and the real withCronRun, with only
// the database, the alert webhook and the cube builder replaced. The fake
// analytics reader renders the route's WHERE clause through drizzle's own
// dialect and honours an excluded id — so the test observes what the query
// asks for, not a string in the source.

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SELF_RUN_ID = "11111111-1111-4111-8111-111111111111";
const PREVIOUS_RUN_ID = "22222222-2222-4222-8222-222222222222";

type FakeRow = {
  id: string;
  cronName: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: string;
  itemsProcessed: number | null;
  details: Record<string, unknown>;
};

const dialect = new PgDialect();

/** Every value bound into the WHERE clause the route built. */
function boundParams(cond: SQL): unknown[] {
  return dialect.sqlToQuery(cond).params;
}

function installFakeDb(rows: FakeRow[]) {
  const updates: Record<string, unknown>[] = [];
  vi.doMock("@/db", async () => {
    const schema = await import("@/db/schema");
    return {
      cronRuns: schema.cronRuns,
      db: {
        insert: () => ({ values: () => ({ returning: async () => [{ id: SELF_RUN_ID }] }) }),
        update: () => ({
          set: (v: Record<string, unknown>) => {
            updates.push(v);
            return { where: async () => undefined };
          },
        }),
      },
      analyticsDb: {
        select: () => ({
          from: () => ({
            where: (cond: SQL) => ({
              orderBy: () => ({
                limit: async () => {
                  // The route filters by cron name; an id it also binds is an
                  // id it wants excluded. Latest-first, like the real query.
                  const params = boundParams(cond);
                  const name = params.find((p) => rows.some((r) => r.cronName === p));
                  return rows
                    .filter((r) => r.cronName === name && !params.includes(r.id))
                    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
                    .slice(0, 1);
                },
              }),
            }),
          }),
        }),
      },
    };
  });
  return updates;
}

const sendCronAlert = vi.fn();

beforeEach(() => {
  vi.resetModules();
  sendCronAlert.mockReset();
  vi.doMock("@/lib/infra/cron-alert", () => ({ sendCronAlert }));
  vi.doMock("@/lib/domain/cron-auth", () => ({ authorizeCronRequest: () => null }));
});

afterEach(() => {
  vi.doUnmock("@/db");
  vi.doUnmock("@/lib/infra/cron-alert");
  vi.doUnmock("@/lib/domain/cron-auth");
  vi.doUnmock("@/lib/analytics/admin-metrics");
  vi.doUnmock("@/src/modules/panorama/infrastructure/cube-builder");
});

function request(path: string): Request {
  return new Request(`http://test.local${path}`);
}

describe("cron-health judges its PREVIOUS run, not the row it just inserted (C04-3)", () => {
  it("reports its own last failure", async () => {
    vi.doMock("@/lib/analytics/admin-metrics", () => ({ STUCK_RUNNING_MS: 10 * 60 * 1000 }));
    const { CRON_REGISTRY } = await import("@/lib/infra/cron-registry");
    const now = new Date();
    const rows: FakeRow[] = [
      // Every OTHER registered cron ran a minute ago and was fine, so the only
      // way this run can be unhealthy is its own history.
      ...CRON_REGISTRY.filter((e) => e.cronName !== "cron_health").map((e, i) => ({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        cronName: e.cronName,
        startedAt: new Date(now.getTime() - 60_000),
        finishedAt: new Date(now.getTime() - 30_000),
        status: "ok",
        itemsProcessed: 0,
        details: {},
      })),
      // Yesterday's meta-run failed…
      {
        id: PREVIOUS_RUN_ID,
        cronName: "cron_health",
        startedAt: new Date(now.getTime() - 60 * 60 * 1000),
        finishedAt: new Date(now.getTime() - 59 * 60 * 1000),
        status: "failed",
        itemsProcessed: 0,
        details: {},
      },
      // …and this request's own row is the newest one, still 'running'.
      {
        id: SELF_RUN_ID,
        cronName: "cron_health",
        startedAt: now,
        finishedAt: null,
        status: "running",
        itemsProcessed: null,
        details: {},
      },
    ];
    installFakeDb(rows);

    const { GET } = await import("@/app/api/cron/cron-health/route");
    const res = await GET(request("/api/cron/cron-health") as never);
    const body = (await res.json()) as {
      ok: boolean;
      unhealthy: { cronName: string; reason: string; lastStatus: string }[];
    };

    expect(res.status).toBe(500);
    expect(body.unhealthy).toEqual([
      expect.objectContaining({
        cronName: "cron_health",
        reason: "last_failed",
        lastStatus: "failed",
      }),
    ]);
  });
});

describe("refresh-cube runs inside withCronRun (C04-4)", () => {
  const OK_LAYER = {
    status: "ok",
    rowCount: 42,
    durationMs: 1000,
    watermark: null,
    builtAt: null,
    perMetric: {},
  };

  it("a KPI-only failure finalizes the row as failed AND pages", async () => {
    const updates = installFakeDb([]);
    vi.doMock("@/src/modules/panorama/infrastructure/cube-builder", () => ({
      refreshCube: vi.fn().mockResolvedValue({
        ...OK_LAYER,
        kpi: { status: "failed", error: "kpi loader exploded" },
      }),
    }));

    const { GET } = await import("@/app/api/cron/refresh-cube/route");
    const res = await GET(request("/api/cron/refresh-cube") as never);

    expect(res.status).toBe(500);
    expect(updates).toEqual([expect.objectContaining({ status: "failed", itemsProcessed: 42 })]);
    expect(sendCronAlert).toHaveBeenCalledTimes(1);
    expect(sendCronAlert.mock.calls[0][0]).toMatchObject({ job: "refresh_cube" });
  });

  it("a builder throw still finalizes the row (no orphaned 'running') and pages", async () => {
    const updates = installFakeDb([]);
    vi.doMock("@/src/modules/panorama/infrastructure/cube-builder", () => ({
      refreshCube: vi.fn().mockRejectedValue(new Error("pooler gone")),
    }));

    const { GET } = await import("@/app/api/cron/refresh-cube/route");
    await expect(GET(request("/api/cron/refresh-cube") as never)).rejects.toThrow("pooler gone");

    expect(updates).toEqual([
      expect.objectContaining({ status: "failed", details: { error: "pooler gone" } }),
    ]);
    expect(sendCronAlert).toHaveBeenCalledTimes(1);
  });

  it("a clean build finalizes ok and does not page", async () => {
    const updates = installFakeDb([]);
    vi.doMock("@/src/modules/panorama/infrastructure/cube-builder", () => ({
      refreshCube: vi.fn().mockResolvedValue({ ...OK_LAYER, kpi: { status: "ok" } }),
    }));

    const { GET } = await import("@/app/api/cron/refresh-cube/route");
    const res = await GET(request("/api/cron/refresh-cube") as never);

    expect(res.status).toBe(200);
    expect(updates).toEqual([expect.objectContaining({ status: "ok", itemsProcessed: 42 })]);
    expect(sendCronAlert).not.toHaveBeenCalled();
  });
});
