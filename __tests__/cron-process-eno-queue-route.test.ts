// Unit tests for GET /api/cron/process-eno-queue.
//
// Auth guard + success/error path. The underlying processEnoQueueBatch is mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

describe("GET /api/cron/process-eno-queue", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.CRON_SECRET = "test-secret";
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
    vi.restoreAllMocks();
    vi.doUnmock("@/lib/infra/eno-queue-processor");
    vi.doUnmock("@/lib/infra/case-cron");
  });

  async function callRoute(headers: Record<string, string>) {
    // Telemetry wrapper passthrough (cursor A1 root cause): the REAL withCronRun
    // writes running/failed rows into the shared local cron_runs table, so the
    // failure fixtures left "proceso no corriendo" noise on /admin. Mirrors the
    // hermetic pattern of cron-close-rabies-observations-route.test.ts. The
    // route derives its own 500-on-failed from the drain totals, so ignoring
    // the summarize callback here loses no assertion.
    vi.doMock("@/lib/infra/case-cron", () => ({
      withCronRun: (_name: string, fn: () => Promise<unknown>) => fn(),
    }));
    const { GET } = await import("@/app/api/cron/process-eno-queue/route");
    const req = new Request("http://test.local/api/cron/process-eno-queue", { headers });
    return GET(req as unknown as Parameters<typeof GET>[0]);
  }

  it("returns 401 when no auth header is provided", async () => {
    vi.doMock("@/lib/infra/eno-queue-processor", () => ({
      processEnoQueueBatch: vi.fn(),
    }));
    const res = await callRoute({});
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ error: "Unauthorized" });
  });

  it("returns 401 when x-cron-secret does not match", async () => {
    vi.doMock("@/lib/infra/eno-queue-processor", () => ({
      processEnoQueueBatch: vi.fn(),
    }));
    const res = await callRoute({ "x-cron-secret": "wrong-secret" });
    expect(res.status).toBe(401);
  });

  it("returns 401 when Authorization: Bearer does not match", async () => {
    vi.doMock("@/lib/infra/eno-queue-processor", () => ({
      processEnoQueueBatch: vi.fn(),
    }));
    const res = await callRoute({ authorization: "Bearer bad-token" });
    expect(res.status).toBe(401);
  });

  it("returns 200 with batch stats when the secret matches via x-cron-secret", async () => {
    const scannedAt = new Date("2026-06-19T12:00:00.000Z");
    // The route drains in batches within one run; return the work once, then an
    // empty batch so the drain loop terminates.
    const batchMock = vi
      .fn()
      .mockResolvedValueOnce({ scannedAt, processed: 10, failed: 0, skipped: 2 })
      .mockResolvedValue({ scannedAt, processed: 0, failed: 0, skipped: 0 });
    vi.doMock("@/lib/infra/eno-queue-processor", () => ({
      processEnoQueueBatch: batchMock,
    }));
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      scanned_at: scannedAt.toISOString(),
      processed: 10,
      failed: 0,
      skipped: 2,
    });
  });

  it("returns 500 when the batch reports failed rows (Vercel must retry the legal-notification queue)", async () => {
    vi.doMock("@/lib/infra/eno-queue-processor", () => ({
      processEnoQueueBatch: vi
        .fn()
        .mockResolvedValueOnce({
          scannedAt: new Date("2026-06-19T12:00:00.000Z"),
          processed: 10,
          failed: 1,
          skipped: 2,
        })
        .mockResolvedValue({
          scannedAt: new Date("2026-06-19T12:00:00.000Z"),
          processed: 0,
          failed: 0,
          skipped: 0,
        }),
    }));
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    // A failed ENO fanout row must surface as a failed cron so Vercel retries.
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, failed: 1 });
  });

  it("returns 200 when the secret matches via Authorization: Bearer", async () => {
    const scannedAt = new Date();
    vi.doMock("@/lib/infra/eno-queue-processor", () => ({
      processEnoQueueBatch: vi.fn().mockResolvedValue({
        scannedAt,
        processed: 0,
        failed: 0,
        skipped: 0,
      }),
    }));
    const res = await callRoute({ authorization: "Bearer test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.processed).toBe(0);
  });

  it("returns 500 when the helper throws", async () => {
    vi.doMock("@/lib/infra/eno-queue-processor", () => ({
      processEnoQueueBatch: vi.fn().mockRejectedValue(new Error("eno processor crashed")),
    }));
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "eno processor crashed" });
  });
});
