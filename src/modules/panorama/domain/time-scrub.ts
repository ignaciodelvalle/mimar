// Panorama temporal-reproduction primitives (spec F4) — pure domain.
//
// The TimeScrubber lets an operator scrub the active period [since, now] back in
// time to watch a situation form (e.g. the Salta rabies cluster over ~12 days).
// All the date arithmetic lives here as pure functions so it is unit-testable
// WITHOUT React/DOM and shared by both the client control and the API clamp.
//
// Domain purity: NO @/db, NO next, NO React (enforced by the noRestrictedImports
// override for src/modules/*/domain/**). `Date` is allowed; the scrubber steps in
// whole days over short windows and whole MONTHS over long ones (> ~90 days), so a
// multi-year reproduction collapses from ~1095 day-steps to ~36 month-steps. The
// 0..steps index interface is unchanged, so the slider control adapts for free.

const DAY_MS = 24 * 60 * 60 * 1000;

// Windows longer than this step by whole MONTHS instead of days, so a multi-year
// reproduction stays usable (a 3-year span is ~36 month-steps, not ~1095 days).
const MONTH_STEP_THRESHOLD_DAYS = 90;

/** Each scrub step is a whole day (short windows) or a whole month (long ones). */
export type ScrubGranularity = "day" | "month";

/**
 * Bitemporal replay basis (task #77). Every pet_events row carries occurred_at
 * (VALID time — when the fact happened) and recorded_at (TRANSACTION time — when
 * the system/State learned it). The scrubber replays by one or the other:
 *   - "valid"       → occurred_at. "What happened when." (default)
 *   - "transaction" → recorded_at. "What the State KNEW when." An event that
 *                     occurred 2026-03-01 but was recorded 2026-03-13 appears 12
 *                     days later in transaction-time replay — the gap IS the
 *                     reporting-lag / territorial-presence metric.
 */
export type TimeBasis = "valid" | "transaction";

/** Parse a raw `?basis=` query value; anything but "transaction" is the default "valid". */
export function parseTimeBasis(raw: string | null | undefined): TimeBasis {
  return raw === "transaction" ? "transaction" : "valid";
}

/** A discrete reproduction axis over [since, until], stepped by day or month. */
export type ScrubWindow = {
  /** Inclusive lower bound (the active period's `since`, floored to the step). */
  since: Date;
  /** Inclusive upper bound ("ahora" / live). */
  until: Date;
  /** Number of whole steps from `since` to `until` (>= 0). */
  steps: number;
  /** Whether each step is a whole day or a whole month. */
  step: ScrubGranularity;
};

/** Floor a timestamp to the start of its UTC day. */
function floorToUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** Floor a timestamp to the start of its UTC month (day 1, 00:00:00). */
function floorToUtcMonth(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Add `n` whole months to a UTC timestamp (handles year wrap via Date.UTC). */
function addUtcMonths(ms: number, n: number): number {
  const d = new Date(ms);
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth() + n,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  );
}

/** Whole UTC months from `aMs` to `bMs`. `a` is expected to be month-floored. */
function monthsBetween(aMs: number, bMs: number): number {
  const a = new Date(aMs);
  const b = new Date(bMs);
  const months =
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  return Math.max(0, months);
}

/**
 * Build a day-stepped axis from a [since, until] window. `until` is snapped to
 * the END of its day and `since` to the START of its day so the axis spans whole
 * days inclusively. A degenerate or inverted window collapses to a single step.
 */
