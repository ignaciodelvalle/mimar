// Unit tests for reportFinderInPossessionAction (P0e).
//
// Tests verify:
//   1. Anon happy path → petEvents (kind=finder_in_possession) + notification created.
//   2. Logged-in path → recordedByUserId stays NULL, authorVerified=false
//      (finder anonymity invariant — privacy hardening 2026-07-04).
//   3. Pet not lost → ok:false.
//   4. Rate limit → ok:false.
//   5. Idempotency guard → ok:true without second insert.
//   6. Photo upload failure → non-fatal (ok:true + warning).
//   7. Missing name → accepted (anonymous handoff, PO 2026-07-24).
//   8. Missing both phone and email → accepted; owner told no contact left.
//   9. Missing location → ok:false.
//  10. Notification severity=urgent, category=perdidas.
//  11. Vet-urgent condition sets urgent body copy in notification.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendPushForNotifications } from "@/lib/infra/web-push";

import { makeFakeRateLimiter } from "./_helpers/fake-rate-limiter";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PUBLIC_TOKEN = "DIM-P0E-TEST-001";
const PET_ID = "pet-p0e0-0000-0000-000000000001";
const OWNER_USER_ID = "user-p0e0-0000-0000-000000000001";
const FINDER_USER_ID = "user-p0e0-0000-0000-000000000002";
const CARETAKER_USER_ID = "user-p0e0-0000-0000-000000000003";
const CASE_ID = "case-p0e0-0000-0000-000000000001";
const PREVIOUS_STATE = { ok: false as const, error: null };

const BASE_FIELDS = {
  finderName: "Ana González",
  finderPhone: "11-5555-0001",
  // Exact point is now the required location field. localityName/province are
  // still emitted by LocationFields (L2 reverse geocode) and kept as context.
  locationLat: "-34.92",
  locationLng: "-57.95",
  localityName: "La Plata",
  petCondition: "bien",
};

// ---------------------------------------------------------------------------
// Mock: next/headers
// ---------------------------------------------------------------------------

/** The caller's address, per test — the token-ceiling tests rotate it. */
const { callerAddress } = vi.hoisted(() => ({ callerAddress: { value: "10.0.0.1" } }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    // x-real-ip is the trusted edge IP — callerIp() prefers it over XFF.
    get: (key: string) => (key === "x-real-ip" ? callerAddress.value : null),
  })),
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/supabase/admin
// ---------------------------------------------------------------------------

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({})),
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/uploads
// ---------------------------------------------------------------------------

const mockUpload = vi.fn();
vi.mock("@/lib/infra/uploads", () => ({
  uploadAttachmentIfPresent: (supabase: unknown, file: unknown, bucket: unknown) =>
    mockUpload(supabase, file, bucket),
}));

// createNotification fires the Web Push leg for genuinely new rows. Unmocked it
// reaches out to real subscriptions from a unit test.
vi.mock("@/lib/infra/web-push", () => ({
  sendPushForNotifications: vi.fn(async () => undefined),
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/rate-limit — allow by default; tests override per case.
// The action now uses the persistent DB-backed enforceRateLimit (not
// makeMemoryRateLimiter), so we mock enforceRateLimit directly.
// vi.hoisted is used so MockRateLimitError is available both in the vi.mock
// factory (which is hoisted) and in test bodies that need to throw it.
// ---------------------------------------------------------------------------

const { MockRateLimitError, mockEnforceRateLimit, callOrder } = vi.hoisted(() => {
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
    /**
     * The two things whose ORDER is the contract, recorded as they happen.
     *
     * A hand-rolled POST reaches this action with no page load, so a token
     * lookup that runs before the limiter is an unbounded existence oracle:
     * "Mascota no encontrada." and "Esta mascota no está marcada como perdida."
     * are different strings, and anyone can ask as often as they like.
     */
    callOrder: [] as string[],
  };
});

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    // Recorded in the WRAPPER, not in the per-test mock, so the order is
    // captured whatever a test makes the limiter do (resolve, or reject).
    enforceRateLimit: (endpoint: string, id: string, cfg: unknown) => {
      callOrder.push("rate-limit");
      return mockEnforceRateLimit(endpoint, id, cfg);
    },
    RateLimitError: MockRateLimitError,
  };
});

// ---------------------------------------------------------------------------
// Mock: @/lib/supabase/server — simulates the browser session. The action must
// NOT read it (finder anonymity invariant): even when getUser would return a
// logged-in user, the persisted event must carry recordedByUserId=null.
// ---------------------------------------------------------------------------

const mockGetUser = vi.fn(async () => ({
  data: { user: null as { id: string; email?: string } | null },
  error: null,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: () => mockGetUser() } })),
}));

// ---------------------------------------------------------------------------
// Mock: @/db
// ---------------------------------------------------------------------------

let capturedPetEventInsert: Record<string, unknown> | null = null;
let capturedNotificationInsert: Record<string, unknown> | null = null;
let capturedDeadLetterRows: Record<string, unknown>[] = [];
/** Every row of the possession insert — one per alert recipient. */
let capturedNotificationRows: Record<string, unknown>[] = [];
let capturedAttachmentInsert: Record<string, unknown> | null = null;

const INSERTED_EVENT_ID = "evt-p0e-0000-0000-000000000001";

// Controls whether the idempotency query returns an existing event.
const IDEMPOTENT_EXISTING_EVENT_ID = "existing-event-id";
let idempotencyReturnEvent = false;

/** custodia-temporal: does the fixture pet have an active caretaker row? */
let activeCaretakerPresent = false;

/** `pets.in_custody_dispute` of the fixture pet — false is the default. */
let petInCustodyDispute = false;

