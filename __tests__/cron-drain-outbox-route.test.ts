// Unit tests for GET /api/cron/drain-outbox.
//
// Branches:
//   1. Auth failure → 401
//   2. Auth success + no pending rows → 200 { ok: true, processed: 0, delivered: 0, failed: 0, retried: 0 }
//   3. Auth success + one row delivered successfully → processed: 1, delivered: 1
//   4. Auth success + one row fails delivery → processed: 1, retried: 1 (not yet exhausted)
//   5. Auth success + one row exhausts max attempts → processed: 1, failed: 1
//
// Mocks: @/db (cronRuns, eventNotificationOutbox, db) + @/lib/infra/outbox-drainer (deliverOutboxRow, MAX_ATTEMPTS, computeNextRetryAt)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

const FAKE_RUN_ID = "drain-run-id-1111";

describe("GET /api/cron/drain-outbox", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.CRON_SECRET = "test-secret";
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
    vi.restoreAllMocks();
    vi.doUnmock("@/lib/infra/outbox-drainer");
    vi.doUnmock("@/db");
  });

  /**
   * Build db mock supporting INSERT cronRuns (returning), UPDATE cronRuns,
   * SELECT+FOR UPDATE transaction (for pending rows), UPDATE eventNotificationOutbox.
   */
  function buildDbMock(
    pendingRows: { id: string; attempts: number; nextRetryAt: Date; status: string }[],
  ) {
    // cronRuns INSERT
    const cronInsertReturningMock = vi.fn().mockResolvedValue([{ id: FAKE_RUN_ID }]);
    const cronInsertValuesMock = vi.fn().mockReturnValue({ returning: cronInsertReturningMock });
    const insertMock = vi.fn().mockReturnValue({ values: cronInsertValuesMock });

    // cronRuns UPDATE (finalize) and eventNotificationOutbox UPDATE (per-row)
    const updateWhereMock = vi.fn().mockResolvedValue(undefined);
    const updateSetMock = vi.fn().mockReturnValue({ where: updateWhereMock });
    const updateMock = vi.fn().mockReturnValue({ set: updateSetMock });

    // Transaction: SELECT pending rows FOR UPDATE SKIP LOCKED
    const txForMock = vi.fn().mockResolvedValue(pendingRows);
    const txLimitMock = vi.fn().mockReturnValue({ for: txForMock });
    const txOrderByMock = vi.fn().mockReturnValue({ limit: txLimitMock });
    const txWhereMock = vi.fn().mockReturnValue({ orderBy: txOrderByMock });
    const txFromMock = vi.fn().mockReturnValue({ where: txWhereMock });
    const txSelectMock = vi.fn().mockReturnValue({ from: txFromMock });

    // THE CLAIM, inside the same transaction as the select. The route pushes
    // `next_retry_at` forward on the batch it just locked, which is what makes a
    // leased row invisible to a concurrent run — `FOR UPDATE SKIP LOCKED` alone
    // released at commit, before delivery, and let a second run re-deliver.
    // Captured separately from the db-level update so a test can tell the claim
    // apart from the per-row result write.
    const txUpdateWhereMock = vi.fn().mockResolvedValue(undefined);
    const txUpdateSetMock = vi.fn().mockReturnValue({ where: txUpdateWhereMock });
    const txUpdateMock = vi.fn().mockReturnValue({ set: txUpdateSetMock });

    const txObj = {
      select: txSelectMock,
      update: txUpdateMock,
    };

    const transactionMock = vi
      .fn()
      .mockImplementation(async (fn: (tx: typeof txObj) => unknown) => {
        return fn(txObj);
      });

    const dbMock = {
      insert: insertMock,
      update: updateMock,
      transaction: transactionMock,
    };

    return { dbMock, updateMock, txUpdateMock, txUpdateSetMock, transactionMock };
  }

  function mockDeps(
    pendingRows: { id: string; attempts: number; nextRetryAt: Date; status: string }[],
    deliverResults: Array<{ ok: boolean; error: string }>,
    maxAttempts = 5,
  ) {
    const built = buildDbMock(pendingRows);
    const { dbMock } = built;

    vi.doMock("@/db", () => ({
      db: dbMock,
      cronRuns: {},
      eventNotificationOutbox: {},
    }));

    let deliverCallIndex = 0;
    const deliverMock = vi.fn().mockImplementation(() => {
      const result = deliverResults[deliverCallIndex] ?? { ok: true, error: "" };
      deliverCallIndex += 1;
      return Promise.resolve(result);
    });

    const computeNextRetryAtMock = vi.fn().mockReturnValue(new Date(Date.now() + 60_000));

    vi.doMock("@/lib/infra/outbox-drainer", () => ({
      MAX_ATTEMPTS: maxAttempts,
      deliverOutboxRow: deliverMock,
      computeNextRetryAt: computeNextRetryAtMock,
    }));

    return { deliverMock, ...built };
  }

  async function callRoute(headers: Record<string, string>) {
    const { GET } = await import("@/app/api/cron/drain-outbox/route");
    const req = new Request("http://test.local/api/cron/drain-outbox", { headers });
    return GET(req as unknown as Parameters<typeof GET>[0]);
  }

  it("returns 401 when no auth header is provided", async () => {
    mockDeps([], []);
    const res = await callRoute({});
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "Unauthorized" });
  });

  it("returns 401 when x-cron-secret does not match", async () => {
    mockDeps([], []);
    const res = await callRoute({ "x-cron-secret": "wrong" });
    expect(res.status).toBe(401);
  });

  it("returns 401 when Authorization: Bearer does not match", async () => {
    mockDeps([], []);
    const res = await callRoute({ authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
  });

  it("returns 200 with zero counts when there are no pending rows", async () => {
    mockDeps([], []);
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, processed: 0, delivered: 0, failed: 0, retried: 0 });
  });

  it("returns 200 with delivered:1 when one row succeeds", async () => {
    const now = new Date();
    mockDeps(
      [{ id: "row-1", attempts: 0, nextRetryAt: now, status: "pending" }],
      [{ ok: true, error: "" }],
    );
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, processed: 1, delivered: 1, failed: 0, retried: 0 });
  });

  it("returns 200 with retried:1 when one row fails delivery but attempts < MAX_ATTEMPTS", async () => {
    const now = new Date();
    // attempts=1, maxAttempts=5 → not exhausted → retried
    mockDeps(
      [{ id: "row-2", attempts: 1, nextRetryAt: now, status: "pending" }],
      [{ ok: false, error: "timeout" }],
      5,
    );
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, processed: 1, delivered: 0, failed: 0, retried: 1 });
  });

  it("returns 200 with failed:1 when one row exhausts MAX_ATTEMPTS", async () => {
    const now = new Date();
    // attempts=4 → newAttempts=5 === maxAttempts(5) → exhausted → failed
    mockDeps(
      [{ id: "row-3", attempts: 4, nextRetryAt: now, status: "pending" }],
      [{ ok: false, error: "permanently broken" }],
      5,
    );
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, processed: 1, delivered: 0, failed: 1, retried: 0 });
  });

  it("returns 200 when auth matches via Authorization: Bearer", async () => {
    mockDeps([], []);
    const res = await callRoute({ authorization: "Bearer test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The claim lease — the defect this route carried until 2026-09-09.
  // -------------------------------------------------------------------------

  describe("the claim lease — two overlapping runs must not deliver the same row twice", () => {
    const row = () => ({
      id: "outbox-1",
      attempts: 0,
      nextRetryAt: new Date(Date.now() - 60_000),
      status: "pending",
    });

    it("pushes next_retry_at forward INSIDE the select transaction", async () => {
      // THE WHOLE FIX IN ONE ASSERTION. `FOR UPDATE SKIP LOCKED` releases at
      // commit, before delivery runs, leaving the rows `pending` and still due —
      // a second run starting in that window selects and re-delivers them. The
      // claim has to happen while the lock still holds, which means inside this
      // transaction and not after it.
      const { txUpdateMock, txUpdateSetMock } = mockDeps([row()], [{ ok: true, error: "" }]);
      const before = Date.now();
      await callRoute({ authorization: "Bearer test-secret" });

      expect(txUpdateMock).toHaveBeenCalledTimes(1);
      const claimed = txUpdateSetMock.mock.calls[0][0] as { nextRetryAt: Date };
      expect(claimed.nextRetryAt.getTime()).toBeGreaterThan(before);
    });

    it("leases for LONGER than the run's own budget, so a live run never loses its rows", async () => {
      // The reasoning behind the constant, asserted rather than left in a
      // comment: a lease shorter than MAX_DURATION_MS (45s) would let a run
      // still working have its own batch claimed by the next one — the exact
      // double delivery the lease exists to stop, reintroduced by a number.
      const { txUpdateSetMock } = mockDeps([row()], [{ ok: true, error: "" }]);
      const before = Date.now();
      await callRoute({ authorization: "Bearer test-secret" });

      const claimed = txUpdateSetMock.mock.calls[0][0] as { nextRetryAt: Date };
      expect(claimed.nextRetryAt.getTime() - before).toBeGreaterThan(45_000);
    });

    it("claims nothing when the batch is empty", async () => {
      // NON-VACUITY for the two above: the claim is conditional on there being
      // rows, so a passing assertion elsewhere is not just "update always runs".
      const { txUpdateMock } = mockDeps([], []);
      await callRoute({ authorization: "Bearer test-secret" });
      expect(txUpdateMock).not.toHaveBeenCalled();
    });

    it("lets the failure backoff OVERWRITE the lease, so a retry is not delayed by it", async () => {
      // The lease is a claim, not a schedule. A row whose delivery failed must
      // come back on the backoff's terms (60s in this mock), not sit out the
      // full five-minute lease — otherwise the cure slows every retry down.
      const { updateMock } = mockDeps([row()], [{ ok: false, error: "boom" }]);
      const before = Date.now();
      await callRoute({ authorization: "Bearer test-secret" });

      // The db-level updates are cronRuns start/finish plus this row's result;
      // the row's is the one that carries `attempts`.
      const rowWrite = updateMock.mock.results
        .map((r) => r.value as { set: { mock: { calls: unknown[][] } } })
        .flatMap((v) => v.set.mock.calls.map((c) => c[0] as Record<string, unknown>))
        .find((arg) => typeof arg.attempts === "number");

      expect(rowWrite).toBeDefined();
      expect(rowWrite?.status).toBe("pending");
      // Strictly INSIDE the five-minute lease: the backoff won, so the claim did
      // not survive its own failure. The bound is the lease and not the run
      // budget — the first draft of this assertion used 45s and failed against a
      // 60s backoff that was behaving correctly.
      const delay = (rowWrite?.nextRetryAt as Date).getTime() - before;
      expect(delay).toBeLessThan(5 * 60_000);
      expect(delay).toBeGreaterThan(0);
    });
  });
});
