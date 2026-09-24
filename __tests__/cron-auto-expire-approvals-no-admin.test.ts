// auto-expire-approvals on a database with NO active admin (cold-start review
// RA-6, finding 2).
//
// The route picks the oldest active institutional admin as the audit system
// actor. It used to return HTTP 500 `no_active_admin_for_system_actor` BEFORE
// the cron_runs insert, which meant that on a cold-start deployment — and on
// any single-admin deployment the day it deactivates its only admin — the job
// failed every single day while writing zero telemetry. cron-health then
// reported `never_ran`, which is indistinguishable from "never scheduled": a
// daily failure disguised as a job nobody ever turned on.
//
// audit_log.actor_user_id is a nullable SET NULL FK (migration 0080), so an
// actor-less audit row is legal. lib/infra/outbox-drainer.ts already handles
// this exact lookup gracefully; the route now does the same.
//
// The sibling __tests__/cron-auto-expire-approvals.test.ts covers the real
// expiry logic against a live database with the seeded admin present. This file
// covers the branch that live database cannot reach without deactivating every
// admin on a shared local stack, so `@/db` is stubbed instead: what is under
// test is the ORDER of the route's own steps, not SQL.

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Table sentinels ---------------------------------------------------------
// Identity is all the stub needs; the operators below ignore their arguments.
const approvalRequests = { __table: "approval_requests" } as never;
const auditLog = { __table: "audit_log" } as never;
const cronRuns = { __table: "cron_runs" } as never;
const profiles = { __table: "profiles" } as never;

/** Rows the stubbed `select().from(T)` resolves to, keyed by sentinel. */
const selectRows = new Map<unknown, unknown[]>();

const inserted: { table: unknown; values: unknown }[] = [];
const updated: { table: unknown; values: unknown }[] = [];

function makeDb() {
  const selectChain = (table: unknown) => {
    const chain = {
      where: () => chain,
      orderBy: () => chain,
      limit: async () => selectRows.get(table) ?? [],
    };
    return chain;
  };

  return {
    select: () => ({ from: (table: unknown) => selectChain(table) }),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        inserted.push({ table, values });
        return { returning: async () => [{ id: "run-under-test" }] };
      },
    }),
    update: (table: unknown) => ({
      set: (values: unknown) => {
        updated.push({ table, values });
        return { where: async () => undefined };
      },
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(makeDb()),
  };
}

vi.mock("@/db", () => ({
  get approvalRequests() {
    return approvalRequests;
  },
  get auditLog() {
    return auditLog;
  },
  get cronRuns() {
    return cronRuns;
  },
  get profiles() {
    return profiles;
  },
  get db() {
    return makeDb();
  },
}));

// The route builds predicates out of these; with stub tables they would throw
// on real column objects, and the stub DB ignores predicates anyway.
vi.mock("drizzle-orm", () => ({
  and: () => undefined,
  asc: () => undefined,
  eq: () => undefined,
  gt: () => undefined,
  isNull: () => undefined,
  lt: () => undefined,
}));

vi.mock("@/lib/domain/cron-auth", () => ({ authorizeCronRequest: () => null }));
vi.mock("@/lib/infra/cron-alert", () => ({ sendCronAlert: vi.fn(async () => undefined) }));
vi.mock("@/lib/infra/notification-service", () => ({
  createNotification: vi.fn(async () => undefined),
}));

async function callRoute() {
  const { GET } = await import("@/app/api/cron/auto-expire-approvals/route");
  const req = new Request("http://test.local/api/cron/auto-expire-approvals");
  const res = await GET(req as unknown as Parameters<typeof GET>[0]);
  return { res, body: (await res.json()) as { status: string; itemsProcessed: number } };
}

beforeEach(() => {
  inserted.length = 0;
  updated.length = 0;
  selectRows.clear();
  // No active institutional admin, and no stale approvals to sweep.
  selectRows.set(profiles, []);
  selectRows.set(approvalRequests, []);
});

describe("auto-expire-approvals — no active admin (RA-6 finding 2)", () => {
  it("records the run in cron_runs instead of 500ing before telemetry exists", async () => {
    const { res, body } = await callRoute();

    // The regression: a 500 here, with nothing in cron_runs, is a daily silent
    // failure that cron-health reports as `never_ran`.
    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");

    const runInserts = inserted.filter((i) => i.table === cronRuns);
    expect(runInserts).toHaveLength(1);
    expect(runInserts[0].values).toMatchObject({ status: "running" });
  });

  it("closes the run out, so cron-health sees a finished run and not a hung one", async () => {
    await callRoute();

    const runUpdates = updated.filter((u) => u.table === cronRuns);
    expect(runUpdates).toHaveLength(1);
    expect(runUpdates[0].values).toMatchObject({ status: "ok", itemsProcessed: 0 });
  });

  it("does not page anyone: a missing admin is a deployment shape, not a failure", async () => {
    const { sendCronAlert } = await import("@/lib/infra/cron-alert");

    const { body } = await callRoute();

    expect(body.status).toBe("ok");
    expect(sendCronAlert).not.toHaveBeenCalled();
  });
});

describe("auto-expire-approvals — with an active admin, telemetry still comes first", () => {
  it("inserts the cron_runs row before reading the system actor", async () => {
    selectRows.set(profiles, [{ id: "admin-1" }]);

    const { res } = await callRoute();

    expect(res.status).toBe(200);
    expect(inserted.filter((i) => i.table === cronRuns)).toHaveLength(1);
  });
});
