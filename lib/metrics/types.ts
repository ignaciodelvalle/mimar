// Shared types for the lib/metrics/ projection foundation (Pattern B).
//
// The branded SuppressedCells type makes it impossible to return locality-grouped
// data without passing it through suppressSmallCells first — enforcement happens at
// compile-time, not by convention or test coverage alone.

/** A single aggregated cell: one grouping key + a count + optional extras. */
export type Cell = { key: string; count: number; [k: string]: unknown };

// Unique brand symbol — only constructible inside this module / suppressSmallCells.
declare const SUPPRESSED: unique symbol;

/**
 * A Cell[] that has been validated by suppressSmallCells.
 * A raw Cell[] is NOT assignable to SuppressedCells.
 * Consumers that return locality-grouped data MUST use MetricResult<SuppressedCells>.
 */
export type SuppressedCells = readonly Cell[] & { readonly [SUPPRESSED]: true };

/**
 * The required return shape for any locality-grouped projection fetcher.
 * `value` can only be SuppressedCells (built by suppressSmallCells) or a
 * scalar aggregate (for non-locality-grouped fetchers, use the scalar directly).
 */
export type MetricResult<T> = {
  value: T;
  suppressedCount: number;
};
