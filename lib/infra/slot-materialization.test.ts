// Unit tests for lib/slot-materialization.ts (Fase 3).
//
// Pure unit tests — no DB, no Supabase, no network.
// Tests cover:
//   - Weekday match: correct slot count for a 7-day window
//   - Weekday mismatch: zero slots when no day in window matches the rule
//   - Interval math: 30-minute duration in a 2-hour window → 4 slots
//   - End-time edge: last slot's ends_at === end_time exactly (no overshoot)
//   - Capacity propagation: all emitted slots carry the offering's slotCapacity

import { describe, expect, it } from "vitest";

import type { ServiceOffering, ServiceScheduleRule } from "@/db/schema";
import { type RuleWithOffering, materializeSlotsForRule } from "@/lib/infra/slot-materialization";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Build a minimal ServiceScheduleRule shape for testing. */
function makeRule(
  overrides: Partial<ServiceScheduleRule> & {
    daysOfWeek: number[];
    startTimeLocal: string;
    endTimeLocal: string;
  },
): ServiceScheduleRule {
  const base = {
    id: "rule-test-id",
    serviceOfferingId: "offering-test-id",
    effectiveFrom: "2020-01-01",
    effectiveUntil: null,
    timezone: "America/Argentina/Buenos_Aires",
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return {
    ...base,
    ...overrides,
    daysOfWeek: overrides.daysOfWeek as unknown as ServiceScheduleRule["daysOfWeek"],
    startTimeLocal: overrides.startTimeLocal as unknown as ServiceScheduleRule["startTimeLocal"],
    endTimeLocal: overrides.endTimeLocal as unknown as ServiceScheduleRule["endTimeLocal"],
    effectiveFrom: (overrides.effectiveFrom ??
      base.effectiveFrom) as unknown as ServiceScheduleRule["effectiveFrom"],
  } as ServiceScheduleRule;
}

/** Build a minimal ServiceOffering shape for testing. */
function makeOffering(
  overrides: Partial<Pick<ServiceOffering, "id" | "slotCapacity" | "durationMinutes">>,
): Pick<ServiceOffering, "id" | "slotCapacity" | "durationMinutes"> {
  return {
    id: overrides.id ?? "offering-test-id",
    slotCapacity: overrides.slotCapacity ?? 5,
    durationMinutes: overrides.durationMinutes ?? 30,
  };
}

function makeRuleWithOffering(
  ruleOverrides: Partial<ServiceScheduleRule> & {
    daysOfWeek: number[];
    startTimeLocal: string;
    endTimeLocal: string;
  },
  offeringOverrides: Partial<Pick<ServiceOffering, "id" | "slotCapacity" | "durationMinutes">> = {},
): RuleWithOffering {
  return {
    rule: makeRule(ruleOverrides),
    offering: makeOffering(offeringOverrides),
  };
}

/**
 * ISO 8601 weekday for a Date (1=Mon…7=Sun).
 * Copied from the implementation for symmetry in tests.
 */
function isoWeekday(d: Date): number {
  const day = d.getDay();
  return day === 0 ? 7 : day;
}

// ────────────────────────────────────────────────────────────────────────────
// Find the next occurrence of a specific ISO weekday from today.
// ────────────────────────────────────────────────────────────────────────────

function nextOccurrenceOfWeekday(weekday: number, from: Date = new Date()): Date {
  const d = new Date(from);
  d.setUTCHours(0, 0, 0, 0);
  while (isoWeekday(d) !== weekday) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe("materializeSlotsForRule", () => {
  it("emits correct slot count for a 7-day window when weekday matches once", () => {
    // Rule fires every Monday. Window = 7 days starting from next Monday.
    const monday = nextOccurrenceOfWeekday(1); // next Monday (UTC midnight)
    const windowStart = monday;
    const windowEnd = new Date(monday.getTime() + 6 * 24 * 60 * 60 * 1000); // +6 days

    const rwo = makeRuleWithOffering(
      {
        daysOfWeek: [1], // Monday only
        startTimeLocal: "09:00",
        endTimeLocal: "10:00",
        effectiveFrom: "2020-01-01",
      },
      { durationMinutes: 30 },
    );

    const slots = materializeSlotsForRule(rwo, windowStart, windowEnd);

    // One Monday in the 7-day window, 60-min window / 30-min slots = 2 slots.
    expect(slots).toHaveLength(2);
  });

  it("returns zero slots when no date in the window matches the rule's weekday", () => {
    // Rule fires only on Sunday (7). Window covers Mon–Sat (6 days, no Sunday).
    const monday = nextOccurrenceOfWeekday(1);
    const windowStart = monday;
    const windowEnd = new Date(monday.getTime() + 5 * 24 * 60 * 60 * 1000); // Mon–Sat

    const rwo = makeRuleWithOffering({
      daysOfWeek: [7], // Sunday only
      startTimeLocal: "10:00",
      endTimeLocal: "12:00",
      effectiveFrom: "2020-01-01",
    });

    const slots = materializeSlotsForRule(rwo, windowStart, windowEnd);
    expect(slots).toHaveLength(0);
  });

  it("produces 4 slots for a 30-minute duration in a 2-hour window", () => {
    // Pick a fixed weekday that definitely appears in our window.
    const tuesday = nextOccurrenceOfWeekday(2);
    const windowStart = tuesday;
    const windowEnd = tuesday; // single-day window

    const rwo = makeRuleWithOffering(
      {
        daysOfWeek: [2], // Tuesday
        startTimeLocal: "08:00",
        endTimeLocal: "10:00", // 2 hours = 4 × 30-min slots
        effectiveFrom: "2020-01-01",
      },
      { durationMinutes: 30 },
    );

    const slots = materializeSlotsForRule(rwo, windowStart, windowEnd);
    expect(slots).toHaveLength(4);
  });

  it("does NOT emit a slot that would extend past end_time_local", () => {
    // 60-min window with 40-min slots: only 1 slot fits (40 min), not 2 (80 min).
    const wednesday = nextOccurrenceOfWeekday(3);
    const windowStart = wednesday;
    const windowEnd = wednesday;

    const rwo = makeRuleWithOffering(
      {
        daysOfWeek: [3], // Wednesday
        startTimeLocal: "09:00",
        endTimeLocal: "10:00", // 60-min window
        effectiveFrom: "2020-01-01",
      },
      { durationMinutes: 40 },
    );

    const slots = materializeSlotsForRule(rwo, windowStart, windowEnd);
    // 40-min slot: 09:00–09:40 fits; 09:40–10:20 does NOT fit (> 10:00).
    expect(slots).toHaveLength(1);

    // Verify the slot ends exactly at the 40-min mark (not 10:00).
    const slot = slots[0];
    expect(slot).toBeDefined();
    if (!slot) throw new Error("slot is undefined");
    const durationMs = slot.endsAt.getTime() - slot.startsAt.getTime();
    expect(durationMs).toBe(40 * 60 * 1000);
  });

  it("last slot's ends_at equals end_time_local exactly when slots divide evenly", () => {
    // 2-hour window, 30-min slots → 4 slots. Last ends_at = start + 4×30 = start + 2h.
    const thursday = nextOccurrenceOfWeekday(4);
    const windowStart = thursday;
    const windowEnd = thursday;

    const rwo = makeRuleWithOffering(
      {
        daysOfWeek: [4], // Thursday
        startTimeLocal: "14:00",
        endTimeLocal: "16:00",
        effectiveFrom: "2020-01-01",
      },
      { durationMinutes: 30 },
    );

    const slots = materializeSlotsForRule(rwo, windowStart, windowEnd);
    expect(slots).toHaveLength(4);

    const last = slots[slots.length - 1];
    expect(last).toBeDefined();
    if (!last) throw new Error("last slot is undefined");
    const lastEnds = last.endsAt;

    // ends_at of the last slot should be exactly end_time_local (16:00 local = UTC offset).
    // We verify relative: last.endsAt - first.startsAt = 2h exactly.
    const first = slots[0];
    expect(first).toBeDefined();
    if (!first) throw new Error("first slot is undefined");
    const totalMs = lastEnds.getTime() - first.startsAt.getTime();
    expect(totalMs).toBe(2 * 60 * 60 * 1000);
  });

  it("all emitted slots carry the offering's slotCapacity", () => {
    const friday = nextOccurrenceOfWeekday(5);

    const rwo = makeRuleWithOffering(
      {
        daysOfWeek: [5], // Friday
        startTimeLocal: "10:00",
        endTimeLocal: "12:00",
        effectiveFrom: "2020-01-01",
      },
      { durationMinutes: 30, slotCapacity: 8 },
    );

    const slots = materializeSlotsForRule(rwo, friday, friday);
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot.capacity).toBe(8);
      expect(slot.bookingsCount).toBe(0);
    }
  });

  it("respects effectiveFrom — skips dates before the rule's effective start", () => {
    // Put effectiveFrom in the future relative to windowStart.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const futureDate = new Date(today.getTime() + 10 * 24 * 60 * 60 * 1000); // +10 days
    const futureStr = futureDate.toISOString().slice(0, 10);

    // Window spans from today for 14 days.
    const windowEnd = new Date(today.getTime() + 13 * 24 * 60 * 60 * 1000);

    // Rule fires every day of the week.
    const rwo = makeRuleWithOffering({
      daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
      startTimeLocal: "10:00",
      endTimeLocal: "11:00",
      effectiveFrom: futureStr, // only starts in 10 days
    });

    const slots = materializeSlotsForRule(rwo, today, windowEnd);
    // All slots should be on or after futureDate.
    for (const slot of slots) {
      expect(slot.startsAt.getTime()).toBeGreaterThanOrEqual(futureDate.getTime());
    }
  });
});