export function buildScrubWindow(since: Date, until: Date): ScrubWindow {
  const rawSinceMs = since.getTime();
  const untilMs = until.getTime();
  if (!Number.isFinite(rawSinceMs) || !Number.isFinite(untilMs)) {
    return { since: new Date(rawSinceMs), until: new Date(untilMs), steps: 0, step: "day" };
  }

  // Long windows step by month so multi-year reproduction stays usable.
  if ((untilMs - rawSinceMs) / DAY_MS > MONTH_STEP_THRESHOLD_DAYS) {
    const sinceMs = floorToUtcMonth(rawSinceMs);
    const steps = untilMs <= sinceMs ? 0 : monthsBetween(sinceMs, untilMs);
    return { since: new Date(sinceMs), until: new Date(untilMs), steps, step: "month" };
  }

  // Short windows keep whole-day stepping (unchanged behaviour).
  const sinceMs = floorToUtcDay(rawSinceMs);
  if (untilMs <= sinceMs) {
    return { since: new Date(sinceMs), until: new Date(untilMs), steps: 0, step: "day" };
  }
  // Inclusive whole-day count from the start-of-day `since` to `until`.
  const steps = Math.max(0, Math.floor((floorToUtcDay(untilMs) - sinceMs) / DAY_MS));
  return { since: new Date(sinceMs), until: new Date(untilMs), steps, step: "day" };
}

/**
 * Map a 0..steps slider index to its as-of Date. Index 0 → `since`; the final
 * index → `until` ("ahora"). The index is clamped into range so out-of-bounds
 * keyboard input never escapes the window.
 */
export function dayIndexToDate(win: ScrubWindow, index: number): Date {
  const clamped = Math.max(0, Math.min(win.steps, Math.round(index)));
  if (clamped >= win.steps) return new Date(win.until.getTime());
  if (win.step === "month") return new Date(addUtcMonths(win.since.getTime(), clamped));
  return new Date(win.since.getTime() + clamped * DAY_MS);
}

/** Map an as-of Date back to its nearest 0..steps slider index. */
export function dateToDayIndex(win: ScrubWindow, asOf: Date): number {
  const idx =
    win.step === "month"
      ? monthsBetween(win.since.getTime(), asOf.getTime())
      : Math.round((asOf.getTime() - win.since.getTime()) / DAY_MS);
  return Math.max(0, Math.min(win.steps, idx));
}

/**
 * Advance the play loop by one day. Returns the next index, or `null` once the
 * end ("ahora") is reached so the caller can stop the interval. Wrapping is the
 * caller's choice — returning null keeps the loop honest (play → stop at live).
 */
export function nextPlayIndex(win: ScrubWindow, current: number): number | null {
  const clamped = Math.max(0, Math.min(win.steps, Math.round(current)));
  if (clamped >= win.steps) return null;
  return clamped + 1;
}

/**
 * Clamp an arbitrary as-of timestamp into [since, until]. Used by the API route so
 * a crafted `?asOf=` can never widen the window below `since` or above "now".
 * Returns `null` when the input is absent/un-parseable (caller treats null as live).
 */
export function clampAsOf(asOf: Date | null, since: Date, until: Date): Date | null {
  if (!asOf || Number.isNaN(asOf.getTime())) return null;
  const t = asOf.getTime();
  if (t < since.getTime()) return new Date(since.getTime());
  if (t > until.getTime()) return new Date(until.getTime());
  return asOf;
}

/** Parse an ISO string to a Date, or null when absent/invalid. */
export function parseAsOf(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Human es-AR label for the as-of date shown beside the scrubber (and aria-valuetext). */
export function formatAsOfLabel(date: Date): string {
  // Use UTC parts so the displayed day matches the day-stepped axis (built in UTC).
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

/**
 * THE long-form es-AR day label every as-of surface renders: "7 de mayo de 2026".
 *
 * UTC-pinned by design — the whole scrub axis is UTC day markers
 * (parseAsOfFromParams → UTC midnight, buildScrubWindow → UTC-floored steps), so
 * any formatter that renders an as-of instant in America/Argentina/Buenos_Aires
 * shows the PREVIOUS calendar day (T2.4 off-by-one: URL ?asOf=2026-05-08, dock
 * "08 may", context bar "al 7 de mayo"). One formatter, one shape, one clock:
 * the dock headline, the context bar (buildViewMeta), the PNG/informe footer
 * (panorama-export) and the pinned-popup cutoff all read this function.
 * `formatAsOfLabel` above keeps the compact shape for axis ticks only.
 */
export function formatAsOfDayLong(date: Date): string {
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}
