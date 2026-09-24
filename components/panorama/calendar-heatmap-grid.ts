// Pure grid math for the CalendarHeatmap (viz-suite Wave 1, item 1).
//
// Turns a window [since, until] plus per-DAY scope-total counts into a
// GitHub-style grid: columns are ISO weeks, rows are weekdays. It is the
// non-React, non-DOM twin of signal-histogram.ts — kept pure so the window→cells
// math (leading/trailing ABSENT days vs in-window ZERO days, intensity bucketing,
// month-label placement) is unit-testable without a render.
//
// CALENDAR-DATE DISCIPLINE (no timezone drift): a "YYYY-MM-DD" here is a pure
// calendar date, never an instant. We both CONSTRUCT (Date.UTC) and READ
// (getUTC*) in UTC, so the day/month/weekday components equal the parsed digits
// with no ambient-zone shift — the same reason lib/utils/format.ts anchors date
// inputs at noon UTC. No toLocale*/Intl call lives here (those pin AR_TIME_ZONE
// in the component's display layer); this file is arithmetic only.

const DAY_MS = 86_400_000;

/** es-AR month abbreviations for the horizontal axis labels (index 0 = enero). */
export const MONTHS_SHORT_ES = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sep",
  "oct",
  "nov",
  "dic",
] as const;

/** es-AR full month names for per-cell aria-labels ("7 de julio: N eventos"). */
export const MONTHS_LONG_ES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const;

/** Weekday initials, Monday-first (es-AR standard week). L M M J V S D. */
export const WEEKDAY_INITIALS_MON = ["L", "M", "M", "J", "V", "S", "D"] as const;
/** Weekday initials, Sunday-first. D L M M J V S. */
export const WEEKDAY_INITIALS_SUN = ["D", "L", "M", "M", "J", "V", "S"] as const;

export type DailyCount = { date: string; count: number };

/** A single rendered day. `level` is the sequential-intensity bucket (0 = zero). */
export type CalendarCell = {
  /** "YYYY-MM-DD". */
  date: string;
  count: number;
  /** 0 = no events, 1–4 = ascending intensity relative to the window max. */
  level: 0 | 1 | 2 | 3 | 4;
  /** Day-of-month (1–31), for the aria-label — precomputed to avoid re-parsing. */
  dayOfMonth: number;
  /** Month index (0–11), for the aria-label + axis labels. */
  monthIndex: number;
};

/** One week column. `cells[r]` is null for days OUTSIDE the window (ABSENT, blank). */
export type CalendarColumn = {
  /** Exactly 7 slots, indexed by weekday row (0 = week start). null = absent. */
  cells: (CalendarCell | null)[];
  /** es-AR short month label shown above this column, or null. */
  monthLabel: string | null;
};

export type CalendarGrid = {
  columns: CalendarColumn[];
  /** 7 weekday initials aligned to the row order (respects weekStartsOn). */
  weekdayLabels: readonly string[];
  weekStartsOn: 0 | 1;
  /** Max daily count across in-window days — the intensity scale's top. */
  max: number;
  /** Sum of all in-window counts (drives the empty/methodNote honesty). */
  total: number;
  /** Number of in-window days rendered (absent padding excluded). */
  dayCount: number;
};

/** Parse a strict "YYYY-MM-DD" into a UTC-midnight epoch, or null if malformed. */
function parseDayUTC(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  // Reject overflow dates (2026-02-30 → March) by round-tripping the components.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return t;
}

