// Unit tests for GET /api/cron/business-rules-reeval.
//
// Branches:
//   1. Auth failure → 401
//   2. Auth success + db query returns rows + reEvaluatePppClassificationChange succeeds → 200
//   3. Auth success + handler throws → 500
//   4. Bounded sweep: MAX_SCOPES_PER_RUN caps scopes processed per run and
//      persists `nextScopeIndex`; a later run resumes from it and wraps to 0
//      once every scope in the cycle has been covered.
//
// Both db (@/db) and reEvaluatePppClassificationChange
// (@/lib/infra/business-rules-reeval) are mocked so the test stays pure (no
// DB access). NOTE: the mock path was previously "@/lib/business-rules-
// reeval" (stale — the module lives at "@/lib/infra/business-rules-reeval"),
// so vi.doMock never intercepted the real import and this suite silently ran
// against the REAL (unmocked) implementation. Fixed alongside the
// admin-rules-console reeval generalization.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

// Identity markers so the `@/db` mock's `db.select(...).from(table)` can
// branch on which table is being queried: govtBusinessRules (jurisdiction
// rows) vs cron_runs (resume-cursor lookup, added by the boundedness fix).
const GOVT_RULES_TABLE = { __table: "govt_business_rules" };
const CRON_RUNS_TABLE = { __table: "cron_runs" };

