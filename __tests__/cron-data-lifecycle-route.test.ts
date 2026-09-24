// Unit tests for the HTTP layer of GET /api/cron/data-lifecycle.
//
// SCOPE, and why this is a second file. __tests__/cron-data-lifecycle.test.ts
// calls the lib functions directly against the local DB on purpose — its own
// header says so — so the purge SQL is exercised for real there. What that file
// cannot see is what the ROUTE does with the result, and the finding this file
// exists for is exactly that: a run that drained only part of a table returned
// `ok: true` with a 200 and logged NOTHING, so the `backlogged` flags were
// visible only to someone already reading the JSON.
//
// Both @/db and @/lib/infra/data-lifecycle are mocked — same harness as
// cron-purge-scan-events-route.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DataLifecycleResult } from "@/lib/infra/data-lifecycle";

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;
const FAKE_RUN_ID = "fake-run-id-data-lifecycle";

const DRAINED: DataLifecycleResult = {
  notificationsDeleted: 3,
  rateLimitBucketsDeleted: 7,
  cronRunsDeleted: 1,
  pushSubscriptionsDeleted: 2,
  pushTargetsDeleted: 1,
  orgContactIpsPurged: 4,
  stagedUploadsDeleted: 6,
  backlogged: {
    notifications: false,
    rateLimitBuckets: false,
    cronRuns: false,
    pushSubscriptions: false,
    pushTargets: false,
    orgContactIps: false,
    stagedUploads: false,
  },
  failures: [],
};

