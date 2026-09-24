// notifyOwnerOfFoundPetAction — the "encontré tu mascota" channel.
//
// WHAT THIS FILE IS ABOUT
// ---------------------------------------------------------------------------
// Someone scans the QR of a lost dog, types their phone number and presses
// send. This action is the ENTIRE circuit: it writes no event, no case, no
// sighting — the notification IS the only place the finder's phone number goes.
// So two failure modes here are not "a missed notification", they are the
// report itself disappearing while the person is told it arrived:
//
//   1. DURABILITY. The write used to be a bare `db.insert(notifications)`
//      inside a swallowing try/catch, with no dedupe key and no dead-letter. A
//      200 ms hiccup in the pool — a deploy, a pooler restart — and the insert
//      failed, the error was logged, and the action returned "listo". The
//      finder walked away certain the owner had been told. Nothing had been
//      written anywhere.
//   2. THE RECIPIENT. The owner was picked with an unranked `.limit(1)` over
//      every active ownership row, with no role filter. On a pet with an active
//      foster Postgres was free to hand back the foster, and the finder's phone
//      went to them instead of the titular. That exact bug was found and fixed
//      in the SIBLING flow (ROUTE-1, audit 2026-08-04) and the fix — ranked
//      recipients in lib/infra/pet-alert-recipients.ts — was never brought here.
//      Worse: a row held by an ORGANISATION has a null user id, and when one of
//      those came back first the action answered "No se encontró un dueño
//      activo" over a perfectly notifiable titular.
//
// WHY THE DEAD-LETTER ASSERTION USES THE REAL SERVICE. Asserting that the code
// "calls createNotificationsBulk" would prove a wiring diagram, not durability.
// These tests run the REAL lib/infra/notification-service over a mocked `@/db`,
// make the notifications insert throw, and then look for the finder's phone
// number in `notification_dead_letter` — where the retry cron can find it.
//
// Also covered (kept from the original file): the persistent rate-limit
// migration, the anonymous-report cases (PO 2026-07-24), and the rule that a
// rejected submission does not burn the (IP, token) budget.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendPushForNotifications } from "@/lib/infra/web-push";

import { makeFakeRateLimiter } from "./_helpers/fake-rate-limiter";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PUBLIC_TOKEN = "DIM-PUBLIC-NOTIFY-001";
const PET_ID = "pet-pub-0000-0000-000000000001";
const OWNER_USER_ID = "user-pub-0000-0000-000000000001";
const FOSTER_USER_ID = "user-pub-0000-0000-000000000002";
const CARETAKER_USER_ID = "user-pub-0000-0000-000000000003";
const PREVIOUS_STATE = { ok: false as const, error: null };

// ---------------------------------------------------------------------------
// Mock: next/headers
// ---------------------------------------------------------------------------

/** The caller's address, per test — the token-ceiling tests rotate it. */
const { callerAddress } = vi.hoisted(() => ({ callerAddress: { value: "203.0.113.42" } }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    // x-real-ip is the trusted edge IP — callerIp() prefers it over XFF.
    get: (key: string) => (key === "x-real-ip" ? callerAddress.value : null),
  })),
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/rate-limit — allow by default; tests override per case.
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

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: (endpoint: string, id: string, cfg: unknown) =>
      mockEnforceRateLimit(endpoint, id, cfg),
    RateLimitError: MockRateLimitError,
  };
});

