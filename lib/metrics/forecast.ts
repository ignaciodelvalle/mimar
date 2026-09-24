// lib/metrics/forecast.ts — Pure trend projection (forecast) for flow series.
//
// WHY THIS EXISTS
// ---------------
// The gob/admin dashboards already render historical FLOW series (event counts
// per bucket) via lib/metrics/trends.ts + the chart primitives. What they did
// NOT answer is the executive question: "at the current rate, do we cross the
// target, and roughly when?". This module adds a simple FORWARD PROJECTION over
// those same buckets — a confidence band + an estimated target-crossing.
//
// THIS IS NOT ML. It is ordinary least-squares (OLS) linear regression over the
// bucket index (Paquete J §J-D1 default = "linear"). An optional Holt linear
// double-exponential smoothing is exposed for series with a stronger local
// trend. The intent is an HONEST directional read, not econometric rigor:
//   - the confidence band comes from the regression residual standard error and
//     WIDENS with the forecast horizon (further out ⇒ less certain), and
//   - everything is labelled "proyección" downstream so nobody mistakes the
//     dashed band for a guarantee.
//
// PURITY & ROBUSTNESS (no DB, no Next.js runtime — unit-testable in isolation)
//   - Input is the already-bucketed, k-anonymised {x,y}[] from a SingleSeriesTrend.
//   - k-anonymity gaps: lib/metrics/timeseries.ts suppresses small per-bucket
//     cells to y=0. A genuine zero is a real signal, but a SUPPRESSED zero is a
//     hole. We CANNOT distinguish them from the points alone, so callers should
//     pass the raw suppressed series; we treat every provided point as observed.
//     We deliberately DO NOT invent or interpolate signal for missing buckets —
//     the regression simply fits the points it is given, in order, by index.
//   - < MIN_POINTS (default 4): too few points to fit a trustworthy line →
//     `insufficient: true`, and we return ONLY the actuals (no forecast band).
//     The UI then shows "datos insuficientes para proyectar" instead of an
//     invented straight line.
//   - Flat series: slope ≈ 0, narrow band; targetCrossing returns null when the
//     series is already on the requested side of the target.
//
// The DB-bound fetchers (trends.ts) produce the series; this module is the pure
// transform they delegate to — mirroring the timeseries.ts / trends.ts split.

/** A raw observed point from a SingleSeriesTrend. */
export type SeriesPoint = {
  x: string;
  y: number;
  /** k-anon-masked bucket (timeseries.ts suppressSmallBuckets): the real value
   *  is 1..k-1 rendered as 0 — EXCLUDED from the regression fit so the mask
   *  doesn't bias the projection downward (dataviz review 2026-07-23 #6). */
  suppressed?: true;
};

/** Minimum observed points required to fit a projection. Below this we abstain. */
export const MIN_POINTS = 4;

/** Default forecast horizon (buckets ahead) — Paquete J §J-D2. */
export const DEFAULT_HORIZON = 3;

/** Supported projection methods — Paquete J §J-D1. */
export type ForecastMethod = "linear" | "holt";

export type ForecastOpts = {
  /** Buckets to project into the future. Default DEFAULT_HORIZON (3). */
  horizon?: number;
  /** Projection method. Default "linear" (OLS). */
  method?: ForecastMethod;
  /**
   * Real calendar label for the h-th projected bucket (see timeseries.ts's
   * futureBucketLabel) — the caller knows the period/granularity this module
   * deliberately doesn't. Absent → the legacy relative "+1", "+2" labels.
   */
  labelForecast?: (h: number) => string;
};

/**
 * One point on the forecast chart.
 *  - kind "actual"   → an observed bucket (lo = hi = y, no band).
 *  - kind "forecast" → a projected bucket (lo/hi describe the confidence band).
 */
export type ForecastPoint = {
  x: string;
  y: number;
  lo: number;
  hi: number;
  kind: "actual" | "forecast";
};

export type ForecastResult = {
  /** Actuals (kind:"actual") followed by projected buckets (kind:"forecast"). */
  points: ForecastPoint[];
  /** The method actually used to produce the projection. */
  method: ForecastMethod;
  /** Estimated trend, in series units per bucket (0 when insufficient). */
  slopePerBucket: number;
  /** True when there were fewer than MIN_POINTS observations → no forecast. */
  insufficient: boolean;
};

/** Direction of a target relative to the series for crossing detection. */
export type CrossingDirection = "above" | "below";

