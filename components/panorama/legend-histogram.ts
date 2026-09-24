// Pure helper for the in-legend value distribution (#5).
//
// A coverage choropleth on the FIXED [0,100] divergent axis (anchored at the
// compliance meta) is honest about comparability but hides WHERE the data
// actually falls: with real rabies-coverage values living ~34–65 against an 80%
// meta, every province lands below the neutral midpoint and the map reads flat,
// while the whole above-meta (teal) half is empty. A tiny histogram of the actual
// province values, drawn UNDER the gradient on the same axis, restores the missing
// signal — the reader sees the spread and the empty region, not just the endpoints.
//
// Kept pure (no React, no maplibre) so the bucketing is unit-testable.

/** One histogram bucket over the value axis. */
export type HistogramBin = { lo: number; hi: number; count: number };

/**
 * Bucket `values` into `binCount` equal-width bins spanning [domainMin, domainMax].
 * Values outside the domain are clamped into the edge bins (never dropped), so the
 * counts always sum to values.length. Returns an empty array for a degenerate
 * domain (min ≥ max) or a non-positive binCount.
 */
export function valueHistogram(
  values: readonly number[],
  domainMin: number,
  domainMax: number,
  binCount = 12,
): HistogramBin[] {
  if (binCount <= 0 || !(domainMax > domainMin)) return [];
  const width = (domainMax - domainMin) / binCount;
  const bins: HistogramBin[] = Array.from({ length: binCount }, (_, i) => ({
    lo: domainMin + i * width,
    hi: domainMin + (i + 1) * width,
    count: 0,
  }));
  for (const v of values) {
    if (typeof v !== "number" || Number.isNaN(v)) continue;
    // Clamp into the domain, then locate the bin; the top edge lands in the last bin.
    const clamped = Math.min(domainMax, Math.max(domainMin, v));
    let idx = Math.floor((clamped - domainMin) / width);
    if (idx >= binCount) idx = binCount - 1;
    if (idx < 0) idx = 0;
    bins[idx].count += 1;
  }
  return bins;
}

/** The largest bucket count (for normalizing bar heights). 0 for an empty histogram. */
export function histogramPeak(bins: readonly HistogramBin[]): number {
  let peak = 0;
  for (const b of bins) if (b.count > peak) peak = b.count;
  return peak;
}
