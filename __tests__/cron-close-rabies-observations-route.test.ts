// Unit tests for GET /api/cron/close-rabies-observations.
//
// Mirrors cron-expire-foster-proposals-route.test.ts exactly:
//   auth guard (401 on missing / wrong secret), success path (200), error path (500).
// The underlying helper closeEligibleRabiesObservations is mocked so the test
// stays pure (no DB access).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

describe("GET /api/cron/close-rabies-observations", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.CRON_SECRET = "test-secret";
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
    vi.restoreAllMocks();
    vi.doUnmock("@/lib/infra/rabies-observation-closer");
    vi.doUnmock("@/lib/infra/case-cron");
  });

  async function callRoute(headers: Record<string, string>) {
    // Telemetry wrapper (fleet telemetry, 2026-07-03): passthrough so the
    // pure route test doesn't need a cron_runs-capable db mock.
    vi.doMock("@/lib/infra/case-cron", () => ({
      withCronRun: (_name: string, fn: () => Promise<unknown>) => fn(),
      // Route reads the keyset resume cursor before the sweep (fleet extension).
      readLastRunDetail: vi.fn().mockResolvedValue(null),
    }));
    const { GET } = await import("@/app/api/cron/close-rabies-observations/route");
    const req = new Request("http://test.local/api/cron/close-rabies-observations", { headers });
    return GET(req as unknown as Parameters<typeof GET>[0]);
  }

  it("returns 401 when the x-cron-secret header is missing", async () => {
    vi.doMock("@/lib/infra/rabies-observation-closer", () => ({
      closeEligibleRabiesObservations: vi.fn(),
    }));
    const res = await callRoute({});
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "Unauthorized" });
  });

  it("returns 401 when the x-cron-secret header does not match", async () => {
    vi.doMock("@/lib/infra/rabies-observation-closer", () => ({
      closeEligibleRabiesObservations: vi.fn(),
    }));
    const res = await callRoute({ "x-cron-secret": "wrong-value" });
    expect(res.status).toBe(401);
  });

  it("returns 401 when the Authorization: Bearer header does not match", async () => {
    vi.doMock("@/lib/infra/rabies-observation-closer", () => ({
      closeEligibleRabiesObservations: vi.fn(),
    }));
    const res = await callRoute({ authorization: "Bearer wrong-secret" });
    expect(res.status).toBe(401);
  });

  it("returns 200 with helper stats when the secret matches via x-cron-secret", async () => {
    const closeMock = vi.fn().mockResolvedValue({ closed: 3, skipped: 1, errors: 0 });
    vi.doMock("@/lib/infra/rabies-observation-closer", () => ({
      closeEligibleRabiesObservations: closeMock,
    }));
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, closed: 3, skipped: 1, errors: 0 });
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
    expect(closeMock).toHaveBeenCalledOnce();
  });

  it("returns 200 when the secret matches via Authorization: Bearer", async () => {
    const closeMock = vi.fn().mockResolvedValue({ closed: 0, skipped: 0, errors: 0 });
    vi.doMock("@/lib/infra/rabies-observation-closer", () => ({
      closeEligibleRabiesObservations: closeMock,
    }));
    const res = await callRoute({ authorization: "Bearer test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("returns 500 with the error message when the helper throws", async () => {
    vi.doMock("@/lib/infra/rabies-observation-closer", () => ({
      closeEligibleRabiesObservations: vi.fn().mockRejectedValue(new Error("db connection lost")),
    }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "db connection lost" });
    errSpy.mockRestore();
  });
});
