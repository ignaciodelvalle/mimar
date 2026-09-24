// Pure bucketing + pivot helpers for time-series (trend) projections.
//
// This module is DB-FREE on purpose: every function here is a pure transform
// over already-fetched rows. The DB-bound trend fetchers (lib/metrics/trends.ts)
// run the GROUP BY in SQL and then hand the raw rows to these helpers for
// bucket-granularity selection, stacked pivoting, and k-anonymity suppression.
//
// Keeping the transforms pure means the bucketing logic (the part with real
// branching: granularity choice, pivot, small-cell suppression) is unit-tested
// without a live Postgres — mirroring how computeDiseaseSummary is a pure rollup
// the fetcher delegates to.

import type { AnalyticsPeriod } from "@/lib/analytics/analytics-period";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The natural temporal bucket for a chart x-axis. */
export type BucketGranularity = "week" | "month";

/**
 * Pick the natural bucket granularity for a reporting window.
 *
 * Short/medium windows (≤ ~120 days) read best as ISO weeks; anything longer
 * (the 12-month default, YTD past spring, custom multi-month ranges) is bucketed
 * by calendar month so the x-axis stays legible (no 50+ week ticks).
 *
 * The 120-day cutoff keeps the 7d / 30d / 90d presets on weeks and the 12m
 * default on months. Exported so the fetcher can pass the matching
 * date_trunc() unit to SQL.
 */
export function bucketGranularityFor(period: AnalyticsPeriod): BucketGranularity {
  const spanDays = (period.until.getTime() - period.since.getTime()) / DAY_MS;
  return spanDays <= 120 ? "week" : "month";
}

/** The Postgres date_trunc() unit string for a granularity. */
export function dateTruncUnit(granularity: BucketGranularity): "week" | "month" {
  return granularity;
}

/**
 * A single bucketed, keyed cell: one period bucket + one series key + a count.
 * `bucketStart` is the ISO date of the period start (sort key, never displayed).
 * `bucketLabel` is the pre-formatted es-AR x-axis label.
 */
export type SeriesBucketRow = {
  /** ISO date of the bucket start (sort key). */
  bucketStart: string;
  /** Pre-formatted es-AR x-axis label, e.g. "2026-W03" or "ene." */
  bucketLabel: string;
  /** The series this count belongs to (e.g. a death cause, a disease code). */
  seriesKey: string;
  /** Count for (bucket, series). */
  count: number;
};

/** One row of a stacked chart: a period bucket + a value per series. */
export type StackedPoint = {
  /** x-axis label (es-AR, pre-formatted). */
  x: string;
  /** One numeric value per series key. Missing series default to 0. */
  values: Record<string, number>;
  /**
   * SUPPRESSED ≠ ZERO, per (bucket, series) CELL.
   *
   * `suppressSmallStackedCells` masks a 1..k-1 cell to `values[key] = 0` and
   * used to return only an AGGREGATE `suppressedCount` — so the individual cell
   * was structurally indistinguishable from a measured zero the moment it left
   * this module. `/gob/mortalidad`'s "Ver datos" fallback table then printed a
   * plain `0` for a month that really had 1..4 rabies deaths, under a card
   * header that simultaneously disclosed "N celdas ocultas (privacidad)": two
   * renderings of one fact, one of them a false epidemiological claim.
   *
   * This is the per-cell twin of the flag `suppressSmallBuckets` already puts on
   * single-series points (see `SingleSeriesTrend` in ./trends.ts), and it exists
   * for the same reason: the aggregate count tells a reader that SOMETHING was
   * hidden, never WHICH cell, so no renderer could tell a masked cell from a
   * real one.
   *
   * Keyed by series key; only masked keys are present. Absent (the common case)
   * means nothing in this bucket was masked. The numeric `values` stay 0 on
   * purpose — every existing numeric consumer keeps working unchanged, and the
   * flag is what lets an honest renderer say "oculto (privacidad)" instead.
   */
  suppressed?: Record<string, true>;
};