/** Format a UTC epoch back to "YYYY-MM-DD". */
function dayKeyUTC(t: number): string {
  const d = new Date(t);
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${mo}-${da}`;
}

/** Weekday row index (0 = week start) for a UTC epoch. */
function weekdayIndex(t: number, weekStartsOn: 0 | 1): number {
  const dow = new Date(t).getUTCDay(); // 0 = Sunday … 6 = Saturday
  return weekStartsOn === 1 ? (dow + 6) % 7 : dow;
}

/**
 * Map a count to a sequential intensity bucket 0–4 relative to the window max.
 * Monotonic non-decreasing in `count`: 0 → 0, and `count === max` → 4. Quartile
 * thresholds on the [1, max] range give the classic GitHub 5-step ramp.
 */
export function intensityLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || max <= 0) return 0;
  const r = count / max;
  if (r <= 0.25) return 1;
  if (r <= 0.5) return 2;
  if (r <= 0.75) return 3;
  return 4;
}

/**
 * Cap a heatmap window to the most recent `maxMonths` calendar months.
 *
 * The panorama's default period can span multiple years; rendering every ISO
 * week then makes the day-cell grid unreadably wide. PO decision (2026-07-14):
 * when the window exceeds `maxMonths`, clamp the START forward to `until` minus
 * `maxMonths` calendar months and flag it (`capped`) so the UI can note the
 * truncation. A window at or under the cap (or a malformed/inverted one) is
 * returned unchanged with `capped: false`.
 *
 * Boundary: a window spanning EXACTLY `maxMonths` (since === cutoff) is NOT
 * capped — only a strictly longer window (since < cutoff) is.
 */
export function clampSinceToRecentMonths(
  since: string,
  until: string,
  maxMonths: number,
): { since: string; capped: boolean } {
  const startT = parseDayUTC(since);
  const endT = parseDayUTC(until);
  if (startT === null || endT === null || startT > endT || maxMonths <= 0) {
    return { since, capped: false };
  }
  const end = new Date(endT);
  // Same day-of-month, `maxMonths` earlier (JS Date rolls negative months into
  // the prior year); UTC throughout, matching the module's calendar-date rule.
  const cutoffT = Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - maxMonths, end.getUTCDate());
  if (startT < cutoffT) {
    return { since: dayKeyUTC(cutoffT), capped: true };
  }
  return { since, capped: false };
}

/**
 * Build the week-column grid spanning [since, until] inclusive.
 *
 * Contract:
 *  - Days INSIDE the window with no matching count render as ZERO (level 0),
 *    NOT absent — a real "nada ese día" reading.
 *  - Grid positions OUTSIDE the window (the ragged first/last week) are ABSENT
 *    (null cells) so the caller renders them blank, never as zero.
 *  - Intensity is derived from the window's own max (relative, not absolute).
 *  - A malformed or inverted window (since > until) yields an empty grid.
 */
export function buildCalendarGrid(params: {
  since: string;
  until: string;
  counts: ReadonlyArray<DailyCount>;
  /** 0 = Sunday-first, 1 = Monday-first (default, es-AR). */
  weekStartsOn?: 0 | 1;
}): CalendarGrid {
  const { since, until, counts, weekStartsOn = 1 } = params;
  const weekdayLabels = weekStartsOn === 1 ? WEEKDAY_INITIALS_MON : WEEKDAY_INITIALS_SUN;

  const startT = parseDayUTC(since);
  const endT = parseDayUTC(until);
  if (startT === null || endT === null || startT > endT) {
    return { columns: [], weekdayLabels, weekStartsOn, max: 0, total: 0, dayCount: 0 };
  }

  // Fold the (possibly per-layer-merged) counts into one lookup by day.
  const countByDay = new Map<string, number>();
  for (const c of counts) {
    if (c && typeof c.date === "string" && Number.isFinite(c.count)) {
      countByDay.set(c.date, (countByDay.get(c.date) ?? 0) + c.count);
    }
  }

  const columns: CalendarColumn[] = [];
  let current: (CalendarCell | null)[] = [];
  let max = 0;
  let total = 0;
  let dayCount = 0;

  // Leading absent slots: the first week's days before the window start.
  const firstWi = weekdayIndex(startT, weekStartsOn);
  for (let r = 0; r < firstWi; r++) current.push(null);

  for (let t = startT; t <= endT; t += DAY_MS) {
    // A new week begins at row 0 (only once at least one slot is filled — the
    // leading pad guarantees the very first day is never a spurious flush).
    if (weekdayIndex(t, weekStartsOn) === 0 && current.length > 0) {
      columns.push({ cells: current, monthLabel: null });
      current = [];
    }
    const key = dayKeyUTC(t);
    const count = countByDay.get(key) ?? 0;
    const dt = new Date(t);
    dayCount += 1;
    total += count;
    if (count > max) max = count;
    current.push({
      date: key,
      count,
      level: 0, // assigned in the second pass once `max` is known
      dayOfMonth: dt.getUTCDate(),
      monthIndex: dt.getUTCMonth(),
    });
  }
  if (current.length > 0) {
    // Trailing absent slots pad the final week to 7.
    while (current.length < 7) current.push(null);
    columns.push({ cells: current, monthLabel: null });
  }

  // Second pass: intensity is relative to the window max.
  if (max > 0) {
    for (const col of columns) {
      for (const cell of col.cells) {
        if (cell) cell.level = intensityLevel(cell.count, max);
      }
    }
  }

  // Month labels: mark the column where each month first appears (its earliest
  // in-window day), matching the GitHub axis where a label sits at the month's
  // starting week.
  let prevMonth = -1;
  for (const col of columns) {
    const rep = col.cells.find((c): c is CalendarCell => c !== null);
    if (rep && rep.monthIndex !== prevMonth) {
      col.monthLabel = MONTHS_SHORT_ES[rep.monthIndex];
      prevMonth = rep.monthIndex;
    }
  }

  return { columns, weekdayLabels, weekStartsOn, max, total, dayCount };
}

/** Pluralized es-AR "N evento(s)" for aria-labels and tooltips. */
export function eventosLabel(count: number): string {
  return `${count} ${count === 1 ? "evento" : "eventos"}`;
}

/** Per-cell accessible name: "7 de julio: 3 eventos". */
export function cellAriaLabel(cell: CalendarCell): string {
  return `${cell.dayOfMonth} de ${MONTHS_LONG_ES[cell.monthIndex]}: ${eventosLabel(cell.count)}`;
}
