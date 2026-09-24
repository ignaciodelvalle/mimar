// Abuse budgets on the physical-tag lifecycle actions (app/actions/tags.ts).
//
// WHY THIS FILE EXISTS (abuse-surface audit, S1): `activateTagAction` was
// rate-limited from day one — it guards an evidence gate, so a botnet guessing
// wrapper codes is the obvious threat. `revokeTagAction` had NO budget at all,
// and it is the more DESTRUCTIVE of the two: revocation is terminal (a revoked
// chapa can never be reactivated), it takes a FOR UPDATE row lock, appends to
// the append-only spine and fans a notification out to every co-owner. Being
// authenticated bounds who can call it, not how often.
//
// These tests drive the REAL enforceRateLimit against an in-memory
// rate_limit_buckets store (the scan-log-rate-limit.ts pattern — a faithful
// stand-in for the DB-backed atomic UPSERT), and the writers are mocked so a
// throttled call can be proven to never REACH them.
//
// Contract asserted here:
//   - revoke is bounded per IP (10/min) and per serial (3/min);
//   - a throttled call answers the shared "Demasiados intentos" copy and the
//     writer is not invoked;
//   - a call inside budget still reaches the writer (the limiter must not be a
//     blanket refusal — a test that only proves refusals passes on a broken
//     action too);
//   - both budgets key on the NORMALIZED serial, so "tag-abcd-2345" and
//     "TAG-ABCD-2345" share one bucket instead of handing an attacker a fresh
//     budget per casing;
//   - activation's existing budgets (5/min per IP, 3/min per serial) are pinned
//     at the same time — they had no test either.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const rateLimitBucketsRef = { __table: "rate_limit_buckets" };
  return {
    rateLimitBucketsRef,
    bucketCounts: new Map<string, number>(),
    activateCalls: [] as unknown[],
    revokeCalls: [] as unknown[],
  };
});

// Trusted edge IP present — the shape callerIp() prefers.
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (k: string) => (k === "x-real-ip" ? "203.0.113.77" : null),
  })),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }) },
  })),
}));

// Active (non-erased) profile: the right-to-erasure lockout is not what is
// under test here.
vi.mock("@/lib/infra/request-cache", () => ({
  getProfileCached: vi.fn(async () => ({ deletedAt: null })),
}));

// @/db — only the rate_limit_buckets UPSERT matters; it drives the counter the
// REAL enforceRateLimit reads back through .returning().
vi.mock("@/db", () => {
  function rlChain() {
    let key = "";
    const chain = {
      values: (v: { bucketKey: string }) => {
        key = v.bucketKey;
        return chain;
      },
      onConflictDoUpdate: () => chain,
      returning: async () => {
        const next = (h.bucketCounts.get(key) ?? 0) + 1;
        h.bucketCounts.set(key, next);
        return [{ count: next }];
      },
    };
    return chain;
  }
  return {
    db: { insert: () => rlChain() },
    rateLimitBuckets: h.rateLimitBucketsRef,
    petTags: {},
    pets: {},
  };
});

// The writers are the thing a throttled call must never reach.
vi.mock("@/src/modules/pets/application/tags/activate-tag", () => ({
  activateTagForUser: vi.fn(async (...args: unknown[]) => {
    h.activateCalls.push(args);
    return { ok: true, eventId: "event-activate" };
  }),
}));
vi.mock("@/src/modules/pets/application/tags/revoke-tag", () => ({
  revokeTagForUser: vi.fn(async (...args: unknown[]) => {
    h.revokeCalls.push(args);
    return { ok: true, eventId: "event-revoke" };
  }),
}));
vi.mock("@/src/modules/pets/application/tags/issue-tag-batch", () => ({
  issueTagBatchForAdmin: vi.fn(async () => ({ ok: true, rows: [] })),
}));

const PET_ID = "22222222-2222-4222-8222-222222222222";
const THROTTLED = /demasiados intentos/i;

/**
 * A DISTINCT serial per call, so a per-IP budget can be measured on its own.
 *
 * Uniqueness is load-bearing and easy to get wrong: the first version of this
 * built the suffix from `String(n).padStart(4, "0").replace(/0/g, "2")`, which
 * maps n=0 and n=2 to the same "2222" — quietly spending two of the per-SERIAL
 * budget while the test believed it was only exercising the per-IP one.
 */
