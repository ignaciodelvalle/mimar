// Unit tests for reportDisputeTip (dispute-safe finder tip, PO 2026-07-24).
//
// The contract under test (see report-dispute-tip.ts header):
//   1. Disputed pet + info → case_events row (entry_type finder_tip) on the
//      open dispute case, recordedByUserId NULL — and NO notification insert
//      of any kind (neither disputing party may learn a tip exists).
//   2. Non-disputed pet → hard refusal, nothing written.
//   3. Missing info → rejected WITHOUT consuming the rate-limit budget.
//   4. Rate limit exceeded → ok:false, nothing written.
//   5. Name/contact/location optional → payload nulls, notes say "no informado".
//   6. Integrity hole (disputed pet without an open dispute case) → honest
//      error, nothing written.
//   7. ORDER: pure input validation → limiter → token lookup. Anything that
//      reads the pet row before the limiter is an unbounded oracle (below).

import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeFakeRateLimiter } from "@/__tests__/_helpers/fake-rate-limiter";

const PUBLIC_TOKEN = "DIM-DISP-TIP-001";
const PET_ID = "pet-disp-0000-0000-000000000001";
const CASE_ID = "case-disp-0000-0000-000000000001";
const CALLER_IP = "203.0.113.99";

// ---------------------------------------------------------------------------
// Mock: rate limit — allow by default; tests override per case.
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

const mockReportError = vi.fn();
vi.mock("@/lib/infra/report-error", () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
}));

// ---------------------------------------------------------------------------
// Mock: @/db
// ---------------------------------------------------------------------------

let capturedInserts: Record<string, unknown>[] = [];
// Controls the two sequenced selects: pet row, then dispute-case join.
let petRow: Record<string, unknown> | null = null;
let caseRow: Record<string, unknown> | null = null;