// ---------------------------------------------------------------------------
// Internal: ordinary least-squares fit over the integer bucket index.
// ---------------------------------------------------------------------------

type Fit = {
  /** Intercept (value at index 0). */
  intercept: number;
  /** Slope (units per bucket). */
  slope: number;
  /** Residual standard error of the fit (σ of residuals, n-2 dof). */
  residualSe: number;
  /** Mean of the x (index) values, for the prediction-interval widening term. */
  meanIndex: number;
  /** Σ(x − meanIndex)² — the spread of the index, for the widening term. */
  ssx: number;
  /** Number of observations. */
  n: number;
};

/**
 * Fit y = intercept + slope·index by least squares. `atIndices` defaults to
 * 0..n-1; passing explicit indices lets the caller EXCLUDE k-anon-suppressed
 * buckets from the fit while keeping the surviving observations on the real
 * time axis (the indices stay absolute, so gaps don't compress time).
 * Returns a residual standard error so callers can build a widening band.
 */
function olsFit(ys: number[], atIndices?: number[]): Fit {
  const n = ys.length;
  const indices = atIndices ?? ys.map((_, i) => i);
  const meanIndex = indices.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let sxy = 0;
  let ssx = 0;
  for (let i = 0; i < n; i++) {
    const dx = indices[i] - meanIndex;
    sxy += dx * (ys[i] - meanY);
    ssx += dx * dx;
  }

  // ssx === 0 only when n < 2 (single point) — guarded by MIN_POINTS upstream,
  // but keep the divide safe regardless.
  const slope = ssx > 0 ? sxy / ssx : 0;
  const intercept = meanY - slope * meanIndex;

  // Residual standard error with n-2 degrees of freedom (simple regression).
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const predicted = intercept + slope * indices[i];
    const r = ys[i] - predicted;
    sse += r * r;
  }
  const dof = Math.max(1, n - 2);
  const residualSe = Math.sqrt(sse / dof);

  return { intercept, slope, residualSe, meanIndex, ssx, n };
}

/**
 * Holt's linear (double-exponential) smoothing. Produces a level + trend that
 * adapt to the most recent buckets, then extrapolates level + h·trend. The band
 * here reuses the OLS residual standard error as a pragmatic spread estimate —
 * Holt has no closed-form interval and we explicitly do not claim econometric
 * rigor (see file header).
 */
