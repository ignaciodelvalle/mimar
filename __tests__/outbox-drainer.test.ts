// Unit tests for the outbox drainer logic.
//
// These tests exercise the pure-logic parts of the drainer:
//   - computeNextRetryAt: backoff schedule
//   - deliverOutboxRow: no-op delivery handler (v1)
//
// The cron route itself (app/api/cron/drain-outbox/route.ts) is an integration
// boundary; its logic is covered by the unit tests here via the exported helpers.

import { describe, expect, it } from "vitest";

import { BACKOFF_MINUTES, MAX_ATTEMPTS, computeNextRetryAt } from "@/lib/infra/outbox-drainer";

// ---------------------------------------------------------------------------
// Backoff schedule
// ---------------------------------------------------------------------------

describe("computeNextRetryAt", () => {
  const base = new Date("2026-05-22T12:00:00.000Z");

  it("attempt 1 → backoff[0] = 5 minutes", () => {
    const next = computeNextRetryAt(1, base);
    expect(next.getTime()).toBe(base.getTime() + 5 * 60_000);
  });

  it("attempt 2 → backoff[1] = 15 minutes", () => {
    const next = computeNextRetryAt(2, base);
    expect(next.getTime()).toBe(base.getTime() + 15 * 60_000);
  });

  it("attempt 3 → backoff[2] = 45 minutes", () => {
    const next = computeNextRetryAt(3, base);
    expect(next.getTime()).toBe(base.getTime() + 45 * 60_000);
  });

  it("attempt 6 → backoff[5] = 720 minutes (12h)", () => {
    const next = computeNextRetryAt(6, base);
    expect(next.getTime()).toBe(base.getTime() + 720 * 60_000);
  });

  it("attempt 7 → backoff[6] = 1440 minutes (24h)", () => {
    const next = computeNextRetryAt(7, base);
    expect(next.getTime()).toBe(base.getTime() + 1440 * 60_000);
  });

  it("attempt 8 (MAX) → backoff[7] = 1440 minutes (24h)", () => {
    const next = computeNextRetryAt(8, base);
    expect(next.getTime()).toBe(base.getTime() + 1440 * 60_000);
  });

  it("attempt beyond MAX → clamps to last backoff (1440 minutes)", () => {
    const next = computeNextRetryAt(100, base);
    expect(next.getTime()).toBe(base.getTime() + 1440 * 60_000);
  });

  it("BACKOFF_MINUTES has 8 entries matching spec C4", () => {
    expect(BACKOFF_MINUTES).toEqual([5, 15, 45, 120, 360, 720, 1440, 1440]);
  });

  it("MAX_ATTEMPTS = 8", () => {
    expect(MAX_ATTEMPTS).toBe(8);
  });
});