/** The shape a stacked time-series chart consumes. */
export type StackedSeries = {
  /** Ordered series keys (raw, not display labels) — define the stack order. */
  seriesKeys: string[];
  /** Chronologically ordered points, one per period bucket. */
  points: StackedPoint[];
};

/**
 * Pivot long-format (bucket × series) rows into a stacked-chart shape.
 *
 * - Buckets are emitted in chronological order (by bucketStart).
 * - Series keys are ordered by total descending (largest band at the bottom of
 *   the stack), so the dominant cause/disease reads first.
 * - Every point carries a value for EVERY series key (0-filled) so the stacked
 *   area chart has no gaps.
 */
export function pivotStackedSeries(rows: SeriesBucketRow[]): StackedSeries {
  if (rows.length === 0) return { seriesKeys: [], points: [] };

  // Aggregate per-series totals (for ordering) and per-bucket maps.
  const seriesTotals = new Map<string, number>();
  const buckets = new Map<string, { start: string; label: string; values: Map<string, number> }>();

  for (const r of rows) {
    seriesTotals.set(r.seriesKey, (seriesTotals.get(r.seriesKey) ?? 0) + r.count);
    const b = buckets.get(r.bucketStart) ?? {
      start: r.bucketStart,
      label: r.bucketLabel,
      values: new Map<string, number>(),
    };
    b.values.set(r.seriesKey, (b.values.get(r.seriesKey) ?? 0) + r.count);
    buckets.set(r.bucketStart, b);
  }

  const seriesKeys = [...seriesTotals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k]) => k);

  const points: StackedPoint[] = [...buckets.values()]
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((b) => {
      const values: Record<string, number> = {};
      for (const key of seriesKeys) values[key] = b.values.get(key) ?? 0;
      return { x: b.label, values };
    });

  return { seriesKeys, points };
}

// ---------------------------------------------------------------------------
// Zero-fill (dataviz review 2026-07-23, finding #2)
//
// The SQL GROUP BY drops buckets with zero events, so a quiet week/month
// simply produced NO row — and the categorical x-axis then glued "feb." to
// "jun." as adjacent ticks. That erased quiet periods (the most decision-
// relevant surveillance signal), silently desynced sparkline point counts
// between tiles sharing a window, and made the forecast regression (which
// fits by INDEX) run over compressed time, corrupting "alcanza la meta en
// ~N períodos". These helpers restore the complete bucket axis.
// ---------------------------------------------------------------------------

/**
 * Every bucket start (UTC) the window [since, until] spans at a granularity —
 * the same starts Postgres date_trunc(unit) would emit for events in range:
 * calendar-month firsts, or ISO-week Mondays.
 */
export function enumerateBucketStarts(
  period: AnalyticsPeriod,
  granularity: BucketGranularity,
): Date[] {
  const starts: Date[] = [];
  const until = period.until.getTime();
  if (granularity === "month") {
    let d = new Date(Date.UTC(period.since.getUTCFullYear(), period.since.getUTCMonth(), 1));
    while (d.getTime() <= until) {
      starts.push(d);
      d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    }
  } else {
    const dow = period.since.getUTCDay() || 7; // Sun=0 → 7 (ISO)
    let d = new Date(
      Date.UTC(
        period.since.getUTCFullYear(),
        period.since.getUTCMonth(),
        period.since.getUTCDate() - (dow - 1),
      ),
    );
    while (d.getTime() <= until) {
      starts.push(d);
      d = new Date(d.getTime() + 7 * DAY_MS);
    }
  }
  return starts;
}

/** A labeled single-series bucket before the sort key is stripped. */
export type LabeledBucket = { start: string; x: string; y: number };

/** Exclusive end of the bucket that starts at `start`. */
function bucketEndMs(start: Date, granularity: BucketGranularity): number {
  return granularity === "month"
    ? Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)
    : start.getTime() + 7 * DAY_MS;
}