describe("GET /api/cron/data-lifecycle — backlog reporting", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    process.env.CRON_SECRET = "test-secret";
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
    vi.restoreAllMocks();
    vi.doUnmock("@/lib/infra/data-lifecycle");
    vi.doUnmock("@/db");
    vi.doUnmock("@/lib/infra/cron-alert");
  });

  function mockDeps(purge: () => Promise<DataLifecycleResult>) {
    const whereMock = vi.fn().mockResolvedValue(undefined);
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    const updateMock = vi.fn().mockReturnValue({ set: setMock });
    const returningMock = vi.fn().mockResolvedValue([{ id: FAKE_RUN_ID }]);
    const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
    const insertMock = vi.fn().mockReturnValue({ values: valuesMock });

    vi.doMock("@/db", () => ({
      db: { insert: insertMock, update: updateMock },
      cronRuns: { id: "id" },
    }));

    const runDataLifecyclePurge = vi.fn().mockImplementation(purge);
    vi.doMock("@/lib/infra/data-lifecycle", () => ({ runDataLifecyclePurge }));

    // THE ALERT MUST BE MOCKED TO BE OBSERVED. Left real it no-ops in the test
    // env (CRON_ALERT_WEBHOOK is unset), so nothing sees whether it was called
    // or what it said — which let two mutants live: deleting the whole
    // `if (status === "failed") { await sendCronAlert(...) }` block, and
    // dropping the `${section}: ` prefix that names the failed target. Same
    // recipe as __tests__/cron-reconcile-pet-status-route.test.ts.
    const sendCronAlert = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/infra/cron-alert", () => ({ sendCronAlert }));

    // `setMock` is what the cron_runs row is built from — the assertions about
    // what a failed run RECORDS read it rather than trusting the JSON body.
    return { runDataLifecyclePurge, setMock, sendCronAlert };
  }

  async function callRoute(extraHeaders: Record<string, string> = {}) {
    const { GET } = await import("@/app/api/cron/data-lifecycle/route");
    const req = new Request("http://test.local/api/cron/data-lifecycle", {
      headers: { "x-cron-secret": "test-secret", ...extraHeaders },
    });
    return GET(req as unknown as Parameters<typeof GET>[0]);
  }

  /** Every string console.warn was called with, joined. */
  function warnings(): string {
    return warnSpy.mock.calls.map((args: unknown[]) => args.join(" ")).join("\n");
  }

  it("warns and NAMES the tables when a purge stopped short", async () => {
    mockDeps(async () => ({
      ...DRAINED,
      backlogged: {
        notifications: true,
        rateLimitBuckets: true,
        cronRuns: false,
        pushSubscriptions: false,
        pushTargets: false,
        orgContactIps: false,
        stagedUploads: false,
      },
    }));

    const res = await callRoute();

    // The run itself succeeded — this is a backlog, not a failure. The point is
    // that a 200 no longer hides it.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });

    const logged = warnings();
    expect(logged).toContain("backlog remains");
    expect(logged).toContain("notifications");
    expect(logged).toContain("rate_limit_buckets");
    // NON-VACUITY: a warning that names every table on every backlog says
    // nothing about WHICH one is behind. cron_runs drained, so it must not
    // appear — and `notifications` above must not be satisfied by the substring
    // inside some other word.
    expect(logged).not.toContain("cron_runs");
  });

  it("says nothing when all four targets drained", async () => {
    mockDeps(async () => DRAINED);

    const res = await callRoute();

    expect(res.status).toBe(200);
    expect(warnings()).not.toContain("backlog remains");
  });

  it("names push_subscriptions when THAT target is the one behind", async () => {
    mockDeps(async () => ({
      ...DRAINED,
      backlogged: {
        notifications: false,
        rateLimitBuckets: false,
        cronRuns: false,
        pushSubscriptions: true,
        pushTargets: true,
        orgContactIps: false,
        stagedUploads: false,
      },
    }));

    await callRoute();

    const logged = warnings();
    expect(logged).toContain("backlog remains");
    expect(logged).toContain("push_subscriptions");
    expect(logged).not.toContain("rate_limit_buckets");
  });

  // -------------------------------------------------------------------------
  // The budget the dispatcher hands down (RN-3 F17 / RN re-run HIGH)
  //
  // The purge used to drain under its own 45 s constant inside a 55 s
  // dispatcher. The daily route now forwards the job's FAIR SHARE of what is
  // left as a request header; this route must pass it through, and must fall
  // back to its own ceiling when called standalone (no header).
  // -------------------------------------------------------------------------

  it("passes the dispatcher's budget header through to the purge", async () => {
    const { runDataLifecyclePurge } = mockDeps(async () => DRAINED);

    await callRoute({ "x-cron-budget-ms": "12345" });

    expect(runDataLifecyclePurge).toHaveBeenCalledWith(
      expect.objectContaining({ maxDurationMs: 12_345 }),
    );
  });

  it("runs on its own ceiling when no budget header arrives (standalone invocation)", async () => {
    const { runDataLifecyclePurge } = mockDeps(async () => DRAINED);

    await callRoute();

    const [options] = runDataLifecyclePurge.mock.calls[0] as [{ maxDurationMs?: number }];
    expect(options?.maxDurationMs).toBeUndefined();
  });

  it("does NOT report a backlog on a failed run — nothing ran, which is a different fact", async () => {
    // The route seeds `counts` with all four flags TRUE so a failed run cannot
    // claim four drained tables. That initial shape must not be re-reported as
    // a backlog: the failure already logs an error and pages a human, and
    // "four tables are behind" would be a fabricated measurement.
    mockDeps(async () => {
      throw new Error("pooler down");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await callRoute();

    expect(res.status).toBe(500);
    expect(warnings()).not.toContain("backlog remains");
  });

  // -------------------------------------------------------------------------
  // A FAILED TARGET IS A FAILED RUN THAT STILL TELLS THE TRUTH (2026-09-10)
  //
  // The composite no longer throws when one of six targets breaks — it isolates
  // it so the other five report the rows they really deleted. The danger in that
  // fix is the opposite mistake, and it is worse: a partial failure quietly
  // returning 200. So the route must read `failures`, fail the run, page, AND
  // keep the honest counts.
  // -------------------------------------------------------------------------

  it("a FAILED TARGET fails the run, names it, and still records the counts the other five earned", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { setMock, sendCronAlert } = mockDeps(async () => ({
      ...DRAINED,
      pushSubscriptionsDeleted: 0,
      pushTargetsDeleted: 0,
      backlogged: { ...DRAINED.backlogged, pushSubscriptions: true },
      failures: [{ target: "pushSubscriptions" as const, reason: "pooler down" }],
    }));

    const res = await callRoute();

    // STILL VISIBLY FAILED. Isolation must not become silence: Vercel's cron
    // dashboard reads the status code, and a 200 here would hide a broken
    // target forever.
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);

    // AND STILL TRUE. These are the counts the defect used to overwrite with
    // zeros — five targets' real work, erased because a sixth threw.
    expect(body).toMatchObject({
      rateLimitBucketsDeleted: 7,
      notificationsDeleted: 3,
      cronRunsDeleted: 1,
      orgContactIpsPurged: 4,
      stagedUploadsDeleted: 6,
      pushSubscriptionsDeleted: 0,
      pushTargetsDeleted: 0,
    });

    // The cron_runs row carries the same story: itemsProcessed sums the real
    // work, and `details.errors` NAMES the target rather than saying an error
    // occurred somewhere in a six-target job.
    const [recorded] = setMock.mock.calls[0] as [
      {
        status: string;
        itemsProcessed: number;
        details: { errors?: { section: string; reason: string }[] };
      },
    ];
    expect(recorded.status).toBe("failed");
    expect(recorded.itemsProcessed).toBe(7 + 3 + 1 + 4 + 6);
    expect(recorded.details.errors).toEqual([
      { section: "pushSubscriptions", reason: "pooler down" },
    ]);

    // The human-readable log names the table the reader is about to open.
    const logged = errorSpy.mock.calls.map((args: unknown[]) => args.join(" ")).join("\n");
    expect(logged).toContain("pushSubscriptions");
    expect(logged).toContain("push_subscriptions");
    expect(logged).toContain("pooler down");

    // THE PAGE STILL FIRES, and its headline NAMES the target. A partial
    // failure that alerted with a bare reason would leave the person woken at
    // 3am guessing which of six targets it came from; one that did not alert at
    // all would be the isolation turning into silence.
    expect(sendCronAlert).toHaveBeenCalledTimes(1);
    expect(sendCronAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        job: "data_lifecycle",
        severity: "critical",
        error: "pushSubscriptions: pooler down",
        details: expect.objectContaining({
          // The counts the other five earned ride along, so the alert itself
          // says what DID happen rather than implying nothing did.
          rateLimitBucketsDeleted: 7,
          errors: [{ section: "pushSubscriptions", reason: "pooler down" }],
        }),
      }),
    );

    // The failed target's rows are still on the table, so the backlog warning
    // is an honest measurement here — unlike on a run whose composite threw.
    expect(warnings()).toContain("push_subscriptions");
  });

  it("a clean run records no errors, stays 200, and pages NOBODY", async () => {
    const { setMock, sendCronAlert } = mockDeps(async () => DRAINED);

    const res = await callRoute();

    expect(res.status).toBe(200);
    // NON-VACUITY for the alert assertion above: an alert that fired on every
    // run would satisfy it while training the recipient to ignore the channel.
    expect(sendCronAlert).not.toHaveBeenCalled();
    const [recorded] = setMock.mock.calls[0] as [{ status: string; details: { errors?: unknown } }];
    expect(recorded.status).toBe("ok");
    // NON-VACUITY for the test above: `errors` is only added to `details` when
    // there is one, so an empty run must not carry the key at all.
    expect(recorded.details.errors).toBeUndefined();
  });
});