function buildMockDb() {
  let selectCallCount = 0;

  const selectChain = {
    from: vi.fn(() => selectChain),
    where: vi.fn(() => selectChain),
    innerJoin: vi.fn(() => selectChain),
    limit: vi.fn(async () => {
      selectCallCount++;
      if (selectCallCount === 1) {
        callOrder.push("publicPetByToken");
        return petRow ? [petRow] : [];
      }
      return caseRow ? [caseRow] : [];
    }),
  };

  const insertChain = {
    values: vi.fn(async (data: Record<string, unknown>) => {
      capturedInserts.push(data);
      return insertChain;
    }),
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
  cases: {},
  custodyDisputes: {},
  caseEvents: {},
  // The shared custody-lock predicate (db/schema.ts). The use-case calls it to
  // build its WHERE; the mocked drizzle chain never inspects the result, so a
  // sentinel is enough — what matters is that the export EXISTS, because a
  // missing one makes the whole file fail to collect with zero failing tests.
  disputeHoldsCustodyLock: () => ({ __mock: "disputeHoldsCustodyLock" }),
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

async function importUseCase() {
  const mod = await import("@/src/modules/custody-disputes/application/report-dispute-tip");
  return mod.reportDisputeTip;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reportDisputeTip — dispute-safe finder tip", () => {
  beforeEach(() => {
    capturedInserts = [];
    callOrder = [];
    mockReportError.mockClear();
    mockEnforceRateLimit.mockClear();
    mockEnforceRateLimit.mockResolvedValue(undefined);
    petRow = { id: PET_ID, name: "Luna", inCustodyDispute: true };
    caseRow = { caseId: CASE_ID };
    buildMockDb();
  });

  it("disputed pet: inserts a finder_tip case event on the open dispute case and NOTHING else", async () => {
    const reportDisputeTip = await importUseCase();
    const fd = makeFormData({
      info: "La vi en la plaza con un señor de campera roja.",
      locationText: "Plaza Mitre, Quilmes",
      finderName: "Marta",
      finderContact: "11-4444-5555",
    });

    const result = await reportDisputeTip(PUBLIC_TOKEN, CALLER_IP, fd);

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();

    // Exactly ONE insert — the case event. A second insert would be the
    // notification this path must never send.
    expect(capturedInserts).toHaveLength(1);
    const inserted = capturedInserts[0];
    expect(inserted.caseId).toBe(CASE_ID);
    expect(inserted.entryType).toBe("finder_tip");
    // Finder anonymity invariant: never linked to an account.
    expect(inserted.recordedByUserId).toBeNull();
    expect(inserted.notes as string).toContain("La vi en la plaza");
    expect(inserted.notes as string).toContain("Plaza Mitre");
    expect(inserted.notes as string).toContain("Marta");
    const payload = inserted.payload as Record<string, unknown>;
    expect(payload.source).toBe("public_credential");
    expect(payload.finder_contact).toBe("11-4444-5555");
  });

  it("hard-refuses a pet WITHOUT an open custody dispute (the normal flows own that case)", async () => {
    petRow = { id: PET_ID, name: "Luna", inCustodyDispute: false };
    buildMockDb();

    const reportDisputeTip = await importUseCase();
    const fd = makeFormData({ info: "La vi por acá." });

    const result = await reportDisputeTip(PUBLIC_TOKEN, CALLER_IP, fd);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("titularidad");
    expect(capturedInserts).toHaveLength(0);
  });

  it("consumes the limiter BEFORE resolving the token (no token-existence oracle)", async () => {
    // This form is hand-postable: nothing requires a page load first, so every
    // request used to reach `publicPetByToken` unbounded. The two refusals are
    // DISTINCT strings — "Mascota no encontrada." vs "…no tiene una revisión de
    // titularidad abierta." — so an attacker could enumerate which DIM tokens
    // exist AND which of them are under custody review, at whatever rate the
    // database would serve. The limiter is what makes that finite; it has to
    // run first to do it.
    const reportDisputeTip = await importUseCase();
    const fd = makeFormData({ info: "La vi en la plaza." });

    await reportDisputeTip(PUBLIC_TOKEN, CALLER_IP, fd);

    // The per-ADDRESS bucket, then the lookup, then the animal's own bucket
    // (A03-2), which deliberately waits for the refusals that write nothing.
    expect(callOrder).toEqual(["limiter", "publicPetByToken", "limiter"]);
  });

  it("still refuses a throttled caller WITHOUT resolving the token", async () => {
    mockEnforceRateLimit.mockRejectedValue(
      new MockRateLimitError(new Date(Date.now() + 60_000), "dispute_tip:minute"),
    );

    const reportDisputeTip = await importUseCase();
    await reportDisputeTip(PUBLIC_TOKEN, CALLER_IP, makeFormData({ info: "La vi." }));

    // Not merely "the limiter ran": a limiter that answers 429 after the read
    // it was supposed to prevent bounds nothing.
    expect(callOrder).toEqual(["limiter"]);
  });

  it("missing info → rejected without consuming the rate-limit budget", async () => {
    const reportDisputeTip = await importUseCase();
    const fd = makeFormData({ finderName: "Marta" }); // no info

    const result = await reportDisputeTip(PUBLIC_TOKEN, CALLER_IP, fd);

    expect(result.ok).toBe(false);
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(capturedInserts).toHaveLength(0);
  });

  it("rate limit exceeded → ok:false and nothing written", async () => {
    mockEnforceRateLimit.mockRejectedValue(
      new MockRateLimitError(new Date(Date.now() + 60_000), "dispute_tip:minute"),
    );

    const reportDisputeTip = await importUseCase();
    const fd = makeFormData({ info: "La vi por acá." });

    const result = await reportDisputeTip(PUBLIC_TOKEN, CALLER_IP, fd);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("poco");
    expect(capturedInserts).toHaveLength(0);
  });

  it("name, contact and location are optional — payload nulls, notes say 'no informado'", async () => {
    const reportDisputeTip = await importUseCase();
    const fd = makeFormData({ info: "Está en el patio de una casa en la esquina." });

    const result = await reportDisputeTip(PUBLIC_TOKEN, CALLER_IP, fd);

    expect(result.ok).toBe(true);
    expect(capturedInserts).toHaveLength(1);
    const payload = capturedInserts[0].payload as Record<string, unknown>;
    expect(payload.finder_name).toBeNull();
    expect(payload.finder_contact).toBeNull();
    expect(payload.location_text).toBeNull();
    expect(capturedInserts[0].notes as string).toContain("no informado");
  });

  it("disputed pet without an open dispute case (integrity hole) → honest error, nothing written", async () => {
    caseRow = null;
    buildMockDb();

    const reportDisputeTip = await importUseCase();
    const fd = makeFormData({ info: "La vi por acá." });

    const result = await reportDisputeTip(PUBLIC_TOKEN, CALLER_IP, fd);

    expect(result.ok).toBe(false);
    expect(mockReportError).toHaveBeenCalled();
    expect(capturedInserts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The animal's own ceiling (audit A03-2)
// ---------------------------------------------------------------------------
//
// Tips land on the case timeline a reviewing authority has to read. The
// per-(address, token) bucket alone let N addresses write 10 × N of them an
// hour. The second bucket is keyed on the token alone; its ceiling is stated
// here as 5/min + 30/hour, independently of the constant.

describe("reportDisputeTip — the animal's own ceiling (A03-2)", () => {
  beforeEach(() => {
    capturedInserts = [];
    callOrder = [];
    mockReportError.mockClear();
    mockEnforceRateLimit.mockReset().mockResolvedValue(undefined);
    petRow = { id: PET_ID, name: "Luna", inCustodyDispute: true };
    caseRow = { caseId: CASE_ID };
    buildMockDb();
  });

  it("spends two buckets: the address's, keyed (token, ip), and the animal's, keyed on the token alone", async () => {
    const reportDisputeTip = await importUseCase();
    await reportDisputeTip(PUBLIC_TOKEN, CALLER_IP, makeFormData({ info: "La vi en la plaza." }));

    expect(mockEnforceRateLimit.mock.calls).toEqual([
      [`dispute_tip:${PUBLIC_TOKEN}`, CALLER_IP, { maxPerMinute: 1, maxPerHour: 10 }],
      ["dispute_tip_token", PUBLIC_TOKEN, { maxPerMinute: 5, maxPerHour: 30 }],
    ]);
  });

  it("refuses a FRESH address once thirty others have sent a tip within the hour", async () => {
    const limiter = makeFakeRateLimiter((key) => new MockRateLimitError(new Date(), key));
    mockEnforceRateLimit.mockImplementation(limiter.enforce);
    const reportDisputeTip = await importUseCase();

    for (let n = 1; n <= 30; n++) {
      buildMockDb();
      const ok = await reportDisputeTip(
        PUBLIC_TOKEN,
        `203.0.113.${n}`,
        makeFormData({ info: `Aviso ${n}` }),
      );
      expect(ok.ok, `tip ${n} should have landed`).toBe(true);
      limiter.advance(61_000);
    }
    expect(capturedInserts).toHaveLength(30);

    buildMockDb();
    const refused = await reportDisputeTip(
      PUBLIC_TOKEN,
      "198.51.100.200",
      makeFormData({ info: "Aviso 31" }),
    );

    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/muchos avisos sobre esta mascota/);
    expect(refused.error).not.toMatch(/Ya enviaste/);
    expect(capturedInserts).toHaveLength(30);
  });

  it("a tip refused before any write (no open dispute) does not spend the animal's budget", async () => {
    petRow = { id: PET_ID, name: "Luna", inCustodyDispute: false };
    buildMockDb();
    const reportDisputeTip = await importUseCase();
    await reportDisputeTip(PUBLIC_TOKEN, CALLER_IP, makeFormData({ info: "La vi." }));

    expect(mockEnforceRateLimit.mock.calls.map((call) => call[0])).toEqual([
      `dispute_tip:${PUBLIC_TOKEN}`,
    ]);
  });
});