/**
 * The partial unique index `notifications_dedupe_key_unique`, when a test needs
 * it. `null` (the default) keeps the historical behaviour: every notification
 * insert "succeeds". The ceiling tests set a Set, so a repeated key persists
 * nothing and returns no row — which is what makes "once an hour" testable.
 */
let persistedDedupeKeys: Set<string> | null = null;

function buildMockDb(petStatus = "lost", eventId = INSERTED_EVENT_ID) {
  let selectCallCount = 0;
  /** Whether the last `.values()` persisted anything — drives `.returning()`. */
  let lastInsertPersisted = true;

  // Positional fake: each terminated select returns the next fixture in order.
  //
  // Terminating on `.limit()` ALONE was a trap (2026-08-04): the action's owner
  // lookup stopped calling `.limit(1)` — it now reads every active ownership row
  // so it can RANK them (ROUTE-1) — and the chain silently handed back the
  // builder object instead of rows, so `.find` was not a function. The chain is
  // thenable now, so a query that ends at `.where()` resolves the same way and
  // this fake stops depending on how a query happens to be spelled.
  function nextResult(): unknown[] {
    selectCallCount++;
    if (selectCallCount === 1) {
      // pet query — the token resolution, and the thing the limiter must precede
      callOrder.push("pet-lookup");
      return [
        { id: PET_ID, name: "Luna", status: petStatus, inCustodyDispute: petInCustodyDispute },
      ];
    }
    if (selectCallCount === 2) {
      // active holders — ranked by role, titular wins
      return activeCaretakerPresent
        ? [
            { userId: OWNER_USER_ID, role: "owner" },
            { userId: CARETAKER_USER_ID, role: "caretaker" },
          ]
        : [{ userId: OWNER_USER_ID, role: "owner" }];
    }
    if (selectCallCount === 3) {
      // idempotency query
      return idempotencyReturnEvent ? [{ id: IDEMPOTENT_EXISTING_EVENT_ID }] : [];
    }
    if (selectCallCount === 4) {
      // open case query
      return [{ id: CASE_ID }];
    }
    // Origin-shelter lookup and anything after it: this fixture's pet never
    // passed through a shelter, so the A5 notification block is skipped.
    return [];
  }

  const selectChain = {
    from: vi.fn(() => selectChain),
    where: vi.fn(() => selectChain),
    innerJoin: vi.fn(() => selectChain),
    leftJoin: vi.fn(() => selectChain),
    orderBy: vi.fn(() => selectChain),
    limit: vi.fn(async () => nextResult()),
    // The object this fake stands in for — Drizzle's query builder — IS a
    // thenable by design: `await db.select().from(x).where(y)` resolves with no
    // terminal call. A double that is not thenable can only emulate the queries
    // that happen to end in `.limit()`, and that gap is exactly what broke here.
    // biome-ignore lint/suspicious/noThenProperty: emulating Drizzle's thenable query builder
    then: (resolve: (v: unknown[]) => unknown) => resolve(nextResult()),
  };

  // insertChain supports .values().returning() (petEvents) and .values() alone
  // (notifications, attachments).
  const insertChain = {
    values: vi.fn((raw: Record<string, unknown> | Record<string, unknown>[]) => {
      lastInsertPersisted = true;
      // custodia-temporal: the possession alert became a SET (titular +
      // active caretaker), so `.values()` now receives an array here. The
      // per-field assertions below are about the notification's CONTENT, which
      // is identical for every recipient, so the first row answers them —
      // `capturedNotificationRows` is what the recipient-count assertions use.
      const rows = Array.isArray(raw) ? raw : [raw];
      const data = rows[0] ?? {};
      if ("errorMessage" in data) {
        // A notification_dead_letter row. It CARRIES a `payload` key, so without
        // this branch first it was misfiled as a pet event and silently
        // overwrote the real one — the double corrupting what the test reads.
        capturedDeadLetterRows.push(...rows);
      } else if ("payload" in data) {
        capturedPetEventInsert = data;
      } else if ("storagePath" in data) {
        capturedAttachmentInsert = data;
      } else {
        // ACCUMULATE, do not overwrite. The possession alert is now written one
        // recipient per call through createNotification (idempotent + durable),
        // where it used to be a single `.values([a, b])`. Overwriting made the
        // recipient-count assertions see only the last call.
        const keys = persistedDedupeKeys;
        const persisted = keys
          ? rows.filter((row) => {
              const key = String(row.dedupeKey);
              if (keys.has(key)) return false;
              keys.add(key);
              return true;
            })
          : rows;
        lastInsertPersisted = persisted.length > 0;
        capturedNotificationInsert ??= persisted[0] ?? null;
        capturedNotificationRows.push(...persisted);
      }
      return insertChain;
    }),
    // createNotification's path: .values().onConflictDoNothing().returning().
    // Without this the whole canonical write threw, fell into its own
    // dead-letter, and the assertions below were quietly grading the
    // dead-letter row instead of the notification.
    onConflictDoNothing: vi.fn(() => insertChain),
    returning: vi.fn(async () => (lastInsertPersisted ? [{ id: eventId }] : [])),
  };

  mockDb.select = vi.fn(() => selectChain);
  mockDb.insert = vi.fn(() => insertChain);
}

const mockDb = {
  select: vi.fn(),
  insert: vi.fn(),
};

