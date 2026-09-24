// Unit test — logScan is CIVIL-SILENT for a soft-deleted pet (art. 16, Ley 25.326).
//
// PO-4 policy: a soft-deleted pet (`pets.deleted_at` set by erase_subject_data)
// reads as NEVER REGISTERED to civil surfaces. The public credential page 404s
// for it, but `logScan` is reachable directly through the @no-auth-required
// `logScanAction` with a token saved before deletion (an old QR). The reader
// resolved the pet with a bare `eq(pets.publicToken, …)` and NO deleted_at
// term, so on an erased pet the row still returned, `if (!pet) return;` did NOT
// short-circuit, and the scan was BOTH logged as a `credential_scanned` event
// AND handed to `notifyOwnerOfFirstStrangerScan`. Because the erasure RPC
// soft-deletes the pet but never ends `ownerships` rows, a SURVIVING CO-OWNER
// (a live person) then received a notification about scan activity on a pet the
// civil surfaces call never-existed — the art. 16 leak.
//
// The guard is `.where(and(eq(pets.publicToken, token), isNull(pets.deletedAt)))`.
//
// HOW THIS TEST SEES THE GUARD. The db is mocked, and a mock `.where()` that
// discards its predicate could not tell a guarded read from an unguarded one.
// So drizzle's `eq`/`and`/`isNull` are mocked into small structural descriptors
// and the mocked pet lookup SIMULATES the DB soft-delete filter: an erased row
// is returned UNLESS the query it received actually carries isNull(deletedAt).
// Remove the guard from the reader and the mock hands the erased row back, the
// event is inserted and the notifier fires — this test goes red. That is the
// mutation tripwire the fix needs, honest to the real DB semantics.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PUBLIC_TOKEN = "DIM-SOFT-DEL1";
const PET_ID = "pet-soft-0000-0000-000000000001";

// ---------------------------------------------------------------------------
// Mock: next/headers — only the raw IP is present (local-dev shape), so the
// coarse geo floor resolves to null and the real payload schema still validates.
// ---------------------------------------------------------------------------

const mockGeoHeaders: Record<string, string> = { "x-real-ip": "203.0.113.9" };
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: (key: string) => mockGeoHeaders[key] ?? null })),
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/supabase/server — anonymous scanner (the stranger whose scan
// would fan a notification out to the surviving co-owner).
// ---------------------------------------------------------------------------

const mockGetUser = vi.fn(async () => ({
  data: { user: null as { id: string } | null },
  error: null,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: () => mockGetUser() } })),
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/infra/rate-limit — no-op so every scan reaches the pet lookup.
// ---------------------------------------------------------------------------

vi.mock("@/lib/infra/rate-limit", () => ({
  enforceRateLimit: vi.fn(async () => {}),
  callerIp: (h: { get(k: string): string | null }) => h.get("x-real-ip") ?? "unknown",
  RateLimitError: class RateLimitError extends Error {},
}));

// ---------------------------------------------------------------------------
// Mock: the owner-onboarding notifier. Its invocation IS the leak's second
// half — the real notifier fans out to the surviving co-owner — so we assert
// on the call itself, decoupled from the @/db mock's shape.
// ---------------------------------------------------------------------------

const mockNotifyFirstStrangerScan = vi.fn(async (..._args: unknown[]) => ({ delivered: 0 }));
vi.mock("@/lib/infra/notify-owner-of-first-stranger-scan", () => ({
  notifyOwnerOfFirstStrangerScan: (...args: unknown[]) => mockNotifyFirstStrangerScan(...args),
}));

// ---------------------------------------------------------------------------
// Mock: drizzle-orm operators as structural descriptors, so the mocked db can
// SEE whether the reader's predicate carries the soft-delete guard. Everything
// else in drizzle-orm is passed through untouched.
// ---------------------------------------------------------------------------

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => ({ __op: "eq", col, val }),
    isNull: (col: unknown) => ({ __op: "isNull", col }),
    and: (...conds: unknown[]) => ({ __op: "and", conds }),
  };
});

type Cond = { __op?: string; col?: unknown; conds?: Cond[] } | null | unknown;

