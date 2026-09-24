// Unit tests for GET /api/cron/reconcile-pet-status.
//
// Branches:
//   1. Auth failure → 401
//   2. Auth success + no pets → 200 { ok: true, scanned: 0, divergent: 0 }
//   3. Auth success + all pets match → 200 { ok: true, scanned: N, divergent: 0 }
//   4. Auth success + one pet drifted → 200 { ok: true, divergent: 1, sample contains entry }
//   5. Auth success + rederive throws for one pet → error captured in details, run stays ok
//   6. Auth success + Authorization: Bearer header variant
//   7. Cursor persistence: earlyStop persists `nextCursor`; a later run reads
//      the previous run's `nextCursor` from cron_runs and resumes from it,
//      wrapping back to null once it reaches the end of the table.
//   8. Drift alert: divergent > 0 sends a "warning"-severity sendCronAlert
//      with the sample + count; divergent === 0 sends no alert.
//   9. Wider report (finding A08-3): drift outside the status family is
//      counted per family into details.familyDrift and pages through its OWN
//      alert — it never moves `divergent`, and status drift never triggers it.
//
// Mocks: @/db (cronRuns, pets, db) + @/lib/infra/rederive-pet-cache (rederivePetCache, hasDrift, driftedColumns)
//   + @/lib/infra/cron-alert (sendCronAlert, mocked only in the drift-alert
//     tests — other tests leave it unmocked, which is safe: the real
//     implementation no-ops when CRON_ALERT_WEBHOOK is unset, as it is here)
//   + drizzle-orm's `gt` (spied, passthrough disabled) so we can assert the
//     exact cursor value the pets query was built with, without needing a
//     real column/SQL builder.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    // Replace with a spy that returns an inspectable marker instead of a real
    // SQL fragment — the mocked `pets`/`cronRuns` table objects have no real
    // columns, so the marker just needs to carry the cursor value through.
    gt: vi.fn((column: unknown, value: unknown) => ({ __gt: true, column, value })),
  };
});

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;
const FAKE_RUN_ID = "reconcile-run-id-1234";

// Identity markers for the mocked tables — used so the `@/db` mock's
// `db.select(...).from(table)` can branch on WHICH table is being queried
// (pets batch scan vs. the cron_runs "read last finished run" lookup).
const PETS_TABLE = { __table: "pets" };
const CRON_RUNS_TABLE = { __table: "cron_runs" };

// ---------------------------------------------------------------------------
// Minimal pet rows
// ---------------------------------------------------------------------------

const PET_CLEAN = { id: "pet-uuid-1", publicToken: "DIM-AAAA-1111", status: "active" };
const PET_DRIFTED = { id: "pet-uuid-2", publicToken: "DIM-BBBB-2222", status: "active" };

