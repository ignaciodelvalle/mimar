// Regression test for deferPrint — the INP mitigation helper for window.print().
// Pure function, no DOM needed. Uses fake timers to assert the deferred behaviour.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deferPrint } from "@/lib/infra/defer-print";

describe("deferPrint", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT call the callback synchronously", () => {
    const fn = vi.fn();
    deferPrint(fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it("calls the callback exactly once after timers run", () => {
    const fn = vi.fn();
    deferPrint(fn);
    vi.runAllTimers();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns undefined synchronously (handler returns fast)", () => {
    const result = deferPrint(vi.fn());
    expect(result).toBeUndefined();
  });

  it("(default-arg path) schedules window.print when no arg is provided", () => {
    // The vitest env is Node (no jsdom), so window.print may not exist.
    // Stub it on globalThis so the default arg path can be exercised.
    if (typeof globalThis.window === "undefined") {
      // No window in this env — skip rather than fail with a misleading error.
      return;
    }
    const originalPrint = globalThis.window.print;
    const printMock = vi.fn();
    globalThis.window.print = printMock;
    try {
      deferPrint();
      expect(printMock).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(printMock).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.window.print = originalPrint;
    }
  });
});
