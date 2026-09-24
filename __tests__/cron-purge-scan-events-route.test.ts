// Unit tests for GET /api/cron/purge-scan-events.
//
// Branches:
//   1. Auth failure → 401
//   2. Auth success + purge succeeds → 200 { ok: true }
//   3. Auth success + purge throws → 500 { ok: false } (error captured in cron_runs;
//      the route returns HTTP 500 so Vercel flags/retries — review 23 fleet extension)
//
// Both @/db (cronRuns, db) and @/lib/infra/scan-retention (purgeExpiredScanEvents) are mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

const FAKE_RUN_ID = "fake-run-id-9999";

describe("GET /api/cron/purge-scan-events", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.CRON_SECRET = "test-secret";
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
    vi.restoreAllMocks();
    vi.doUnmock("@/lib/infra/scan-retention");
    vi.doUnmock("@/db");
  });

  function mockDeps(purgeImpl: () => Promise<number>) {
    // Mock db: INSERT cronRuns returning → [{id: FAKE_RUN_ID}]
    //         UPDATE cronRuns → no-op
    const whereMock = vi.fn().mockResolvedValue(undefined);
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    const updateMock = vi.fn().mockReturnValue({ set: setMock });
    const returningMock = vi.fn().mockResolvedValue([{ id: FAKE_RUN_ID }]);
    const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
    const insertMock = vi.fn().mockReturnValue({ values: valuesMock });

    const dbMock = {
      insert: insertMock,
      update: updateMock,
    };

    vi.doMock("@/db", () => ({
      db: dbMock,
      cronRuns: {},
    }));

    vi.doMock("@/lib/infra/scan-retention", () => ({
      purgeExpiredScanEvents: vi.fn().mockImplementation(purgeImpl),
    }));

    return { dbMock };
  }

  async function callRoute(headers: Record<string, string>) {
    const { GET } = await import("@/app/api/cron/purge-scan-events/route");
    const req = new Request("http://test.local/api/cron/purge-scan-events", { headers });
    return GET(req as unknown as Parameters<typeof GET>[0]);
  }

  it("returns 401 when no auth header is provided", async () => {
    mockDeps(() => Promise.resolve(0));
    const res = await callRoute({});
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "Unauthorized" });
  });

  it("returns 401 when x-cron-secret does not match", async () => {
    mockDeps(() => Promise.resolve(0));
    const res = await callRoute({ "x-cron-secret": "wrong-secret" });
    expect(res.status).toBe(401);
  });

  it("returns 401 when Authorization: Bearer does not match", async () => {
    mockDeps(() => Promise.resolve(0));
    const res = await callRoute({ authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
  });

  it("returns 200 with ok:true and deleted count when purge succeeds", async () => {
    mockDeps(() => Promise.resolve(42));
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      scanEventsDeleted: 42,
      runId: FAKE_RUN_ID,
    });
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns 200 when auth matches via Authorization: Bearer", async () => {
    mockDeps(() => Promise.resolve(7));
    const res = await callRoute({ authorization: "Bearer test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.scanEventsDeleted).toBe(7);
  });

  it("returns 500 with ok:false when purge throws (Vercel must flag + retry)", async () => {
    mockDeps(() => Promise.reject(new Error("purge failed")));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    // The route captures the error in cron_runs AND returns HTTP 500 so Vercel's
    // cron dashboard flags the run as failed and retries (a cron must not report
    // success on failure — review 23 fleet extension). runId is still returned
    // so the failure can be correlated in cron_runs.
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.runId).toBe(FAKE_RUN_ID);
    errSpy.mockRestore();
  });
});
