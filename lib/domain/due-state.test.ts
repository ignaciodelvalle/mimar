// due-state.test — the G4 deadline normalization (obligations-worklist).
//
// The contract under test is the worklist's common currency: every domain
// hands in ONLY a dueAt Date; state/day-counts/ranking/badge words all come
// from here. The badge assertions double as the tier-vs-count regression
// guard: the rendered number is always dueAt↔now distance, never a tier.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_DUE_SOON_DAYS,
  type DueInfo,
  compareDueInfo,
  computeDueInfo,
  dueDateBadge,
} from "./due-state";

// Fixed clock: 2026-08-02T15:00:00Z = 12:00 in AR (UTC-3, no DST).
const NOW = new Date("2026-08-02T15:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function daysFromNow(days: number): Date {
  return new Date(NOW.getTime() + days * DAY_MS);
}

describe("computeDueInfo — states and day counts", () => {
  it("null dueAt → honest no-deadline shape (onTime, zeros, dueAt null)", () => {
    expect(computeDueInfo(null, NOW)).toEqual({
      dueAt: null,
      overdueDays: 0,
      dueInDays: 0,
      state: "onTime",
    });
  });

  it("an invalid Date is treated as no deadline, never NaN math", () => {
    const due = computeDueInfo(new Date("not-a-date"), NOW);
    expect(due.dueAt).toBeNull();
    expect(due.state).toBe("onTime");
    expect(due.overdueDays).toBe(0);
  });

  it("a deadline 3 days past → overdue by 3 AR calendar days", () => {
    const due = computeDueInfo(daysFromNow(-3), NOW);
    expect(due.state).toBe("overdue");
    expect(due.overdueDays).toBe(3);
    expect(due.dueInDays).toBe(0);
  });

  it("a deadline missed earlier TODAY → overdue with overdueDays 0 (Venció hoy)", () => {
    const due = computeDueInfo(new Date(NOW.getTime() - 2 * 60 * 60 * 1000), NOW);
    expect(due.state).toBe("overdue");
    expect(due.overdueDays).toBe(0);
  });

  it("a deadline later today → dueSoon with dueInDays 0 (Vence hoy)", () => {
    const due = computeDueInfo(new Date(NOW.getTime() + 5 * 60 * 60 * 1000), NOW);
    expect(due.state).toBe("dueSoon");
    expect(due.dueInDays).toBe(0);
    expect(due.overdueDays).toBe(0);
  });

  it("day identity is the ARGENTINE calendar day, not UTC: 01:00Z tomorrow is still 22:00 today in AR", () => {
    // 2026-08-03T01:00:00Z = 2026-08-02 22:00 in AR — same AR day as NOW.
    const due = computeDueInfo(new Date("2026-08-03T01:00:00.000Z"), NOW);
    expect(due.state).toBe("dueSoon");
    expect(due.dueInDays).toBe(0);
  });

  it("tomorrow → dueSoon 1; the default window's last day → dueSoon; one past it → onTime", () => {
    expect(computeDueInfo(daysFromNow(1), NOW)).toMatchObject({ state: "dueSoon", dueInDays: 1 });
    expect(computeDueInfo(daysFromNow(DEFAULT_DUE_SOON_DAYS), NOW)).toMatchObject({
      state: "dueSoon",
      dueInDays: DEFAULT_DUE_SOON_DAYS,
    });
    expect(computeDueInfo(daysFromNow(DEFAULT_DUE_SOON_DAYS + 1), NOW)).toMatchObject({
      state: "onTime",
      dueInDays: DEFAULT_DUE_SOON_DAYS + 1,
    });
  });

  it("accepts a caller-supplied dueSoon window", () => {
    expect(computeDueInfo(daysFromNow(5), NOW, 7).state).toBe("dueSoon");
    expect(computeDueInfo(daysFromNow(5), NOW, 2).state).toBe("onTime");
  });
});

describe("compareDueInfo — the worklist ranking contract", () => {
  const overdue9 = computeDueInfo(daysFromNow(-9), NOW);
  const overdue2 = computeDueInfo(daysFromNow(-2), NOW);
  const dueTomorrow = computeDueInfo(daysFromNow(1), NOW);
  const dueIn3 = computeDueInfo(daysFromNow(3), NOW);
  const onTime10 = computeDueInfo(daysFromNow(10), NOW);
  const noDeadline = computeDueInfo(null, NOW);

  it("sorts state first (overdue → dueSoon → onTime), most overdue leading", () => {
    const sorted = [onTime10, dueTomorrow, overdue2, noDeadline, overdue9, dueIn3].sort(
      compareDueInfo,
    );
    expect(sorted).toEqual([overdue9, overdue2, dueTomorrow, dueIn3, onTime10, noDeadline]);
  });

  it("within overdue: MORE days overdue ranks first (never ascending)", () => {
    expect(compareDueInfo(overdue9, overdue2)).toBeLessThan(0);
    expect(compareDueInfo(overdue2, overdue9)).toBeGreaterThan(0);
  });

  it("within non-overdue: sooner deadline ranks first", () => {
    expect(compareDueInfo(dueTomorrow, dueIn3)).toBeLessThan(0);
  });

  it("a row with NO deadline sinks below every dated row, even an on-time one", () => {
    expect(compareDueInfo(noDeadline, onTime10)).toBeGreaterThan(0);
    expect(compareDueInfo(noDeadline, noDeadline)).toBe(0);
  });

  it("equal calendar distance falls back to the raw dueAt timestamp (deterministic)", () => {
    const morning = computeDueInfo(new Date("2026-07-30T10:00:00.000Z"), NOW);
    const evening = computeDueInfo(new Date("2026-07-30T20:00:00.000Z"), NOW);
    expect(morning.overdueDays).toBe(evening.overdueDays);
    expect(compareDueInfo(morning, evening)).toBeLessThan(0);
  });
});

describe("dueDateBadge — honest words, honest tones", () => {
  const badge = (due: DueInfo) => dueDateBadge(due);

  it("overdue renders the DAYS-OVERDUE count (dueAt↔now distance), danger tone", () => {
    expect(badge(computeDueInfo(daysFromNow(-3), NOW))).toEqual({
      label: "Venció hace 3 días",
      tone: "danger",
    });
  });

  it("singular agreement: 1 día, never '1 días'", () => {
    expect(badge(computeDueInfo(daysFromNow(-1), NOW)).label).toBe("Venció hace 1 día");
  });

  it("missed earlier today → 'Venció hoy', never 'hace 0 días'", () => {
    expect(badge(computeDueInfo(new Date(NOW.getTime() - 1000), NOW)).label).toBe("Venció hoy");
  });

  it("due today / tomorrow / in N days — dueSoon wording, warn (open) tone", () => {
    expect(badge(computeDueInfo(new Date(NOW.getTime() + 1000), NOW))).toEqual({
      label: "Vence hoy",
      tone: "open",
    });
    expect(badge(computeDueInfo(daysFromNow(1), NOW))).toEqual({
      label: "Vence mañana",
      tone: "open",
    });
    expect(badge(computeDueInfo(daysFromNow(3), NOW))).toEqual({
      label: "Vence en 3 días",
      tone: "open",
    });
  });

  it("on-time renders the days-until count with ok tone", () => {
    expect(badge(computeDueInfo(daysFromNow(10), NOW))).toEqual({
      label: "Vence en 10 días",
      tone: "ok",
    });
  });

  it("no deadline → 'Sin plazo', neutral — never a fabricated date", () => {
    expect(badge(computeDueInfo(null, NOW))).toEqual({ label: "Sin plazo", tone: "neutral" });
  });
});