describe("GET /api/cron/business-rules-reeval", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.CRON_SECRET = "test-secret";
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
    vi.restoreAllMocks();
    vi.doUnmock("@/lib/infra/business-rules-reeval");
    vi.doUnmock("@/lib/infra/case-cron");
    vi.doUnmock("@/db");
  });

  /**
   * `lastRunDetails`, when provided, simulates a previously FINISHED
   * cron_runs row for this cron whose `details.nextScopeIndex` the route
   * should resume from. Omit it to simulate "no prior run" (fresh cycle).
   */
  function mockDeps(
    rows: { country: string; province: string | null; locality: string | null }[],
    reEvalResult: {
      scanned: number;
      flippedToPpp: number;
      flippedToNonPpp: number;
      notified: number;
    },
    lastRunDetails?: Record<string, unknown>,
  ) {
    // govtBusinessRules SELECT: db.select().from(govtBusinessRules).where() → rows
    const rulesWhereMock = vi.fn().mockResolvedValue(rows);

    // cron_runs SELECT (resume-cursor lookup): db.select({details}).from(cronRuns)
    //   .where().orderBy().limit(1)
    const cronRunsLimitMock = vi
      .fn()
      .mockResolvedValue(lastRunDetails !== undefined ? [{ details: lastRunDetails }] : []);
    const cronRunsOrderByMock = vi.fn().mockReturnValue({ limit: cronRunsLimitMock });
    const cronRunsWhereMock = vi.fn().mockReturnValue({ orderBy: cronRunsOrderByMock });

    const fromMock = vi.fn().mockImplementation((table: unknown) => {
      if (table === CRON_RUNS_TABLE) {
        return { where: cronRunsWhereMock };
      }
      return { where: rulesWhereMock };
    });
    const selectMock = vi.fn().mockReturnValue({ from: fromMock });
    const dbMock = { select: selectMock };

    vi.doMock("@/db", () => ({
      db: dbMock,
      govtBusinessRules: GOVT_RULES_TABLE,
      cronRuns: CRON_RUNS_TABLE,
    }));

    const reEvalMock = vi.fn().mockResolvedValue(reEvalResult);
    vi.doMock("@/lib/infra/business-rules-reeval", () => ({
      reEvaluatePppClassificationChange: reEvalMock,
    }));

    // Telemetry wrapper (fleet telemetry, 2026-07-03): passthrough so the
    // pure route test doesn't need a cron_runs-capable db mock.
    vi.doMock("@/lib/infra/case-cron", () => ({
      withCronRun: (_name: string, fn: () => Promise<unknown>) => fn(),
    }));

    return { reEvalMock };
  }

  async function callRoute(headers: Record<string, string>) {
    const { GET } = await import("@/app/api/cron/business-rules-reeval/route");
    const req = new Request("http://test.local/api/cron/business-rules-reeval", { headers });
    return GET(req as unknown as Parameters<typeof GET>[0]);
  }

  it("returns 401 when no auth header is provided", async () => {
    mockDeps([], { scanned: 0, flippedToPpp: 0, flippedToNonPpp: 0, notified: 0 });
    const res = await callRoute({});
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "Unauthorized" });
  });

  it("returns 401 when x-cron-secret does not match", async () => {
    mockDeps([], { scanned: 0, flippedToPpp: 0, flippedToNonPpp: 0, notified: 0 });
    const res = await callRoute({ "x-cron-secret": "wrong" });
    expect(res.status).toBe(401);
  });

  it("returns 200 with aggregated stats when auth passes and no extra jurisdiction rows", async () => {
    // No extra rows → only the default AR scope is processed.
    const { reEvalMock } = mockDeps([], {
      scanned: 10,
      flippedToPpp: 2,
      flippedToNonPpp: 1,
      notified: 3,
    });
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      scopes: 1,
      scanned: 10,
      flippedToPpp: 2,
      flippedToNonPpp: 1,
      notified: 3,
    });
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
    // One call for the default AR scope. (First arg is the scope; a second
    // options arg carries the per-scope deadline — assert on the scope only.)
    expect(reEvalMock).toHaveBeenCalledTimes(1);
    expect(reEvalMock.mock.calls[0][0]).toEqual({ country: "AR", province: null, locality: null });
  });

  it("returns 200 and processes multiple jurisdiction scopes when db rows are returned", async () => {
    const extraRows = [
      { country: "AR", province: "Buenos Aires", locality: null },
      { country: "AR", province: "Buenos Aires", locality: "Mar del Plata" },
    ];
    const { reEvalMock } = mockDeps(extraRows, {
      scanned: 5,
      flippedToPpp: 0,
      flippedToNonPpp: 0,
      notified: 0,
    });
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    // 1 default AR + 2 extra rows = 3 scopes total
    expect(body.scopes).toBe(3);
    expect(body.scanned).toBe(15); // 3 × 5
    // reEvalMock called once per scope
    expect(reEvalMock).toHaveBeenCalledTimes(3);
  });

  it("returns 200 when auth matches via Authorization: Bearer", async () => {
    mockDeps([], { scanned: 0, flippedToPpp: 0, flippedToNonPpp: 0, notified: 0 });
    const res = await callRoute({ authorization: "Bearer test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("returns 500 when db query throws", async () => {
    // cron_runs resume-cursor lookup succeeds (no prior run) — the
    // govtBusinessRules query is the one that throws, inside withCronRun's fn.
    const rulesWhereMock = vi.fn().mockRejectedValue(new Error("db query failed"));
    const cronRunsLimitMock = vi.fn().mockResolvedValue([]);
    const cronRunsOrderByMock = vi.fn().mockReturnValue({ limit: cronRunsLimitMock });
    const cronRunsWhereMock = vi.fn().mockReturnValue({ orderBy: cronRunsOrderByMock });
    const fromMock = vi.fn().mockImplementation((table: unknown) => {
      if (table === CRON_RUNS_TABLE) {
        return { where: cronRunsWhereMock };
      }
      return { where: rulesWhereMock };
    });
    const selectMock = vi.fn().mockReturnValue({ from: fromMock });
    vi.doMock("@/db", () => ({
      db: { select: selectMock },
      govtBusinessRules: GOVT_RULES_TABLE,
      cronRuns: CRON_RUNS_TABLE,
    }));
    vi.doMock("@/lib/infra/business-rules-reeval", () => ({
      reEvaluatePppClassificationChange: vi.fn(),
    }));
    // This case builds its own mocks (doesn't go through mockDeps), so the
    // telemetry-wrapper passthrough must be re-declared here too.
    vi.doMock("@/lib/infra/case-cron", () => ({
      withCronRun: (_name: string, fn: () => Promise<unknown>) => fn(),
    }));
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "db query failed" });
  });

  // ---------------------------------------------------------------------------
  // Bounded sweep — the fix under test. Three total scopes this cycle:
  // AR default, "Buenos Aires", "Cordoba" (sorted by scopeKey so AR default,
  // with empty province/locality, always sorts first).
  //
  // Run 1 stops early (time budget forced via a Date.now spy) right after
  // covering the AR-default scope ("scope A") and persists nextScopeIndex=1.
  // Run 2 reads that cursor and resumes with "Buenos Aires" ("scope B")
  // FIRST — proving it picked up where run 1 left off instead of restarting
  // from scope 0 — then completes the cycle and wraps back to index 0.
  // ---------------------------------------------------------------------------

  const THREE_SCOPE_ROWS = [
    { country: "AR", province: "Buenos Aires", locality: null },
    { country: "AR", province: "Cordoba", locality: null },
  ];

  it("run 1: stops early on the time budget and persists nextScopeIndex", async () => {
    const { reEvalMock } = mockDeps(THREE_SCOPE_ROWS, {
      scanned: 1,
      flippedToPpp: 0,
      flippedToNonPpp: 0,
      notified: 0,
    });

    // Force the time-budget check to trip immediately AFTER the first scope
    // is processed: call 1 = `start`, call 2 = pre-loop budget check (still
    // under budget), call 3 = the next iteration's budget check (over budget).
    let calls = 0;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => (calls++ < 2 ? 0 : 999_999_999));

    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchObject({
      ok: true,
      scopesTotal: 3,
      scopes: 1,
      earlyStop: true,
      nextScopeIndex: 1,
    });
    // Only the AR-default scope (index 0, sorts first) was processed.
    expect(reEvalMock).toHaveBeenCalledTimes(1);
    expect(reEvalMock.mock.calls[0][0]).toEqual({ country: "AR", province: null, locality: null });

    dateSpy.mockRestore();
  });

  it("run 2: resumes from the persisted nextScopeIndex and wraps to 0 after a full cycle", async () => {
    const { reEvalMock } = mockDeps(
      THREE_SCOPE_ROWS,
      { scanned: 1, flippedToPpp: 0, flippedToNonPpp: 0, notified: 0 },
      // Simulate run 1's persisted cursor: resume at index 1 ("Buenos Aires").
      { nextScopeIndex: 1 },
    );

    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();

    // A full, uninterrupted cycle covers every scope once (3 total) and
    // wraps the cursor back to 0 for the next cycle.
    expect(body).toMatchObject({
      ok: true,
      scopesTotal: 3,
      scopes: 3,
      earlyStop: false,
      nextScopeIndex: 0,
    });
    expect(reEvalMock).toHaveBeenCalledTimes(3);
    // The FIRST scope processed this run is "Buenos Aires" (index 1) — proof
    // the run resumed from the persisted cursor instead of restarting at the
    // AR-default scope (index 0).
    expect(reEvalMock.mock.calls[0][0]).toEqual({
      country: "AR",
      province: "Buenos Aires",
      locality: null,
    });
  });

  it("caps scopes processed per run at MAX_SCOPES_PER_RUN even with no time pressure", async () => {
    // 30 extra jurisdiction rows + the AR default = 31 total scopes, well
    // over the MAX_SCOPES_PER_RUN=25 hard cap.
    const manyRows = Array.from({ length: 30 }, (_, i) => ({
      country: "AR",
      province: `Province-${String(i).padStart(2, "0")}`,
      locality: null,
    }));
    const { reEvalMock } = mockDeps(manyRows, {
      scanned: 1,
      flippedToPpp: 0,
      flippedToNonPpp: 0,
      notified: 0,
    });

    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchObject({ ok: true, scopesTotal: 31, scopes: 25, earlyStop: true });
    expect(reEvalMock).toHaveBeenCalledTimes(25);
  });
});
