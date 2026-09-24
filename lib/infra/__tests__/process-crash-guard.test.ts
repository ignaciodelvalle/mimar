// Unit tests for the process-level crash backstop (task #39). Proves the guard
// registers on the current process and that its unhandledRejection handler keeps
// the process alive (logs, does not rethrow) — the behavior the layer-cache
// background-revalidation crash needed as its last line of defence.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetProcessCrashGuardsForTest,
  registerProcessCrashGuards,
} from "../process-crash-guard";

describe("registerProcessCrashGuards", () => {
  beforeEach(() => {
    __resetProcessCrashGuardsForTest();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetProcessCrashGuardsForTest();
  });

  it("registers unhandledRejection + uncaughtException listeners on the process", () => {
    const before = {
      rej: process.listenerCount("unhandledRejection"),
      exc: process.listenerCount("uncaughtException"),
    };
    const registered = registerProcessCrashGuards();
    try {
      expect(registered).toBe(true);
      expect(process.listenerCount("unhandledRejection")).toBe(before.rej + 1);
      expect(process.listenerCount("uncaughtException")).toBe(before.exc + 1);
    } finally {
      // Remove the listeners this test added so the count stays clean.
      const rej = process.listeners("unhandledRejection").at(-1);
      const exc = process.listeners("uncaughtException").at(-1);
      if (rej) process.off("unhandledRejection", rej);
      if (exc) process.off("uncaughtException", exc);
    }
  });

  it("is idempotent — a second call registers nothing", () => {
    registerProcessCrashGuards();
    const after1 = process.listenerCount("unhandledRejection");
    const registeredAgain = registerProcessCrashGuards();
    try {
      expect(registeredAgain).toBe(false);
      expect(process.listenerCount("unhandledRejection")).toBe(after1);
    } finally {
      const rej = process.listeners("unhandledRejection").at(-1);
      const exc = process.listeners("uncaughtException").at(-1);
      if (rej) process.off("unhandledRejection", rej);
      if (exc) process.off("uncaughtException", exc);
    }
  });

  it("the unhandledRejection handler logs and returns (keeps the process alive)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    registerProcessCrashGuards();
    const handler = process.listeners("unhandledRejection").at(-1) as (
      reason: unknown,
      promise: Promise<unknown>,
    ) => void;
    try {
      expect(handler).toBeTypeOf("function");
      const p = Promise.resolve();
      // Invoking the handler must NOT throw — that is what "kept process alive"
      // means at the handler level.
      expect(() => handler(new Error("synthetic revalidation rejection"), p)).not.toThrow();
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("kept process alive"),
        expect.anything(),
      );
    } finally {
      const rej = process.listeners("unhandledRejection").at(-1);
      const exc = process.listeners("uncaughtException").at(-1);
      if (rej) process.off("unhandledRejection", rej);
      if (exc) process.off("uncaughtException", exc);
    }
  });
});