function holtForecast(
  ys: number[],
  horizon: number,
  residualSe: number,
): { fitted: number[]; project: (h: number) => number; slope: number } {
  // Smoothing constants: moderate level + trend responsiveness. Fixed in v1.
  const alpha = 0.5;
  const beta = 0.3;

  let level = ys[0];
  let trend = ys[1] - ys[0];
  const fitted: number[] = [ys[0]];

  for (let i = 1; i < ys.length; i++) {
    const prevLevel = level;
    level = alpha * ys[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
    fitted.push(level);
  }

  const project = (h: number) => level + h * trend;
  void horizon;
  void residualSe;
  return { fitted, project, slope: trend };
}

// ---------------------------------------------------------------------------
// projectSeries — the public projection entry point.
// ---------------------------------------------------------------------------

/**
 * Project a flow series forward and return actuals + a forecast band.
 *
 * @param points - The observed {x,y}[] (already bucketed + k-anonymised).
 * @param opts   - horizon (default 3) and method (default "linear").
 */
export function projectSeries(points: SeriesPoint[], opts: ForecastOpts = {}): ForecastResult {
  const horizon = Math.max(0, Math.trunc(opts.horizon ?? DEFAULT_HORIZON));
  const method: ForecastMethod = opts.method ?? "linear";

  const actuals: ForecastPoint[] = points.map((p) => ({
    x: p.x,
    y: p.y,
    lo: p.y,
    hi: p.y,
    kind: "actual" as const,
  }));

  // The fit runs over NON-suppressed observations only, at their ABSOLUTE
  // indices (see SeriesPoint.suppressed): a masked 1..k-1 bucket fed to the
  // regression as 0 dragged the slope down, and excluding it by index (rather
  // than filtering the array) keeps the time axis uncompressed.
  const fitObs = points
    .map((p, i) => ({ i, y: p.y, suppressed: p.suppressed === true }))
    .filter((o) => !o.suppressed);

  // Too few FITTABLE points OR a zero horizon → abstain: return actuals only.
  if (fitObs.length < MIN_POINTS || horizon === 0) {
    return {
      points: actuals,
      method,
      slopePerBucket: 0,
      insufficient: fitObs.length < MIN_POINTS,
    };
  }

  const ys = fitObs.map((o) => o.y);
  const fit = olsFit(
    ys,
    fitObs.map((o) => o.i),
  );

  // Predicted value at a future index (n-1 is the last observed bucket —
  // suppressed or not, the horizon extends from the series' real end).
  const lastIndex = points.length - 1;

  let predictAt: (index: number) => number;
  let slopePerBucket: number;

  if (method === "holt") {
    // NOTE: Holt smooths the non-suppressed observations as if contiguous
    // (sequential smoothing has no index concept) — acceptable for the unused
    // v1 method; the default linear path is fully gap-aware.
    const holt = holtForecast(ys, horizon, fit.residualSe);
    predictAt = (index: number) => holt.project(index - lastIndex);
    slopePerBucket = holt.slope;
  } else {
    predictAt = (index: number) => fit.intercept + fit.slope * index;
    slopePerBucket = fit.slope;
  }

  // Confidence band: a prediction-interval-style half-width that WIDENS with
  // horizon. We use the residual SE scaled by the standard prediction-interval
  // factor sqrt(1 + 1/n + (x0 - meanIndex)² / ssx). As x0 moves away from the
  // observed index range, the third term grows, so further buckets get a wider
  // band (interval monotonicity). z≈1.96 ≈ a ~95% band; honest, not exact.
  const z = 1.96;
  const halfWidthAt = (index: number): number => {
    const dx = index - fit.meanIndex;
    const varianceFactor = 1 + 1 / fit.n + (fit.ssx > 0 ? (dx * dx) / fit.ssx : 0);
    return z * fit.residualSe * Math.sqrt(varianceFactor);
  };

  const forecast: ForecastPoint[] = [];
  for (let h = 1; h <= horizon; h++) {
    const index = lastIndex + h;
    const yHat = predictAt(index);
    const hw = halfWidthAt(index);
    forecast.push({
      x: opts.labelForecast ? opts.labelForecast(h) : forecastLabel(points, h),
      // Flow counts cannot go negative — clamp the central line and band floor.
      y: Math.max(0, round1(yHat)),
      lo: Math.max(0, round1(yHat - hw)),
      hi: Math.max(0, round1(yHat + hw)),
      kind: "forecast",
    });
  }

  return {
    points: [...actuals, ...forecast],
    method,
    slopePerBucket: round1(slopePerBucket),
    insufficient: false,
  };
}

/**
 * Estimate how many buckets ahead the projection crosses `target`.
 *
 * Returns the first forecast bucket (1-based, in bucket units) whose central
 * projected value reaches the target on the requested side, or `null` when it
 * does not happen within the horizon (or the result is insufficient).
 *
 * - direction "above": the series is climbing toward a target it is below; we
 *   report when the projection first reaches/exceeds `target`. If the last
 *   actual is already ≥ target, there is nothing to cross → null.
 * - direction "below": the series is falling toward a target it is above; we
 *   report when the projection first reaches/falls below `target`. If already
 *   ≤ target → null.
 */
export function targetCrossing(
  result: ForecastResult,
  target: number,
  direction: CrossingDirection,
): number | null {
  if (result.insufficient) return null;

  const forecastPoints = result.points.filter((p) => p.kind === "forecast");
  if (forecastPoints.length === 0) return null;

  const actuals = result.points.filter((p) => p.kind === "actual");
  const lastActual = actuals.at(-1);
  if (!lastActual) return null;

  // Already on the target side at the last observation → no crossing to report.
  if (direction === "above" && lastActual.y >= target) return null;
  if (direction === "below" && lastActual.y <= target) return null;

  for (let i = 0; i < forecastPoints.length; i++) {
    const y = forecastPoints[i].y;
    if (direction === "above" && y >= target) return i + 1;
    if (direction === "below" && y <= target) return i + 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Round to one decimal — counts stay readable, band edges stay stable. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Label for the h-th forecast bucket. We do not know the calendar math of the
 * underlying granularity here (that lives in timeseries.ts), so we emit a
 * stable, locale-neutral relative label "+1", "+2", … that the chart renders
 * after the last actual. The x-axis already carries the actual period labels;
 * the forecast tail is visually distinguished by the dashed style + band.
 */
function forecastLabel(points: SeriesPoint[], h: number): string {
  void points;
  return `+${h}`;
}