vi.mock("@/db", () => ({
  db: mockDb,
  pets: {},
  ownerships: {},
  petEvents: {},
  notifications: {},
  cases: {},
  profiles: {},
  attachments: {},
}));

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reportFinderInPossessionAction — P0e", () => {
  beforeEach(() => {
    capturedPetEventInsert = null;
    capturedNotificationInsert = null;
    capturedNotificationRows = [];
    capturedDeadLetterRows = [];
    capturedAttachmentInsert = null;
    idempotencyReturnEvent = false;
    activeCaretakerPresent = false;
    callOrder.length = 0;
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    mockUpload.mockReset();
    mockUpload.mockResolvedValue({
      uploadedPath: "finder-photo-abc.jpg",
      mimeType: "image/jpeg",
      size: 4000,
      error: null,
    });
    buildMockDb("lost");
  });

  // --- Happy paths ---

  it("anon happy path: inserts petEvent (kind=finder_in_possession) and notification", async () => {
    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );
    const fd = makeFormData({ ...BASE_FIELDS, canKeepIndefinite: "true" });

    const result = await reportFinderInPossessionAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();

    // petEvent was inserted.
    expect(capturedPetEventInsert).not.toBeNull();
    const payload = capturedPetEventInsert?.payload as Record<string, unknown>;
    expect(payload.kind).toBe("finder_in_possession");
    expect(payload.finderName).toBe("Ana González");
    expect(payload.finderContact).toBe("11-5555-0001");
    expect(capturedPetEventInsert?.authorRole).toBe("finder");
    expect(capturedPetEventInsert?.recordedByUserId).toBeNull();
    expect(capturedPetEventInsert?.authorVerified).toBe(false);

    // Full possession-specific fields must be present in the persisted payload
    // (guards against the validate-then-discard bypass re-emerging).
    expect(payload.location).toEqual({
      localityName: "La Plata",
      provinceCode: null,
      provinceName: null,
    });
    // Exact point persisted on the event row (columns, not payload) — this is
    // what the owner-side map reads to show where the finder has the pet.
    expect(capturedPetEventInsert?.locationLat).toBe("-34.92");
    expect(capturedPetEventInsert?.locationLng).toBe("-57.95");
    expect(payload.petCondition).toBe("bien");
    expect(payload.canKeepIndefinite).toBe(true);
    expect(payload.canKeepUntil).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(payload, "message")).toBe(true);

    // notification was inserted.
    expect(capturedNotificationInsert).not.toBeNull();
    // ROUTE-1 parity at the CALL SITE, not just in the helper: this fixture's
    // pet has one active holder and no caretaker, so exactly ONE notification
    // must be written — the same single alert this action always sent.
    expect(capturedNotificationRows).toHaveLength(1);
    expect(capturedNotificationRows[0].userId).toBe(OWNER_USER_ID);
    expect(capturedNotificationInsert?.notificationType).toBe("pet_in_possession");
    expect(capturedNotificationInsert?.severity).toBe("urgent");
    expect(capturedNotificationInsert?.category).toBe("perdidas");
  });

  it("includes photoStoragePath in payload when photo upload succeeds", async () => {
    vi.resetModules();
    buildMockDb("lost");
    mockUpload.mockResolvedValue({
      uploadedPath: "finder-photo-xyz.jpg",
      mimeType: "image/jpeg",
      size: 3000,
      error: null,
    });

    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );
    const photo = new File(["fake-image-bytes"], "luna-now.jpg", { type: "image/jpeg" });
    const fd = makeFormData({ ...BASE_FIELDS, canKeepIndefinite: "true", photoNow: photo });

    const result = await reportFinderInPossessionAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(true);
    const payload = capturedPetEventInsert?.payload as Record<string, unknown>;
    expect(payload.photoStoragePath).toBe("finder-photo-xyz.jpg");
  });

  it("photo upload failure is non-fatal: ok:true + warning set, no photoStoragePath", async () => {
    vi.resetModules();
    buildMockDb("lost");
    mockUpload.mockResolvedValue({
      uploadedPath: null,
      mimeType: null,
      size: null,
      error: "network error",
    });

    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );
    const photo = new File(["bytes"], "fail.jpg", { type: "image/jpeg" });
    const fd = makeFormData({ ...BASE_FIELDS, canKeepIndefinite: "true", photoNow: photo });

    const result = await reportFinderInPossessionAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(true);
    expect(result.warning).toBeTruthy();
    const payload = capturedPetEventInsert?.payload as Record<string, unknown>;
    expect(payload.photoStoragePath == null).toBe(true);
  });

  // --- Logged-in path: finder anonymity invariant ---

  it("logged-in finder: recordedByUserId stays NULL and authorVerified=false (anonymity invariant)", async () => {
    vi.resetModules();
    buildMockDb("lost");
    // Simulate a logged-in session — the action must ignore it entirely.
    mockGetUser.mockResolvedValue({
      data: { user: { id: FINDER_USER_ID, email: "ana@test.com" } },
      error: null,
    });

    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );
    const fd = makeFormData({ ...BASE_FIELDS, canKeepIndefinite: "true" });

    const result = await reportFinderInPossessionAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(true);
    // The report must NOT link the finder's DIM account: identity lives only
    // in the typed payload fields (finderName / finderContact).
    expect(capturedPetEventInsert?.recordedByUserId).toBeNull();
    expect(capturedPetEventInsert?.authorVerified).toBe(false);
    const payload = capturedPetEventInsert?.payload as Record<string, unknown>;
    expect(payload.finderName).toBe("Ana González");
  });

  // --- Validation failures ---

  it("returns ok:false when pet is not lost", async () => {
    vi.resetModules();
    buildMockDb("active");

    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );
    const fd = makeFormData({ ...BASE_FIELDS, canKeepIndefinite: "true" });

    const result = await reportFinderInPossessionAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(capturedPetEventInsert).toBeNull();
  });

  // A06-G5: the D2 gate is server-side because the action is anon-callable —
  // a hand-rolled POST reaches it with no page in between.
  it("refuses a pet under custody dispute and relays nothing to the contested owner", async () => {
    vi.resetModules();
    buildMockDb("lost");
    petInCustodyDispute = true;
    try {
      const { reportFinderInPossessionAction } = await import(
        "@/app/(public)/p/[publicToken]/encontre/action"
      );
      const fd = makeFormData({ ...BASE_FIELDS, canKeepIndefinite: "true" });

      const result = await reportFinderInPossessionAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

      expect(result).toEqual({
        ok: false,
        error:
          "En esta credencial los avisos los recibe la autoridad competente, no la persona registrada como dueña. Enviá tu aviso desde la credencial de la mascota.",
      });
      // createNotificationsBulk writes a notifications or a dead-letter row;
      // the refusal must come before any insert at all.
      expect(mockDb.insert).not.toHaveBeenCalled();
      expect(capturedPetEventInsert).toBeNull();
      expect(capturedNotificationRows).toHaveLength(0);
      expect(capturedDeadLetterRows).toHaveLength(0);
    } finally {
      petInCustodyDispute = false;
    }
  });

  it("accepts a handoff without finderName (anonymous, PO 2026-07-24) — payload carries null, copy falls back to 'Alguien'", async () => {
    vi.resetModules();
    buildMockDb("lost");
    mockUpload.mockResolvedValue({ uploadedPath: null, mimeType: null, size: null, error: null });

    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );
    const { finderName: _dropped, ...noName } = BASE_FIELDS;
    const fd = makeFormData({ ...noName, canKeepIndefinite: "true" });

    const result = await reportFinderInPossessionAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(true);
    const payload = capturedPetEventInsert?.payload as Record<string, unknown>;
    expect(payload.finderName).toBeNull();
    expect(capturedNotificationInsert?.body as string).toContain("Alguien");
  });

  it("a validation-rejected submission does NOT consume the rate-limit budget (tester fix #6)", async () => {
    vi.resetModules();
    buildMockDb("lost");
    mockEnforceRateLimit.mockClear();

    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );
    // No lat/lng — the required map point is missing → rejected pre-limit.
    const fd = makeFormData({
      finderName: "Ana",
      finderPhone: "1111",
      localityName: "La Plata",
      petCondition: "bien",
      canKeepIndefinite: "true",
    });

    const result = await reportFinderInPossessionAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(false);
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
  });

  // --- Ordering: the limiter runs before the token is resolved (E1) ---
  //
  // The last of three token-existence oracles in this family. `report-pet-
  // sighting.ts` and `report-dispute-tip.ts` were fixed on 2026-08-21 — both had
  // been EXEMPT from the throttle-coverage fence on the written claim that their
  // limiter ran first, and in both it ran after. This action carried the same
  // inversion, and the same exemption text, tracked in that commit and closed
  // here. Its refusal strings are its own oracle: "Mascota no encontrada." vs
  // "Esta mascota no está marcada como perdida." vs the dispute notice — three
  // distinguishable answers about a token, free, to anyone who can POST.

  it("consults the limiter BEFORE it resolves the token", async () => {
    vi.resetModules();
    buildMockDb("lost");

    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );
    const fd = makeFormData({ ...BASE_FIELDS, canKeepIndefinite: "true" });

    const result = await reportFinderInPossessionAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(true);
    // ORDER, not presence. A limiter consulted after the lookup bounds nothing.
    expect(callOrder.slice(0, 2)).toEqual(["rate-limit", "pet-lookup"]);
  });

  it("resolves NO token at all for a caller already over the limit", async () => {
    vi.resetModules();
    buildMockDb("lost");
    mockEnforceRateLimit.mockRejectedValueOnce(
      new MockRateLimitError(new Date(Date.now() + 60_000), "finder_possession"),
    );

    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );
    const fd = makeFormData({ ...BASE_FIELDS, canKeepIndefinite: "true" });

    const result = await reportFinderInPossessionAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(false);
    // THE ORACLE, CLOSED. A throttled caller learns nothing about the token —
    // no query ran, so there is nothing for the answer to have been derived
    // from, and the refusal is the same for every token in the space.
    expect(callOrder).toEqual(["rate-limit"]);
  });

  it("accepts a handoff without any contact — owner is told no contact was left (PO 2026-07-24)", async () => {
    vi.resetModules();
    buildMockDb("lost");
    mockUpload.mockResolvedValue({ uploadedPath: null, mimeType: null, size: null, error: null });

    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );
    const fd = makeFormData({
      finderName: "Ana",
      locationLat: "-34.92",
      locationLng: "-57.95",
      localityName: "La Plata",
      petCondition: "bien",
      canKeepIndefinite: "true",
    });

    const result = await reportFinderInPossessionAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(true);
    const payload = capturedPetEventInsert?.payload as Record<string, unknown>;
    expect(payload.finderContact).toBeNull();
    expect(capturedNotificationInsert?.body as string).toContain("No dejó datos de contacto");
  });

  it("returns ok:false when the map point is missing", async () => {
    vi.resetModules();
    buildMockDb("lost");

    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );
    // Has locality but NO lat/lng — the exact point is now the required field.
    const fd = makeFormData({
      finderName: "Ana",
      finderPhone: "1111",
      localityName: "La Plata",
      petCondition: "bien",
      canKeepIndefinite: "true",
    });

    const result = await reportFinderInPossessionAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("dónde");
  });

  it("returns ok:false when neither canKeepUntil nor canKeepIndefinite is set", async () => {
    vi.resetModules();
    buildMockDb("lost");

    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );
    const fd = makeFormData({
      finderName: "Ana",
      finderPhone: "1111",
      locationLat: "-34.92",
      locationLng: "-57.95",
      localityName: "La Plata",
      petCondition: "bien",
      // no canKeepIndefinite or canKeepUntil
    });

    const result = await reportFinderInPossessionAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("cuándo");
  });

  // --- Rate limiting (persistent DB-backed enforceRateLimit) ---

  it("returns ok:false when rate limit is exceeded (enforceRateLimit throws RateLimitError)", async () => {
    vi.resetModules();
    buildMockDb("lost");
    // Simulate the persistent limiter throwing a RateLimitError.
    mockEnforceRateLimit.mockRejectedValue(
      new MockRateLimitError(
        new Date(Date.now() + 60_000),
        "finder_possession:DIM-P0E-TEST-001:10.0.0.1:minute",
      ),
    );

    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );
    const fd = makeFormData({ ...BASE_FIELDS, canKeepIndefinite: "true" });

    const result = await reportFinderInPossessionAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("poco");
    expect(capturedPetEventInsert).toBeNull();
  });

  // --- Idempotency ---

  it("returns ok:true without a second insert when an identical event exists in the last 5 min", async () => {
    vi.resetModules();
    idempotencyReturnEvent = true;
    buildMockDb("lost");

    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );
    const fd = makeFormData({ ...BASE_FIELDS, canKeepIndefinite: "true" });

    const result = await reportFinderInPossessionAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    // The EVENT is what the guard protects: no second copy in the spine.
    expect(capturedPetEventInsert).toBeNull();

    // THE NOTIFICATION IS RE-ATTEMPTED, and this assertion is the inverse of
    // what stood here before. The old expectation — that a retry writes no
    // notification — froze a real bug as the spec: the event is written first
    // and the owner's alert second, so a first attempt that died in between
    // left the finder with an error and the owner with nothing. Pressing the
    // button again found the event, returned the success screen, and told
    // nobody. Both people then believed the report went through.
    //
    // A retry is evidence that attempt 1 may have failed, not proof that it
    // succeeded. Re-attempting is safe because the write now carries a dedupe
    // key derived from the event id: if the alert did land the first time,
    // ON CONFLICT DO NOTHING makes this a no-op and no second push goes out.
    expect(capturedNotificationInsert).not.toBeNull();
    expect(capturedNotificationInsert?.notificationType).toBe("pet_in_possession");
    expect(capturedNotificationInsert?.dedupeKey).toBe(
      `event:${IDEMPOTENT_EXISTING_EVENT_ID}:${OWNER_USER_ID}:pet_in_possession`,
    );
    // Keyed off the EXISTING event, not a fresh id — that is what lets the
    // no-op recognise the alert attempt 1 already made.
    expect(capturedNotificationInsert?.relatedEventId).toBe(IDEMPOTENT_EXISTING_EVENT_ID);
    // And nothing fell into the dead-letter: the canonical path really ran.
    expect(capturedDeadLetterRows).toHaveLength(0);
  });

  // --- Notification copy for vet-urgent condition ---

  it("notification title contains URGENTE when petCondition is 'necesita vet urgente'", async () => {
    vi.resetModules();
    buildMockDb("lost");
    mockUpload.mockResolvedValue({ uploadedPath: null, mimeType: null, size: null, error: null });

    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );
    const fd = makeFormData({
      finderName: "Carlos",
      finderPhone: "9999",
      locationLat: "-32.95",
      locationLng: "-60.66",
      localityName: "Rosario",
      petCondition: "necesita_vet_urgente",
      canKeepIndefinite: "true",
    });

    await reportFinderInPossessionAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(capturedNotificationInsert?.title as string).toContain("URGENTE");
  });

  // --- custodia-temporal: fan-out to the active caretaker ---

  it("notifies the titular AND the active caretaker, with the SAME finder contact", async () => {
    // The spec's scenario. The caretaker is the person who physically has this
    // animal's routine; a redacted copy of the alert would make the second
    // recipient useless at the only thing they are there for. The titular loses
    // nothing — same alert, ranked first.
    vi.resetModules();
    activeCaretakerPresent = true;
    buildMockDb("lost");
    mockUpload.mockResolvedValue({ uploadedPath: null, mimeType: null, size: null, error: null });

    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );
    const fd = makeFormData({ ...BASE_FIELDS, canKeepIndefinite: "true" });

    const result = await reportFinderInPossessionAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(true);
    expect(capturedNotificationRows).toHaveLength(2);
    expect(capturedNotificationRows.map((r) => r.userId)).toEqual([
      OWNER_USER_ID,
      CARETAKER_USER_ID,
    ]);
    // Identical payload, not a summarised second copy.
    expect(capturedNotificationRows[1].body).toBe(capturedNotificationRows[0].body);
    expect(capturedNotificationRows[0].body as string).toContain("11-5555-0001");
    expect(capturedNotificationRows[1].body as string).toContain("11-5555-0001");
    expect(capturedNotificationRows[1].severity).toBe("urgent");
  });

  // --- caseId association ---

  it("sets caseId on the petEvent when an open lost case exists", async () => {
    vi.resetModules();
    buildMockDb("lost");
    mockUpload.mockResolvedValue({ uploadedPath: null, mimeType: null, size: null, error: null });

    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );
    const fd = makeFormData({ ...BASE_FIELDS, canKeepIndefinite: "true" });

    await reportFinderInPossessionAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(capturedPetEventInsert?.caseId).toBe(CASE_ID);
  });

  // --- P0g: attachments table integration ---

  it("P0g: inserts an attachments row linked to the event when photo upload succeeds", async () => {
    vi.resetModules();
    buildMockDb("lost");
    capturedAttachmentInsert = null;
    mockUpload.mockResolvedValue({
      uploadedPath: "finder-photo-abc.jpg",
      mimeType: "image/jpeg",
      size: 4000,
      error: null,
    });

    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );
    const photo = new File(["fake-image-bytes"], "luna-now.jpg", { type: "image/jpeg" });
    const fd = makeFormData({ ...BASE_FIELDS, canKeepIndefinite: "true", photoNow: photo });

    const result = await reportFinderInPossessionAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(true);
    expect(capturedAttachmentInsert).not.toBeNull();
    const att = capturedAttachmentInsert as unknown as Record<string, unknown>;
    expect(att.eventId).toBe(INSERTED_EVENT_ID);
    expect(att.petId).toBe(PET_ID);
    expect(att.storagePath).toBe("finder-photo-abc.jpg");
    // Anonymous (no logged-in user): uploadedByUserId must be null.
    expect(att.uploadedByUserId).toBeNull();
  });

  it("P0g: uploadedByUserId stays NULL on attachment even when finder is logged in", async () => {
    vi.resetModules();
    buildMockDb("lost");
    capturedAttachmentInsert = null;
    // Simulate a logged-in session — the attachment must NOT link the account.
    mockGetUser.mockResolvedValue({
      data: { user: { id: FINDER_USER_ID, email: "ana@test.com" } },
      error: null,
    });
    mockUpload.mockResolvedValue({
      uploadedPath: "finder-photo-loggedin.jpg",
      mimeType: "image/jpeg",
      size: 3000,
      error: null,
    });

    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );
    const photo = new File(["fake-image-bytes"], "now.jpg", { type: "image/jpeg" });
    const fd = makeFormData({ ...BASE_FIELDS, canKeepIndefinite: "true", photoNow: photo });

    await reportFinderInPossessionAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(
      (capturedAttachmentInsert as unknown as Record<string, unknown>).uploadedByUserId,
    ).toBeNull();
  });

  it("P0g: does NOT insert an attachments row when no photo is provided", async () => {
    vi.resetModules();
    buildMockDb("lost");
    capturedAttachmentInsert = null;
    mockUpload.mockResolvedValue({ uploadedPath: null, mimeType: null, size: null, error: null });

    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );
    const fd = makeFormData({ ...BASE_FIELDS, canKeepIndefinite: "true" });

    const result = await reportFinderInPossessionAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    expect(result.ok).toBe(true);
    expect(capturedAttachmentInsert).toBeNull();
  });

  // --- Contact concatenation ---

  it("concatenates phone and email in finderContact when both provided", async () => {
    vi.resetModules();
    buildMockDb("lost");
    mockUpload.mockResolvedValue({ uploadedPath: null, mimeType: null, size: null, error: null });

    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );
    const fd = makeFormData({
      finderName: "María",
      finderPhone: "11-1111-2222",
      finderEmail: "maria@test.com",
      locationLat: "-34.92",
      locationLng: "-57.95",
      localityName: "La Plata",
      petCondition: "bien",
      canKeepIndefinite: "true",
    });

    await reportFinderInPossessionAction(PUBLIC_TOKEN, PREVIOUS_STATE, fd);

    const payload = capturedPetEventInsert?.payload as Record<string, unknown>;
    expect(payload.finderContact as string).toContain("11-1111-2222");
    expect(payload.finderContact as string).toContain("maria@test.com");
  });
});