// The push leg is a delivery channel, not a record. Stubbed so a test failure
// here can only ever be about what was PERSISTED.
vi.mock("@/lib/infra/web-push", () => ({
  sendPushForNotifications: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mock: @/db
//
// Table identity matters: the assertions are about WHICH table a row landed in
// (notifications vs notification_dead_letter), so the sentinels are distinct
// objects the mock can compare against, not the interchangeable `{}` they were.
// ---------------------------------------------------------------------------

const TABLES = vi.hoisted(() => ({
  pets: { __table: "pets" },
  ownerships: { __table: "ownerships" },
  notifications: { __table: "notifications" },
  notificationDeadLetter: { __table: "notification_dead_letter" },
}));

type Row = Record<string, unknown>;

let petRows: Row[] = [];
let holderRows: Row[] = [];
let notificationsInsertThrows = false;
let insertedNotifications: Row[] = [];
let deadLetteredRows: Row[] = [];
/**
 * The partial unique index `notifications_dedupe_key_unique`, which the
 * service's ON CONFLICT DO NOTHING leans on. Without it every "once an hour"
 * claim below would be untestable: the double would persist every duplicate.
 */
let persistedDedupeKeys = new Set<string>();

/**
 * A hand-rolled Drizzle builder double: every method returns the chain, and the
 * chain is thenable so `await` at any point yields rows — which is how the real
 * builder behaves, and what lets the production code await wherever it does.
 */
type Chain = any;

function selectChain(): Chain {
  let table: unknown = null;
  const rows = (): Row[] => {
    if (table === TABLES.pets) return petRows;
    if (table === TABLES.ownerships) return holderRows;
    return [];
  };
  const chain: Chain = {
    from: (t: unknown) => {
      table = t;
      return chain;
    },
    where: () => chain,
    limit: () => chain,
    orderBy: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    // Thenable, so `await` on any point of the chain yields the rows — a real
    // Drizzle builder is thenable for exactly this reason.
    // biome-ignore lint/suspicious/noThenProperty: that is what makes it a builder double.
    then: (res: (v: Row[]) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(res, rej),
  };
  return chain;
}

function insertChain(table: unknown): Chain {
  const failing = table === TABLES.notifications && notificationsInsertThrows;
  let written: Row[] = [{}];
  const settle = (): Promise<Row[]> => {
    if (failing) return Promise.reject(new Error("pool blip: connection terminated"));
    return Promise.resolve(written.map((_, i) => ({ id: `notif-${i + 1}` })));
  };
  const chain: Chain = {
    values: (v: Row | Row[]) => {
      const rows = Array.isArray(v) ? v : [v];
      if (table === TABLES.notifications) {
        // A failing insert records what was ATTEMPTED (the dead-letter tests
        // read it); a succeeding one persists only keys it has not seen.
        written = failing
          ? rows
          : rows.filter((row) => {
              const key = String(row.dedupeKey);
              if (persistedDedupeKeys.has(key)) return false;
              persistedDedupeKeys.add(key);
              return true;
            });
        insertedNotifications.push(...written);
      }
      if (table === TABLES.notificationDeadLetter) deadLetteredRows.push(...rows);
      return chain;
    },
    onConflictDoNothing: () => chain,
    returning: () => settle(),
    // biome-ignore lint/suspicious/noThenProperty: same builder double as above.
    then: (res: (v: Row[]) => unknown, rej: (e: unknown) => unknown) => settle().then(res, rej),
  };
  return chain;
}

const mockDb = vi.hoisted(() => ({ select: vi.fn(), insert: vi.fn() }));

vi.mock("@/db", () => ({
  db: mockDb,
  pets: TABLES.pets,
  ownerships: TABLES.ownerships,
  notifications: TABLES.notifications,
  notificationDeadLetter: TABLES.notificationDeadLetter,
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal();
  return actual as object;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

const BASE_FIELDS = {
  finderName: "Roberto Sánchez",
  finderContact: "11-9999-8888",
};

const LIVE_PET: Row = {
  id: PET_ID,
  name: "Pochi",
  status: "active",
  publicToken: PUBLIC_TOKEN,
  inCustodyDispute: false,
};

function reset(options: { petFound?: boolean; holders?: Row[] } = {}): void {
  petRows = options.petFound === false ? [] : [LIVE_PET];
  holderRows = options.holders ?? [
    { userId: OWNER_USER_ID, role: "owner", startedAt: new Date("2026-01-01") },
  ];
  notificationsInsertThrows = false;
  insertedNotifications = [];
  deadLetteredRows = [];
  persistedDedupeKeys = new Set();
  callerAddress.value = "203.0.113.42";
  mockEnforceRateLimit.mockReset().mockResolvedValue(undefined);
  mockDb.select.mockReset().mockImplementation(() => selectChain());
  mockDb.insert.mockReset().mockImplementation((t: unknown) => insertChain(t));
}

async function loadAction() {
  const mod = await import("@/app/actions/public");
  return mod.notifyOwnerOfFoundPetAction;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("notifyOwnerOfFoundPetAction — persistent rate-limit migration", () => {
  beforeEach(() => {
    reset();
  });

  it("happy path: inserts notification row when finder provides valid data", async () => {
    const result = await (await loadAction())(
      PUBLIC_TOKEN,
      PREVIOUS_STATE,
      makeFormData(BASE_FIELDS),
    );

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(insertedNotifications).toHaveLength(1);
    expect(insertedNotifications[0].notificationType).toBe("pet_found_report");
    expect(insertedNotifications[0].severity).toBe("urgent");
    expect(insertedNotifications[0].userId).toBe(OWNER_USER_ID);
  });

  it("calls enforceRateLimit with the IP from x-forwarded-for", async () => {
    await (await loadAction())(PUBLIC_TOKEN, PREVIOUS_STATE, makeFormData(BASE_FIELDS));

    expect(mockEnforceRateLimit).toHaveBeenCalledWith(
      expect.stringContaining("found_notify"),
      "203.0.113.42",
      expect.objectContaining({ maxPerMinute: 1, maxPerHour: 10 }),
    );
  });

  it("returns ok:false when enforceRateLimit throws RateLimitError", async () => {
    mockEnforceRateLimit.mockRejectedValue(
      new MockRateLimitError(
        new Date(Date.now() + 60_000),
        `found_notify:${PUBLIC_TOKEN}:203.0.113.42:minute`,
      ),
    );

    const result = await (await loadAction())(
      PUBLIC_TOKEN,
      PREVIOUS_STATE,
      makeFormData(BASE_FIELDS),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("poco");
    expect(insertedNotifications).toHaveLength(0);
  });

  it("returns ok:false when pet is not found", async () => {
    reset({ petFound: false });

    const result = await (await loadAction())(
      PUBLIC_TOKEN,
      PREVIOUS_STATE,
      makeFormData(BASE_FIELDS),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("no encontrada");
  });

  it("accepts a report without finderName (anonymous, PO 2026-07-24) — body falls back to 'Alguien'", async () => {
    const result = await (await loadAction())(
      PUBLIC_TOKEN,
      PREVIOUS_STATE,
      makeFormData({ finderContact: "1111" }),
    );

    expect(result.ok).toBe(true);
    expect(insertedNotifications[0].body as string).toContain("Alguien");
    expect(insertedNotifications[0].body as string).toContain("1111");
  });

  // TURNED AROUND 2026-08-22. This test used to assert the opposite — that a
  // rejected submission does NOT consume the budget, filed as "tester fix #6".
  // That reading is superseded, and it was superseded for every OTHER public
  // POST back in 967a1f3c: charging only for submissions that resolve makes the
  // door an existence oracle. The refusal for an unknown token would be free and
  // distinguishable from the refusal for a known one, so anyone could enumerate
  // the national token space at no cost — which is the entire threat the
  // (IP, token) limiter exists to price.
  //
  // The tester's complaint was real and is not dismissed: a person who fat-fingers
  // a token does burn one of their ten hourly attempts. That is the accepted cost,
  // and it is the same cost the sighting and dispute-tip forms already charge.
  //
  // Keeping this test green was not free either: it pinned the inversion in place,
  // so whoever moved the limiter to its correct position would have met a red test
  // and concluded they were wrong. See __tests__/public-token-throttle-coverage.
  it("a rejected submission (pet not found) DOES consume the budget — the door charges before it resolves", async () => {
    reset({ petFound: false });

    const result = await (await loadAction())(
      PUBLIC_TOKEN,
      PREVIOUS_STATE,
      makeFormData(BASE_FIELDS),
    );

    expect(result.ok).toBe(false);
    // Charged, and charged BEFORE the lookup could tell the caller anything.
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(1);
    expect(mockEnforceRateLimit).toHaveBeenCalledWith(
      `found_notify:${PUBLIC_TOKEN}`,
      expect.anything(),
      expect.objectContaining({ maxPerMinute: 1, maxPerHour: 10 }),
    );
  });

  // A06-G5: the D2 gate is server-side because the action is anon-callable; the
  // credential page hiding the form is not the gate. Deleting the `if` must
  // turn this red.
  it("refuses a pet under custody dispute and relays nothing to the contested owner", async () => {
    petRows = [{ ...LIVE_PET, inCustodyDispute: true }];

    const result = await (await loadAction())(
      PUBLIC_TOKEN,
      PREVIOUS_STATE,
      makeFormData(BASE_FIELDS),
    );

    expect(result).toEqual({
      ok: false,
      error:
        "En esta credencial los avisos los recibe la autoridad competente, no la persona registrada como dueña. Enviá tu aviso desde la credencial de la mascota.",
    });
    // createNotificationsBulk was never reached: it writes either a
    // notifications row or a dead-letter row, and there is neither.
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(insertedNotifications).toHaveLength(0);
    expect(deadLetteredRows).toHaveLength(0);
  });

  it("accepts a report without finderContact — owner is told no contact was left", async () => {
    const result = await (await loadAction())(
      PUBLIC_TOKEN,
      PREVIOUS_STATE,
      makeFormData({ finderName: "Ana" }),
    );

    expect(result.ok).toBe(true);
    expect(insertedNotifications[0].body as string).toContain("Ana");
    expect(insertedNotifications[0].body as string).toContain("No dejó datos de contacto");
  });
});

describe("notifyOwnerOfFoundPetAction — the report survives a failed write", () => {
  beforeEach(() => {
    reset();
  });

  it("dead-letters the finder's phone number when the notifications insert throws", async () => {
    // THE BUG, exactly: a transient failure on the only write in this circuit.
    notificationsInsertThrows = true;

    const result = await (await loadAction())(
      PUBLIC_TOKEN,
      PREVIOUS_STATE,
      makeFormData(BASE_FIELDS),
    );

    // Still "listo" for the finder — a stranger doing a favour must not be
    // handed a scary error, and an error invites a resend the dedupe key would
    // then swallow. The honesty lives in the dead-letter, not in the copy.
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();

    // And the report is somewhere the retry cron can replay it, with the phone
    // number intact. Without this the number existed only in a request that has
    // already returned.
    expect(deadLetteredRows).toHaveLength(1);
    const payload = deadLetteredRows[0].payload as Record<string, unknown>;
    expect(payload.userId).toBe(OWNER_USER_ID);
    expect(String(payload.body)).toContain("11-9999-8888");
    expect(deadLetteredRows[0].dedupeKey).toBeTruthy();
  });

  it("carries a dedupe key so the replay cannot double-notify", async () => {
    await (await loadAction())(PUBLIC_TOKEN, PREVIOUS_STATE, makeFormData(BASE_FIELDS));

    expect(insertedNotifications[0].dedupeKey).toBeTruthy();
  });

  it("NON-VACUITY: nothing is dead-lettered when the insert succeeds", async () => {
    await (await loadAction())(PUBLIC_TOKEN, PREVIOUS_STATE, makeFormData(BASE_FIELDS));

    expect(insertedNotifications).toHaveLength(1);
    expect(deadLetteredRows).toHaveLength(0);
  });
});

describe("notifyOwnerOfFoundPetAction — who hears it (ROUTE-1 ranking)", () => {
  it("notifies the TITULAR even when a foster row comes back first", async () => {
    // The unranked `.limit(1)` let Postgres return the foster, and the finder's
    // phone went to them while the titular never heard. Same bug, same pet
    // shape, as the one already fixed in the sibling flow.
    reset({
      holders: [
        { userId: FOSTER_USER_ID, role: "foster", startedAt: new Date("2026-02-01") },
        { userId: OWNER_USER_ID, role: "owner", startedAt: new Date("2026-01-01") },
      ],
    });

    const result = await (await loadAction())(
      PUBLIC_TOKEN,
      PREVIOUS_STATE,
      makeFormData(BASE_FIELDS),
    );

    expect(result.ok).toBe(true);
    expect(insertedNotifications.map((n) => n.userId)).toContain(OWNER_USER_ID);
  });

  it("also reaches an active caretaker, with the same body", async () => {
    // The person physically minding the animal is a concurrent recipient, not a
    // fallback — the same decision the sibling flow made (proposal D2).
    reset({
      holders: [
        { userId: OWNER_USER_ID, role: "owner", startedAt: new Date("2026-01-01") },
        { userId: CARETAKER_USER_ID, role: "caretaker", startedAt: new Date("2026-02-01") },
      ],
    });

    await (await loadAction())(PUBLIC_TOKEN, PREVIOUS_STATE, makeFormData(BASE_FIELDS));

    const userIds = insertedNotifications.map((n) => n.userId);
    expect(userIds).toContain(OWNER_USER_ID);
    expect(userIds).toContain(CARETAKER_USER_ID);
    expect(new Set(insertedNotifications.map((n) => n.body)).size).toBe(1);
  });

  it("does not refuse a notifiable titular because an org-held row came first", async () => {
    // 229 rows in the local database are org-held custody with a null user id.
    // One of those first meant "No se encontró un dueño activo" over a titular
    // who was right there.
    reset({
      holders: [
        { userId: null, role: "shelter_custody", startedAt: new Date("2026-02-01") },
        { userId: OWNER_USER_ID, role: "owner", startedAt: new Date("2026-01-01") },
      ],
    });

    const result = await (await loadAction())(
      PUBLIC_TOKEN,
      PREVIOUS_STATE,
      makeFormData(BASE_FIELDS),
    );

    expect(result.ok).toBe(true);
    expect(insertedNotifications.map((n) => n.userId)).toContain(OWNER_USER_ID);
  });

  it("still refuses when nobody can be notified at all", async () => {
    reset({ holders: [] });

    const result = await (await loadAction())(
      PUBLIC_TOKEN,
      PREVIOUS_STATE,
      makeFormData(BASE_FIELDS),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("dueño activo");
  });
});

// ---------------------------------------------------------------------------
// The animal's own ceiling (audit A03-2)
// ---------------------------------------------------------------------------
//
// This action writes nothing but urgent notifications, so the per-(address,
// token) bucket alone meant 10 × N "alguien encontró a tu mascota" an hour for
// anyone with N addresses. The second bucket is keyed on the token alone. Its
// ceiling is stated here as 5/min + 30/hour, independently of the constant.
//
// Over that ceiling this surface DEGRADES instead of refusing: the report is
// still written with the finder's contact, it just stops ringing, and the owner
// gets one "muchos avisos" notice per clock hour.

describe("notifyOwnerOfFoundPetAction — the animal's own ceiling (A03-2)", () => {
  beforeEach(() => {
    reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spends three buckets: the address's, keyed (token, ip), and the animal's two, keyed on the token alone", async () => {
    await (await loadAction())(PUBLIC_TOKEN, PREVIOUS_STATE, makeFormData(BASE_FIELDS));

    expect(mockEnforceRateLimit.mock.calls).toEqual([
      [`found_notify:${PUBLIC_TOKEN}`, "203.0.113.42", { maxPerMinute: 1, maxPerHour: 10 }],
      // The hard ceiling: 300/h = 10 x the degrade ceiling of 30. Hour only.
      ["found_notify_token_hard", PUBLIC_TOKEN, { maxPerHour: 300 }],
      ["found_notify_token", PUBLIC_TOKEN, { maxPerMinute: 5, maxPerHour: 30 }],
    ]);
  });

  it("keeps ACCEPTING a fresh address once thirty others have reported within the hour: the report degrades, it is never refused", async () => {
    // Fixed clock windows + 1/min per address: five addresses fill the 30/h
    // ceiling in six minutes. A refusal from here on would let whoever filled
    // it keep every real finder away from the owner until the hour turns.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T15:10:00.000Z"));
    const limiter = makeFakeRateLimiter((key) => new MockRateLimitError(new Date(), key));
    mockEnforceRateLimit.mockImplementation(limiter.enforce);
    const action = await loadAction();

    for (let n = 1; n <= 30; n++) {
      callerAddress.value = `203.0.113.${n}`;
      const ok = await action(PUBLIC_TOKEN, PREVIOUS_STATE, makeFormData(BASE_FIELDS));
      expect(ok.ok, `report ${n} should have landed`).toBe(true);
      limiter.advance(61_000);
    }
    // Inside the ceiling nothing changed: thirty urgent alerts, no notice.
    expect(insertedNotifications).toHaveLength(30);
    expect(insertedNotifications.every((row) => row.severity === "urgent")).toBe(true);

    insertedNotifications = [];
    vi.mocked(sendPushForNotifications).mockClear();
    callerAddress.value = "198.51.100.200";
    const accepted = await action(
      PUBLIC_TOKEN,
      PREVIOUS_STATE,
      makeFormData({ finderName: "Marta", finderContact: "11-4444-7777" }),
    );

    // The finder sees the normal success: no refusal, no "probá más tarde".
    expect(accepted).toEqual({ ok: true, error: null });

    // Their contact reached the owner, on a row that does not ring.
    const reports = insertedNotifications.filter((r) => r.notificationType === "pet_found_report");
    expect(reports).toHaveLength(1);
    expect(reports[0].userId).toBe(OWNER_USER_ID);
    expect(reports[0].body).toContain("11-4444-7777");
    expect(reports[0].severity).toBe("warning");

    // And the owner is told, once, that reports are piling up - and THAT one
    // rings: it is the only signal the silent reports exist at all.
    const notices = insertedNotifications.filter(
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
      title: "Muchos avisos sobre Pochi",
      dedupeKey: `found_overflow:${PUBLIC_TOKEN}:2026-09-18T15:00:00.000Z:${OWNER_USER_ID}`,
    });
    expect(notices[0].body).toMatch(/Llegaron muchos avisos sobre Pochi en la última hora/);
  });

  it("writes ONE overflow notice for the hour however many reports cross the ceiling, and every report still arrives", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T15:00:00.000Z"));
    const limiter = makeFakeRateLimiter((key) => new MockRateLimitError(new Date(), key));
    mockEnforceRateLimit.mockImplementation(limiter.enforce);
    const action = await loadAction();

    // 45 reports, one address each, 61 s apart: 45 minutes, one clock hour.
    for (let n = 1; n <= 45; n++) {
      callerAddress.value = `203.0.113.${n}`;
      const result = await action(
        PUBLIC_TOKEN,
        PREVIOUS_STATE,
        makeFormData({ finderContact: `11-0000-${String(n).padStart(4, "0")}` }),
      );
      expect(result, `report ${n}`).toEqual({ ok: true, error: null });
      limiter.advance(61_000);
      vi.setSystemTime(new Date(Date.now() + 61_000));
    }

    const reports = insertedNotifications.filter((r) => r.notificationType === "pet_found_report");
    expect(reports).toHaveLength(45);
    expect(reports[44].body).toContain("11-0000-0045");
    expect(reports.filter((r) => r.severity === "urgent")).toHaveLength(30);
    expect(reports.filter((r) => r.severity === "warning")).toHaveLength(15);
    expect(
      insertedNotifications.filter((r) => r.notificationType === "anonymous_reports_overflow"),
    ).toHaveLength(1);
  });

  it("the hard ceiling: reports 1-30 ring, 31-300 arrive degraded, the 301st is refused and writes nothing", async () => {
    // 300 reports 12 s apart = 5 a minute (exactly the degrade minute cap, so
    // only the hour decides who degrades): the 300th at 299 x 12 s = 59 min
    // 48 s and the 301st at the same instant - one clock hour. One IPv6 /64
    // each, which is what a /48 hands out 65 536 of.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T15:00:00.000Z"));
    const limiter = makeFakeRateLimiter((key) => new MockRateLimitError(new Date(), key));
    mockEnforceRateLimit.mockImplementation(limiter.enforce);
    const action = await loadAction();
    const address = (n: number) => `2001:db8:0:${n.toString(16)}::1`;

    for (let n = 1; n <= 300; n++) {
      if (n > 1) {
        limiter.advance(12_000);
        vi.setSystemTime(new Date(Date.now() + 12_000));
      }
      callerAddress.value = address(n);
      const result = await action(
        PUBLIC_TOKEN,
        PREVIOUS_STATE,
        makeFormData({ finderContact: `11-0000-${String(n).padStart(4, "0")}` }),
      );
      expect(result, `report ${n}`).toEqual({ ok: true, error: null });
    }
    const reports = insertedNotifications.filter((r) => r.notificationType === "pet_found_report");
    expect(reports.filter((r) => r.severity === "urgent")).toHaveLength(30);
    expect(reports.filter((r) => r.severity === "warning")).toHaveLength(270);

    const before = insertedNotifications.length;
    callerAddress.value = address(301);
    const refused = await action(
      PUBLIC_TOKEN,
      PREVIOUS_STATE,
      makeFormData({ finderContact: "11-9999-0301" }),
    );

    expect(refused).toEqual({
      ok: false,
      error:
        "Recibimos demasiados avisos sobre esta mascota en la última hora y no podemos registrar otro ahora. " +
        "Si la credencial muestra un teléfono, llamá directamente; si no, una veterinaria o un refugio " +
        "puede leer su microchip. Probá de nuevo cuando empiece la próxima hora.",
    });
    expect(insertedNotifications.length).toBe(before);
  });

  it("a report refused before any write does not spend the animal's budget", async () => {
    // Nobody notifiable → refused. The token bucket sits after that refusal on
    // purpose: a submission that writes nothing must not bring the animal
    // closer to its ceiling.
    reset({ holders: [] });
    await (await loadAction())(PUBLIC_TOKEN, PREVIOUS_STATE, makeFormData(BASE_FIELDS));

    const buckets = mockEnforceRateLimit.mock.calls.map((call) => call[0]);
    expect(buckets).toEqual([`found_notify:${PUBLIC_TOKEN}`]);
  });
});
