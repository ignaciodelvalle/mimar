// enforceRateLimit — fail-CLOSED contract (lib/infra/rate-limit.ts:150-158).
//
// The limiter guards anonymous public-write surfaces. If the DB-backed
// bucket upsert fails (connection glitch, driver edge-case returning no
// rows), the limiter must THROW — never silently allow the request. A
// fail-open mutant here (catch-and-continue, or treating an empty
// returning() as "count 0, allowed") would disable every anonymous rate
// limit in the product with no test noticing.
//
// The DB layer is mocked ON PURPOSE: the contract under test IS the error
// path, which a healthy real database cannot produce on demand.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockReturning } = vi.hoisted(() => ({ mockReturning: vi.fn() }));

vi.mock("@/db", () => {
  const chain = {
    values: vi.fn(() => chain),
    onConflictDoUpdate: vi.fn(() => chain),
    returning: (...args: unknown[]) => mockReturning(...args),
  };
  return {
    db: { insert: vi.fn(() => chain) },
    // Column stubs — referenced by the sql`` template and the conflict target.
    rateLimitBuckets: { bucketKey: "bucket_key", count: "count" },
  };
});

import { RateLimitError, enforceRateLimit } from "@/lib/infra/rate-limit";

beforeEach(() => {
  mockReturning.mockReset();
});

describe("enforceRateLimit — fail-closed on driver failure", () => {
  it("THROWS (does not allow) when the upsert rejects", async () => {
    mockReturning.mockRejectedValue(new Error("connection refused"));
    await expect(
      enforceRateLimit("welfare_anon", "203.0.113.9", { maxPerMinute: 1 }),
    ).rejects.toThrow("connection refused");
  });

  it("THROWS (does not allow) when the upsert returns no rows", async () => {
    mockReturning.mockResolvedValue([]);
    await expect(
      enforceRateLimit("welfare_anon", "203.0.113.9", { maxPerMinute: 1 }),
    ).rejects.toThrow(/UPSERT returned no rows/);
  });

  it("the no-rows failure is NOT a RateLimitError — callers must not map it to a friendly retry message", async () => {
    // Call sites catch RateLimitError and return "try again later"; any other
    // throw must propagate as a real failure. If this guard ever threw
    // RateLimitError, a broken driver would masquerade as normal throttling.
    mockReturning.mockResolvedValue([]);
    await expect(
      enforceRateLimit("welfare_anon", "203.0.113.9", { maxPerMinute: 1 }),
    ).rejects.toSatisfy((err) => !(err instanceof RateLimitError));
  });

  it("sanity contrast: over-limit count still raises RateLimitError through the same chain", async () => {
    mockReturning.mockResolvedValue([{ count: 2 }]);
    await expect(
      enforceRateLimit("welfare_anon", "203.0.113.9", { maxPerMinute: 1 }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("sanity contrast: an in-budget count resolves (the mock models the real chain)", async () => {
    mockReturning.mockResolvedValue([{ count: 1 }]);
    await expect(
      enforceRateLimit("welfare_anon", "203.0.113.9", { maxPerMinute: 1 }),
    ).resolves.toBeUndefined();
  });
});
