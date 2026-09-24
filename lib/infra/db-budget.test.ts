// Unit tests for withDbBudget — the "never hang, never crash" DB fan-out guard
// (task #74). No database: we drive resolved/rejected/slow promises directly and
// pin the three outcomes plus the crash-safety guarantee.

import { afterEach, describe, expect, it, vi } from "vitest";

import { DbBudgetExceededError, withDbBudget, withDbBudgetOrThrow } from "./db-budget";

const later = <T>(value: T, ms: number): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));
const rejectLater = (err: unknown, ms: number): Promise<never> =>
  new Promise((_, reject) => setTimeout(() => reject(err), ms));

describe("withDbBudget", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves the real value when the promise settles before the budget", async () => {
    const result = await withDbBudget(later("real", 5), 1000, "fast", "fallback");
    expect(result).toBe("real");
  });

  it("resolves the degraded fallback when the budget elapses first", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Promise takes 200ms; budget is 20ms → the budget wins with the fallback.
    const result = await withDbBudget(later("real", 200), 20, "slow", "degraded");
    expect(result).toBe("degraded");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exceeded 20ms budget"));
  });

  it("propagates the rejection when the promise rejects BEFORE the budget", async () => {
    const err = new Error("db down");
    await expect(withDbBudget(rejectLater(err, 5), 1000, "early-reject", "fallback")).rejects.toBe(
      err,
    );
  });

  it("swallows a LATE rejection (after the budget) — never an unhandledRejection", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      // Budget (10ms) fires first → returns fallback. The underlying promise then
      // rejects at 60ms; the guard must catch it so the process never sees an
      // unhandledRejection.
      const result = await withDbBudget(
        rejectLater(new Error("late boom"), 60),
        10,
        "late-reject",
        "fallback",
      );
      expect(result).toBe("fallback");

      // Wait past the underlying rejection and flush microtasks.
      await new Promise((r) => setTimeout(r, 120));

      expect(unhandled).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("rejected after budget elapsed (swallowed)"),
        expect.anything(),
      );
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

// task #39 — the throwing variant used INSIDE the layer Data Cache so a background
// stale-revalidation never runs unbudgeted AND never caches a degraded envelope.
describe("withDbBudgetOrThrow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves the real value when the promise settles before the budget", async () => {
    const result = await withDbBudgetOrThrow(later("real", 5), 1000, "fast");
    expect(result).toBe("real");
  });

  it("THROWS a typed DbBudgetExceededError when the budget elapses (never a value)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // A thrown revalidation is what makes unstable_cache keep the stale entry
    // instead of caching a degraded one — so this MUST reject, never resolve.
    await expect(withDbBudgetOrThrow(later("real", 200), 20, "slow")).rejects.toBeInstanceOf(
      DbBudgetExceededError,
    );
  });

  it("propagates the real rejection when the promise rejects BEFORE the budget", async () => {
    const err = new Error("db down");
    await expect(withDbBudgetOrThrow(rejectLater(err, 5), 1000, "early-reject")).rejects.toBe(err);
  });

  it("swallows a LATE rejection (after the budget) — never an unhandledRejection", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      // Budget (10ms) throws first. The underlying promise rejects at 60ms; the
      // guard must swallow it so the process never sees an unhandledRejection —
      // this is the exact crash class the fix targets.
      await expect(
        withDbBudgetOrThrow(rejectLater(new Error("late boom"), 60), 10, "late-reject"),
      ).rejects.toBeInstanceOf(DbBudgetExceededError);

      await new Promise((r) => setTimeout(r, 120));

      expect(unhandled).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("rejected after budget elapsed (swallowed)"),
        expect.anything(),
      );
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
