// Unit tests for GET /api/cron/vaccine-due.
//
// Auth guard + success/error path. The underlying runVaccineDueScan is mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

describe("GET /api/cron/vaccine-due", () => {
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
    const { GET } = await import("@/app/api/cron/vaccine-due/route");
    const req = new Request("http://test.local/api/cron/vaccine-due", { headers });
    return GET(req as unknown as Parameters<typeof GET>[0]);
  }

  it("returns 401 when no auth header is provided", async () => {
    vi.doMock("@/lib/infra/notifications", () => ({
      runVaccineDueScan: vi.fn(),
      runPostAdoptionCheckinScan: vi.fn(),
    }));
    const res = await callRoute({});
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ error: "Unauthorized" });
  });

  it("returns 401 when x-cron-secret does not match", async () => {
    vi.doMock("@/lib/infra/notifications", () => ({
      runVaccineDueScan: vi.fn(),
      runPostAdoptionCheckinScan: vi.fn(),
    }));
    const res = await callRoute({ "x-cron-secret": "wrong" });
    expect(res.status).toBe(401);
  });

  it("returns 401 when Authorization: Bearer does not match", async () => {
    vi.doMock("@/lib/infra/notifications", () => ({
      runVaccineDueScan: vi.fn(),
      runPostAdoptionCheckinScan: vi.fn(),
    }));
    const res = await callRoute({ authorization: "Bearer bad-token" });
    expect(res.status).toBe(401);
  });

  it("returns 200 with scan stats when the secret matches via x-cron-secret", async () => {
    const scannedAt = new Date("2026-06-19T12:00:00.000Z");
    const scanMock = vi.fn().mockResolvedValue({
      scannedAt,
      insertedCount: 5,
      insertedNotificationIds: ["n1", "n2", "n3", "n4", "n5"],
    });
    vi.doMock("@/lib/infra/notifications", () => ({
      runVaccineDueScan: scanMock,
      runPostAdoptionCheckinScan: vi.fn(),
    }));
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      scanned_at: scannedAt.toISOString(),
      inserted_count: 5,
    });
    expect(body.inserted_notification_ids).toHaveLength(5);
    expect(scanMock).toHaveBeenCalledOnce();
  });

  it("returns 200 when the secret matches via Authorization: Bearer", async () => {
    const scannedAt = new Date();
    vi.doMock("@/lib/infra/notifications", () => ({
      runVaccineDueScan: vi.fn().mockResolvedValue({
        scannedAt,
        insertedCount: 0,
        insertedNotificationIds: [],
      }),
      runPostAdoptionCheckinScan: vi.fn(),
    }));
    const res = await callRoute({ authorization: "Bearer test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.inserted_count).toBe(0);
  });

  it("returns 500 with the error message when the helper throws", async () => {
    vi.doMock("@/lib/infra/notifications", () => ({
      runVaccineDueScan: vi.fn().mockRejectedValue(new Error("vaccine scan failed")),
      runPostAdoptionCheckinScan: vi.fn(),
    }));
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "vaccine scan failed" });
  });
});