// ---------------------------------------------------------------------------
// The animal's own ceiling (audit A03-2)
// ---------------------------------------------------------------------------
//
// The heaviest of the anonymous reports: an urgent alert per recipient plus a
// row on the spine. The per-(address, token) bucket alone let N addresses send
// 10 × N of them an hour. The second bucket is keyed on the token alone; its
// ceiling is stated here as 5/min + 30/hour, independently of the constant.
//
// Over that ceiling this surface DEGRADES instead of refusing: the event and the
// finder's contact are still written, the owner's alert just stops ringing, and
// the owner gets one "muchos avisos" notice per clock hour.

describe("reportFinderInPossessionAction — the animal's own ceiling (A03-2)", () => {
  const FIELDS = { ...BASE_FIELDS, canKeepIndefinite: "true" };

  afterEach(() => {
    persistedDedupeKeys = null;
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.resetModules();
    persistedDedupeKeys = new Set();
    capturedPetEventInsert = null;
    capturedNotificationInsert = null;
    capturedNotificationRows = [];
    capturedDeadLetterRows = [];
    capturedAttachmentInsert = null;
    idempotencyReturnEvent = false;
    activeCaretakerPresent = false;
    callOrder.length = 0;
    callerAddress.value = "10.0.0.1";
    mockEnforceRateLimit.mockReset().mockResolvedValue(undefined);
    mockUpload.mockReset().mockResolvedValue({
      uploadedPath: null,
      mimeType: null,
      size: null,
      error: null,
    });
    buildMockDb("lost");
  });

  it("spends three buckets: the address's, keyed (token, ip), and the animal's two, keyed on the token alone", async () => {
    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );
    await reportFinderInPossessionAction(PUBLIC_TOKEN, PREVIOUS_STATE, makeFormData(FIELDS));

    expect(mockEnforceRateLimit.mock.calls).toEqual([
      [`finder_possession:${PUBLIC_TOKEN}`, "10.0.0.1", { maxPerMinute: 1, maxPerHour: 10 }],
      // The hard ceiling: 300/h = 10 x the degrade ceiling of 30. Hour only.
      ["finder_possession_token_hard", PUBLIC_TOKEN, { maxPerHour: 300 }],
      ["finder_possession_token", PUBLIC_TOKEN, { maxPerMinute: 5, maxPerHour: 30 }],
    ]);
    // Address bucket, lookup, animal buckets: those wait for the refusals that
    // write nothing.
    expect(callOrder).toEqual(["rate-limit", "pet-lookup", "rate-limit", "rate-limit"]);
  });

  it("keeps ACCEPTING a fresh address once thirty others have reported within the hour: the report degrades, it is never refused", async () => {
    // Fixed clock windows + 1/min per address: five addresses fill the 30/h
    // ceiling in six minutes. A refusal from here on would let whoever filled
    // it keep every real finder away from the owner until the hour turns.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T15:10:00.000Z"));
    const limiter = makeFakeRateLimiter((key) => new MockRateLimitError(new Date(), key));
    mockEnforceRateLimit.mockImplementation(limiter.enforce);
    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );

    for (let n = 1; n <= 30; n++) {
      buildMockDb("lost", `evt-flood-${n}`);
      callerAddress.value = `203.0.113.${n}`;
      const ok = await reportFinderInPossessionAction(
        PUBLIC_TOKEN,
        PREVIOUS_STATE,
        makeFormData({ ...FIELDS, finderPhone: `11-0000-${String(n).padStart(4, "0")}` }),
      );
      expect(ok.ok, `report ${n} should have landed`).toBe(true);
      limiter.advance(61_000);
    }
    // Inside the ceiling nothing changed: thirty urgent alerts, no notice.
    expect(capturedNotificationRows).toHaveLength(30);
    expect(capturedNotificationRows.every((row) => row.severity === "urgent")).toBe(true);

    buildMockDb("lost", "evt-real-finder");
    capturedPetEventInsert = null;
    capturedNotificationRows = [];
    vi.mocked(sendPushForNotifications).mockClear();
    callerAddress.value = "198.51.100.200";
    const accepted = await reportFinderInPossessionAction(
      PUBLIC_TOKEN,
      PREVIOUS_STATE,
      makeFormData({ ...FIELDS, finderPhone: "11-4444-7777" }),
    );

    // The finder sees the normal success: no refusal, no "probá más tarde".
    expect(accepted).toEqual({ ok: true, error: null, warning: null });

    // The spine still gets the report, contact and all.
    expect(capturedPetEventInsert).not.toBeNull();
    const payload = (capturedPetEventInsert as unknown as { payload: Record<string, unknown> })
      .payload;
    expect(payload.finderContact).toBe("11-4444-7777");

    // The owner gets the finder's contact, on a row that does not ring.
    const reports = capturedNotificationRows.filter(
      (r) => r.notificationType === "pet_in_possession",
    );
    expect(reports).toHaveLength(1);
    expect(reports[0].userId).toBe(OWNER_USER_ID);
    expect(reports[0].body).toContain("11-4444-7777");
    expect(reports[0].severity).toBe("warning");
    expect(reports[0].relatedEventId).toBe("evt-real-finder");

    // And the owner is told, once, that reports are piling up - and THAT one
    // rings: it is the only signal the silent reports exist at all.
    const notices = capturedNotificationRows.filter(
      (r) => r.notificationType === "anonymous_reports_overflow",
    );
    expect(notices).toHaveLength(1);
    const pushed = vi
      .mocked(sendPushForNotifications)
      .mock.calls.flatMap((call) => call[0] as Array<Record<string, unknown>>);
    expect(pushed.map((row) => row.notificationType)).toEqual(["anonymous_reports_overflow"]);
    expect(notices[0]).toMatchObject({
      userId: OWNER_USER_ID,
      severity: "urgent",
      category: "perdidas",
      relatedPetId: PET_ID,
      title: "Muchos avisos sobre Luna",
      dedupeKey: `found_overflow:${PUBLIC_TOKEN}:2026-09-18T15:00:00.000Z:${OWNER_USER_ID}`,
    });
  });

  it("writes ONE overflow notice for the hour however many reports cross the ceiling, and every report still lands", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T15:00:00.000Z"));
    const limiter = makeFakeRateLimiter((key) => new MockRateLimitError(new Date(), key));
    mockEnforceRateLimit.mockImplementation(limiter.enforce);
    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );

    // 45 reports, one address each, 61 s apart: 45 minutes, one clock hour.
    let events = 0;
    for (let n = 1; n <= 45; n++) {
      buildMockDb("lost", `evt-${n}`);
      capturedPetEventInsert = null;
      callerAddress.value = `203.0.113.${n}`;
      const result = await reportFinderInPossessionAction(
        PUBLIC_TOKEN,
        PREVIOUS_STATE,
        makeFormData({ ...FIELDS, finderPhone: `11-0000-${String(n).padStart(4, "0")}` }),
      );
      expect(result.ok, `report ${n}`).toBe(true);
      if (capturedPetEventInsert) events++;
      limiter.advance(61_000);
      vi.setSystemTime(new Date(Date.now() + 61_000));
    }

    expect(events).toBe(45);
    const reports = capturedNotificationRows.filter(
      (r) => r.notificationType === "pet_in_possession",
    );
    expect(reports).toHaveLength(45);
    expect(reports[44].body).toContain("11-0000-0045");
    expect(reports.filter((r) => r.severity === "urgent")).toHaveLength(30);
    expect(reports.filter((r) => r.severity === "warning")).toHaveLength(15);
    expect(
      capturedNotificationRows.filter((r) => r.notificationType === "anonymous_reports_overflow"),
    ).toHaveLength(1);
  });

  it("over the degrade ceiling the report lands WITHOUT its photo, and the finder is told the photo was not kept", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T15:10:00.000Z"));
    const limiter = makeFakeRateLimiter((key) => new MockRateLimitError(new Date(), key));
    mockEnforceRateLimit.mockImplementation(limiter.enforce);
    mockUpload.mockReset().mockResolvedValue({
      uploadedPath: "finder-photo.jpg",
      mimeType: "image/jpeg",
      size: 3000,
      error: null,
    });
    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );
    const photo = () => new File(["fake-image-bytes"], "luna.jpg", { type: "image/jpeg" });

    // Inside the ceiling the photo is stored, exactly as before.
    for (let n = 1; n <= 30; n++) {
      buildMockDb("lost", `evt-in-${n}`);
      callerAddress.value = `203.0.113.${n}`;
      const result = await reportFinderInPossessionAction(
        PUBLIC_TOKEN,
        PREVIOUS_STATE,
        makeFormData({ ...FIELDS, photoNow: photo() }),
      );
      expect(result, `report ${n}`).toEqual({ ok: true, error: null, warning: null });
      limiter.advance(61_000);
    }
    expect(mockUpload).toHaveBeenCalledTimes(30);

    mockUpload.mockClear();
    buildMockDb("lost", "evt-over");
    capturedPetEventInsert = null;
    capturedAttachmentInsert = null;
    callerAddress.value = "198.51.100.200";
    const over = await reportFinderInPossessionAction(
      PUBLIC_TOKEN,
      PREVIOUS_STATE,
      makeFormData({ ...FIELDS, finderPhone: "11-4444-7777", photoNow: photo() }),
    );

    expect(over).toEqual({
      ok: true,
      error: null,
      warning:
        "El aviso fue registrado, pero la foto no se guardó porque llegaron muchos avisos sobre esta mascota en la última hora.",
    });
    expect(mockUpload).not.toHaveBeenCalled();
    expect(capturedAttachmentInsert).toBeNull();
    const payload = (capturedPetEventInsert as unknown as { payload: Record<string, unknown> })
      .payload;
    expect(payload.finderContact).toBe("11-4444-7777");
    expect(payload.photoStoragePath == null).toBe(true);
  });

  it("the hard ceiling: reports 1-30 ring, 31-300 land degraded without a photo, the 301st is refused and writes nothing", async () => {
    // 300 reports, 12 s apart = 5 a minute (exactly the degrade minute cap, so
    // only the hour decides who degrades): the 300th lands at 299 x 12 s =
    // 59 min 48 s, and the 301st at the same instant - one clock hour.
    // One IPv6 /64 each - what a /48 hands out 65 536 of.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T15:00:00.000Z"));
    const limiter = makeFakeRateLimiter((key) => new MockRateLimitError(new Date(), key));
    mockEnforceRateLimit.mockImplementation(limiter.enforce);
    mockUpload.mockReset().mockResolvedValue({
      uploadedPath: "finder-photo.jpg",
      mimeType: "image/jpeg",
      size: 3000,
      error: null,
    });
    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );
    const address = (n: number) => `2001:db8:0:${n.toString(16)}::1`;

    let events = 0;
    for (let n = 1; n <= 300; n++) {
      if (n > 1) {
        limiter.advance(12_000);
        vi.setSystemTime(new Date(Date.now() + 12_000));
      }
      buildMockDb("lost", `evt-${n}`);
      capturedPetEventInsert = null;
      callerAddress.value = address(n);
      const result = await reportFinderInPossessionAction(
        PUBLIC_TOKEN,
        PREVIOUS_STATE,
        makeFormData({
          ...FIELDS,
          finderPhone: `11-0000-${String(n).padStart(4, "0")}`,
          photoNow: new File(["x"], "p.jpg", { type: "image/jpeg" }),
        }),
      );
      expect(result.ok, `report ${n}`).toBe(true);
      if (capturedPetEventInsert) events++;
    }

    expect(events).toBe(300);
    // Only the thirty inside the degrade ceiling stored a photo.
    expect(mockUpload).toHaveBeenCalledTimes(30);
    const reports = capturedNotificationRows.filter(
      (r) => r.notificationType === "pet_in_possession",
    );
    expect(reports.filter((r) => r.severity === "urgent")).toHaveLength(30);
    expect(reports.filter((r) => r.severity === "warning")).toHaveLength(270);

    buildMockDb("lost", "evt-refused");
    capturedPetEventInsert = null;
    const before = capturedNotificationRows.length;
    callerAddress.value = address(301);
    const refused = await reportFinderInPossessionAction(
      PUBLIC_TOKEN,
      PREVIOUS_STATE,
      makeFormData({ ...FIELDS, finderPhone: "11-9999-0301" }),
    );

    expect(refused.ok).toBe(false);
    expect(refused.error).toBe(
      "Recibimos demasiados avisos sobre esta mascota en la última hora y no podemos registrar otro ahora. " +
        "Si la credencial muestra un teléfono, llamá directamente; si no, una veterinaria o un refugio " +
        "puede leer su microchip. Probá de nuevo cuando empiece la próxima hora.",
    );
    expect(capturedPetEventInsert).toBeNull();
    expect(capturedNotificationRows.length).toBe(before);
  });

  it("a report refused before any write (pet not lost) does not spend the animal's budget", async () => {
    buildMockDb("active");
    const { reportFinderInPossessionAction } = await import(
      "@/app/(public)/p/[publicToken]/encontre/action"
    );
    const result = await reportFinderInPossessionAction(
      PUBLIC_TOKEN,
      PREVIOUS_STATE,
      makeFormData(FIELDS),
    );

    expect(result.ok).toBe(false);
    expect(mockEnforceRateLimit.mock.calls.map((call) => call[0])).toEqual([
      `finder_possession:${PUBLIC_TOKEN}`,
    ]);
  });
});
