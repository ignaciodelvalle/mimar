// Unit tests for reportPetSightingAction (P0d additions).
//
// Tests verify:
//   1. finderName / finderContact / photoStoragePath land in the note_added
//      payload when provided.
//   2. Those fields are absent (or null) when not provided (back-compat).
//   3. A photo upload failure is non-fatal — ok:true still returned.
//   4. Existing validation (missing location) still returns ok:false.
//
// DB and Supabase are fully mocked so no local stack is required.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeFakeRateLimiter } from "./_helpers/fake-rate-limiter";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PUBLIC_TOKEN = "DIM-TEST-SIGHTING-001";
const PET_ID = "pet-0000-0000-0000-000000000001";
const OWNER_USER_ID = "user-0000-0000-0000-000000000001";
const CASE_ID = "case-0000-0000-0000-000000000001";
const PREVIOUS_STATE = { ok: false as const, error: null };

// ---------------------------------------------------------------------------
// Mock: next/headers
// ---------------------------------------------------------------------------

/** The caller's address, per test — the token-ceiling tests rotate it. */
const { callerAddress } = vi.hoisted(() => ({ callerAddress: { value: "1.2.3.4" } }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    // x-real-ip is the trusted edge IP — callerIp() prefers it over XFF.
    get: (key: string) => (key === "x-real-ip" ? callerAddress.value : null),
  })),
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/supabase/admin — the action uses the service-role admin client
// for photo uploads so anonymous finders can bypass the authenticated-RLS
// policy on the event-attachments bucket.
// ---------------------------------------------------------------------------

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({})),
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/uploads — uploadAttachmentIfPresent
// ---------------------------------------------------------------------------

const mockUpload = vi.fn();
vi.mock("@/lib/infra/uploads", () => ({
  uploadAttachmentIfPresent: (...args: unknown[]) => mockUpload(...args),
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/rate-limit — allow by default.
// The action now uses the persistent DB-backed enforceRateLimit.
// ---------------------------------------------------------------------------

const { MockRateLimitError, mockEnforceRateLimit } = vi.hoisted(() => {
  class MockRateLimitError extends Error {
    resetAt: Date;
    reason: string;
    constructor(resetAt: Date, reason: string) {
      super(`Rate limit exceeded: ${reason}`);
      this.name = "RateLimitError";
      this.resetAt = resetAt;
      this.reason = reason;
    }
  }
  return {
    MockRateLimitError,
    mockEnforceRateLimit: vi.fn().mockResolvedValue(undefined),
  };
});

/** Records which collaborator ran first — the limiter-before-lookup proof. */
let callOrder: string[] = [];

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: (endpoint: string, id: string, cfg: unknown) => {
      callOrder.push("limiter");
      return mockEnforceRateLimit(endpoint, id, cfg);
    },
    RateLimitError: MockRateLimitError,
  };
});

// ---------------------------------------------------------------------------
// Mock: @/db — pet + owner + case queries + inserts
// ---------------------------------------------------------------------------

// Captured insert calls so tests can inspect the payload.
let capturedPetEventInsert: Record<string, unknown> | null = null;
let capturedNotificationInsert: Record<string, unknown> | null = null;
/**
 * Every notification row of the sighting's ONE bulk insert, in recipient order.
 * `capturedNotificationInsert` stays the first of them so the assertions that
 * only care about type/body/dedupe read the same thing they always did.
 */
let capturedNotificationInserts: Record<string, unknown>[] = [];
let capturedAttachmentInsert: Record<string, unknown> | null = null;

const INSERTED_EVENT_ID = "evt-0000-0000-0000-000000000001";

/** The table the in-flight `db.insert(...)` targets, by its drizzle name. */
let insertTarget = "";

/**
 * A drizzle table's SQL name, read off the symbol drizzle stamps on it. Read
 * this way rather than by importing the table objects: drizzle-orm itself is
 * mocked in this file, so a `getTableName` import would be the mock's.
 */
function drizzleTableName(table: unknown): string {
  if (table === null || typeof table !== "object") return "";
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name")] as string;
}

// We need the DB to return:
//   - pet (status=lost, id, name)
//   - owner (userId)
//   - openCase (id)
//   - insert petEvents (with .returning())
//   - insert notifications
//   - insert attachments

