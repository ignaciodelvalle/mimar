// Unit tests for lib/events/plausibility.ts (P4 plausibility layer, item 1).
// Pure function — no mocks needed.

import { describe, expect, it } from "vitest";
import { CLOCK_SKEW_TOLERANCE_MS, assertOccurredAtPlausible } from "./plausibility";

const NOW = new Date("2026-07-08T12:00:00Z");

describe("assertOccurredAtPlausible", () => {
  it("pins CLOCK_SKEW_TOLERANCE_MS at exactly 5 minutes", () => {
    // Literal on purpose: the boundary tests below derive their fixtures FROM
    // the constant, so a silent 5min→5h regression would pass them all. This
    // is the one assertion a tolerance change must consciously update.
    expect(CLOCK_SKEW_TOLERANCE_MS).toBe(300_000);
  });

  describe("date-only mode (isDateOnly: true)", () => {
    // parseDateInput anchors "YYYY-MM-DD" at NOON UTC. In date-only mode the
    // future check must compare AR calendar days, so a same-day submission is
    // plausible at ANY hour — including before 09:05 AR, where the instant
    // compare (noon UTC vs now) used to reject it.

    it("accepts today's date submitted at 03:00 UTC (00:00 AR — before the noon anchor)", () => {
      const earlyNow = new Date("2026-07-08T03:00:00Z"); // 00:00 AR on 2026-07-08
      const occurredAt = new Date("2026-07-08T12:00:00Z"); // parseDateInput("2026-07-08")
      const result = assertOccurredAtPlausible({ occurredAt, isDateOnly: true, now: earlyNow });
      expect(result.ok).toBe(true);
    });

    it("rejects tomorrow-in-AR as FUTURE_DATE", () => {
      const now = new Date("2026-07-08T23:00:00Z"); // 20:00 AR on 2026-07-08
      const occurredAt = new Date("2026-07-09T12:00:00Z"); // parseDateInput("2026-07-09")
      const result = assertOccurredAtPlausible({ occurredAt, isDateOnly: true, now });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("FUTURE_DATE");
    });

    it("accepts a date that is tomorrow in UTC but still today in AR", () => {
      // 22:30 AR on the 8th = 01:30Z on the 9th. The user's date input default
      // (todayIsoInAr) is "2026-07-08" — same AR day, must pass.
      const now = new Date("2026-07-09T01:30:00Z"); // 22:30 AR on 2026-07-08
      const occurredAt = new Date("2026-07-08T12:00:00Z"); // parseDateInput("2026-07-08")
      const result = assertOccurredAtPlausible({ occurredAt, isDateOnly: true, now });
      expect(result.ok).toBe(true);
    });

    it("still rejects a date-only value before the pet's date of birth", () => {
      const result = assertOccurredAtPlausible({
        occurredAt: new Date("2023-12-31T12:00:00Z"),
        isDateOnly: true,
        petDateOfBirth: "2024-01-01",
        now: NOW,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("BEFORE_BIRTH");
    });
  });

  describe("future-date guard", () => {
    it("accepts an occurredAt exactly at now", () => {
      const result = assertOccurredAtPlausible({ occurredAt: NOW, now: NOW });
      expect(result.ok).toBe(true);
    });

    it("accepts an occurredAt in the past", () => {
      const result = assertOccurredAtPlausible({
        occurredAt: new Date("2026-01-01T00:00:00Z"),
        now: NOW,
      });
      expect(result.ok).toBe(true);
    });

    it("accepts an occurredAt within the clock-skew tolerance", () => {
      const withinSkew = new Date(NOW.getTime() + CLOCK_SKEW_TOLERANCE_MS - 1000);
      const result = assertOccurredAtPlausible({ occurredAt: withinSkew, now: NOW });
      expect(result.ok).toBe(true);
    });

    it("accepts an occurredAt exactly at the tolerance boundary", () => {
      const atBoundary = new Date(NOW.getTime() + CLOCK_SKEW_TOLERANCE_MS);
      const result = assertOccurredAtPlausible({ occurredAt: atBoundary, now: NOW });
      expect(result.ok).toBe(true);
    });

    it("rejects an occurredAt just past the tolerance boundary", () => {
      const pastBoundary = new Date(NOW.getTime() + CLOCK_SKEW_TOLERANCE_MS + 1000);
      const result = assertOccurredAtPlausible({ occurredAt: pastBoundary, now: NOW });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("FUTURE_DATE");
    });

    it("rejects an occurredAt far in the future", () => {
      const result = assertOccurredAtPlausible({
        occurredAt: new Date("2030-01-01T00:00:00Z"),
        now: NOW,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("FUTURE_DATE");
    });
  });

  describe("birth-floor guard", () => {
    it("accepts an occurredAt after the pet's date of birth", () => {
      const result = assertOccurredAtPlausible({
        occurredAt: new Date("2025-06-01T00:00:00Z"),
        petDateOfBirth: "2024-01-01",
        now: NOW,
      });
      expect(result.ok).toBe(true);
    });

    it("accepts an occurredAt on the pet's date of birth", () => {
      const result = assertOccurredAtPlausible({
        occurredAt: new Date("2024-01-01T12:00:00Z"),
        petDateOfBirth: "2024-01-01",
        now: NOW,
      });
      expect(result.ok).toBe(true);
    });

    it("rejects an occurredAt before the pet's date of birth", () => {
      const result = assertOccurredAtPlausible({
        occurredAt: new Date("2023-12-31T00:00:00Z"),
        petDateOfBirth: "2024-01-01",
        now: NOW,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("BEFORE_BIRTH");
    });

    it("ignores the birth floor when petDateOfBirth is null (unknown DOB)", () => {
      const result = assertOccurredAtPlausible({
        occurredAt: new Date("1990-01-01T00:00:00Z"),
        petDateOfBirth: null,
        now: NOW,
      });
      expect(result.ok).toBe(true);
    });

    it("ignores the birth floor when petDateOfBirth is omitted", () => {
      const result = assertOccurredAtPlausible({
        occurredAt: new Date("1990-01-01T00:00:00Z"),
        now: NOW,
      });
      expect(result.ok).toBe(true);
    });

    it("ignores a malformed petDateOfBirth instead of throwing", () => {
      const result = assertOccurredAtPlausible({
        occurredAt: new Date("1990-01-01T00:00:00Z"),
        petDateOfBirth: "not-a-date",
        now: NOW,
      });
      expect(result.ok).toBe(true);
    });

    it("future-date check takes priority when both would fail", () => {
      // occurredAt is both in the future AND before an (absurd) future DOB —
      // future-date must win since it is checked first.
      const result = assertOccurredAtPlausible({
        occurredAt: new Date("2030-01-01T00:00:00Z"),
        petDateOfBirth: "2031-01-01",
        now: NOW,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("FUTURE_DATE");
    });
  });
});
