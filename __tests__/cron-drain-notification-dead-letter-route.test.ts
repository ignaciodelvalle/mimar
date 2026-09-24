// Unit tests for GET /api/cron/drain-notification-dead-letter.
//
// The drainer replays unresolved notification_dead_letter rows through
// createNotification() and stamps resolved_at. Branches:
//   1. Auth failure → 401
//   2. No unresolved rows → 200 { ok: true, scanned: 0, resolved: 0 }
//   3. Row replays successfully (inserted) → resolved, resolved_at stamped
//   4. Row already present (duplicate) → resolved (idempotent)
//   5. Row still fails (dead_lettered again) → stillFailing, original resolved (bounded)
//   6. Malformed payload → invalid, row resolved so it stops blocking the scan
//   7. Global failure (select throws) → ok:false + HTTP 500
//   8. Recipient erased (profile deleted_at set) → not replayed, redacted (A06-G2)
//   9. Every resolve drops the payload (A06-G1) and error_message (HIGH-1)
//  10. A row resolved between scan and lock is not replayed (LOW-1)
//  11. The push leg runs after the replay transaction commits, not inside it,
//      and only for a row that actually landed as new (LOW-A)
//
// Mocks @/db (cronRuns, notificationDeadLetter, profiles, db) +
// @/lib/infra/notification-service + @/lib/infra/web-push.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;
const FAKE_RUN_ID = "dl-run-id-9999";