describe("GET /api/cron/reconcile-pet-status", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.CRON_SECRET = "test-secret";
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
    vi.restoreAllMocks();
    vi.doUnmock("@/db");
    vi.doUnmock("@/lib/infra/rederive-pet-cache");
    vi.doUnmock("@/lib/infra/cron-alert");
  });

  // ---------------------------------------------------------------------------
  // Mock builders
  // ---------------------------------------------------------------------------

  /**
   * Build a Drizzle-style db mock that:
   *   - INSERT cronRuns → returns [{ id: FAKE_RUN_ID }]
   *   - UPDATE cronRuns → no-op
   *   - SELECT cronRuns (last finished run lookup) → resolves to
   *     `lastRunDetails` wrapped in a row, or [] when omitted (no prior run)
   *   - SELECT pets (keyset query) → returns the provided batches in order
   *
   * `lastRunDetails`, when provided, simulates a previously FINISHED cron_runs
   * row for this cron whose `details.nextCursor` the route should resume from.
   */
  function buildDbMock(
    petBatches: (typeof PET_CLEAN)[][],
    lastRunDetails?: Record<string, unknown>,
  ) {
    // cronRuns INSERT
    const returningMock = vi.fn().mockResolvedValue([{ id: FAKE_RUN_ID }]);
    const insertValuesMock = vi.fn().mockReturnValue({ returning: returningMock });
    const insertMock = vi.fn().mockReturnValue({ values: insertValuesMock });

    // cronRuns UPDATE
    const updateWhereMock = vi.fn().mockResolvedValue(undefined);
    const updateSetMock = vi.fn().mockReturnValue({ where: updateWhereMock });
    const updateMock = vi.fn().mockReturnValue({ set: updateSetMock });

    // cronRuns SELECT — "read last finished run" lookup used to resume the
    // cursor. Chain: db.select({details}).from(cronRuns).where(...).orderBy(...).limit(1)
    const cronRunsLimitMock = vi
      .fn()
      .mockResolvedValue(lastRunDetails !== undefined ? [{ details: lastRunDetails }] : []);
    const cronRunsOrderByMock = vi.fn().mockReturnValue({ limit: cronRunsLimitMock });
    const cronRunsWhereMock = vi.fn().mockReturnValue({ orderBy: cronRunsOrderByMock });

    // pets SELECT — the route calls db.select(...).from(pets).$dynamic() then chains
    // .where().orderBy().limit(). We must mock each step of the builder chain.
    // The route first calls $dynamic() to get a chainable query, then conditionally
    // adds .where(gt(...)) for cursor pagination, then .orderBy().limit() to execute.
    let batchIndex = 0;

    const limitMock = vi.fn().mockImplementation(async () => {
      const batch = petBatches[batchIndex] ?? [];
      batchIndex += 1;
      return batch;
    });
    const orderByMock = vi.fn().mockReturnValue({ limit: limitMock });
    const petsWhereMock = vi.fn().mockReturnValue({ orderBy: orderByMock });

    // $dynamic() returns a chainable object that supports both .where() and
    // .orderBy() directly (used when cursor is null) and via .where() chaining.
    const dynamicMock = vi.fn().mockReturnValue({
      where: petsWhereMock,
      orderBy: orderByMock,
    });

    // .from(table) branches on WHICH table is being queried — pets (batch
    // scan, uses $dynamic()) vs cron_runs (resume-cursor lookup, plain chain).
    const fromMock = vi.fn().mockImplementation((table: unknown) => {
      if (table === CRON_RUNS_TABLE) {
        return { where: cronRunsWhereMock };
      }
      return { $dynamic: dynamicMock };
    });
    const selectMock = vi.fn().mockReturnValue({ from: fromMock });

    const dbMock = {
      insert: insertMock,
      update: updateMock,
      select: selectMock,
    };

    return { dbMock, updateSetMock, petsWhereMock };
  }

  function mockCleanRun(
    petBatches: (typeof PET_CLEAN)[][],
    lastRunDetails?: Record<string, unknown>,
  ) {
    const { dbMock, updateSetMock, petsWhereMock } = buildDbMock(petBatches, lastRunDetails);

    vi.doMock("@/db", () => ({
      db: dbMock,
      cronRuns: CRON_RUNS_TABLE,
      pets: PETS_TABLE,
    }));

    // No drift for any pet
    vi.doMock("@/lib/infra/rederive-pet-cache", () => ({
      rederivePetCache: vi.fn().mockResolvedValue({
        status: { stored: "active", derived: "active", matches: true },
      }),
      hasDrift: vi.fn().mockReturnValue(false),
      driftedColumns: vi.fn().mockReturnValue({}),
    }));

    return { updateSetMock, petsWhereMock };
  }

  function mockDriftedRun(petBatches: (typeof PET_CLEAN)[][], driftedPetId: string) {
    const { dbMock, updateSetMock, petsWhereMock } = buildDbMock(petBatches);

    vi.doMock("@/db", () => ({
      db: dbMock,
      cronRuns: CRON_RUNS_TABLE,
      pets: PETS_TABLE,
    }));

    vi.doMock("@/lib/infra/rederive-pet-cache", () => ({
      rederivePetCache: vi.fn().mockImplementation(async (id: string) => {
        if (id === driftedPetId) {
          return {
            status: { stored: "active", derived: "deceased", matches: false },
            deceasedAt: { stored: null, derived: new Date("2026-01-01"), matches: false },
          };
        }
        return { status: { stored: "active", derived: "active", matches: true } };
      }),
      hasDrift: vi
        .fn()
        .mockImplementation((report: Record<string, { matches: boolean }>) =>
          Object.values(report).some((r) => !r.matches),
        ),
      driftedColumns: vi
        .fn()
        .mockImplementation((report: Record<string, { matches: boolean }>) =>
          Object.fromEntries(Object.entries(report).filter(([, r]) => !r.matches)),
        ),
    }));

    return { updateSetMock, petsWhereMock };
  }

  function mockRederiveThrows(petBatches: (typeof PET_CLEAN)[][]) {
    const { dbMock, updateSetMock, petsWhereMock } = buildDbMock(petBatches);

    vi.doMock("@/db", () => ({
      db: dbMock,
      cronRuns: CRON_RUNS_TABLE,
      pets: PETS_TABLE,
    }));

    vi.doMock("@/lib/infra/rederive-pet-cache", () => ({
      rederivePetCache: vi.fn().mockRejectedValue(new Error("db connection lost")),
      hasDrift: vi.fn().mockReturnValue(false),
      driftedColumns: vi.fn().mockReturnValue({}),
    }));

    return { updateSetMock, petsWhereMock };
  }

  /**
   * Mocks @/lib/infra/cron-alert so drift-alert tests can assert on
   * sendCronAlert's call arguments. Must be invoked (and vi.doMock takes
   * effect) BEFORE callRoute() dynamically imports the route module.
   */
  function mockSendCronAlert() {
    const sendCronAlertMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/infra/cron-alert", () => ({
      sendCronAlert: sendCronAlertMock,
    }));
    return sendCronAlertMock;
  }

  async function callRoute(headers: Record<string, string>) {
    const { GET } = await import("@/app/api/cron/reconcile-pet-status/route");
    const req = new Request("http://test.local/api/cron/reconcile-pet-status", { headers });
    return GET(req as unknown as Parameters<typeof GET>[0]);
  }

  // ---------------------------------------------------------------------------
  // Auth branch
  // ---------------------------------------------------------------------------

  it("returns 401 when no auth header is provided", async () => {
    mockCleanRun([]);
    const res = await callRoute({});
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "Unauthorized" });
  });

  it("returns 401 when x-cron-secret does not match", async () => {
    mockCleanRun([]);
    const res = await callRoute({ "x-cron-secret": "wrong-secret" });
    expect(res.status).toBe(401);
  });

  it("returns 401 when Authorization: Bearer does not match", async () => {
    mockCleanRun([]);
    const res = await callRoute({ authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // No pets
  // ---------------------------------------------------------------------------

  it("returns 200 with scanned=0 divergent=0 when there are no pets", async () => {
    // Empty first batch → loop exits immediately
    mockCleanRun([[]]);
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, scanned: 0, divergent: 0, sample: [] });
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ---------------------------------------------------------------------------
  // Clean run (no drift)
  // ---------------------------------------------------------------------------

  it("returns scanned=1 divergent=0 when one pet matches", async () => {
    // Single batch with one pet, then empty terminator batch
    mockCleanRun([[PET_CLEAN], []]);
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, scanned: 1, divergent: 0, sample: [] });
  });

  it("returns 200 via Authorization: Bearer header", async () => {
    mockCleanRun([[]]);
    const res = await callRoute({ authorization: "Bearer test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Drift detected
  // ---------------------------------------------------------------------------

  it("returns divergent=1 with sample entry when one pet has drifted status", async () => {
    mockDriftedRun([[PET_DRIFTED], []], PET_DRIFTED.id);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, scanned: 1, divergent: 1 });
    expect(body.sample).toHaveLength(1);
    expect(body.sample[0].petId).toBe(PET_DRIFTED.id);
    expect(body.sample[0].publicToken).toBe(PET_DRIFTED.publicToken);
    // The derived status should reflect what rederivePetCache returned
    expect(body.sample[0].derived).toBe("deceased");
    // Warn log was emitted
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("DRIFT DETECTED"));
    warnSpy.mockRestore();
  });

  it("ignores non-status column drift (contract: status family only)", async () => {
    // A pet whose ONLY drift is in legacy microchip columns must NOT count as
    // divergent — the header contract scopes this cron to status + deceasedAt.
    // (Staging 2026-07-18: microchip-column drift made the pets.status card
    // claim divergence that wasn't there and kept cron_health red.)
    const { dbMock } = buildDbMock([[PET_CLEAN], []]);
    vi.doMock("@/db", () => ({ db: dbMock, cronRuns: CRON_RUNS_TABLE, pets: PETS_TABLE }));
    vi.doMock("@/lib/infra/rederive-pet-cache", () => ({
      rederivePetCache: vi.fn().mockResolvedValue({
        status: { stored: "active", derived: "active", matches: true },
        deceasedAt: { stored: null, derived: null, matches: true },
        microchipId: { stored: "900123", derived: null, matches: false },
        microchipCountryCode: { stored: "900", derived: null, matches: false },
      }),
    }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, scanned: 1, divergent: 0 });
    expect(body.sample).toHaveLength(0);
    warnSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // The wider report (finding A08-3)
  // ---------------------------------------------------------------------------

  function mockFamilyDriftRun(report: Record<string, unknown>) {
    const { dbMock, updateSetMock } = buildDbMock([[PET_DRIFTED], []]);
    vi.doMock("@/db", () => ({ db: dbMock, cronRuns: CRON_RUNS_TABLE, pets: PETS_TABLE }));
    vi.doMock("@/lib/infra/rederive-pet-cache", () => ({
      rederivePetCache: vi.fn().mockResolvedValue(report),
    }));
    return { updateSetMock };
  }

  it("counts drift outside the status family per family and pages through its own alert", async () => {
    const { updateSetMock } = mockFamilyDriftRun({
      status: { stored: "active", derived: "active", matches: true },
      deceasedAt: { stored: null, derived: null, matches: true },
      jurisdictionProvince: { stored: "CABA", derived: "Buenos Aires", matches: false },
      jurisdictionLocality: { stored: "Palermo", derived: "Tandil", matches: false },
      estimatedWeightKg: { stored: "8.5", derived: "8.5", matches: true },
    });
    const sendCronAlertMock = mockSendCronAlert();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const body = await (await callRoute({ "x-cron-secret": "test-secret" })).json();

    // The status contract is untouched: the card and cron-health see nothing.
    expect(body).toMatchObject({ ok: true, scanned: 1, divergent: 0 });
    expect(sendCronAlertMock).toHaveBeenCalledTimes(1);
    expect(sendCronAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        job: "reconcile_pet_status",
        severity: "warning",
        error: expect.stringContaining("jurisdiction=1"),
        details: expect.objectContaining({ familyDrift: { jurisdiction: 1 } }),
      }),
    );
    const details = updateSetMock.mock.calls[0][0].details;
    expect(details.familyDrift).toEqual({ jurisdiction: 1 });
    expect(details.familySample[0]).toEqual({
      petId: PET_DRIFTED.id,
      publicToken: PET_DRIFTED.publicToken,
      families: { jurisdiction: ["jurisdictionProvince", "jurisdictionLocality"] },
    });
    warnSpy.mockRestore();
  });

  it("files a checked column it has no family for under 'unclassified' instead of dropping it", async () => {
    mockFamilyDriftRun({
      status: { stored: "active", derived: "active", matches: true },
      someFutureCacheColumn: { stored: 1, derived: 2, matches: false },
    });
    const sendCronAlertMock = mockSendCronAlert();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await callRoute({ "x-cron-secret": "test-secret" });

    expect(sendCronAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ familyDrift: { unclassified: 1 } }),
      }),
    );
    warnSpy.mockRestore();
  });

  it("pages twice when both sides drift — neither alert swallows the other", async () => {
    mockFamilyDriftRun({
      status: { stored: "active", derived: "deceased", matches: false },
      inCustodyDispute: { stored: false, derived: true, matches: false },
    });
    const sendCronAlertMock = mockSendCronAlert();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const body = await (await callRoute({ "x-cron-secret": "test-secret" })).json();

    expect(body.divergent).toBe(1);
    expect(sendCronAlertMock).toHaveBeenCalledTimes(2);
    expect(sendCronAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ familyDrift: { custody_dispute: 1 } }),
      }),
    );
    warnSpy.mockRestore();
  });

  it("counts two drifted pets and limits sample to MAX_SAMPLE", async () => {
    const PET2 = { id: "pet-uuid-3", publicToken: "DIM-CCCC-3333", status: "active" };
    mockDriftedRun([[PET_DRIFTED, PET2], []], PET_DRIFTED.id);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Only PET_DRIFTED has drift (PET2 is clean in this mock — hasDrift is called per-pet
    // and returns true only for PET_DRIFTED's report shape)
    expect(body.divergent).toBe(1);
    warnSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Drift alert (sendCronAlert) — the gap this change wires up: reconcile
  // itself must page on drift instead of relying solely on cron-health's
  // next (up to daily) run to notice the "drift" verdict.
  // ---------------------------------------------------------------------------

  it("sends a warning-severity cron alert with the sample + count when drift is detected", async () => {
    mockDriftedRun([[PET_DRIFTED], []], PET_DRIFTED.id);
    const sendCronAlertMock = mockSendCronAlert();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await callRoute({ "x-cron-secret": "test-secret" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, scanned: 1, divergent: 1 });

    expect(sendCronAlertMock).toHaveBeenCalledTimes(1);
    expect(sendCronAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        job: "reconcile_pet_status",
        severity: "warning",
        details: expect.objectContaining({
          scanned: 1,
          divergent: 1,
          sample: expect.arrayContaining([
            expect.objectContaining({
              petId: PET_DRIFTED.id,
              publicToken: PET_DRIFTED.publicToken,
            }),
          ]),
        }),
      }),
    );

    warnSpy.mockRestore();
  });

  it("does not send a cron alert when divergent is 0", async () => {
    mockCleanRun([[PET_CLEAN], []]);
    const sendCronAlertMock = mockSendCronAlert();

    const res = await callRoute({ "x-cron-secret": "test-secret" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.divergent).toBe(0);
    expect(sendCronAlertMock).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Per-pet error does not abort the batch
  // ---------------------------------------------------------------------------

  it("captures per-pet rederive errors AND fails the run (HTTP 500 so Vercel retries)", async () => {
    mockRederiveThrows([[PET_CLEAN], []]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await callRoute({ "x-cron-secret": "test-secret" });
    // Per-pet rederive errors are still isolated (the batch is not aborted mid-run
    // and each error is captured in cron_runs.details), but the run is NOT healthy:
    // it now returns HTTP 500 with ok:false so Vercel flags/retries — a cron must
    // not report success on failure (review 23 fleet extension). Drift detection is
    // idempotent, so the retry is safe.
    expect(res.status).toBe(500);
    const body = await res.json();
    // scanned increments before rederive call; divergent stays 0
    expect(body.ok).toBe(false);
    expect(body.scanned).toBe(1);
    expect(body.divergent).toBe(0);
    errSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Cursor persistence — the fix under test. Run 1 processes batch A and
  // stops early (time budget exhausted), persisting `nextCursor`. Run 2
  // reads that persisted cursor from the last finished cron_runs row, uses
  // it to resume the pets query, processes batch B, and — having reached the
  // true end of the table — wraps `nextCursor` back to null.
  // ---------------------------------------------------------------------------

  it("run 1: persists nextCursor when the run stops early on the time budget", async () => {
    // No previous finished run → fresh sweep, cursor starts at null.
    const { updateSetMock, petsWhereMock } = mockCleanRun([[PET_CLEAN], []]);

    // Force the time-budget check to trip immediately AFTER the first pet is
    // processed: call 1 = `start`, call 2 = pre-fetch budget check (still
    // under budget), call 3 = post-pet budget check (over budget).
    let calls = 0;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => (calls++ < 2 ? 0 : 999_999_999));

    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scanned).toBe(1);

    // Fresh sweep — no cursor to resume from, so the pets query was never
    // filtered with .where(gt(...)).
    expect(petsWhereMock).not.toHaveBeenCalled();

    // The persisted cron_runs row must record the cursor to resume from —
    // NOT null — so a later run doesn't restart from the top.
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ earlyStop: true, nextCursor: PET_CLEAN.id }),
      }),
    );

    dateSpy.mockRestore();
  });

  it("run 2: resumes from the previous run's persisted cursor and wraps to null at the end of the table", async () => {
    const PET_B = { id: "pet-uuid-9", publicToken: "DIM-DDDD-9999", status: "active" };

    // Simulate the previous (finished) cron_runs row for this cron whose
    // nextCursor is batch A's last pet id (PET_CLEAN.id, from "run 1" above).
    const { updateSetMock, petsWhereMock } = mockCleanRun([[PET_B], []], {
      scanned: 1,
      divergent: 0,
      earlyStop: true,
      nextCursor: PET_CLEAN.id,
    });

    const res = await callRoute({ "x-cron-secret": "test-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Batch B (a pet the earlier run hadn't reached yet) got processed.
    expect(body.scanned).toBe(1);

    // The pets query WAS filtered — resumed from the persisted cursor, not
    // restarted from the top of the table.
    expect(petsWhereMock).toHaveBeenCalledWith(
      expect.objectContaining({ __gt: true, value: PET_CLEAN.id }),
    );

    // This run reached the true end of the table (no earlyStop) → the
    // cursor wraps back to null so the NEXT run starts a fresh full sweep.
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ earlyStop: false, nextCursor: null }),
      }),
    );
  });
});