const mockDb = {
  select: vi.fn(),
  insert: vi.fn(),
  // P4 item 3 (2026-07-08): the action now wraps insertEventIdempotent in
  // db.transaction() (advisory lock inside it requires an active tx). The
  // mock tx is just `mockDb` itself — its .select/.insert get reassigned by
  // buildMockDb() before each test same as the top-level `db` reference.
  transaction: vi.fn((cb: (tx: typeof mockDb) => unknown) => cb(mockDb)),
  // The lock statement itself (`select pg_advisory_xact_lock(...)`) — only
  // reached on the keyed path; a no-op stub is enough since these tests never
  // assert on its SQL.
  execute: vi.fn(async () => undefined),
};

/**
 * The active `ownerships` rows the recipient ranking sees, per test.
 *
 * The action no longer resolves ONE titular row of its own: it calls
 * `resolveLostPetAlertRecipients`, which reads every active holder and ranks
 * them in JS (owner → shelter_custody → longest-standing), adding caretakers as
 * concurrent recipients. So the interesting fixtures are ROW SETS, not a single
 * winner — a shelter-held pet with no `owner` row at all is the one that a role
 * filter turned into a hard refusal.
 */
let activeHolderRows: Array<{ userId: string | null; role: string }> = [];

/** `pets.seed_tag` of the resolved pet — null is a real pet (the default). */
let petSeedTag: string | null = null;

/** `pets.in_custody_dispute` of the resolved pet — false is the default. */
let petInCustodyDispute = false;

// Rebuild mock DB state before each test.
function buildMockDb() {
  let selectCallCount = 0;
  // Default fixture: the ordinary pet, one titular, nobody else. Tests that care
  // about custody reassign `activeHolderRows` AFTER calling buildMockDb().
  activeHolderRows = [{ userId: OWNER_USER_ID, role: "owner" }];
  capturedNotificationInserts = [];

  const selectChain = {
    from: vi.fn(() => selectChain),
    where: vi.fn(() => selectChain),
    innerJoin: vi.fn(() => selectChain),
    // The ranking query orders by started_at so its row choice cannot depend on
    // heap order (a pet with an accepted temporary caretaker has TWO active
    // ownerships rows) — and it TERMINATES here, with no `.limit()`, because
    // picking the winner is a JS decision over ALL active holders rather than a
    // SQL one over the first row Postgres feels like returning. So orderBy
    // resolves to the row set instead of returning the chain: a stub that
    // returned the chain made `await` resolve to the chain object itself and
    // `activeHolders.find` come back undefined. The mock has to keep up with the
    // query — it did not until 2026-08-23, and then it had to again the same day.
    orderBy: vi.fn(async () => activeHolderRows),
    limit: vi.fn(async () => {
      selectCallCount++;
      if (selectCallCount === 1) {
        // pet query
        callOrder.push("publicPetByToken");
        return [
          {
            id: PET_ID,
            name: "Luna",
            status: "lost",
            seedTag: petSeedTag,
            inCustodyDispute: petInCustodyDispute,
          },
        ];
      }
      // open case query
      return [{ id: CASE_ID }];
    }),
  };

  // Each insert is routed by the TABLE it targets, never by the shape of its
  // data. Shape-sniffing ("payload" in data → it must be the pet event) was
  // only ever unambiguous because the old hand-listed mock was INCOMPLETE:
  // without `notificationDeadLetter`, the notification flush's dead-letter
  // path could not run. Complete the mock and it does — and
  // notification_dead_letter.payload is a column too (db/schema.ts:1713), so
  // the dead-lettered row overwrote the captured pet event and two assertions
  // read the wrong insert. The real schema is spread into this mock, so the
  // table's own drizzle name is available and exact.
  const insertChain = {
    values: vi.fn((data: Record<string, unknown> | Record<string, unknown>[]) => {
      switch (insertTarget) {
        case "pet_events":
          capturedPetEventInsert = data as Record<string, unknown>;
          break;
        case "attachments":
          capturedAttachmentInsert = data as Record<string, unknown>;
          break;
        // The notification write is a BULK insert now (one row per ranked
        // recipient), so `.values()` receives an array. Both shapes are
        // normalised to the array, and the singular capture keeps pointing at
        // the first row.
        case "notifications":
          capturedNotificationInserts = Array.isArray(data) ? data : [data];
          capturedNotificationInsert = capturedNotificationInserts[0] ?? null;
          break;
        default:
          // notification_dead_letter, rate_limit_buckets, anything else: not
          // what these tests assert on, and deliberately not captured.
          break;
      }
      return insertChain;
    }),
    returning: vi.fn(async () => [{ id: INSERTED_EVENT_ID }]),
  };

  mockDb.select = vi.fn(() => selectChain);
  mockDb.insert = vi.fn((table: unknown) => {
    insertTarget = drizzleTableName(table);
    return insertChain;
  });
}

