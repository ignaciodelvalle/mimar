// Regression guard for the AR-local date-default sweep: resolveOccurredAt
// previously anchored on `new Date().toISOString()` (the UTC calendar day),
// which silently misdates a denuncia near AR midnight (UTC-3) — e.g. late in
// the Argentine evening, UTC has already rolled to the next day, so "now"
// wrongly resolves to a date one day in the future relative to Argentina.
// resolveOccurredAt must anchor on the Argentine calendar day instead.

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveOccurredAt } from "./Step3Where";

describe("resolveOccurredAt", () => {
  afterEach(() => vi.useRealTimers());

  it("'now' returns the AR calendar day, not the UTC day, near AR midnight", () => {
    // 2026-07-16T01:30:00Z is the 16th in UTC but still 22:30 on the 15th in AR.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T01:30:00.000Z"));
    expect(resolveOccurredAt("now")).toBe("2026-07-15");
  });

  it("'today_yesterday' subtracts one day from the AR calendar day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T01:30:00.000Z"));
    expect(resolveOccurredAt("today_yesterday")).toBe("2026-07-14");
  });

  it("'several_days_ago' subtracts five days from the AR calendar day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T01:30:00.000Z"));
    expect(resolveOccurredAt("several_days_ago")).toBe("2026-07-10");
  });

  it("agrees with a naive UTC computation when both zones are on the same day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T15:00:00.000Z"));
    expect(resolveOccurredAt("now")).toBe("2026-07-15");
  });
});