/**
 * Insert an explicit y=0 bucket for every enumerated bucket the SQL rows
 * skipped, matching by label (labels are unique per bucket: ISO weeks carry
 * the year; months carry a 2-digit year). One honesty exception: a TRAILING
 * bucket the window only partially covers is NOT fabricated when it has no
 * row — a zero there would paint a fake terminal collapse for a period that
 * simply hasn't finished (the "dives to 0 at jul 26" artifact). Real rows in
 * a partial bucket still pass through untouched. Unmatched SQL rows (never
 * expected; a TZ-drift safety) are merged back in chronological order.
 */
export function zeroFillLabeledBuckets(
  labeled: LabeledBucket[],
  period: AnalyticsPeriod,
  granularity: BucketGranularity,
): LabeledBucket[] {
  const byLabel = new Map(labeled.map((p) => [p.x, p]));
  const filled: LabeledBucket[] = [];
  for (const start of enumerateBucketStarts(period, granularity)) {
    const label = formatBucketLabel(start, granularity);
    const existing = byLabel.get(label);
    if (existing) {
      filled.push(existing);
      byLabel.delete(label);
      continue;
    }
    if (bucketEndMs(start, granularity) > period.until.getTime()) continue;
    filled.push({ start: start.toISOString(), x: label, y: 0 });
  }
  for (const leftover of byLabel.values()) filled.push(leftover);
  return filled.sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * Stacked variant: insert an all-zero point for every enumerated bucket the
 * pivoted series skipped (same label matching + trailing-partial exception).
 * A rowless result stays empty — filling zero-months under ZERO series would
 * draw bare axes with nothing to decode (the in-chart empty state's job).
 */
export function zeroFillStackedPoints(
  series: StackedSeries,
  period: AnalyticsPeriod,
  granularity: BucketGranularity,
): StackedSeries {
  if (series.seriesKeys.length === 0) return series;
  const byLabel = new Map(series.points.map((p) => [p.x, p]));
  const zeroValues = () => Object.fromEntries(series.seriesKeys.map((k) => [k, 0]));
  const filled: Array<{ start: string; point: StackedPoint }> = [];
  for (const start of enumerateBucketStarts(period, granularity)) {
    const label = formatBucketLabel(start, granularity);
    const existing = byLabel.get(label);
    if (existing) {
      filled.push({ start: start.toISOString(), point: existing });
      byLabel.delete(label);
      continue;
    }
    if (bucketEndMs(start, granularity) > period.until.getTime()) continue;
    filled.push({ start: start.toISOString(), point: { x: label, values: zeroValues() } });
  }
  // TZ-drift safety: unmatched pivoted points keep their original order slot.
  let merged = filled.sort((a, b) => a.start.localeCompare(b.start)).map((f) => f.point);
  if (byLabel.size > 0) {
    const leftovers = new Set(byLabel.values());
    merged = series.points.filter((p) => leftovers.has(p)).concat(merged);
  }
  return { seriesKeys: series.seriesKeys, points: merged };
}

/**
 * Real calendar label for the h-th FORECAST bucket after the last actual
 * (axis-format unification, visual review 2026-07-23 #13: projection ticks
 * rendered literally "+1, +2, +3"). Anchored on `actualCount` — the number of
 * points the zero-filled series actually plots — so when the trailing partial
 * bucket was skipped, +1 correctly names IT, not the bucket after it. Falls
 * back to the old relative label if the window enumerates nothing.
 */
export function futureBucketLabel(
  period: AnalyticsPeriod,
  granularity: BucketGranularity,
  actualCount: number,
  h: number,
): string {
  const starts = enumerateBucketStarts(period, granularity);
  const base = starts[Math.min(Math.max(actualCount, 1), starts.length) - 1];
  if (!base) return `+${h}`;
  const future =
    granularity === "month"
      ? new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + h, 1))
      : new Date(base.getTime() + h * 7 * DAY_MS);
  return formatBucketLabel(future, granularity);
}

/**
 * k-anonymity for a single-series trend.
 *
 * Per-bucket counts below `k` are noise that can re-identify a small cohort
 * (e.g. "1 bite in this barrio this week"). They are suppressed to 0 in the
 * returned series and counted in `suppressedCount` so the UI can disclose
 * "N períodos ocultos (privacidad)".
 *
 * NOTE: 0-counts are NOT suppressed (a genuine zero is a true, non-identifying
 * signal — the operator needs to see the dip). Only 1..k-1 are masked.
 */
