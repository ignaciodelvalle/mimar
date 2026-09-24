// Analytics read-handle override (task #22 — cube refresh read-timeout fix).
//
// Pure, DB-free: proves the dispatch mechanics without a database —
//   (1) the request-path analytics backstop DEFAULTS to 15s (the #74
//       death-spiral protection must never silently move),
//   (2) `runWithAnalyticsReadHandle` installs an override that
//       `resolveAnalyticsReadHandle` — and therefore every `analyticsDb`
//       method call, at any module depth — honors inside its async context,
//   (3) the override never leaks outside that context (request paths are
//       untouched).
//
// The end-to-end proof (the builder's national rollups actually running on the
// long-timeout client) is cube-parity.test.ts, which drives the real
// refreshCube against the local DB.

import { describe, expect, it } from "vitest";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import {
  analyticsDb,
  analyticsStatementTimeoutMs,
  resolveAnalyticsReadHandle,
  runWithAnalyticsReadHandle,
  statementTimeoutOptions,
} from "@/db";
import type * as schema from "@/db/schema";

type Handle = PostgresJsDatabase<typeof schema>;

/** A sentinel fake handle: only the method identity matters for dispatch. */
const sentinel = {
  select: () => "sentinel-select",
} as unknown as Handle;

describe("request-path analytics backstop (must stay 15s)", () => {
  it("defaults to 15000 ms when the env is unset", () => {
    expect(analyticsStatementTimeoutMs({})).toBe(15000);
  });

  it("honors an explicit project-wide env override", () => {
    expect(
      analyticsStatementTimeoutMs({
        ANALYTICS_STATEMENT_TIMEOUT_MS: "20000",
      }),
    ).toBe(20000);
  });

  it("statementTimeoutOptions emits both server-side ceilings", () => {
    expect(statementTimeoutOptions(15000)).toBe(
      "-c statement_timeout=15000 -c idle_in_transaction_session_timeout=15000",
    );
  });
});

describe("runWithAnalyticsReadHandle (builder read-handle override)", () => {
  it("resolves the override inside the context and the real handle outside", async () => {
    expect(resolveAnalyticsReadHandle()).not.toBe(sentinel);
    await runWithAnalyticsReadHandle(sentinel, async () => {
      expect(resolveAnalyticsReadHandle()).toBe(sentinel);
    });
    expect(resolveAnalyticsReadHandle()).not.toBe(sentinel);
  });

  it("dispatches analyticsDb method calls to the override — including at async depth", async () => {
    // Simulates a repository loader N modules deep: it only sees the imported
    // `analyticsDb` binding, yet the call lands on the builder's handle.
    async function deepLoaderCall(): Promise<string> {
      await Promise.resolve(); // cross an async boundary like a real loader
      return (analyticsDb as unknown as { select: () => string }).select();
    }
    const result = await runWithAnalyticsReadHandle(sentinel, deepLoaderCall);
    expect(result).toBe("sentinel-select");
  });

  it("does not leak the override to a sibling async context", async () => {
    let insideResolved: Handle | null = null;
    const inside = runWithAnalyticsReadHandle(sentinel, async () => {
      await new Promise((r) => setTimeout(r, 10));
      insideResolved = resolveAnalyticsReadHandle();
    });
    // Concurrent "request path" while the builder is mid-flight: real handle.
    expect(resolveAnalyticsReadHandle()).not.toBe(sentinel);
    await inside;
    expect(insideResolved).toBe(sentinel);
  });

  it("propagates the callback's return value and errors", async () => {
    await expect(runWithAnalyticsReadHandle(sentinel, async () => 42)).resolves.toBe(42);
    await expect(
      runWithAnalyticsReadHandle(sentinel, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
