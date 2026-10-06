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

/** Raw statements the last installFakeDb saw through db.execute. */
let executedSql: SQL[] = [];

/** Every value bound into the WHERE clause the route built. */
function boundParams(cond: SQL): unknown[] {
  return dialect.sqlToQuery(cond).params;
}

function installFakeDb(rows: FakeRow[], opts: { sweepFails?: boolean; sweepHangs?: boolean } = {}) {
  const updates: Record<string, unknown>[] = [];
  // Raw statements (the abandoned-run sweep), kept apart from `updates` so the
  // finalize assertions below keep reading only withCronRun's own UPDATE.
  const executed: SQL[] = [];
  vi.doMock("@/db", async () => {
    const schema = await import("@/db/schema");
    return {
      cronRuns: schema.cronRuns,
      db: {
        execute: async (q: SQL) => {
          if (opts.sweepFails) throw new Error("sweep: pooler gone");
          if (opts.sweepHangs) return new Promise(() => {});
          executed.push(q);
          return [];
        },
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
  executedSql = executed;
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
  vi.useRealTimers();
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

describe("refresh-cube never leaves its row 'running' (2026-10 hang)", () => {
  const OK = {
    status: "ok",
    rowCount: 42,
    durationMs: 1000,
    watermark: null,
    builtAt: null,
    perMetric: {},
    kpi: { status: "ok" },
  };
  const TIMED_OUT = {
    ...OK,
    status: "error",
    rowCount: 0,
    error: "canceling statement due to statement timeout (57014)",
    kpi: { status: "error", error: "layer build failed" },
  };

  /** The builder's module surface the route uses; the retry consults the
   * statement timeout to decide whether a second attempt still fits. */
  function mockBuilder(refreshCube: (...args: unknown[]) => Promise<unknown>) {
    const fn = vi.fn(refreshCube);
    vi.doMock("@/src/modules/panorama/infrastructure/cube-builder", () => ({
      refreshCube: fn,
      cubeBuilderStatementTimeoutMs: () => 120_000,
    }));
    return fn;
  }

  function settle(p: Promise<unknown>): Promise<string> {
    return p.then(
      () => "resolved",
      (e: Error) => e.message,
    );
  }

  // The staging failure: the build's promise never settled (a pipelined query
  // through the transaction pooler lost its response), the platform killed the
  // function at maxDuration, and withCronRun's catch never ran — 8 rows stuck
  // at 'running', no alert. A deadline below maxDuration must turn that hang
  // into a finalized, paged failure that says what happened.
  it("the deadline aborts the build; the build unwinds and the row closes failed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const updates = installFakeDb([]);
    let seen: AbortSignal | undefined;
    // A builder that behaves like the real one under abort: its queries reject
    // when the clients are destroyed, and it RETURNS a structured error.
    const refresh = mockBuilder((opts) => {
      seen = (opts as { signal: AbortSignal }).signal;
      return new Promise((resolve) => {
        seen?.addEventListener("abort", () =>
          resolve({ ...TIMED_OUT, error: "aborted (deadline): CONNECTION_DESTROYED" }),
        );
      });
    });

    const { GET, maxDuration } = await import("@/app/api/cron/refresh-cube/route");
    const outcome = GET(request("/api/cron/refresh-cube") as never);

    // Not yet: a slow-but-alive build is not cut short early.
    await vi.advanceTimersByTimeAsync(239_000);
    expect(seen?.aborted).toBe(false);
    expect(updates).toEqual([]);

    // At 240s — strictly inside maxDuration — the build is aborted, unwinds
    // with its own structured error (meta stamped by the builder), and the
    // route finalizes THAT result as a failed, paged run.
    await vi.advanceTimersByTimeAsync(1_000);
    const res = await outcome;
    expect(seen?.aborted).toBe(true);
    expect(240_000).toBeLessThan(maxDuration * 1000);
    expect(res.status).toBe(500);
    // No retry once aborted, even though the result is an error.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(updates).toEqual([
      expect.objectContaining({
        status: "failed",
        details: expect.objectContaining({ error: "aborted (deadline): CONNECTION_DESTROYED" }),
      }),
    ]);
    expect(updates[0].finishedAt).toBeInstanceOf(Date);
    expect(sendCronAlert).toHaveBeenCalledTimes(1);
    expect(sendCronAlert.mock.calls[0][0]).toMatchObject({ job: "refresh_cube" });
  });

  it("a build that ignores the abort still closes the row after a bounded drain", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const updates = installFakeDb([]);
    mockBuilder(() => new Promise(() => {}));

    const { GET, maxDuration } = await import("@/app/api/cron/refresh-cube/route");
    const outcome = settle(GET(request("/api/cron/refresh-cube") as never));

    await vi.advanceTimersByTimeAsync(240_000);
    expect(updates).toEqual([]); // still draining
    await vi.advanceTimersByTimeAsync(15_000);
    const message = await outcome;
    expect(message).toMatch(/did not finish within 240s/);
    expect(255_000).toBeLessThan(maxDuration * 1000);
    expect(updates).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(sendCronAlert).toHaveBeenCalledTimes(1);
  });

  it("retries a statement timeout only while a whole statement timeout still fits", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    installFakeDb([]);
    // First attempt times out FAST: 240s - ~0s left > 120s → one retry.
    const quick = mockBuilder(() => Promise.resolve(TIMED_OUT));
    let { GET } = await import("@/app/api/cron/refresh-cube/route");
    await settle(GET(request("/api/cron/refresh-cube") as never));
    expect(quick).toHaveBeenCalledTimes(2);

    // First attempt times out after 200s: 40s left < 120s → no retry, so a
    // second write transaction can never start after the reads already failed.
    vi.resetModules();
    installFakeDb([]);
    const late = mockBuilder(
      () => new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 200_000)),
    );
    ({ GET } = await import("@/app/api/cron/refresh-cube/route"));
    const outcome = settle(GET(request("/api/cron/refresh-cube") as never));
    await vi.advanceTimersByTimeAsync(200_000);
    await outcome;
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("closes this cron's abandoned 'running' rows before it starts", async () => {
    const updates = installFakeDb([]);
    mockBuilder(() => Promise.resolve(OK));

    const { GET } = await import("@/app/api/cron/refresh-cube/route");
    const res = await GET(request("/api/cron/refresh-cube") as never);

    expect(res.status).toBe(200);
    expect(updates).toEqual([expect.objectContaining({ status: "ok" })]);
    expect(executedSql).toHaveLength(1);
    // The row-selection semantics are pinned against Postgres in the DB-backed
    // test below; this one only proves the route runs the sweep for ITSELF.
    expect(dialect.sqlToQuery(executedSql[0]).params).toEqual(["refresh_cube", 900]);
  });

  it("a failing sweep never blocks the build", async () => {
    const updates = installFakeDb([], { sweepFails: true });
    mockBuilder(() => Promise.resolve(OK));

    const { GET } = await import("@/app/api/cron/refresh-cube/route");
    const res = await GET(request("/api/cron/refresh-cube") as never);

    expect(res.status).toBe(200);
    expect(updates).toEqual([expect.objectContaining({ status: "ok", itemsProcessed: 42 })]);
    expect(sendCronAlert).not.toHaveBeenCalled();
  });

  it("a HUNG sweep is abandoned after 10s and the run still opens and closes its row", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const updates = installFakeDb([], { sweepHangs: true });
    mockBuilder(() => Promise.resolve(OK));

    const { GET } = await import("@/app/api/cron/refresh-cube/route");
    const outcome = GET(request("/api/cron/refresh-cube") as never);
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await outcome;

    expect(res.status).toBe(200);
    expect(updates).toEqual([expect.objectContaining({ status: "ok", itemsProcessed: 42 })]);
  });
});

