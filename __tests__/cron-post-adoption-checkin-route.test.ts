// Unit tests for GET /api/cron/post-adoption-checkin.
//
// Auth guard + success/error path. The underlying runPostAdoptionCheckinScan is mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

describe("GET /api/cron/post-adoption-checkin", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.CRON_SECRET = "test-secret";
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
    vi.restoreAllMocks();
    vi.doUnmock("@/lib/infra/notifications");
    vi.doUnmock("@/lib/infra/case-cron");
  });

  async function callRoute(headers: Record<string, string>) {
    // Telemetry wrapper passthrough (cursor A1 root cause): the REAL withCronRun
    // writes running/failed rows into the shared local cron_runs table, so the
    // 500-path fixtures left "proceso no corriendo" noise on /admin. Mirrors the
    // hermetic pattern of cron-close-rabies-observations-route.test.ts.
    vi.doMock("@/lib/infra/case-cron", () => ({
      withCronRun: (_name: string, fn: () => Promise<unknown>) => fn(),
    }));
    const { GET } = await import("@/app/api/cron/post-adoption-checkin/route");
    const req = new Request("http://test.local/api/cron/post-adoption-checkin", { headers });
    return GET(req as unknown as Parameters<typeof GET>[0]);
  }

  it("returns 401 when no auth header is provided", async () => {
    vi.doMock("@/lib/infra/notifications", () => ({
      runPostAdoptionCheckinScan: vi.fn(),
      runVaccineDueScan: vi.fn(),
    }));
    const res = await callRoute({});
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ error: "Unauthorized" });
  });

  it("returns 401 when x-cron-secret does not match", async () => {
    vi.doMock("@/lib/infra/notifications", () => ({
      runPostAdoptionCheckinScan: vi.fn(),
      runVaccineDueScan: vi.fn(),
    }));
    const res = await callRoute({ "x-cron-secret": "wrong-secret" });
    expect(res.status).toBe(401);
  });

  it("returns 401 when Authorization: Bearer does not match", async () => {
    vi.doMock("@/lib/infra/notifications", () => ({
      runPostAdoptionCheckinScan: vi.fn(),
      runVaccineDueScan: vi.fn(),
    }));
    const res = await callRoute({ authorization: "Bearer bad-token" });
    expect(res.status).toBe(401);
  });

  it("returns 200 with scan stats when the secret matches via x-cron-secret", async () => {
    const scannedAt = new Date("2026-06-19T12:00:00.000Z");
    const scanMock = vi.fn().mockResolvedValue({
      scannedAt,
      proactiveInsertedIds: ["p1", "p2"],
      missedInsertedIds: ["m1"],
    });
    vi.doMock("@/lib/infra/notifications", () => ({
      runPostAdoptionCheckinScan: scanMock,
      runVaccineDueScan: vi.fn(),
    }));
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      scanned_at: scannedAt.toISOString(),
      proactive_inserted_count: 2,
      missed_inserted_count: 1,
    });
    expect(body.proactive_inserted_ids).toEqual(["p1", "p2"]);
    expect(body.missed_inserted_ids).toEqual(["m1"]);
    expect(scanMock).toHaveBeenCalledOnce();
  });

  it("returns 200 when the secret matches via Authorization: Bearer", async () => {
    const scannedAt = new Date();
    vi.doMock("@/lib/infra/notifications", () => ({
      runPostAdoptionCheckinScan: vi.fn().mockResolvedValue({
        scannedAt,
        proactiveInsertedIds: [],
        missedInsertedIds: [],
      }),
      runVaccineDueScan: vi.fn(),
    }));
    const res = await callRoute({ authorization: "Bearer test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.proactive_inserted_count).toBe(0);
    expect(body.missed_inserted_count).toBe(0);
  });

  it("returns 500 when the helper throws", async () => {
    vi.doMock("@/lib/infra/notifications", () => ({
      runPostAdoptionCheckinScan: vi.fn().mockRejectedValue(new Error("checkin scan failed")),
      runVaccineDueScan: vi.fn(),
    }));
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "checkin scan failed" });
  });
});
