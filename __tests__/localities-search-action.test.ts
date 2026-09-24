// Tests the server action wrapper. We mock requireUserOrRedirect so the test
// can drive the auth-gate path without spinning up a Next.js runtime.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/infra/auth-guards", () => ({
  requireUserOrRedirect: vi.fn(),
}));

import { searchLocalitiesAction } from "@/app/actions/localities";
import { db } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
// The reset lives in the use-case module, never in the "use server" file (A01-4).
import { __resetRateLimitForTests } from "@/src/modules/localities/application/search/search-localities";
import { sql } from "drizzle-orm";

const mockAs = (userId: string) =>
  vi.mocked(requireUserOrRedirect).mockResolvedValue({
    user: { id: userId } as never,
  } as never);

// Freeze the clock so every call in a test lands in the same minute window.
// The limiter buckets by CALENDAR minute (`Math.floor(now / 60_000)` in
// lib/infra/rate-limit.ts), not by a sliding window, so a run that straddles
// :59 → :00 gets a fresh budget mid-test: the "61st call is throttled"
// assertion then reads a bucket that was never filled and returns results.
// The same straddle splits the persistence test's single bucket row into two.
//
// This is not hypothetical — it failed under full-suite load on 2026-08-08
// while passing in 5s in isolation. The sibling suites (tag-actions-rate-limit,
// scan-log-rate-limit) already carry this guard with the same mid-minute :30
// timestamp; this file had missed it.
//
// ONLY Date is faked. Those siblings mock the bucket store, but this suite
// drives the real limiter through postgres.js, which needs live
// setTimeout/setInterval for its connection timeouts.
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-08T12:00:30.000Z"));
  await __resetRateLimitForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("searchLocalitiesAction", () => {
  it("returns [] for queries under 2 chars without hitting the lib", async () => {
    mockAs("user-a");
    expect(await searchLocalitiesAction({ query: "" })).toEqual({ results: [] });
    expect(await searchLocalitiesAction({ query: "x" })).toEqual({ results: [] });
  });

  it("returns invalid_province when an unknown province code is supplied", async () => {
    mockAs("user-b");
    const r = await searchLocalitiesAction({ provinceCode: "AR-Inventada", query: "la plata" });
    expect(r).toEqual({ error: "invalid_province" });
  });

  it("delegates to searchLocalities and returns the result envelope", async () => {
    mockAs("user-c");
    const r = await searchLocalitiesAction({ provinceCode: "AR-B", query: "la plata" });
    expect("results" in r).toBe(true);
    if ("results" in r) {
      expect(r.results.length).toBeGreaterThan(0);
      expect(r.results[0].provinceCode).toBe("AR-B");
    }
  });

  it("returns rate_limited after 60 calls in the window", async () => {
    mockAs("user-d");
    for (let i = 0; i < 60; i++) {
      const r = await searchLocalitiesAction({ provinceCode: "AR-B", query: "la plata" });
      expect("results" in r).toBe(true);
    }
    const r = await searchLocalitiesAction({ provinceCode: "AR-B", query: "la plata" });
    expect(r).toEqual({ error: "rate_limited" });
  });

  it("rate limit is per user — different sessions share no budget", async () => {
    mockAs("user-e");
    for (let i = 0; i < 60; i++) {
      await searchLocalitiesAction({ provinceCode: "AR-B", query: "la plata" });
    }
    expect(await searchLocalitiesAction({ provinceCode: "AR-B", query: "la plata" })).toEqual({
      error: "rate_limited",
    });

    mockAs("user-f");
    const r = await searchLocalitiesAction({ provinceCode: "AR-B", query: "la plata" });
    expect("results" in r).toBe(true);
  });

  it("persists the budget in rate_limit_buckets — survives worker restarts", async () => {
    // The former in-memory rateLimitMap reset on every cold start, so the
    // limit never held across Vercel lambda instances. The durable limiter
    // writes each consumed slot to rate_limit_buckets: assert the bucket row
    // exists with the consumed count (cross-worker state, not process memory).
    mockAs("user-persist");
    await searchLocalitiesAction({ provinceCode: "AR-B", query: "la plata" });
    await searchLocalitiesAction({ provinceCode: "AR-B", query: "la plata" });

    const rows = (await db.execute(
      sql`select count from rate_limit_buckets where bucket_key like 'localities_search:user-persist:minute:%'`,
    )) as Array<{ count: number }>;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].count)).toBe(2);
  });
});
