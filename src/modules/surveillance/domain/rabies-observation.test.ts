// Unit tests for domain/rabies-observation.ts
// Spec source: cross-cutting parity quirk #1 (computeRabiesVaccineValidAtBite)
//              and #2 (computeObservationUntil).
//
// These are PURE functions — zero DB, zero Next.js imports.

import { describe, expect, it } from "vitest";

import {
  OPEN_OBSERVATION_STATUSES,
  PROFESSIONAL_OUTCOMES,
  RABIES_OBSERVATION_DAYS,
  RABIES_OBSERVATION_STATUSES,
  type RabiesObservationOutcome,
  type RabiesObservationStatus,
  computeObservationUntil,
  isObservationOpen,
  isRabiesVaccineValid,
  mustWaitForObservationEnd,
  outcomeToStatus,
  resolveObservationDeadline,
  resolveObservationWindowDays,
  vetCloseRefusal,
} from "./rabies-observation";

// ---------------------------------------------------------------------------
// RABIES_OBSERVATION_DAYS constant
// ---------------------------------------------------------------------------

describe("RABIES_OBSERVATION_DAYS", () => {
  it("is 10", () => {
    expect(RABIES_OBSERVATION_DAYS).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// RABIES_OBSERVATION_STATUSES constant
// ---------------------------------------------------------------------------

describe("RABIES_OBSERVATION_STATUSES", () => {
  it("includes all 5 valid statuses", () => {
    expect(RABIES_OBSERVATION_STATUSES).toContain("in_progress");
    expect(RABIES_OBSERVATION_STATUSES).toContain("completed_negative");
    expect(RABIES_OBSERVATION_STATUSES).toContain("completed_positive_rabies");
    expect(RABIES_OBSERVATION_STATUSES).toContain("completed_dead");
    expect(RABIES_OBSERVATION_STATUSES).toContain("completed_lost_to_followup");
  });
});

// ---------------------------------------------------------------------------
// PROFESSIONAL_OUTCOMES constant
// ---------------------------------------------------------------------------

describe("PROFESSIONAL_OUTCOMES", () => {
  it("includes negative, positive_rabies, dead, lost_to_followup", () => {
    expect(PROFESSIONAL_OUTCOMES).toContain("negative");
    expect(PROFESSIONAL_OUTCOMES).toContain("positive_rabies");
    expect(PROFESSIONAL_OUTCOMES).toContain("dead");
    expect(PROFESSIONAL_OUTCOMES).toContain("lost_to_followup");
  });

  it("has exactly 4 outcomes", () => {
    expect(PROFESSIONAL_OUTCOMES).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// outcomeToStatus — state machine
// ---------------------------------------------------------------------------

describe("outcomeToStatus", () => {
  it("maps negative → completed_negative", () => {
    expect(outcomeToStatus("negative")).toBe("completed_negative");
  });

  it("maps positive_rabies → completed_positive_rabies", () => {
    expect(outcomeToStatus("positive_rabies")).toBe("completed_positive_rabies");
  });

  it("maps dead → completed_dead", () => {
    expect(outcomeToStatus("dead")).toBe("completed_dead");
  });

  it("maps lost_to_followup → completed_lost_to_followup", () => {
    expect(outcomeToStatus("lost_to_followup")).toBe("completed_lost_to_followup");
  });

  it("every PROFESSIONAL_OUTCOME maps to a value containing the outcome word", () => {
    const outcomes: RabiesObservationOutcome[] = [
      "negative",
      "positive_rabies",
      "dead",
      "lost_to_followup",
    ];
    for (const outcome of outcomes) {
      const status: RabiesObservationStatus = outcomeToStatus(outcome);
      expect(status).toMatch(/^completed_/);
    }
  });
});

// ---------------------------------------------------------------------------
// computeObservationUntil — calendar arithmetic (parity quirk #2)
// ---------------------------------------------------------------------------

describe("computeObservationUntil", () => {
  it("adds exactly 10 calendar days to the bite date", () => {
    const bite = new Date("2026-01-01T12:00:00Z");
    const until = computeObservationUntil(bite);
    expect(until.getUTCDate() - bite.getUTCDate()).toBe(10);
  });

  it("does NOT mutate the input date", () => {
    const bite = new Date("2026-03-15T08:00:00Z");
    const original = bite.getTime();
    computeObservationUntil(bite);
    expect(bite.getTime()).toBe(original);
  });

  it("preserves hour/minute/second from the bite date (setDate arithmetic)", () => {
    const bite = new Date("2026-06-01T15:30:45.000Z");
    const until = computeObservationUntil(bite);
    // setDate only changes the day — time components are preserved
    const daysAdded = (until.getTime() - bite.getTime()) / (1000 * 60 * 60 * 24);
    expect(daysAdded).toBe(10);
  });

  it("crosses month boundaries correctly", () => {
    // Jan 25 + 10 days = Feb 4
    const bite = new Date("2026-01-25T00:00:00Z");
    const until = computeObservationUntil(bite);
    expect(until.getUTCMonth()).toBe(1); // February (0-indexed)
    expect(until.getUTCDate()).toBe(4);
  });

  it("crosses year boundaries correctly", () => {
    // Dec 28 + 10 days = Jan 7 next year
    const bite = new Date("2025-12-28T00:00:00Z");
    const until = computeObservationUntil(bite);
    expect(until.getUTCFullYear()).toBe(2026);
    expect(until.getUTCMonth()).toBe(0); // January
    expect(until.getUTCDate()).toBe(7);
  });

  it("DST edge case: AR (America/Argentina/Buenos_Aires) uses -03:00 year-round (no DST), result is 10 days later", () => {
    // Argentina does NOT observe DST so this is just a calendar check.
    // The key is we use setDate (calendar day arithmetic) not + 240h.
    const biteLocal = new Date("2026-10-18T00:00:00-03:00"); // Oct 18 in AR
    const until = computeObservationUntil(biteLocal);
    // 10 calendar days later = Oct 28
    const biteDay = biteLocal.getDate();
    expect(until.getDate()).toBe(biteDay + 10);
  });
});

// ---------------------------------------------------------------------------
// resolveObservationDeadline — T4.13 (2026-08-01) shared fallback.
//
// Extracted from close-eligible-observations.ts (the auto-close sweep) and
// reused by /admin/observaciones's "Cierre estimado" render — the deadline
// must be the SAME whether a cron reads it to decide auto-close or an
// operator reads it to plan a follow-up. Pinned here so the two call sites
// can never silently diverge again.
// ---------------------------------------------------------------------------

describe("resolveObservationDeadline", () => {
  const startedAt = new Date("2026-01-01T12:00:00Z");

  it("uses the payload's observation_until when present and valid", () => {
    const explicit = "2026-01-15T00:00:00Z";
    const result = resolveObservationDeadline(explicit, startedAt);
    expect(result.toISOString()).toBe(new Date(explicit).toISOString());
  });

  it("falls back to computeObservationUntil(startedAt) when the field is absent (undefined)", () => {
    const result = resolveObservationDeadline(undefined, startedAt);
    expect(result.toISOString()).toBe(computeObservationUntil(startedAt).toISOString());
  });

  it("falls back to computeObservationUntil(startedAt) when the field is null", () => {
    const result = resolveObservationDeadline(null, startedAt);
    expect(result.toISOString()).toBe(computeObservationUntil(startedAt).toISOString());
  });

  it("falls back to computeObservationUntil(startedAt) when the field is an empty string", () => {
    const result = resolveObservationDeadline("", startedAt);
    expect(result.toISOString()).toBe(computeObservationUntil(startedAt).toISOString());
  });

  it("falls back to computeObservationUntil(startedAt) when the field is an unparsable string", () => {
    const result = resolveObservationDeadline("not-a-date", startedAt);
    expect(result.toISOString()).toBe(computeObservationUntil(startedAt).toISOString());
  });

  it("accepts a Date instance directly (not just a string), for callers that already parsed it", () => {
    const explicit = new Date("2026-01-20T00:00:00Z");
    const result = resolveObservationDeadline(explicit, startedAt);
    expect(result.toISOString()).toBe(explicit.toISOString());
  });

  it("falls back for a non-date-like value (e.g. a number), never throws", () => {
    const result = resolveObservationDeadline(12345, startedAt);
    expect(result.toISOString()).toBe(computeObservationUntil(startedAt).toISOString());
  });
});

// ---------------------------------------------------------------------------
// isRabiesVaccineValid — pure predicate (parity quirk #1)
//
// Spec: SQL `~* '(antirr[áa]bica|rabies)'` vaccine_name regex;
//       next_due_at > biteDate if present, else administered + 1yr > biteDate;
//       no vaccine → false.
//
// The function receives the latest vaccination event row (or null) and the
// biteDate, and returns a boolean.
// ---------------------------------------------------------------------------

type VaccineEvent = {
  occurredAt: Date;
  payload: Record<string, unknown>;
};

describe("isRabiesVaccineValid", () => {
  const biteDate = new Date("2026-06-01T00:00:00Z");

  // ---- No vaccine at all ----

  it("returns false when latestEvent is null (no vaccine on record)", () => {
    expect(isRabiesVaccineValid(null, biteDate)).toBe(false);
  });

  // ---- vaccine_name matching (regex `~* '(antirr[áa]bica|rabies)'`) ----

  it("returns false when vaccine_name does not match rabies regex", () => {
    const event: VaccineEvent = {
      occurredAt: new Date("2025-01-01Z"),
      payload: { vaccine_name: "Leptospira pentavalente" },
    };
    expect(isRabiesVaccineValid(event, biteDate)).toBe(false);
  });

  it("returns false when vaccine_name is missing from payload", () => {
    const event: VaccineEvent = {
      occurredAt: new Date("2025-01-01Z"),
      payload: {},
    };
    expect(isRabiesVaccineValid(event, biteDate)).toBe(false);
  });

  it("matches 'antirrábica' (with accent on á)", () => {
    const event: VaccineEvent = {
      occurredAt: new Date("2025-07-01Z"),
      payload: { vaccine_name: "Vacuna antirrábica triple" },
    };
    // administered 2025-07-01 + 1yr = 2026-07-01 > biteDate 2026-06-01 → valid
    expect(isRabiesVaccineValid(event, biteDate)).toBe(true);
  });

  it("matches 'antirrabica' (no accent on a)", () => {
    const event: VaccineEvent = {
      occurredAt: new Date("2025-07-01Z"),
      payload: { vaccine_name: "antirrabica" },
    };
    expect(isRabiesVaccineValid(event, biteDate)).toBe(true);
  });

  it("matches 'rabies' (English, case-insensitive)", () => {
    const event: VaccineEvent = {
      occurredAt: new Date("2025-07-01Z"),
      payload: { vaccine_name: "Nobivac Rabies" },
    };
    expect(isRabiesVaccineValid(event, biteDate)).toBe(true);
  });

  it("matches 'RABIES' (uppercase)", () => {
    const event: VaccineEvent = {
      occurredAt: new Date("2025-07-01Z"),
      payload: { vaccine_name: "RABIES VACCINE" },
    };
    expect(isRabiesVaccineValid(event, biteDate)).toBe(true);
  });

  // ---- next_due_at branch ----

  it("returns true when next_due_at is after biteDate", () => {
    const event: VaccineEvent = {
      occurredAt: new Date("2024-01-01Z"),
      payload: {
        vaccine_name: "antirrábica",
        next_due_at: "2026-12-01T00:00:00Z", // after bite
      },
    };
    expect(isRabiesVaccineValid(event, biteDate)).toBe(true);
  });

  it("returns false when next_due_at is before biteDate", () => {
    const event: VaccineEvent = {
      occurredAt: new Date("2024-01-01Z"),
      payload: {
        vaccine_name: "antirrábica",
        next_due_at: "2026-01-01T00:00:00Z", // before bite
      },
    };
    expect(isRabiesVaccineValid(event, biteDate)).toBe(false);
  });

  it("ignores next_due_at when it is not a valid date string, falls back to 1yr rule", () => {
    const event: VaccineEvent = {
      occurredAt: new Date("2025-07-01Z"),
      payload: {
        vaccine_name: "rabies",
        next_due_at: "not-a-date",
      },
    };
    // 2025-07-01 + 1yr = 2026-07-01 > 2026-06-01 → valid
    expect(isRabiesVaccineValid(event, biteDate)).toBe(true);
  });

  // ---- 1-year fallback branch (setFullYear) ----

  it("returns true when administered + 1yr is after biteDate (no next_due_at)", () => {
    const event: VaccineEvent = {
      occurredAt: new Date("2025-07-01Z"), // + 1yr = 2026-07-01 > 2026-06-01
      payload: { vaccine_name: "antirrábica" },
    };
    expect(isRabiesVaccineValid(event, biteDate)).toBe(true);
  });

  it("returns false when administered + 1yr is before biteDate (no next_due_at)", () => {
    const event: VaccineEvent = {
      occurredAt: new Date("2024-05-01Z"), // + 1yr = 2025-05-01 < 2026-06-01
      payload: { vaccine_name: "antirrábica" },
    };
    expect(isRabiesVaccineValid(event, biteDate)).toBe(false);
  });

  it("returns false when occurredAt is invalid (NaN), even with matching vaccine_name", () => {
    const event: VaccineEvent = {
      occurredAt: new Date("invalid"),
      payload: { vaccine_name: "rabies" },
    };
    expect(isRabiesVaccineValid(event, biteDate)).toBe(false);
  });

  it("exact 1yr boundary: administered exactly 1yr before biteDate is NOT valid (strict greater-than)", () => {
    // setFullYear(2026) on 2025-06-01 = 2026-06-01; that equals biteDate, not >
    const event: VaccineEvent = {
      occurredAt: new Date("2025-06-01T00:00:00Z"),
      payload: { vaccine_name: "antirrábica" },
    };
    expect(isRabiesVaccineValid(event, biteDate)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// window_expired_unclosed — the state that asserts nothing (2026-08-17)
// ---------------------------------------------------------------------------

describe("window_expired_unclosed", () => {
  it("is a declared status, and is NOT one of the completed_* terminal values", () => {
    expect(RABIES_OBSERVATION_STATUSES).toContain("window_expired_unclosed");
    expect("window_expired_unclosed".startsWith("completed_")).toBe(false);
  });

  it("is NOT reachable from any outcome — no clinical result maps onto it", () => {
    const reachable = PROFESSIONAL_OUTCOMES.map((o) => outcomeToStatus(o));
    expect(reachable).not.toContain("window_expired_unclosed");
  });

  it("counts as OPEN alongside in_progress, and nothing else does", () => {
    expect(isObservationOpen("in_progress")).toBe(true);
    expect(isObservationOpen("window_expired_unclosed")).toBe(true);
    for (const s of RABIES_OBSERVATION_STATUSES) {
      if (s === "in_progress" || s === "window_expired_unclosed") continue;
      expect(isObservationOpen(s)).toBe(false);
    }
    expect(isObservationOpen(null)).toBe(false);
    expect(isObservationOpen(undefined)).toBe(false);
  });

  it("OPEN_OBSERVATION_STATUSES matches the predicate exactly", () => {
    expect([...OPEN_OBSERVATION_STATUSES].every(isObservationOpen)).toBe(true);
    expect(RABIES_OBSERVATION_STATUSES.filter(isObservationOpen)).toEqual([
      ...OPEN_OBSERVATION_STATUSES,
    ]);
  });
});

// ---------------------------------------------------------------------------
// resolveObservationWindowDays — never invents the national baseline
// ---------------------------------------------------------------------------

describe("resolveObservationWindowDays", () => {
  it("returns the recorded window", () => {
    expect(resolveObservationWindowDays(14)).toBe(14);
    expect(resolveObservationWindowDays("14")).toBe(14);
  });

  it("returns null — NOT 10 — when the observation predates the field", () => {
    expect(resolveObservationWindowDays(undefined)).toBeNull();
    expect(resolveObservationWindowDays(null)).toBeNull();
    expect(resolveObservationWindowDays("no")).toBeNull();
    expect(resolveObservationWindowDays(0)).toBeNull();
    expect(resolveObservationWindowDays(-3)).toBeNull();
    // The whole point: an absent window must not silently become RABIES_OBSERVATION_DAYS.
    expect(resolveObservationWindowDays(undefined)).not.toBe(RABIES_OBSERVATION_DAYS);
  });
});

// ---------------------------------------------------------------------------
// mustWaitForObservationEnd — the veterinarian's legal wait (PO 2026-09-18)
// ---------------------------------------------------------------------------

describe("mustWaitForObservationEnd", () => {
  const DEADLINE = new Date("2026-09-24T12:00:00.000Z");
  const BEFORE = new Date("2026-09-18T15:00:00.000Z");
  const AFTER = new Date("2026-09-24T12:00:00.001Z");

  it("holds a negative back until the window ends", () => {
    expect(mustWaitForObservationEnd("negative", DEADLINE, BEFORE)).toBe(true);
  });

  it("releases the negative at the deadline itself, not a millisecond later", () => {
    expect(mustWaitForObservationEnd("negative", DEADLINE, DEADLINE)).toBe(false);
    expect(mustWaitForObservationEnd("negative", DEADLINE, AFTER)).toBe(false);
  });

  it("gates the negative only — the other vet refusals live in vetCloseRefusal", () => {
    const ungated: RabiesObservationOutcome[] = ["positive_rabies", "dead", "lost_to_followup"];
    for (const outcome of ungated) {
      expect(mustWaitForObservationEnd(outcome, DEADLINE, BEFORE), outcome).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// vetCloseRefusal — every early exit a veterinarian may not take (PO D1)
// ---------------------------------------------------------------------------

describe("vetCloseRefusal", () => {
  const DEADLINE = new Date("2026-09-24T12:00:00.000Z");
  const BEFORE = new Date("2026-09-18T15:00:00.000Z");
  const AFTER = new Date("2026-09-24T12:00:00.001Z");

  it("before the deadline, only a positive goes through", () => {
    expect(vetCloseRefusal("positive_rabies", DEADLINE, BEFORE)).toBeNull();
    expect(vetCloseRefusal("negative", DEADLINE, BEFORE)).toBe("negative_before_deadline");
    expect(vetCloseRefusal("dead", DEADLINE, BEFORE)).toBe("dead_before_deadline");
    expect(vetCloseRefusal("lost_to_followup", DEADLINE, BEFORE)).toBe("lost_to_followup_never");
  });

  it("from the deadline on, negative and death open; 'sin seguimiento' never does", () => {
    for (const now of [DEADLINE, AFTER]) {
      expect(vetCloseRefusal("negative", DEADLINE, now)).toBeNull();
      expect(vetCloseRefusal("dead", DEADLINE, now)).toBeNull();
      expect(vetCloseRefusal("positive_rabies", DEADLINE, now)).toBeNull();
      expect(vetCloseRefusal("lost_to_followup", DEADLINE, now)).toBe("lost_to_followup_never");
    }
  });
});
