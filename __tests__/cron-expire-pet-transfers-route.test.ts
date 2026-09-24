// Unit tests for GET /api/cron/expire-pet-transfers.
//
// Mirrors cron-expire-foster-proposals-route.test.ts:
//   auth guard (401), success path (200), error path (500).
// The underlying helper expirePetTransfersAction is mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

describe("GET /api/cron/expire-pet-transfers", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.CRON_SECRET = "test-secret";
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
    vi.restoreAllMocks();
    vi.doUnmock("@/src/modules/transfers/actions");
    vi.doUnmock("@/lib/infra/case-cron");
  });

  async function callRoute(headers: Record<string, string>) {
    // Telemetry wrapper passthrough (cursor A1 root cause): the REAL withCronRun
    // writes running/failed rows into the shared local cron_runs table, so the
    // failure fixtures left "proceso no corriendo" noise on /admin. Mirrors the
    // hermetic pattern of cron-close-rabies-observations-route.test.ts.
    vi.doMock("@/lib/infra/case-cron", () => ({
      withCronRun: (_name: string, fn: () => Promise<unknown>) => fn(),
    }));
    const { GET } = await import("@/app/api/cron/expire-pet-transfers/route");
    const req = new Request("http://test.local/api/cron/expire-pet-transfers", { headers });
    return GET(req as unknown as Parameters<typeof GET>[0]);
  }

  it("returns 401 when the x-cron-secret header is missing", async () => {
    vi.doMock("@/src/modules/transfers/actions", () => ({
      expirePetTransfersAction: vi.fn(),
    }));
    const res = await callRoute({});
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "Unauthorized" });
  });

  it("returns 401 when the x-cron-secret header does not match", async () => {
    vi.doMock("@/src/modules/transfers/actions", () => ({
      expirePetTransfersAction: vi.fn(),
    }));
    const res = await callRoute({ "x-cron-secret": "bad-secret" });
    expect(res.status).toBe(401);
  });

  it("returns 401 when Authorization: Bearer does not match", async () => {
    vi.doMock("@/src/modules/transfers/actions", () => ({
      expirePetTransfersAction: vi.fn(),
    }));
    const res = await callRoute({ authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
  });

  it("returns 200 with helper stats when the secret matches via x-cron-secret", async () => {
    const expireMock = vi.fn().mockResolvedValue({ candidates: 4, expired: 2, errors: 0 });
    vi.doMock("@/src/modules/transfers/actions", () => ({
      expirePetTransfersAction: expireMock,
    }));
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, candidates: 4, expired: 2, errors: 0 });
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
    expect(expireMock).toHaveBeenCalledOnce();
  });

  it("returns 200 when the secret matches via Authorization: Bearer", async () => {
    const expireMock = vi.fn().mockResolvedValue({ candidates: 0, expired: 0, errors: 0 });
    vi.doMock("@/src/modules/transfers/actions", () => ({
      expirePetTransfersAction: expireMock,
    }));
    const res = await callRoute({ authorization: "Bearer test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("returns 500 when the run had per-row errors (partial failure must not report success)", async () => {
    // The action resolves normally but reports errors > 0 (some transfers failed
    // to expire). The route must surface HTTP 500 so Vercel retries — a cron
    // must not report success on failure (review 23 fleet extension).
    const expireMock = vi.fn().mockResolvedValue({ expired: 2, errors: 1 });
    vi.doMock("@/src/modules/transfers/actions", () => ({
      expirePetTransfersAction: expireMock,
    }));
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, expired: 2, errors: 1 });
  });

  it("returns 500 with the error message when the helper throws", async () => {
    vi.doMock("@/src/modules/transfers/actions", () => ({
      expirePetTransfersAction: vi.fn().mockRejectedValue(new Error("transfer db error")),
    }));
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "transfer db error" });
  });
});
