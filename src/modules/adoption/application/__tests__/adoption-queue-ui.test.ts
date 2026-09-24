// Unit tests for pure UI helpers in AdoptionQueueList (no DOM, no React).
//
// Covers:
//   - ageDays: age computation from ISO timestamp.
//   - ADOPTION_SLA_WARNING_DAYS: breach threshold is defined and positive.
//   - Range-selection math (the shift-click logic, extracted as a pure helper).

import { describe, expect, it } from "vitest";

import { ADOPTION_SLA_WARNING_DAYS, ageDays } from "@/components/AdoptionQueueList";

// ---------------------------------------------------------------------------
// ageDays
// ---------------------------------------------------------------------------

// ageDays is now ARGENTINE-CALENDAR-day based (calendarDaysAgoInAr), not an
// elapsed-ms floor. The old suite asserted the broken elapsed behavior with
// the real wall clock (e.g. "25 hours ago is 1 day" — near midnight AR that
// is TWO calendar days) and was time-of-day flaky; fixtures now pin `now`
// mid-day AR and assert calendar semantics.
describe("ageDays", () => {
  const NOW = new Date("2026-07-04T15:00:00Z"); // 12:00 AR on 2026-07-04

  it("returns 0 for a timestamp earlier the same AR day", () => {
    expect(ageDays("2026-07-04T10:00:00Z", NOW)).toBe(0); // 07:00 AR same day
  });

  it("returns 1 for yesterday EVENING in AR, even though under 24h elapsed", () => {
    // 20:00 AR on 07-03, viewed 12:00 AR on 07-04 = 16 elapsed hours. The
    // old floor(elapsed/24h) said 0 ("hoy"); it was submitted AYER.
    expect(ageDays("2026-07-03T23:00:00Z", NOW)).toBe(1);
  });

  it("returns 2 for 25 hours ago when that crosses two AR midnights", () => {
    // 25h before 00:30 AR lands at 23:30 AR two days back — the old elapsed
    // math said 1.
    const lateNow = new Date("2026-07-04T03:30:00Z"); // 00:30 AR on 07-04
    expect(ageDays("2026-07-03T02:30:00Z", lateNow)).toBe(2); // 23:30 AR 07-02
  });

  it("returns correct days for 7-day-old timestamp (SLA threshold)", () => {
    expect(ageDays("2026-06-27T15:00:00Z", NOW)).toBe(7);
  });

  it("returns correct days for 30-day-old timestamp", () => {
    expect(ageDays("2026-06-04T15:00:00Z", NOW)).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// ADOPTION_SLA_WARNING_DAYS
// ---------------------------------------------------------------------------

describe("ADOPTION_SLA_WARNING_DAYS", () => {
  it("is defined as a positive number", () => {
    expect(ADOPTION_SLA_WARNING_DAYS).toBeGreaterThan(0);
  });

  // Fixed `now` (12:00 AR): with real Date.now() these boundary probes were
  // time-of-day flaky under calendar-day semantics (a probe crossing an AR
  // midnight gains a day).
  const NOW = new Date("2026-07-04T15:00:00Z");

  it("applications at exactly the threshold are considered stale", () => {
    const d = new Date(NOW.getTime() - ADOPTION_SLA_WARNING_DAYS * 24 * 60 * 60 * 1000);
    expect(ageDays(d.toISOString(), NOW)).toBeGreaterThanOrEqual(ADOPTION_SLA_WARNING_DAYS);
  });

  it("applications just under the threshold are NOT stale", () => {
    const d = new Date(NOW.getTime() - (ADOPTION_SLA_WARNING_DAYS - 1) * 24 * 60 * 60 * 1000);
    expect(ageDays(d.toISOString(), NOW)).toBeLessThan(ADOPTION_SLA_WARNING_DAYS);
  });
});

// ---------------------------------------------------------------------------
// Range-select logic (mirrors the handleRowCheckbox implementation)
// ---------------------------------------------------------------------------

describe("shift-click range select math", () => {
  const IDS = ["a", "b", "c", "d", "e"];

  /**
   * Pure helper that mirrors the shift-click range logic in AdoptionQueueList
   * so we can test it without React.
   */
  function applyRangeSelect(
    prev: Set<string>,
    rows: string[],
    anchorIdx: number,
    targetIdx: number,
    targetId: string,
  ): Set<string> {
    const lo = Math.min(anchorIdx, targetIdx);
    const hi = Math.max(anchorIdx, targetIdx);
    const next = new Set(prev);
    const targetState = !prev.has(targetId);
    for (let i = lo; i <= hi; i++) {
      const rowId = rows[i];
      if (rowId) {
        if (targetState) next.add(rowId);
        else next.delete(rowId);
      }
    }
    return next;
  }

  it("selects a range from anchor to target when none were selected", () => {
    const result = applyRangeSelect(new Set(), IDS, 1, 3, "d");
    expect(result.has("b")).toBe(true);
    expect(result.has("c")).toBe(true);
    expect(result.has("d")).toBe(true);
    expect(result.has("a")).toBe(false);
    expect(result.has("e")).toBe(false);
  });

  it("works in reverse order (target before anchor)", () => {
    const result = applyRangeSelect(new Set(), IDS, 4, 2, "c");
    expect(result.has("c")).toBe(true);
    expect(result.has("d")).toBe(true);
    expect(result.has("e")).toBe(true);
    expect(result.has("a")).toBe(false);
  });

  it("deselects a range when the target is already selected", () => {
    const prev = new Set(["b", "c", "d"]);
    // Clicking "b" (idx 1) with anchor at idx 3 ("d") — "b" is already selected → deselect range.
    const result = applyRangeSelect(prev, IDS, 3, 1, "b");
    expect(result.has("b")).toBe(false);
    expect(result.has("c")).toBe(false);
    expect(result.has("d")).toBe(false);
    expect(result.has("a")).toBe(false); // was not selected, stays out
    expect(result.has("e")).toBe(false); // was not in range
  });

  it("single-item range (anchor === target) behaves like a normal toggle", () => {
    const result = applyRangeSelect(new Set(), IDS, 2, 2, "c");
    expect(result.has("c")).toBe(true);
    expect(result.size).toBe(1);
  });
});
