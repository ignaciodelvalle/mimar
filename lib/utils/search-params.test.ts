// Unit tests for lib/utils/search-params.ts.
//
// The defect these close: `?chip=a&chip=b` makes Next hand a page `string[]`,
// and every `sp.chip?.trim()` in the codebase throws
// "chip.trim is not a function" → a raw 500 screen. The array case is the ONLY
// interesting one; the rest of the surface exists so a caller can drop the
// helper in without changing behavior for the ordinary single-value path.

import { describe, expect, it } from "vitest";

import { firstSearchParam, trimmedSearchParam } from "@/lib/utils/search-params";

describe("firstSearchParam", () => {
  it("returns the FIRST value of a repeated param", () => {
    // The whole point. `?chip=a&chip=b` → "a", not "a,b" and not a throw.
    expect(firstSearchParam(["a", "b"])).toBe("a");
    // Order is part of the contract, not incidental: pin that it is not last.
    expect(firstSearchParam(["a", "b"])).not.toBe("b");
  });

  it("passes a plain string through untouched", () => {
    expect(firstSearchParam("DIM-PAMP-0001")).toBe("DIM-PAMP-0001");
    // Whitespace survives — collapsing it is trimmedSearchParam's job, and a
    // caller doing its own parsing must get the raw value.
    expect(firstSearchParam("  x  ")).toBe("  x  ");
  });

  it("returns undefined for an absent param and for an empty array", () => {
    expect(firstSearchParam(undefined)).toBeUndefined();
    // `[]` is truthy, so `value || fallback` would NOT catch this: an empty
    // array must collapse to the same "missing" case as undefined or callers
    // grow a third branch.
    expect(firstSearchParam([])).toBeUndefined();
  });

  it("does not throw where a bare string method would", () => {
    // The regression itself, stated as a behavior. Before the helper, this
    // exact expression is what pages ran.
    const repeated = ["a", "b"] as string | string[];
    expect(() => (repeated as string).trim()).toThrow(TypeError);
    expect(() => firstSearchParam(repeated)).not.toThrow();
  });
});

describe("trimmedSearchParam", () => {
  it("trims the first value of a repeated param", () => {
    expect(trimmedSearchParam(["  a  ", "b"])).toBe("a");
  });

  it("trims a plain string", () => {
    expect(trimmedSearchParam("  982000123456789  ")).toBe("982000123456789");
  });

  it("collapses whitespace-only and empty values to undefined", () => {
    // `?chip=` and `?chip=%20` are the same as no chip. Returning "" instead
    // would make `conflictChip && conflictToken` half-true and re-open the
    // partial-state branch the callers guard against.
    expect(trimmedSearchParam("   ")).toBeUndefined();
    expect(trimmedSearchParam("")).toBeUndefined();
    expect(trimmedSearchParam(["   ", "real"])).toBeUndefined();
  });

  it("returns undefined for an absent param and for an empty array", () => {
    expect(trimmedSearchParam(undefined)).toBeUndefined();
    expect(trimmedSearchParam([])).toBeUndefined();
  });
});