// @/db — the REAL schema (tables, enums) under a MOCKED client.
//
// Spread from db/schema.ts, which never constructs a pool. The hand-listed
// stubs this replaced (`pets: {}`, `notifications: {}`, …) were the shape that
// broke set-pet-lost-coord-range.test.ts for four consecutive full runs on
// 2026-08-22: vitest's mock proxy throws on the first export the list forgot,
// the file dies at collection with zero tests, and the verdict read it as a
// worker crash. This file already logged `No "notificationDeadLetter" export
// is defined on the "@/db" mock` twelve times per run (lib/infra/
// notification-service.ts reads it) — a warning today, the next export read
// a broken file. Same shape as lib/metrics/alert-evaluation.test.ts.
vi.mock("@/db", async () => {
  const schema = await vi.importActual<typeof import("@/db/schema")>("@/db/schema");
  return { ...schema, db: mockDb };
});

// Silence drizzle-orm helpers — the action uses `and`, `eq`, `isNull`.
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal();
  return actual as object;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFormData(fields: Record<string, string | File>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

const BASE_LOCATION = { locationLat: "-34.9214", locationLng: "-57.9545" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reportPetSightingAction — P0d payload fields", () => {
  beforeEach(() => {
    capturedPetEventInsert = null;
    capturedNotificationInsert = null;
    capturedAttachmentInsert = null;
    callOrder = [];
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockUpload.mockReset();
    mockUpload.mockResolvedValue({
      uploadedPath: "abc123.jpg",
      mimeType: "image/jpeg",
      size: 5000,
      error: null,
    });
    buildMockDb();
  });

  it("includes finderName, finderContact, photoStoragePath in the payload when all provided", async () => {
    const { reportPetSightingAction } = await import("@/app/actions/pet-sighting");

    const photo = new File(["fake-image-bytes"], "luna.jpg", { type: "image/jpeg" });
    const fd = makeFormData({
      ...BASE_LOCATION,
      finderName: "María García",
      finderContact: "11-1234-5678",
      photo,
    });

    const result = await reportPetSightingAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();

    const payload = capturedPetEventInsert?.payload as Record<string, unknown> | undefined;
    expect(payload).toBeDefined();
    expect(payload?.finderName).toBe("María García");
    expect(payload?.finderContact).toBe("11-1234-5678");
    expect(payload?.photoStoragePath).toBe("abc123.jpg");
    expect(payload?.kind).toBe("sighting");
  });

  it("omits finderName/finderContact/photoStoragePath when none provided (back-compat)", async () => {
    // Re-import fresh module instance for isolation.
    vi.resetModules();
    buildMockDb();
    mockUpload.mockResolvedValue({ uploadedPath: null, mimeType: null, size: null, error: null });

    const { reportPetSightingAction } = await import("@/app/actions/pet-sighting");

    const fd = makeFormData({ ...BASE_LOCATION });
    const result = await reportPetSightingAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(true);
    const payload = capturedPetEventInsert?.payload as Record<string, unknown> | undefined;
    expect(payload).toBeDefined();
    // Fields must be absent or undefined/null — no contact noise in payload.
    expect(payload?.finderName == null).toBe(true);
    expect(payload?.finderContact == null).toBe(true);
    expect(payload?.photoStoragePath == null).toBe(true);
  });

  it("returns ok:true even when photo upload fails (non-fatal)", async () => {
    vi.resetModules();
    buildMockDb();
    mockUpload.mockResolvedValue({
      uploadedPath: null,
      mimeType: null,
      size: null,
      error: "No se pudo subir la imagen: network error",
    });

    const { reportPetSightingAction } = await import("@/app/actions/pet-sighting");

    const photo = new File(["bytes"], "test.jpg", { type: "image/jpeg" });
    const fd = makeFormData({ ...BASE_LOCATION, photo });
    const result = await reportPetSightingAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(true);
    expect(result.warning).toBeTruthy();
    // photoStoragePath should be absent from the payload.
    const payload = capturedPetEventInsert?.payload as Record<string, unknown> | undefined;
    expect(payload?.photoStoragePath == null).toBe(true);
  });

  it("returns ok:false when location is missing (existing validation unchanged)", async () => {
    vi.resetModules();
    buildMockDb();

    const { reportPetSightingAction } = await import("@/app/actions/pet-sighting");

    const fd = makeFormData({}); // no locationLat/Lng
    const result = await reportPetSightingAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  // --- Rate limiting (persistent DB-backed enforceRateLimit) ---

  it("a validation-rejected submission does NOT consume the rate-limit budget (tester fix #6)", async () => {
    vi.resetModules();
    buildMockDb();
    mockEnforceRateLimit.mockClear();

    const { reportPetSightingAction } = await import("@/app/actions/pet-sighting");

    // Missing location → validation error BEFORE the limiter is consulted,
    // so the finder can fix the form and retry immediately.
    const fd = makeFormData({});
    const result = await reportPetSightingAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(false);
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
  });

  it("consumes the limiter BEFORE resolving the token (no token-existence oracle)", async () => {
    // The form's page 404s for an unknown token, but the action is hand-postable
    // and nothing requires the page load — so every request used to reach
    // `publicPetByToken` unbounded. The refusals are DISTINCT strings
    // ("Mascota no encontrada." vs "Esta mascota no está marcada como
    // perdida."), which turns the unbounded read into an enumeration of which
    // DIM tokens exist AND which of those animals are currently lost. The
    // limiter is what makes that finite; running it after the read bounds
    // nothing.
    vi.resetModules();
    buildMockDb();
    callOrder = [];

    const { reportPetSightingAction } = await import("@/app/actions/pet-sighting");

    await reportPetSightingAction(PUBLIC_TOKEN, PREVIOUS_STATE, makeFormData({ ...BASE_LOCATION }));

    // The per-ADDRESS bucket, then the lookup, then the animal's own bucket
    // (A03-2), which deliberately waits for the refusals that write nothing.
    expect(callOrder).toEqual(["limiter", "publicPetByToken", "limiter"]);
  });

  it("a throttled caller never reaches the token lookup at all", async () => {
    vi.resetModules();
    buildMockDb();
    callOrder = [];
    mockEnforceRateLimit.mockRejectedValue(
      new MockRateLimitError(new Date(Date.now() + 60_000), "sighting:minute"),
    );

    const { reportPetSightingAction } = await import("@/app/actions/pet-sighting");

    const result = await reportPetSightingAction(
      PUBLIC_TOKEN,
      PREVIOUS_STATE,
      makeFormData({ ...BASE_LOCATION }),
    );

    expect(result.ok).toBe(false);
    expect(callOrder).toEqual(["limiter"]);
  });

  it("a successful submission DOES consume the rate-limit budget", async () => {
    vi.resetModules();
    buildMockDb();
    mockEnforceRateLimit.mockClear();
    mockUpload.mockResolvedValue({ uploadedPath: null, mimeType: null, size: null, error: null });

    const { reportPetSightingAction } = await import("@/app/actions/pet-sighting");

    const result = await reportPetSightingAction(
      PUBLIC_TOKEN,
      PREVIOUS_STATE,
      makeFormData({ ...BASE_LOCATION }),
    );
    expect(result.ok).toBe(true);
    // Two buckets since A03-2: the address's and the animal's.
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(2);
  });

  it("returns ok:false when enforceRateLimit throws RateLimitError", async () => {
    vi.resetModules();
    buildMockDb();
    mockEnforceRateLimit.mockRejectedValue(
      new MockRateLimitError(
        new Date(Date.now() + 60_000),
        "sighting:DIM-TEST-SIGHTING-001:1.2.3.4:minute",
      ),
    );

    const { reportPetSightingAction } = await import("@/app/actions/pet-sighting");

    const fd = makeFormData({ ...BASE_LOCATION });
    const result = await reportPetSightingAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("poco");
    expect(capturedPetEventInsert).toBeNull();
  });

  it("includes finder contact in notification body when finderName + finderContact set", async () => {
    vi.resetModules();
    buildMockDb();
    mockUpload.mockResolvedValue({ uploadedPath: null, mimeType: null, size: null, error: null });

    const { reportPetSightingAction } = await import("@/app/actions/pet-sighting");

    const fd = makeFormData({
      ...BASE_LOCATION,
      finderName: "Juan",
      finderContact: "juan@ejemplo.com",
    });
    await reportPetSightingAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    const notifBody = capturedNotificationInsert?.body as string | undefined;
    expect(notifBody).toBeDefined();
    expect(notifBody).toContain("Juan");
    expect(notifBody).toContain("juan@ejemplo.com");
  });

  it("sanitizes finderName and finderContact to their max lengths", async () => {
    vi.resetModules();
    buildMockDb();
    mockUpload.mockResolvedValue({ uploadedPath: null, mimeType: null, size: null, error: null });

    const { reportPetSightingAction } = await import("@/app/actions/pet-sighting");

    const longName = "A".repeat(200);
    const longContact = "B".repeat(200);
    const fd = makeFormData({
      ...BASE_LOCATION,
      finderName: longName,
      finderContact: longContact,
    });
    await reportPetSightingAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    const payload = capturedPetEventInsert?.payload as Record<string, unknown> | undefined;
    expect((payload?.finderName as string).length).toBeLessThanOrEqual(80);
    expect((payload?.finderContact as string).length).toBeLessThanOrEqual(120);
  });

  // P0g: attachments table integration.

  it("P0g: inserts an attachments row linked to the event when photo upload succeeds", async () => {
    vi.resetModules();
    buildMockDb();
    capturedAttachmentInsert = null;
    mockUpload.mockResolvedValue({
      uploadedPath: "abc123.jpg",
      mimeType: "image/jpeg",
      size: 5000,
      error: null,
    });

    const { reportPetSightingAction } = await import("@/app/actions/pet-sighting");

    const photo = new File(["fake-image-bytes"], "luna.jpg", { type: "image/jpeg" });
    const fd = makeFormData({ ...BASE_LOCATION, photo });
    const result = await reportPetSightingAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(true);
    // An attachment row must have been inserted.
    expect(capturedAttachmentInsert).not.toBeNull();
    const att = capturedAttachmentInsert as unknown as Record<string, unknown>;
    expect(att.eventId).toBe(INSERTED_EVENT_ID);
    expect(att.petId).toBe(PET_ID);
    expect(att.storagePath).toBe("abc123.jpg");
    // Anonymous sighting: uploadedByUserId must be null.
    expect(att.uploadedByUserId).toBeNull();
  });

  it("P0g: does NOT insert an attachments row when no photo is provided", async () => {
    vi.resetModules();
    buildMockDb();
    capturedAttachmentInsert = null;
    mockUpload.mockResolvedValue({ uploadedPath: null, mimeType: null, size: null, error: null });

    const { reportPetSightingAction } = await import("@/app/actions/pet-sighting");

    const fd = makeFormData({ ...BASE_LOCATION });
    const result = await reportPetSightingAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(true);
    expect(capturedAttachmentInsert).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Idempotency: duplicate clientIdempotencyKey → wasNoop=true → no second insert
// ---------------------------------------------------------------------------
//
// These tests mock @/lib/event-idempotency directly so they are independent of
// the DB layer. Pattern mirrors checkin and finder idempotency unit tests.

// ---------------------------------------------------------------------------
// Recipient resolution — the regression that a role filter INTRODUCED
// ---------------------------------------------------------------------------

describe("reportPetSightingAction — a seeded (synthetic) pet records nothing", () => {
  beforeEach(() => {
    capturedPetEventInsert = null;
    capturedNotificationInsert = null;
    callOrder = [];
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockUpload.mockReset();
    mockUpload.mockResolvedValue({ uploadedPath: null, mimeType: null, size: null, error: null });
    buildMockDb();
    petSeedTag = "panorama";
  });
  afterEach(() => {
    petSeedTag = null;
  });

  it("refuses with the neutral message and writes no event and no notification", async () => {
    const { reportPetSightingAction } = await import("@/app/actions/pet-sighting");

    const result = await reportPetSightingAction(
      PUBLIC_TOKEN,
      PREVIOUS_STATE,
      makeFormData({ ...BASE_LOCATION }),
    );

    expect(result).toEqual({
      ok: false,
      error: "No es posible registrar esta acción para esta mascota.",
    });
    expect(capturedPetEventInsert).toBeNull();
    expect(capturedNotificationInsert).toBeNull();
  });
});

// A06-G5: the D2 gate must hold for a hand-rolled POST — the action is
// anon-callable, so hiding the form in the UI is not the gate.
describe("reportPetSightingAction — a pet under custody dispute relays nothing", () => {
  beforeEach(() => {
    capturedPetEventInsert = null;
    capturedNotificationInsert = null;
    callOrder = [];
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockUpload.mockReset();
    mockUpload.mockResolvedValue({ uploadedPath: null, mimeType: null, size: null, error: null });
    buildMockDb();
    petInCustodyDispute = true;
  });
  afterEach(() => {
    petInCustodyDispute = false;
  });

  it("refuses with the dispute notice and writes no event and no notification", async () => {
    const { reportPetSightingAction } = await import("@/app/actions/pet-sighting");

    const result = await reportPetSightingAction(
      PUBLIC_TOKEN,
      PREVIOUS_STATE,
      makeFormData({ ...BASE_LOCATION, finderName: "María", finderContact: "11-1234-5678" }),
    );

    expect(result).toEqual({
      ok: false,
      error:
        "En esta credencial los avisos los recibe la autoridad competente, no la persona registrada como dueña. Enviá tu aviso desde la credencial de la mascota.",
    });
    // createNotificationsBulk writes a notifications or a dead-letter row; the
    // refusal must come before any insert at all.
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(capturedPetEventInsert).toBeNull();
    expect(capturedNotificationInsert).toBeNull();
    expect(mockUpload).not.toHaveBeenCalled();
  });
});

describe("reportPetSightingAction — who hears the sighting", () => {
  beforeEach(() => {
    capturedPetEventInsert = null;
    capturedNotificationInsert = null;
    capturedAttachmentInsert = null;
    callOrder = [];
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockUpload.mockReset();
    mockUpload.mockResolvedValue({
      uploadedPath: null,
      mimeType: null,
      size: null,
      error: null,
    });
  });

  // THE ONE THAT WOULD HAVE CAUGHT afd01fb3c. A pet in shelter custody has a
  // shelter_custody org row and a foster USER row and no `owner` row at all, so
  // `eq(role, 'owner')` returned zero rows and the guard below it discarded the
  // whole sighting — before the event write and before the photo upload — for
  // exactly the animals least likely to have a titular watching. Heap order was
  // intermittently right; the filter was deterministically wrong.
  it("records the sighting for a shelter-held pet that has NO owner row", async () => {
    vi.resetModules();
    buildMockDb();
    activeHolderRows = [{ userId: "user-foster-0001", role: "foster" }];

    const { reportPetSightingAction } = await import("@/app/actions/pet-sighting");
    const result = await reportPetSightingAction(
      PUBLIC_TOKEN,
      PREVIOUS_STATE,
      makeFormData({ ...BASE_LOCATION }),
    );

    expect(result.ok).toBe(true);
    expect(capturedPetEventInsert).not.toBeNull();
    expect(capturedNotificationInserts.map((row) => row.userId)).toEqual(["user-foster-0001"]);
  });

  // The other half of the same read, and the reason a bare limit(1) was wrong in
  // the first place: the titular must be in the set, not merely possible.
  it("notifies the titular AND the caretaker, never the caretaker alone", async () => {
    vi.resetModules();
    buildMockDb();
    activeHolderRows = [
      { userId: "user-caretaker-0001", role: "caretaker" },
      { userId: OWNER_USER_ID, role: "owner" },
    ];

    const { reportPetSightingAction } = await import("@/app/actions/pet-sighting");
    const result = await reportPetSightingAction(
      PUBLIC_TOKEN,
      PREVIOUS_STATE,
      makeFormData({ ...BASE_LOCATION }),
    );

    expect(result.ok).toBe(true);
    // Titular first — ranked, not heap-ordered, even though the caretaker row
    // came back first from the query.
    expect(capturedNotificationInserts.map((row) => row.userId)).toEqual([
      OWNER_USER_ID,
      "user-caretaker-0001",
    ]);
    // One dedupe key per recipient, or the second row is swallowed as a conflict.
    const keys = capturedNotificationInserts.map((row) => row.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // AND THE REFUSAL IS GONE. "Nobody can be notified" was a hard `ok: false`
  // placed ABOVE the event insert, so an org-held pet — 381 of them on staging,
  // one lost at the time of writing — had its sighting thrown away under a
  // message that was not even true. Who hears about a fact cannot gate the
  // fact: the event is append-only, the notification is best-effort.
  it("records the sighting even when nobody is notifiable (org-held pet)", async () => {
    vi.resetModules();
    buildMockDb();
    activeHolderRows = [];

    const { reportPetSightingAction } = await import("@/app/actions/pet-sighting");
    const result = await reportPetSightingAction(
      PUBLIC_TOKEN,
      PREVIOUS_STATE,
      makeFormData({ ...BASE_LOCATION }),
    );

    expect(result.ok).toBe(true);
    expect(capturedPetEventInsert).not.toBeNull();
    expect(capturedNotificationInserts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The animal's own ceiling (audit A03-2)
// ---------------------------------------------------------------------------
//
// The per-(address, token) bucket alone let N addresses write 10 × N sightings
// an hour onto one pet's spine and into its owner's inbox. The second bucket is
// keyed on the token with no address, so the number of addresses stops
// mattering. Its ceiling is stated here as 5/min + 30/hour, independently of
// the constant the code reads.

describe("reportPetSightingAction — the animal's own ceiling (A03-2)", () => {
  beforeEach(() => {
    vi.resetModules();
    callOrder = [];
    callerAddress.value = "1.2.3.4";
    mockEnforceRateLimit.mockReset().mockResolvedValue(undefined);
    mockUpload.mockReset().mockResolvedValue({
      uploadedPath: null,
      mimeType: null,
      size: null,
      error: null,
    });
  });

  it("spends two buckets: the address's, keyed (token, ip), and the animal's, keyed on the token alone", async () => {
    buildMockDb();
    const { reportPetSightingAction } = await import("@/app/actions/pet-sighting");
    await reportPetSightingAction(PUBLIC_TOKEN, PREVIOUS_STATE, makeFormData({ ...BASE_LOCATION }));

    expect(mockEnforceRateLimit.mock.calls).toEqual([
      [`sighting:${PUBLIC_TOKEN}`, "1.2.3.4", { maxPerMinute: 1, maxPerHour: 10 }],
      ["sighting_token", PUBLIC_TOKEN, { maxPerMinute: 5, maxPerHour: 30 }],
    ]);
  });

  it("refuses a FRESH address once thirty others have reported this animal within the hour", async () => {
    const limiter = makeFakeRateLimiter((key) => new MockRateLimitError(new Date(), key));
    mockEnforceRateLimit.mockImplementation(limiter.enforce);
    const { reportPetSightingAction } = await import("@/app/actions/pet-sighting");

    // Thirty different people, a minute apart — the per-minute window never
    // binds, the hourly one fills.
    for (let n = 1; n <= 30; n++) {
      buildMockDb();
      callerAddress.value = `203.0.113.${n}`;
      const ok = await reportPetSightingAction(
        PUBLIC_TOKEN,
        PREVIOUS_STATE,
        makeFormData({ ...BASE_LOCATION }),
      );
      expect(ok.ok, `report ${n} should have landed`).toBe(true);
      limiter.advance(61_000);
    }

    // The thirty-first comes from an address that has sent nothing — its own
    // bucket is empty — and is refused by the animal's.
    buildMockDb();
    capturedPetEventInsert = null;
    capturedNotificationInserts = [];
    callerAddress.value = "198.51.100.200";
    const refused = await reportPetSightingAction(
      PUBLIC_TOKEN,
      PREVIOUS_STATE,
      makeFormData({ ...BASE_LOCATION }),
    );

    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/muchos avisos sobre esta mascota/);
    // Not the per-address copy — this caller sent nothing before.
    expect(refused.error).not.toMatch(/Ya enviaste/);
    expect(capturedPetEventInsert).toBeNull();
    expect(capturedNotificationInserts).toEqual([]);
  });

  it("refuses the sixth different address inside one minute", async () => {
    const limiter = makeFakeRateLimiter((key) => new MockRateLimitError(new Date(), key));
    mockEnforceRateLimit.mockImplementation(limiter.enforce);
    const { reportPetSightingAction } = await import("@/app/actions/pet-sighting");

    const outcomes: boolean[] = [];
    for (let n = 1; n <= 6; n++) {
      buildMockDb();
      callerAddress.value = `203.0.113.${n}`;
      const r = await reportPetSightingAction(
        PUBLIC_TOKEN,
        PREVIOUS_STATE,
        makeFormData({ ...BASE_LOCATION }),
      );
      outcomes.push(r.ok);
    }
    expect(outcomes).toEqual([true, true, true, true, true, false]);
  });
});

describe("reportPetSightingAction — idempotency guard", () => {
  // Track how many times insertEventIdempotent is called so we can assert
  // the notification path is NOT reached on a noop.
  const mockInsertEventIdempotent = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    buildMockDb();
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockUpload.mockResolvedValue({ uploadedPath: null, mimeType: null, size: null, error: null });
    capturedPetEventInsert = null;
    capturedNotificationInsert = null;
    capturedAttachmentInsert = null;

    // Override the idempotency helper so we can control wasNoop.
    vi.doMock("@/lib/events/event-idempotency", () => ({
      insertEventIdempotent: mockInsertEventIdempotent,
    }));
  });

  it("returns ok:true and skips second insert when same clientIdempotencyKey is reused (wasNoop=true)", async () => {
    const IDEMPOTENCY_KEY = "de305d54-75b4-431b-adb2-eb6b9e546014";

    // Simulate conflict on the second DB call: wasNoop=true.
    mockInsertEventIdempotent.mockResolvedValue({
      event: { id: INSERTED_EVENT_ID },
      wasNoop: true,
    });

    const { reportPetSightingAction } = await import("@/app/actions/pet-sighting");

    // Single call with wasNoop=true — simulates a duplicate submission.
    const fd = makeFormData({ ...BASE_LOCATION, clientIdempotencyKey: IDEMPOTENCY_KEY });
    const result = await reportPetSightingAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(true);
    // insertEventIdempotent must have been called with the key. P4 item 3:
    // the call now also carries the tx executor as a 2nd arg (advisory lock
    // requires an active transaction) — match it loosely.
    expect(mockInsertEventIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({ clientIdempotencyKey: IDEMPOTENCY_KEY }),
      expect.anything(),
    );
  });

  it("re-attempts the owner alert when wasNoop=true, keyed so it cannot duplicate", async () => {
    // THE INVERSE OF WHAT THIS TEST USED TO ASSERT, and the old expectation was
    // a bug frozen as spec. The sighting event is written first and the owner's
    // alert second, and that second write used to be wrapped in a catch that
    // SWALLOWED — so a first attempt could return the success screen having
    // notified nobody, and this "skip on noop" rule then guaranteed the retry
    // would not fix it. The owner of a lost animal is never told it was seen.
    //
    // A duplicate submission is evidence that attempt 1 may have failed, not
    // proof that it succeeded. Re-attempting is safe because the write carries
    // a dedupe key derived from the event id: if the alert already landed,
    // ON CONFLICT DO NOTHING makes this a no-op and no second push goes out.
    mockInsertEventIdempotent.mockResolvedValue({
      event: { id: INSERTED_EVENT_ID },
      wasNoop: true,
    });

    const { reportPetSightingAction } = await import("@/app/actions/pet-sighting");

    const fd = makeFormData({
      ...BASE_LOCATION,
      clientIdempotencyKey: "de305d54-75b4-431b-adb2-eb6b9e546014",
    });
    const result = await reportPetSightingAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(true);
    expect(capturedNotificationInsert).not.toBeNull();
    expect(capturedNotificationInsert?.notificationType).toBe("pet_sighting");
    // Keyed off the EXISTING event, which is what lets the no-op recognise the
    // alert attempt 1 already made.
    expect(capturedNotificationInsert?.dedupeKey).toBe(
      `event:${INSERTED_EVENT_ID}:${OWNER_USER_ID}:pet_sighting`,
    );
  });

  it("proceeds with normal insert and notification when clientIdempotencyKey is absent", async () => {
    mockInsertEventIdempotent.mockResolvedValue({
      event: { id: INSERTED_EVENT_ID },
      wasNoop: false,
    });

    const { reportPetSightingAction } = await import("@/app/actions/pet-sighting");

    const fd = makeFormData({ ...BASE_LOCATION }); // no clientIdempotencyKey
    const result = await reportPetSightingAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(true);
    // P4 item 3: 2nd arg is the tx executor — match it loosely.
    expect(mockInsertEventIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({ clientIdempotencyKey: null }),
      expect.anything(),
    );
    // Normal path inserts the notification.
    expect(capturedNotificationInsert).not.toBeNull();
  });
});
