// Pure, deterministic slot materialization logic (Fase 3).
//
// materializeSlotsForRule: takes a single schedule rule + date window, returns
// the list of NewTimeSlot-shaped objects that SHOULD exist.
//
// Design constraints:
// - Zero side-effects: no DB calls, no I/O. Call from tests directly.
// - The unique index on time_slots is (service_offering_id, starts_at).
//   Idempotency is enforced at the DB level via .onConflictDoNothing() in
//   the writer. This function simply emits every slot that belongs in the
//   window; duplicates are silently dropped on insert.
// - ISO 8601 weekday: 1 = Mon … 7 = Sun (matches DB storage + schedule rule).
// - start_time_local / end_time_local are treated as local clock times in the
//   offering's timezone. For v1 we convert to UTC via the date + time combo
//   using the Intl API. The timezone is stored on the rule (defaults to
//   America/Argentina/Buenos_Aires).
// - Last slot rule: the final slot's ends_at must be <= end_time_local. No
//   slot is emitted that would extend past end_time_local.

import type { NewTimeSlot, ServiceOffering, ServiceScheduleRule } from "@/db/schema";

// ────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Returns the ISO 8601 weekday (1=Mon … 7=Sun) for a given Date.
 * JS Date.getDay() returns 0=Sun … 6=Sat, so we normalize.
 */
function isoWeekday(d: Date): number {
  const day = d.getDay(); // 0=Sun
  return day === 0 ? 7 : day;
}

/**
 * Converts a YYYY-MM-DD date string + HH:MM time string (local clock) to a
 * UTC Date, interpreting them in the given IANA timezone.
 *
 * Strategy: build a dateTimeString and use Intl.DateTimeFormat with
 * `timeZone` to find the UTC offset at that local moment.
 * This handles DST correctly (the offset can vary by day).
 */
function localToUtc(dateStr: string, timeStr: string, timezone: string): Date {
  // Construct an ISO-ish string and parse it with the offset from Intl.
  // We use the "temporal anchor" trick: format a known UTC time to the target
  // tz and subtract the diff.
  //
  // The Postgres `time` column is returned by postgres-js as "HH:MM:SS". We
  // accept both "HH:MM" and "HH:MM:SS" — normalise to "HH:MM" before appending
  // the seconds literal so the ISO string is always well-formed.
  const hhmm = timeStr.length > 5 ? timeStr.slice(0, 5) : timeStr;
  const candidateIso = `${dateStr}T${hhmm}:00`;
  // Parse as if it were UTC.
  const naiveUtcMs = Date.parse(`${candidateIso}Z`);

  // Ask Intl what date/time the target tz shows for that naive UTC moment.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date(naiveUtcMs)).map((p) => [p.type, p.value]),
  );
  const tzLocalIso = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  const tzLocalMs = Date.parse(`${tzLocalIso}Z`);

  // Offset: how much the timezone is ahead of UTC at that moment.
  const offsetMs = tzLocalMs - naiveUtcMs;

  // Apply correction to get the real UTC ms for the local time.
  return new Date(naiveUtcMs - offsetMs);
}

/**
 * Returns an array of YYYY-MM-DD strings for each date in [windowStart, windowEnd]
 * (inclusive) whose ISO weekday is in the weekdays set.
 */
function matchingDates(
  windowStart: Date,
  windowEnd: Date,
  weekdays: number[],
  effectiveFrom: string,
  effectiveUntil: string | null,
): string[] {
  const days: string[] = [];

  // Clamp window to the rule's effective date range.
  const eff = new Date(`${effectiveFrom}T00:00:00Z`);
  const effUntil = effectiveUntil ? new Date(`${effectiveUntil}T23:59:59Z`) : null;

  const start = windowStart < eff ? eff : windowStart;
  const end = effUntil && windowEnd > effUntil ? effUntil : windowEnd;

  // Iterate day by day (UTC midnight cursor).
  const cursor = new Date(start);
  cursor.setUTCHours(0, 0, 0, 0);
  const endMs = end.getTime();

  while (cursor.getTime() <= endMs) {
    const dow = isoWeekday(cursor);
    if (weekdays.includes(dow)) {
      const y = cursor.getUTCFullYear();
      const m = String(cursor.getUTCMonth() + 1).padStart(2, "0");
      const d = String(cursor.getUTCDate()).padStart(2, "0");
      days.push(`${y}-${m}-${d}`);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return days;
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Input shape for materialization. Combines the rule with its offering's
 * capacity and duration settings (the caller loads these together).
 */
export type RuleWithOffering = {
  rule: ServiceScheduleRule;
  offering: Pick<ServiceOffering, "id" | "slotCapacity" | "durationMinutes">;
};

/**
 * Pure function: given a single active rule + offering + date window, returns
 * all time_slot rows that should exist in that window.
 *
 * Does NOT query or write to the DB. The caller is responsible for bulk
 * inserting the result with onConflictDoNothing().
 *
 * Edge-case: the last slot of the day ends AT end_time_local exactly. A slot
 * is only emitted if start + durationMinutes <= end_time. No overshoot.
 */
export function materializeSlotsForRule(
  { rule, offering }: RuleWithOffering,
  windowStart: Date,
  windowEnd: Date,
): NewTimeSlot[] {
  const weekdays = (rule.daysOfWeek as number[]).filter((d) => d >= 1 && d <= 7);
  const timezone = rule.timezone ?? "America/Argentina/Buenos_Aires";
  const durationMs = offering.durationMinutes * 60 * 1000;

  const dates = matchingDates(
    windowStart,
    windowEnd,
    weekdays,
    rule.effectiveFrom as string,
    (rule.effectiveUntil as string | null) ?? null,
  );

  const slots: NewTimeSlot[] = [];

  for (const dateStr of dates) {
    // Parse start and end in local time → UTC.
    const dayStart = localToUtc(dateStr, rule.startTimeLocal as string, timezone);
    const dayEnd = localToUtc(dateStr, rule.endTimeLocal as string, timezone);

    // Generate slots from dayStart to dayEnd.
    // A slot is valid only if (slotStart + durationMs) <= dayEnd.
    let cursor = dayStart.getTime();
    while (cursor + durationMs <= dayEnd.getTime()) {
      slots.push({
        serviceOfferingId: offering.id,
        ruleId: rule.id,
        startsAt: new Date(cursor),
        endsAt: new Date(cursor + durationMs),
        capacity: offering.slotCapacity,
        bookingsCount: 0,
        status: "open",
      });
      cursor += durationMs;
    }
  }

  return slots;
}
