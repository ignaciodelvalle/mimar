// Integration tests for the persistent rate-limit helper. Mirrors the
// in-memory test style — uses the real rate_limit_buckets table so we
// catch UPSERT race semantics that a mock wouldn't.

import { like } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db, rateLimitBuckets } from "@/db";
import {
  RATE_LIMIT_SEGMENT_MAX,
  RateLimitError,
  enforceRateLimit,
  rateLimitKeySegment,
} from "@/lib/infra/rate-limit";

async function clearBucketsByPrefix(prefix: string): Promise<void> {
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucketKey, `${prefix}%`));
}

describe("enforceRateLimit (persistent)", () => {
  // The clock is frozen for the whole file, for the reason this suite exists to
  // test: `enforceRateLimit` is a FIXED-window limiter whose bucket key embeds
  // `Math.floor(Date.now() / 60_000) * 60_000` (and the hour and day analogues).
  // Every test here reaches a ceiling with a SEQUENCE of calls and then asserts
  // the next one throws. If a window boundary falls inside that sequence, the
  // later calls land on a new key, the counter never reaches the ceiling, and
  // the assertion fails on correct code.
  //
  // "combines minute and hour windows" is the sharpest case: `maxPerMinute: 1`,
  // two calls back to back. A minute boundary between them puts the second on a
  // fresh minute key while the hour key sits at 2 of 5 — no throw, red suite.
  // The hour-window tests are the same defect with a 3600× smaller target.
  //
  // This is the same guard, at the same mid-minute `:30`, that
  // localities-search-action, tag-actions-rate-limit and scan-log-rate-limit
  // have carried since 2026-08-08, and that adoption-registered-adopter-finalize
  // gained on 2026-09-10 after going red under a 1218-second full-suite run.
  // This file was the last real-bucket suite without it.
  //
  // ONLY Date is faked. This suite drives the real rate_limit_buckets table
  // through postgres.js, which needs live setTimeout/setInterval for its
  // connection timeouts — faking the whole timer family would hang the driver.
  //
  // AND THE INSTANT IS DERIVED FROM THE REAL CLOCK, NOT HARDCODED. This suite
  // writes real rows, and `enforceRateLimit` stamps `expires_at` from whatever
  // clock it reads. A literal calendar date would be in the past from the day
  // after it was written, and an already-expired bucket is fair game for
  // `cleanupExpiredBuckets` — which __tests__/cron-data-lifecycle.test.ts drains
  // in a loop, `DELETE FROM rate_limit_buckets WHERE expires_at < now()`,
  // against this same database from a parallel worker. That would delete a
  // counter mid-test and hand back the exact flake this guard exists to remove.
  // Mid-minute of the CURRENT minute keeps both properties: no boundary inside
  // any sequence, and an `expires_at` that is still in the future.
  beforeEach(() => {
    const midMinute = Math.floor(Date.now() / 60_000) * 60_000 + 30_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(midMinute));
  });

  afterEach(async () => {
    // Restoring the real clock first is defensive, not required: only `Date` is
    // faked, so postgres.js's connection timers were never touched and the
    // cleanup below reads no clock at all. It runs first so nothing after this
    // point can inherit a frozen clock by accident.
    vi.useRealTimers();
    await clearBucketsByPrefix("test_rl_");
  });

  it("allows calls up to the limit, then throws RateLimitError", async () => {
    const endpoint = "test_rl_basic";
    const id = "alice";
    // limit=3 per hour. First 3 pass, 4th throws.
    await enforceRateLimit(endpoint, id, { maxPerHour: 3 });
    await enforceRateLimit(endpoint, id, { maxPerHour: 3 });
    await enforceRateLimit(endpoint, id, { maxPerHour: 3 });
    await expect(enforceRateLimit(endpoint, id, { maxPerHour: 3 })).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });

  it("disjoint identifiers don't compete", async () => {
    const endpoint = "test_rl_disjoint";
    await enforceRateLimit(endpoint, "user_a", { maxPerHour: 1 });
    // user_b has its own bucket — no throw.
    await enforceRateLimit(endpoint, "user_b", { maxPerHour: 1 });
    // user_a hits its limit:
    await expect(enforceRateLimit(endpoint, "user_a", { maxPerHour: 1 })).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });

  it("disjoint endpoints don't compete", async () => {
    await enforceRateLimit("test_rl_ep1", "alice", { maxPerHour: 1 });
    await enforceRateLimit("test_rl_ep2", "alice", { maxPerHour: 1 });
    // both at their limit — disjoint endpoint keys, no cross-bleed
    await expect(
      enforceRateLimit("test_rl_ep1", "alice", { maxPerHour: 1 }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("combines minute and hour windows", async () => {
    const endpoint = "test_rl_combined";
    const id = "bob";
    await enforceRateLimit(endpoint, id, { maxPerMinute: 1, maxPerHour: 5 });
    // 2nd in same minute → throws on the minute window
    await expect(
      enforceRateLimit(endpoint, id, { maxPerMinute: 1, maxPerHour: 5 }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("RateLimitError carries resetAt + reason", async () => {
    const endpoint = "test_rl_meta";
    const id = "carol";
    await enforceRateLimit(endpoint, id, { maxPerHour: 1 });
    try {
      await enforceRateLimit(endpoint, id, { maxPerHour: 1 });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      const rle = err as RateLimitError;
      expect(rle.resetAt).toBeInstanceOf(Date);
      expect(rle.resetAt.getTime()).toBeGreaterThan(Date.now());
      expect(rle.reason).toContain(endpoint);
    }
  });

  it("stores the bucket key with the right encoding", async () => {
    const endpoint = "test_rl_keyshape";
    const id = "dave";
    await enforceRateLimit(endpoint, id, { maxPerHour: 5 });
    const rows = await db
      .select()
      .from(rateLimitBuckets)
      .where(like(rateLimitBuckets.bucketKey, "test_rl_keyshape:dave:hour:%"));
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(1);
  });
});

// T2-S5: bucket keys are built from attacker-chosen text (an unparseable
// x-real-ip comes back verbatim from callerSubject; some endpoints embed a URL
// token). Every segment must be bounded, and bounding must neither merge two
// distinct callers nor split one caller across spellings.
describe("rateLimitKeySegment — every bucket-key segment is bounded", () => {
  it("keeps a short, plain identifier verbatim (existing keys do not move)", () => {
    for (const plain of [
      "203.0.113.7",
      "2001:db8:0:1::/64",
      "3f2b8c1e-9a4d-4c7e-8b21-5d6f7a8b9c0d",
      "DIM-7K4Q-9XWZ",
      "auth_login_ip",
      "x".repeat(RATE_LIMIT_SEGMENT_MAX),
    ]) {
      expect(rateLimitKeySegment(plain)).toBe(plain);
    }
  });

  it("hashes anything over the maximum to a fixed-width form", () => {
    const long = "a".repeat(RATE_LIMIT_SEGMENT_MAX + 1);
    const huge = "b".repeat(16_384);
    expect(rateLimitKeySegment(long)).toMatch(/^#[0-9a-f]{40}$/);
    expect(rateLimitKeySegment(huge)).toMatch(/^#[0-9a-f]{40}$/);
    // Distinct inputs stay distinct buckets.
    expect(rateLimitKeySegment(long)).not.toBe(rateLimitKeySegment(huge));
  });

  it("hashes a short segment carrying characters outside the verbatim alphabet", () => {
    expect(rateLimitKeySegment("evil header\r\nx")).toMatch(/^#[0-9a-f]{40}$/);
    expect(rateLimitKeySegment("dni=12345678; drop")).toMatch(/^#[0-9a-f]{40}$/);
  });

  it("a raw segment can never spell a hashed one", () => {
    const hashed = rateLimitKeySegment("c".repeat(200));
    // Someone who sends the hashed form literally gets hashed again, not the
    // same bucket.
    expect(rateLimitKeySegment(hashed)).not.toBe(hashed);
  });

  it("normalises before hashing: Unicode form and surrounding space do not buy a new bucket", () => {
    const composed = `${"z".repeat(70)}\u00e9`;
    const decomposed = `${"z".repeat(70)}e\u0301`;
    expect(decomposed).not.toBe(composed);
    expect(rateLimitKeySegment(decomposed)).toBe(rateLimitKeySegment(composed));
    expect(rateLimitKeySegment(`  ${composed}  `)).toBe(rateLimitKeySegment(composed));
    expect(rateLimitKeySegment(" 203.0.113.7 ")).toBe("203.0.113.7");
  });
});

describe("enforceRateLimit — a hostile identifier cannot bloat the table", () => {
  beforeEach(() => {
    const midMinute = Math.floor(Date.now() / 60_000) * 60_000 + 30_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(midMinute));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await clearBucketsByPrefix("test_rl_bound");
  });

  it("stores a bounded key for a header-sized identifier, and still counts it", async () => {
    const endpoint = "test_rl_bound";
    const hostile = `198.51.100.1${"A".repeat(8_000)}`;
    await enforceRateLimit(endpoint, hostile, { maxPerHour: 1 });
    const rows = await db
      .select()
      .from(rateLimitBuckets)
      .where(like(rateLimitBuckets.bucketKey, `${endpoint}:%`));
    expect(rows).toHaveLength(1);
    // endpoint + ":" + 41-char hash + ":hour:" + a 13-digit epoch.
    expect(rows[0].bucketKey.length).toBeLessThanOrEqual(endpoint.length + 1 + 41 + 6 + 13);
    expect(rows[0].bucketKey).not.toContain("AAAA");

    // Same hostile value → same bucket → the ceiling still bites.
    await expect(enforceRateLimit(endpoint, hostile, { maxPerHour: 1 })).rejects.toBeInstanceOf(
      RateLimitError,
    );
    // And the error does not echo the payload.
    try {
      await enforceRateLimit(endpoint, hostile, { maxPerHour: 1 });
    } catch (err) {
      expect((err as RateLimitError).reason.length).toBeLessThan(200);
    }
  });

  it("bounds a hostile ENDPOINT segment too (URL tokens are embedded there)", async () => {
    const endpoint = `test_rl_bound_ep:${"T".repeat(5_000)}`;
    await enforceRateLimit(endpoint, "alice", { maxPerHour: 5 });
    const rows = await db
      .select()
      .from(rateLimitBuckets)
      .where(like(rateLimitBuckets.bucketKey, "#%:alice:hour:%"));
    const mine = rows.filter((r) => r.bucketKey.startsWith(rateLimitKeySegment(endpoint)));
    expect(mine).toHaveLength(1);
    expect(mine[0].bucketKey.length).toBeLessThan(80);
    await db
      .delete(rateLimitBuckets)
      .where(like(rateLimitBuckets.bucketKey, `${rateLimitKeySegment(endpoint)}:%`));
  });
});