describe("closeAbandonedCronRuns against Postgres", () => {
  // Pattern-matching the SQL cannot tell `<` from `>`; Postgres can. Seed the
  // four cases with started_at computed BY THE DATABASE (no host clock).
  it("closes only this cron's running rows older than the threshold", async () => {
    const postgres = (await import("postgres")).default;
    const sql = postgres(process.env.DATABASE_URL as string, { max: 1, prepare: false });
    const other = `zz_sweep_other_${Date.now()}`;
    const ids: string[] = [];
    try {
      const seed = async (cron: string, status: string, ageMinutes: number) => {
        const [row] = await sql<{ id: string }[]>`
          insert into cron_runs (cron_name, status, started_at, finished_at)
          values (${cron}, ${status}, now() - make_interval(mins => ${ageMinutes}),
                  case when ${status} = 'running' then null else now() end)
          returning id`;
        ids.push(row.id);
        return row.id;
      };
      const oldRunning = await seed("refresh_cube", "running", 60);
      const freshRunning = await seed("refresh_cube", "running", 1);
      const otherOldRunning = await seed(other, "running", 60);
      const oldOk = await seed("refresh_cube", "ok", 60);

      const { closeAbandonedCronRuns } = await import("@/lib/infra/case-cron");
      await closeAbandonedCronRuns("refresh_cube", 15 * 60 * 1000);

      const rows = await sql<
        { id: string; status: string; closed: boolean; error: string | null }[]
      >`
        select id, status, finished_at is not null as closed, details->>'error' as error
          from cron_runs where id = any(${ids})`;
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(oldRunning)).toMatchObject({ status: "failed", closed: true });
      expect(byId.get(oldRunning)?.error).toMatch(/^abandoned:/);
      expect(byId.get(freshRunning)).toMatchObject({
        status: "running",
        closed: false,
        error: null,
      });
      expect(byId.get(otherOldRunning)).toMatchObject({ status: "running", closed: false });
      expect(byId.get(oldOk)).toMatchObject({ status: "ok", error: null });
    } finally {
      if (ids.length) await sql`delete from cron_runs where id = any(${ids})`;
      await sql.end({ timeout: 5 });
    }
  });
});