/** True iff the predicate carries isNull(pets.deletedAt) — the civil guard. */
function guardsPetsDeletedAt(cond: Cond): boolean {
  if (!cond || typeof cond !== "object") return false;
  const c = cond as { __op?: string; col?: unknown; conds?: Cond[] };
  if (c.__op === "isNull" && c.col === "pets.deletedAt") return true;
  if (c.__op === "and" && Array.isArray(c.conds)) return c.conds.some(guardsPetsDeletedAt);
  return false;
}

// ---------------------------------------------------------------------------
// Mock: @/db — the pet lookup simulates the real soft-delete filter; the insert
// is captured. Columns carry stable string identities so the guard is visible.
// ---------------------------------------------------------------------------

let petRow: { id: string; status: string; name: string; deletedAt: Date | null } | null = null;
let capturedInsert: Record<string, unknown> | null = null;
let insertCalled = false;

const mockDb: { select: ReturnType<typeof vi.fn>; insert: ReturnType<typeof vi.fn> } = {
  select: vi.fn(),
  insert: vi.fn(),
};

function buildMockDb() {
  let selectCallCount = 0;
  let lastWhere: Cond = null;
  const selectChain = {
    from: vi.fn(() => selectChain),
    where: vi.fn((cond: Cond) => {
      lastWhere = cond;
      return selectChain;
    }),
    limit: vi.fn(async () => {
      selectCallCount++;
      if (selectCallCount === 1) {
        // Pet lookup by public token — SIMULATE the DB: an erased row is
        // returned only when the query FORGOT the isNull(deletedAt) guard.
        if (!petRow) return [];
        if (petRow.deletedAt && guardsPetsDeletedAt(lastWhere)) return [];
        return [petRow];
      }
      // Ownership (self-scan) lookup — never reached here: the scanner is
      // anonymous, so logScan skips it.
      return [];
    }),
  };
  const insertChain = {
    values: vi.fn(async (data: Record<string, unknown>) => {
      insertCalled = true;
      capturedInsert = data;
    }),
  };
  mockDb.select = vi.fn(() => selectChain);
  mockDb.insert = vi.fn(() => insertChain);
}

vi.mock("@/db", () => ({
  db: mockDb,
  pets: {
    id: "pets.id",
    status: "pets.status",
    name: "pets.name",
    publicToken: "pets.publicToken",
    deletedAt: "pets.deletedAt",
  },
  ownerships: {
    id: "ownerships.id",
    petId: "ownerships.petId",
    ownerUserId: "ownerships.ownerUserId",
    endedAt: "ownerships.endedAt",
  },
  petEvents: {},
}));

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function runScan(): Promise<void> {
  const { logScan } = await import("@/src/modules/pets/application/scans/log-scan");
  await logScan(PUBLIC_TOKEN);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("logScan — civil silence for a soft-deleted pet (art. 16)", () => {
  beforeEach(() => {
    capturedInsert = null;
    insertCalled = false;
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    mockNotifyFirstStrangerScan.mockClear();
    buildMockDb();
  });

  it("a soft-deleted pet: logs NO credential_scanned event and fires NO owner notification", async () => {
    // The erasure soft-deletes the pet but leaves a surviving co-owner's
    // ownership row alive; the real notifier would reach that live person.
    petRow = {
      id: PET_ID,
      status: "active",
      name: "Erased Pet",
      deletedAt: new Date("2026-08-01T00:00:00Z"),
    };

    await runScan();

    expect(insertCalled).toBe(false);
    expect(capturedInsert).toBeNull();
    expect(mockNotifyFirstStrangerScan).not.toHaveBeenCalled();
  });

  it("NON-VACUITY: a LIVE pet's anonymous scan still logs the event AND notifies", async () => {
    // The over-filter guard: the fix must silence ONLY erased pets.
    petRow = { id: PET_ID, status: "active", name: "Live Pet", deletedAt: null };

    await runScan();

    expect(insertCalled).toBe(true);
    expect(capturedInsert?.eventType).toBe("credential_scanned");
    expect(capturedInsert?.authorRole).toBe("scanner");
    expect(capturedInsert?.recordedByUserId).toBeNull();
    expect(mockNotifyFirstStrangerScan).toHaveBeenCalledTimes(1);
    expect(mockNotifyFirstStrangerScan.mock.calls[0][0]).toMatchObject({
      petId: PET_ID,
      petPublicToken: PUBLIC_TOKEN,
    });
  });
});