describe("GET /api/cron/drain-notification-dead-letter", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.CRON_SECRET = "test-secret";
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
    vi.restoreAllMocks();
    vi.doUnmock("@/db");
    vi.doUnmock("@/lib/infra/notification-service");
    vi.doUnmock("@/lib/infra/web-push");
  });

  type Row = { id: string; payload: unknown };

  /** Table sentinel, so the select double can tell the profile lookup apart. */
  const PROFILES = { __table: "profiles" };

  function buildDbMock(
    rows: Row[],
    selectThrows = false,
    erasedUserIds: string[] = [],
    concurrentlyResolvedIds: string[] = [],
  ) {
    const cronInsertReturningMock = vi.fn().mockResolvedValue([{ id: FAKE_RUN_ID }]);
    const cronInsertValuesMock = vi.fn().mockReturnValue({ returning: cronInsertReturningMock });
    const insertMock = vi.fn().mockReturnValue({ values: cronInsertValuesMock });

    const updateWhereMock = vi.fn().mockResolvedValue(undefined);
    const updateSetMock = vi.fn().mockReturnValue({ where: updateWhereMock });
    const updateMock = vi.fn().mockReturnValue({ set: updateSetMock });

    // db.select().from().where().orderBy().limit()
    const limitMock = selectThrows
      ? vi.fn().mockRejectedValue(new Error("db down"))
      : vi.fn().mockResolvedValue(rows);
    const orderByMock = vi.fn().mockReturnValue({ limit: limitMock });
    // The in-transaction re-read of the dead letter: select().from().where().for("update"),
    // one per replayable row, in row order. A row named in concurrentlyResolvedIds
    // was resolved (and redacted) between the scan and the lock (LOW-1).
    const replayable = rows.filter(
      (r) => typeof (r.payload as { title?: unknown } | null)?.title === "string",
    );
    const lockQueue = [...replayable];
    const lockDeadLetterMock = vi.fn(async () => {
      const row = lockQueue.shift();
      if (!row) return [];
      return concurrentlyResolvedIds.includes(row.id)
        ? [{ resolvedAt: new Date(), payload: {} }]
        : [{ resolvedAt: null, payload: row.payload }];
    });
    const whereMock = vi.fn().mockReturnValue({ orderBy: orderByMock, for: lockDeadLetterMock });
    // The recipient lock: select().from(profiles).where().for("share"). Every
    // recipient is a live profile unless the test names it as erased.
    let profileLookupUserId = "";
    const profileLockMock = vi.fn(async (_mode: string) => [
      { deletedAt: erasedUserIds.includes(profileLookupUserId) ? new Date() : null },
    ]);
    const profileChain = {
      where: vi.fn(() => profileChain),
      for: profileLockMock,
    };
    const fromMock = vi.fn((table: unknown) =>
      table === PROFILES ? profileChain : { where: whereMock },
    );
    // The route asks about one recipient at a time, in row order — an
    // unreplayable row never reaches the lookup, so it is not queued.
    const recipientQueue = replayable.map((r) =>
      String((r.payload as { userId?: unknown }).userId),
    );
    const selectMock = vi.fn(() => ({
      from: (table: unknown) => {
        if (table === PROFILES) profileLookupUserId = recipientQueue.shift() ?? "";
        return fromMock(table);
      },
    }));

    const dbMock: Record<string, unknown> = {
      insert: insertMock,
      update: updateMock,
      select: selectMock,
    };
    // The replay runs in a transaction; the double hands the same chains to it.
    const transactionMock = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(dbMock));
    dbMock.transaction = transactionMock;
    return { dbMock, updateSetMock, transactionMock, lockDeadLetterMock, profileLockMock };
  }

  function mockDeps(
    rows: Row[],
    createResults: Array<{ status: "inserted" | "duplicate" | "dead_lettered" }>,
    selectThrows = false,
    erasedUserIds: string[] = [],
    concurrentlyResolvedIds: string[] = [],
  ) {
    const { dbMock, updateSetMock, transactionMock, lockDeadLetterMock, profileLockMock } =
      buildDbMock(rows, selectThrows, erasedUserIds, concurrentlyResolvedIds);
    vi.doMock("@/db", () => ({
      db: dbMock,
      cronRuns: {},
      profiles: Object.assign(PROFILES, { id: {}, deletedAt: {} }),
      notificationDeadLetter: {
        resolvedAt: {},
        createdAt: {},
        id: {},
        payload: {},
      },
    }));

    let i = 0;
    const createMock = vi.fn().mockImplementation(() => {
      const r = createResults[i] ?? { status: "inserted" };
      i += 1;
      return Promise.resolve({ ...r, id: r.status === "inserted" ? "n1" : null });
    });
    vi.doMock("@/lib/infra/notification-service", async () => {
      // toInput (notification-dead-letter-replay.ts) validates severity
      // against NOTIFICATION_SEVERITIES now (A06-G4) — the mock must carry the
      // REAL export, not a hand-copied literal, so a future severity added to
      // (or dropped from) the real list cannot silently drift from this test.
      const actual = await vi.importActual<typeof import("@/lib/infra/notification-service")>(
        "@/lib/infra/notification-service",
      );
      return {
        createNotification: createMock,
        NOTIFICATION_SEVERITIES: actual.NOTIFICATION_SEVERITIES,
      };
    });

    const pushMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/infra/web-push", () => ({
      sendPushForNotifications: pushMock,
    }));

    return {
      createMock,
      updateSetMock,
      transactionMock,
      lockDeadLetterMock,
      profileLockMock,
      pushMock,
    };
  }

  const validPayload = {
    userId: "u1",
    notificationType: "test_notif",
    title: "Hola",
    dedupeKey: "k1",
    body: "cuerpo",
    severity: "info",
  };

  async function callRoute(headers: Record<string, string>) {
    const { GET } = await import("@/app/api/cron/drain-notification-dead-letter/route");
    const req = new Request("http://test.local/api/cron/drain-notification-dead-letter", {
      headers,
    });
    return GET(req as unknown as Parameters<typeof GET>[0]);
  }

  it("returns 401 when no auth header is provided", async () => {
    mockDeps([], []);
    const res = await callRoute({});
    expect(res.status).toBe(401);
  });

  it("returns 200 with zero counts when there are no unresolved rows", async () => {
    mockDeps([], []);
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, scanned: 0, resolved: 0, stillFailing: 0, invalid: 0 });
  });

  it("resolves a row that replays successfully", async () => {
    const { createMock } = mockDeps(
      [{ id: "dl-1", payload: validPayload }],
      [{ status: "inserted" }],
    );
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, scanned: 1, resolved: 1, stillFailing: 0 });
    expect(createMock).toHaveBeenCalledOnce();
    // LOW-A: the push leg must never run inside the replay transaction — the
    // in-tx call always suppresses it.
    expect(createMock.mock.calls[0][0]).toMatchObject({ suppressPush: true });
  });

  // A06-G4: "success" joined notification-service.ts's severity union on
  // 2026-08-19, but the drain's own validator (toInput) still tested only
  // warning/urgent/info and fell through to `undefined` — createNotification's
  // `input.severity ?? "info"` then silently downgraded a replayed success
  // notification. Pinned against NOTIFICATION_SEVERITIES (the shared list) so
  // this cannot regress the way the hand-written `===` chain did.
  it("replays a success-severity payload without downgrading it to info", async () => {
    const { createMock } = mockDeps(
      [{ id: "dl-14", payload: { ...validPayload, severity: "success" } }],
      [{ status: "inserted" }],
    );
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, scanned: 1, resolved: 1, stillFailing: 0, invalid: 0 });
    expect(createMock.mock.calls[0][0]).toMatchObject({ severity: "success" });
  });

  // LOW-A: a stalled push has no timeout and must not hold the profile's FOR
  // SHARE lock, which a waiting art. 16 erasure blocks on. The push leg runs
  // only after the replay transaction has committed.
  it("sends the push after the replay transaction commits, not inside it", async () => {
    const { pushMock, transactionMock } = mockDeps(
      [{ id: "dl-11", payload: validPayload }],
      [{ status: "inserted" }],
    );
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);

    expect(pushMock).toHaveBeenCalledOnce();
    expect(pushMock).toHaveBeenCalledWith([
      expect.objectContaining({
        userId: validPayload.userId,
        dedupeKey: validPayload.dedupeKey,
        title: validPayload.title,
      }),
    ]);
    // Ordering: transaction settles before the push fires.
    expect(transactionMock.mock.invocationCallOrder[0]).toBeLessThan(
      pushMock.mock.invocationCallOrder[0],
    );
  });

  it.each([["duplicate" as const], ["dead_lettered" as const]])(
    "does not push a row that replayed as %s",
    async (status) => {
      const { pushMock } = mockDeps([{ id: "dl-12", payload: validPayload }], [{ status }]);
      const res = await callRoute({ "x-cron-secret": "test-secret" });
      expect([200, 500]).toContain(res.status);
      expect(pushMock).not.toHaveBeenCalled();
    },
  );

  it("does not push an erased recipient's row", async () => {
    const { pushMock } = mockDeps(
      [{ id: "dl-13", payload: { ...validPayload, userId: "erased-user" } }],
      [],
      false,
      ["erased-user"],
    );
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("resolves a duplicate (idempotent) row", async () => {
    mockDeps([{ id: "dl-2", payload: validPayload }], [{ status: "duplicate" }]);
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, scanned: 1, resolved: 1, stillFailing: 0 });
  });

  it("counts a re-dead-lettered row as stillFailing but keeps it bounded (resolves original)", async () => {
    const { updateSetMock } = mockDeps(
      [{ id: "dl-3", payload: validPayload }],
      [{ status: "dead_lettered" }],
    );
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    const body = await res.json();
    // A run that left a payload still failing redelivery is NOT healthy: it now
    // returns HTTP 500 with ok:false so Vercel flags/retries (review 23 fleet
    // extension). The counters are still surfaced for triage.
    expect(res.status).toBe(500);
    expect(body).toMatchObject({ ok: false, scanned: 1, resolved: 0, stillFailing: 1 });
    // resolved_at IS stamped on the original even when re-dead-lettered (bounded).
    const stampedResolved = updateSetMock.mock.calls.some(
      (c) => (c[0] as { resolvedAt?: unknown }).resolvedAt instanceof Date,
    );
    expect(stampedResolved).toBe(true);
  });

  it("marks a malformed payload as invalid and resolves it (run fails, HTTP 500)", async () => {
    const { createMock } = mockDeps([{ id: "dl-4", payload: { userId: "u1" } }], []);
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    const body = await res.json();
    // An unreplayable payload counts as an error, so the run fails (HTTP 500) and
    // Vercel retries — a cron must not report success on failure (review 23 fleet
    // extension). The row is still resolved so it stops blocking the scan.
    expect(res.status).toBe(500);
    expect(body).toMatchObject({ ok: false, scanned: 1, invalid: 1, resolved: 0 });
    // Never attempted a replay for an unreplayable payload.
    expect(createMock).not.toHaveBeenCalled();
  });

  // A06-G2: a subject who exercised art. 16 must not get the notification back.
  it("does not replay a row whose recipient was erased, and redacts it", async () => {
    const { createMock, updateSetMock } = mockDeps(
      [
        { id: "dl-5", payload: { ...validPayload, userId: "erased-user" } },
        { id: "dl-6", payload: validPayload },
      ],
      [{ status: "inserted" }],
      false,
      ["erased-user"],
    );
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, scanned: 2, resolved: 1, skippedErased: 1 });
    // Only the live recipient's row was replayed.
    expect(createMock).toHaveBeenCalledOnce();
    expect(createMock.mock.calls[0][0]).toMatchObject({ userId: "u1" });
    // Both rows were resolved with their payload dropped.
    const redactions = updateSetMock.mock.calls.filter(
      (c) => JSON.stringify((c[0] as { payload?: unknown }).payload) === "{}",
    );
    expect(redactions).toHaveLength(2);
  });

  // A06-G1: a resolved dead letter keeps no copy of the notification.
  it.each([["inserted" as const], ["duplicate" as const], ["dead_lettered" as const]])(
    "drops the payload when it resolves a row that replayed as %s",
    async (status) => {
      const { updateSetMock } = mockDeps([{ id: "dl-7", payload: validPayload }], [{ status }]);
      await callRoute({ "x-cron-secret": "test-secret" });

      const resolving = updateSetMock.mock.calls
        .map((c) => c[0] as { resolvedAt?: unknown; payload?: unknown })
        .filter((set) => set.resolvedAt instanceof Date);
      expect(resolving).toHaveLength(1);
      expect(resolving[0].payload).toEqual({});
      // HIGH-1: error_message may hold drizzle's query params — the same
      // notification again — so the resolve clears it as well.
      expect(resolving[0]).toMatchObject({ errorMessage: "[redacted]" });
    },
  );

  it("drops the payload of an unreplayable row too", async () => {
    const { updateSetMock } = mockDeps([{ id: "dl-8", payload: { userId: "u1" } }], []);
    await callRoute({ "x-cron-secret": "test-secret" });

    const resolving = updateSetMock.mock.calls
      .map((c) => c[0] as { resolvedAt?: unknown; payload?: unknown })
      .filter((set) => set.resolvedAt instanceof Date);
    expect(resolving).toEqual([
      expect.objectContaining({ payload: {}, errorMessage: "[redacted]" }),
    ]);
  });

  // LOW-1: an erasure (or another run) that commits between the scan and the
  // replay must win — the replay re-reads the row under lock and stands down.
  it("does not replay a row resolved between the scan and the lock", async () => {
    const { createMock, updateSetMock } = mockDeps(
      [{ id: "dl-9", payload: validPayload }],
      [{ status: "inserted" }],
      false,
      [],
      ["dl-9"],
    );
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, scanned: 1, resolved: 0, skippedConcurrent: 1 });
    expect(createMock).not.toHaveBeenCalled();
    // Nothing to resolve: the row is already resolved and redacted. (The one
    // update left is the cron_runs bookkeeping.)
    const resolving = updateSetMock.mock.calls.filter(
      (c) => (c[0] as { resolvedAt?: unknown }).resolvedAt instanceof Date,
    );
    expect(resolving).toHaveLength(0);
  });

  it("replays inside a transaction holding the recipient FOR SHARE and the row FOR UPDATE", async () => {
    const { transactionMock, lockDeadLetterMock, profileLockMock } = mockDeps(
      [{ id: "dl-10", payload: validPayload }],
      [{ status: "inserted" }],
    );
    await callRoute({ "x-cron-secret": "test-secret" });

    expect(transactionMock).toHaveBeenCalledOnce();
    expect(profileLockMock).toHaveBeenCalledWith("share");
    expect(lockDeadLetterMock).toHaveBeenCalledWith("update");
    // Profile first, then the dead letter: erase_subject_data's order, so no deadlock.
    expect(profileLockMock.mock.invocationCallOrder[0]).toBeLessThan(
      lockDeadLetterMock.mock.invocationCallOrder[0],
    );
  });

  it("returns ok:false + HTTP 500 when the scan throws", async () => {
    mockDeps([], [], true);
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});