export function suppressSmallBuckets(
  points: Array<{ x: string; y: number }>,
  k = 5,
): { points: Array<{ x: string; y: number; suppressed?: true }>; suppressedCount: number } {
  let suppressedCount = 0;
  const masked = points.map((p) => {
    if (p.y > 0 && p.y < k) {
      suppressedCount += 1;
      // suppressed≠zero (dataviz review 2026-07-23 #6): the masked value stays
      // 0 (backward-compatible with every numeric consumer — sparklines,
      // deltas), but the flag lets honest renderers distinguish "privacy-
      // masked" from a true zero: TimeSeriesChart draws a GAP instead of a
      // fake dip, and projectSeries excludes the point from its fit (a masked
      // 1..k-1 rendered as 0 biased the regression downward).
      return { x: p.x, y: 0, suppressed: true as const };
    }
    return p;
  });
  return { points: masked, suppressedCount };
}

/**
 * k-anonymity for a stacked (multi-series) trend.
 *
 * Each (bucket, series) cell with a small non-zero count is masked to 0 and
 * tallied. Same rule as the single-series variant, applied per cell.
 *
 * Each masked cell is ALSO flagged on its point's `suppressed` map — see the
 * `StackedPoint.suppressed` docblock for why the aggregate count alone was not
 * enough. `values[key]` deliberately stays 0 (numeric consumers unchanged); the
 * flag is the channel a renderer uses to write "oculto (privacidad)" instead of
 * publishing a zero nobody measured.
 *
 * 0-counts are never masked here either — a genuine zero is a non-identifying
 * signal the operator needs.
 */
export function suppressSmallStackedCells(
  series: StackedSeries,
  k = 5,
): { series: StackedSeries; suppressedCount: number } {
  let suppressedCount = 0;
  const points = series.points.map((p) => {
    const values: Record<string, number> = {};
    let suppressed: Record<string, true> | undefined;
    for (const key of series.seriesKeys) {
      const v = p.values[key] ?? 0;
      if (v > 0 && v < k) {
        suppressedCount += 1;
        values[key] = 0;
        // Built lazily so an unmasked bucket carries no empty object — the
        // renderers below branch on `p.suppressed?.[key]`, and an always-present
        // `{}` would read as "this point participates in suppression" to anyone
        // debugging the payload.
        suppressed ??= {};
        suppressed[key] = true;
      } else {
        values[key] = v;
      }
    }
    return suppressed ? { x: p.x, values, suppressed } : { x: p.x, values };
  });
  return { series: { seriesKeys: series.seriesKeys, points }, suppressedCount };
}

/**
 * Format a bucket-start Date into an es-AR x-axis label for the given granularity.
 *  - week  → ISO week label "IYYY-Www" (stable, sortable, locale-neutral).
 *  - month → "ene 26", "feb 26" … (es-AR short month + 2-digit year: month
 *    granularity only kicks in on >120-day windows, which span calendar years,
 *    so a bare "jul." appears twice on a trailing-12m axis and the operator
 *    cannot tell which year a spike belongs to — dataviz review 2026-07-23;
 *    mirrors the ISO-week label's year-carrying design).
 */
export function formatBucketLabel(start: Date, granularity: BucketGranularity): string {
  if (granularity === "month") {
    // Render in UTC: the bucket start is a UTC instant from date_trunc; using the
    // host TZ could roll a month-start (00:00 UTC) back into the prior month.
    return start.toLocaleString("es-AR", { month: "short", year: "2-digit", timeZone: "UTC" });
  }
  return isoWeekLabel(start);
}

/** "IYYY-Www" ISO-week label for a date (e.g. 2026-W03). */
export function isoWeekLabel(d: Date): string {
  // Copy and shift to the Thursday of the ISO week (ISO weeks belong to the
  // year of their Thursday). Work in UTC to avoid TZ drift.
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7; // Sun=0 → 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}