function serialFor(n: number): string {
  // The issued-serial alphabet (lib/infra/publicToken.ts): no 0/1/I/O.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const lo = alphabet[n % alphabet.length];
  const hi = alphabet[Math.floor(n / alphabet.length) % alphabet.length];
  return `TAG-ABCD-${hi}${lo}23`;
}

async function revoke(serial: string) {
  const { revokeTagAction } = await import("@/app/actions/tags");
  return revokeTagAction({ serial, revokeReason: "damaged" });
}

async function activate(serial: string) {
  const { activateTagAction } = await import("@/app/actions/tags");
  return activateTagAction({ serial, activationCode: "WXYZ-6789", petId: PET_ID });
}

beforeEach(() => {
  h.bucketCounts.clear();
  h.activateCalls.length = 0;
  h.revokeCalls.length = 0;
  // Freeze the clock so every call in a test lands in the same minute window;
  // without this a run that straddles :59 → :00 silently gets a fresh bucket.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-05T12:00:30.000Z"));
});

describe("revokeTagAction — per-IP budget", () => {
  it("allows 10 revocations a minute and refuses the 11th without reaching the writer", async () => {
    for (let i = 0; i < 10; i++) {
      const result = await revoke(serialFor(i));
      expect(result, `revocation ${i + 1} of 10 should be inside budget`).toMatchObject({
        ok: true,
      });
    }
    expect(h.revokeCalls).toHaveLength(10);

    const throttled = await revoke(serialFor(99));
    expect("error" in throttled && throttled.error).toMatch(THROTTLED);
    // The writer never ran: no row lock, no spine append, no notification.
    expect(h.revokeCalls).toHaveLength(10);
  });
});

describe("revokeTagAction — per-serial budget", () => {
  it("allows 3 attempts on one serial and refuses the 4th", async () => {
    const serial = "TAG-ABCD-2345";
    for (let i = 0; i < 3; i++) {
      expect(await revoke(serial)).toMatchObject({ ok: true });
    }
    const throttled = await revoke(serial);
    expect("error" in throttled && throttled.error).toMatch(THROTTLED);
    expect(h.revokeCalls).toHaveLength(3);
  });

  it("keys on the NORMALIZED serial, so casing cannot buy a fresh budget", async () => {
    await revoke("tag-abcd-2345");
    const serialKeys = [...h.bucketCounts.keys()].filter((k) => k.startsWith("tag_revoke_serial:"));
    expect(serialKeys.length).toBeGreaterThan(0);
    for (const key of serialKeys) {
      expect(key).toContain("TAG-ABCD-2345");
      expect(key).not.toContain("tag-abcd-2345");
    }
  });

  it("bounds the IP and the serial under their own endpoint keys", async () => {
    await revoke("TAG-ABCD-2345");
    const keys = [...h.bucketCounts.keys()];
    expect(keys.some((k) => k.startsWith("tag_revoke_ip:203.0.113.77:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("tag_revoke_serial:TAG-ABCD-2345:"))).toBe(true);
    // Both windows are armed, not just the per-minute one.
    expect(keys.filter((k) => k.startsWith("tag_revoke_ip:")).length).toBe(2);
  });
});

describe("activateTagAction — the budgets that already existed, now pinned", () => {
  it("allows 5 activations a minute from one IP and refuses the 6th", async () => {
    for (let i = 0; i < 5; i++) {
      expect(await activate(serialFor(i))).toMatchObject({ ok: true });
    }
    const throttled = await activate(serialFor(99));
    expect("error" in throttled && throttled.error).toMatch(THROTTLED);
    expect(h.activateCalls).toHaveLength(5);
  });

  it("allows 3 attempts on one serial and refuses the 4th", async () => {
    const serial = "TAG-EFGH-6789";
    for (let i = 0; i < 3; i++) {
      expect(await activate(serial)).toMatchObject({ ok: true });
    }
    const throttled = await activate(serial);
    expect("error" in throttled && throttled.error).toMatch(THROTTLED);
    expect(h.activateCalls).toHaveLength(3);
  });
});