describe("cube-builder abort plumbing", () => {
  it("an abort destroys the clients: in-flight AND queued queries reject at once", async () => {
    const postgres = (await import("postgres")).default;
    const { endClientsOnAbort } = await import(
      "@/src/modules/panorama/infrastructure/cube-builder"
    );
    const client = postgres(process.env.DATABASE_URL as string, {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    const controller = new AbortController();
    const unbind = endClientsOnAbort(controller.signal, [client]);
    const t0 = Date.now();
    const inFlight = client`select pg_sleep(30)`.then(
      () => "resolved",
      (e: { code?: string }) => e.code ?? "rejected",
    );
    const queued = client`select 1`.then(
      () => "resolved",
      (e: { code?: string }) => e.code ?? "rejected",
    );
    await new Promise((r) => setTimeout(r, 300));
    controller.abort("deadline");
    expect(await inFlight).toBe("CONNECTION_DESTROYED");
    expect(await queued).toMatch(/CONNECTION_(DESTROYED|ENDED)/);
    expect(Date.now() - t0).toBeLessThan(10_000);
    unbind();
  });

  it("an already-aborted signal ends the clients immediately; no signal binds nothing", async () => {
    const { endClientsOnAbort } = await import(
      "@/src/modules/panorama/infrastructure/cube-builder"
    );
    const end = vi.fn(async () => undefined);
    endClientsOnAbort(undefined, [{ end }]);
    expect(end).not.toHaveBeenCalled();
    const c = new AbortController();
    c.abort();
    endClientsOnAbort(c.signal, [{ end }, { end }]);
    expect(end).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenCalledWith({ timeout: 0 });
  });

  it("the read handle refuses .transaction() loudly and passes everything else through", async () => {
    const { forbidTransactions } = await import(
      "@/src/modules/panorama/infrastructure/cube-builder"
    );
    const inner = { transaction: vi.fn(), select: () => "selected" };
    const guarded = forbidTransactions(inner);
    expect(() => guarded.transaction()).toThrow(/transactions are not allowed/);
    expect(inner.transaction).not.toHaveBeenCalled();
    expect(guarded.select()).toBe("selected");
  });
});
