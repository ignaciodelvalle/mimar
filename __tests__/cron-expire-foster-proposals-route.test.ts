// Unit test for the GET handler at app/api/cron/expire-foster-proposals/route.ts.
//
// Scope: the route is a thin auth gate around expireFosterProposals(). The
// helper itself has integration coverage in foster-proposal-expirer.test.ts.
// Here we only verify the CRON_SECRET header check and the success response
// shape. The helper is mocked so the test stays pure.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

describe("GET /api/cron/expire-foster-proposals", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.CRON_SECRET = "test-secret";
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
    vi.restoreAllMocks();
    vi.doUnmock("@/src/modules/foster/actions");
    vi.doUnmock("@/lib/infra/case-cron");
  });

  async function callRoute(headers: Record<string, string>) {
    // Telemetry wrapper passthrough (cursor A1 root cause): the REAL withCronRun
    // writes running/failed rows into the shared local cron_runs table, so the
    // failure fixtures left "proceso no corriendo" noise on /admin. Mirrors the
    // hermetic pattern of cron-close-rabies-observations-route.test.ts. The
    // route derives its own 500-on-errors from the helper stats, so ignoring
    // the summarize callback here loses no assertion.
    vi.doMock("@/lib/infra/case-cron", () => ({
      withCronRun: (_name: string, fn: () => Promise<unknown>) => fn(),
    }));
    const { GET } = await import("@/app/api/cron/expire-foster-proposals/route");
    const req = new Request("http://test.local/api/cron/expire-foster-proposals", { headers });
    // The route handler signature accepts NextRequest, which is structurally
    // compatible with a plain Request for header inspection; cast through
    // unknown to keep the test from depending on the next/server type.
    return GET(req as unknown as Parameters<typeof GET>[0]);
  }

  it("returns 401 when the x-cron-secret header is missing", async () => {
    vi.doMock("@/src/modules/foster/actions", () => ({
      expireFosterProposalsAction: vi.fn(),
    }));
    const res = await callRoute({});
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "Unauthorized" });
  });

  it("returns 401 when the x-cron-secret header does not match", async () => {
    vi.doMock("@/src/modules/foster/actions", () => ({
      expireFosterProposalsAction: vi.fn(),
    }));
    const res = await callRoute({ "x-cron-secret": "wrong-value" });
    expect(res.status).toBe(401);
  });

  it("returns 200 with helper stats when the secret matches", async () => {
    const expireMock = vi.fn().mockResolvedValue({ candidates: 5, expired: 3, errors: 0 });
    vi.doMock("@/src/modules/foster/actions", () => ({
      expireFosterProposalsAction: expireMock,
    }));
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      candidates: 5,
      expired: 3,
      errors: 0,
    });
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
    expect(expireMock).toHaveBeenCalledOnce();
  });

  it("returns 500 when the run had per-row errors (partial failure must not report success)", async () => {
    // The action resolves normally but reports errors > 0 (some proposals failed
    // to expire). The route must surface HTTP 500 so Vercel retries — a cron
    // must not report success on failure (review 23 fleet extension).
    const expireMock = vi.fn().mockResolvedValue({ candidates: 5, expired: 3, errors: 2 });
    vi.doMock("@/src/modules/foster/actions", () => ({
      expireFosterProposalsAction: expireMock,
    }));
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, candidates: 5, expired: 3, errors: 2 });
  });

  it("returns 500 with the error message when the helper throws", async () => {
    vi.doMock("@/src/modules/foster/actions", () => ({
      expireFosterProposalsAction: vi.fn().mockRejectedValue(new Error("db down")),
    }));
    // Silence the expected console.error for clean test output.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "db down" });
    errSpy.mockRestore();
  });
});
