// Unified period helpers for Pattern-B dashboard fetchers.
//
// Re-exports resolveAnalyticsPeriod so callers import from one place, and
// defines named trailing-window constants so no fetcher writes `365 * DAY_MS`
// as a magic number.
//
// IMPORTANT: these are REPORTING windows (time on the x-axis of a chart or
// the denominator of a coverage rate). Clinical windows — such as the 10-day
// rabies-observation legal period (Ord. CABA 41.831) — are NOT here; they live
// as domain constants alongside the rules that use them.

export { resolveAnalyticsPeriod } from "@/lib/analytics/analytics-period";
export type { AnalyticsPeriod, PeriodSearchParams } from "@/lib/analytics/analytics-period";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Convenience factory: named trailing windows as {since, until} objects. */
function trailingWindow(days: number): { since: Date; until: Date } {
  const now = Date.now();
  return { since: new Date(now - days * DAY_MS), until: new Date(now) };
}

/** Default reporting window: trailing 12 months. */
export const TRAILING_12M = trailingWindow(365);

/** Trailing 30 days — standard "current month" KPI window. */
export const TRAILING_30D = trailingWindow(30);

/** Trailing 7 days — "this week" KPI window. */
export const TRAILING_7D = trailingWindow(7);

/** Trailing 24 hours — "today" KPI window. */
export const TRAILING_24H = trailingWindow(1);

/**
 * Named trailing windows as lazy factories (called at request time, not module
 * load time) so the date is always accurate.
 */
export const windows = {
  /** Trailing 12 months from now. */
  trailing12m: () => trailingWindow(365),
  /** Trailing 30 days from now. */
  trailing30d: () => trailingWindow(30),
  /** Trailing 60 days from now (prior-30d comparison window). */
  trailing60d: () => trailingWindow(60),
  /** Trailing 7 days from now. */
  trailing7d: () => trailingWindow(7),
  /** Trailing 14 days from now (prior-7d comparison window). */
  trailing14d: () => trailingWindow(14),
  /** Trailing 24 months from now (prior-12m comparison window). */
  trailing24m: () => trailingWindow(730),
} as const;
