// Tests for lib/unique-token.
//
// The retry path is exercised via a mock executor that lets us control
// the SELECT result deterministically. drizzle's `eq()` is called against
// real columns from the schema (pets.publicToken) so we don't have to
// stub the orm itself — only the executor.

import { describe, expect, it, vi } from "vitest";

import { pets } from "@/db";
import {
  type UniqueTokenOptions,
  generateUniqueToken,
  isUniqueViolation,
} from "@/lib/infra/unique-token";

type MockExecutor = {
  select: ReturnType<typeof vi.fn>;
};

// Builds an executor whose `.select(...).from(...).where(...).limit(...)`
// resolves to `existingRowsByCall[callIndex]`. The shape matches what
// generateUniqueToken expects.
function makeExecutor(existingRowsByCall: Array<Array<{ marker: unknown }>>): MockExecutor {
  let callIndex = 0;
  const select = vi.fn().mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: async () => {
          const rows = existingRowsByCall[callIndex] ?? [];
          callIndex += 1;
          return rows;
        },
      }),
    }),
  }));
  return { select };
}

describe("generateUniqueToken", () => {
  it("returns the first candidate when no collision", async () => {
    const generator = vi.fn(() => "DIM-AAAA-AAAA");
    const executor = makeExecutor([[]]); // first SELECT → no rows
    const result = await generateUniqueToken(pets, pets.publicToken, generator, {
      executor: executor as unknown as UniqueTokenOptions["executor"],
    });
    expect(result).toBe("DIM-AAAA-AAAA");
    expect(generator).toHaveBeenCalledTimes(1);
    expect(executor.select).toHaveBeenCalledTimes(1);
  });

  it("retries on collision and succeeds on the second attempt", async () => {
    let n = 0;
    const generator = vi.fn(() => `DIM-${++n}`);
    const executor = makeExecutor([
      [{ marker: "x" }], // first SELECT → collision
      [], // second SELECT → ok
    ]);
    const result = await generateUniqueToken(pets, pets.publicToken, generator, {
      executor: executor as unknown as UniqueTokenOptions["executor"],
    });
    expect(result).toBe("DIM-2");
    expect(generator).toHaveBeenCalledTimes(2);
    expect(executor.select).toHaveBeenCalledTimes(2);
  });

  it("throws after maxRetries consecutive collisions", async () => {
    const generator = vi.fn(() => "DIM-DUP-DUP");
    const executor = makeExecutor([[{ marker: "x" }], [{ marker: "x" }], [{ marker: "x" }]]);
    await expect(
      generateUniqueToken(pets, pets.publicToken, generator, {
        maxRetries: 3,
        executor: executor as unknown as UniqueTokenOptions["executor"],
      }),
    ).rejects.toThrow(/exhausted 3 retries/);
    expect(generator).toHaveBeenCalledTimes(3);
  });
});

describe("isUniqueViolation", () => {
  it("returns true for direct SQLSTATE 23505 errors", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  it("returns true when nested as cause", () => {
    expect(isUniqueViolation({ message: "wrapped", cause: { code: "23505" } })).toBe(true);
  });

  it("returns false for other Postgres errors", () => {
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation({ code: "42P01" })).toBe(false);
  });

  it("returns false for non-PG-shaped values", () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
  });
});
