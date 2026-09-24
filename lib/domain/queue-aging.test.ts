// D-4 (Lote D) — what a /gob home queue tile may honestly say about time.
//
// The rules under test are the ones a bare count cannot express: a queue fully
// within SLA that still holds a 40-day-old row, an empty queue that must stay
// silent rather than invent an age, and Spanish agreement on "vencidas" vs
// "vencidos" (la denuncia / el caso) — the kind of thing that reads as a bug to
// an es-AR operator even though the number is right.

import { describe, expect, it } from "vitest";

import { type QueueAging, ageInDays, queueAgingNote } from "@/lib/domain/queue-aging";

const NOW = new Date("2026-08-16T15:00:00-03:00");

const aging = (oldestAgeDays: number | null, overdueCount = 0): QueueAging => ({
  oldestAgeDays,
  overdueCount,
});

describe("queueAgingNote — the sub-line under a queue count", () => {
  it("says nothing at all for an empty queue — the 0 is the whole truth", () => {
    expect(queueAgingNote(aging(null), "f")).toBeNull();
    expect(queueAgingNote(aging(null, 0), "m")).toBeNull();
  });

  it("names the oldest row when nothing is overdue (a queue in time still has a tail)", () => {
    expect(queueAgingNote(aging(40), "f")).toBe("La más antigua: 40 días");
  });

  it("leads with the overdue count when there is one — it is the actionable half", () => {
    expect(queueAgingNote(aging(42, 3), "f")).toBe("3 vencidas · la más antigua: 42 días");
    expect(queueAgingNote(aging(42, 3), "m")).toBe("3 vencidos · la más antigua: 42 días");
  });

  it("agrees in gender AND number — one overdue denuncia is 'vencida', one caso 'vencido'", () => {
    expect(queueAgingNote(aging(9, 1), "f")).toBe("1 vencida · la más antigua: 9 días");
    expect(queueAgingNote(aging(9, 1), "m")).toBe("1 vencido · la más antigua: 9 días");
  });

  it("never renders a bare '1 días' — the oldest row at exactly one day", () => {
    expect(queueAgingNote(aging(1), "f")).toBe("La más antigua: 1 día");
    expect(queueAgingNote(aging(1, 1), "m")).toBe("1 vencido · la más antigua: 1 día");
  });

  it("a row that arrived today is 0 días, not omitted and not rounded up to 1", () => {
    expect(queueAgingNote(aging(0), "f")).toBe("La más antigua: 0 días");
  });
});

describe("ageInDays — AR calendar days, floored at zero", () => {
  it("counts calendar days, not 24h blocks (23:50 yesterday → 1 día at 15:00 today)", () => {
    expect(ageInDays(new Date("2026-08-15T23:50:00-03:00"), NOW)).toBe(1);
  });

  it("an earlier moment of the SAME AR day is 0 días", () => {
    expect(ageInDays(new Date("2026-08-16T00:05:00-03:00"), NOW)).toBe(0);
  });

  it("a clock-skewed future timestamp floors to 0 instead of going negative", () => {
    expect(ageInDays(new Date("2026-08-20T10:00:00-03:00"), NOW)).toBe(0);
  });
});
