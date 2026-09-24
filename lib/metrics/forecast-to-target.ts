// lib/metrics/forecast-to-target.ts — FORECAST-A-META: the forecast is a
// PROPERTY of a metric that already has a (current, target) pair, not a new
// screen or a new chart. Given the metric's current value, its target, and
// the trend series the metric's OWN surface already fetches, this module
// answers ONE question in one honest line: "at the current rate, when (if
// ever) does this metric cross its target?"
//
// METHOD — same family as lib/metrics/forecast.ts (projectSeries): ordinary
// least-squares (OLS) linear regression over the trend's bucket index. That
// module answers "render a forecast band chart for a flow series"; this one
// answers "how many months until a RATIO/RATE crosses its scalar target" —
// a different question, same underlying "simple linear projection, not
// econometric rigor" philosophy. Both are extrapolation, not a promise —
// every "months" line is explicitly worded "a este ritmo" (at this pace).
//
// HONESTY GUARDS (in the engine, not the callers — a caller cannot forget
// them because they cannot be reached):
//   - insufficient: fewer than MIN_TREND_POINTS (3) real observations. Too
//     thin to fit a trustworthy line — no forecast, not an invented one.
//   - met: current already on the target side (>= for higher-is-better, <=
//     for lower-is-better). A met target is evidence, not a forecast; `line`
//     is null so no render site can accidentally print a "months to go" on a
//     goal already reached.
//   - receding: the trend is moving AWAY from the target (wrong-direction
//     slope). No ETA is honest here — the number would either be negative or
//     meaningless, so we name the direction instead of faking a horizon.
//   - unreachable: the trend is flat (slope of exactly 0 — no movement to
//     extrapolate) OR moving toward the target so slowly that the naive
//     projection would cross MAX_HORIZON_MONTHS (10 years, Paquete
//     FORECAST-A-META default) — "eventually, technically" is not a useful
//     answer, so it collapses to the same honest non-answer as a flat trend.
//   - months: the only case that prints an ETA, always integer, always
//     prefixed "~" (approximate) — 14.3 months is never shown as anything
//     but "~14 meses".
//
// PURE — no DB, no React, no Next.js runtime. Unit-tested in
// forecast-to-target.test.ts.

/** One observed point on the metric's OWN trend series — {period label, value}. */
export type ForecastTrendPoint = {
  /** Pre-formatted period label (e.g. "Ene 2026") — display-only, not parsed. */
  period: string;
  /** The metric's value at this period, same unit as `current`/`target`. */
  value: number;
};

export type ForecastToTargetInput = {
  /** The metric's current (live) value — may differ slightly from trend's
   *  last point if the trend was fetched for a different instant. */
  current: number;
  /** The metric's target, from lib/metrics/targets.ts (TARGETS.*). */
  target: number;
  /** The metric's OWN historical series, already fetched by the caller's
   *  surface — this module performs zero fetching, zero new queries. */
  trend: ForecastTrendPoint[];
  /**
   * true (default): higher values are better, the metric climbs UP toward
   * `target` from below (coverage/penetration/completion-style ratios).
   * false: lower is better, the metric falls DOWN toward `target` from above
   * (e.g. a return-rate or breach-rate ceiling target).
   */
  higherIsBetter?: boolean;
  /**
   * Calendar months represented by ONE step between consecutive trend
   * points. Default 1 — every current caller (fetchAcquisitionTrend) buckets
   * monthly. Pass a fraction (e.g. 12/52 for weekly buckets) so the output
   * "months" stays literally months even when a surface's granularity is
   * weekly (lib/metrics/timeseries.ts's bucketGranularityFor).
   */
  stepMonths?: number;
};

/**
 * `line` is the ready es-AR string for direct render — null exactly when
 * there is nothing honest to say about an ETA (met or insufficient).
 */
export type ForecastToTargetResult =
  | { kind: "months"; months: number; line: string }
  | { kind: "unreachable"; line: string }
  | { kind: "receding"; line: string }
  | { kind: "met"; line: null }
  | { kind: "insufficient"; line: null };

/** Below this many real observations, no line is fit — see module header. */
export const MIN_TREND_POINTS = 3;

/**
 * Projections beyond this horizon read as "unreachable" rather than a
 * (technically true but useless) three-digit month count. 120 months = 10
 * years — long enough that "eventually" is the honest gist, not a specific
 * ETA a reader could act on.
 */
export const MAX_HORIZON_MONTHS = 120;

/**
 * OLS slope over the series' integer bucket index (0..n-1), in series units
 * per STEP (not per month — callers convert via `stepMonths`). Mirrors
 * lib/metrics/forecast.ts's internal `olsFit` slope term; kept as an
 * independent, smaller helper here because this module only ever needs the
 * slope (no residual/band math — see the file header's method note).
 */
function olsSlopePerStep(ys: number[]): number {
  const n = ys.length;
  const meanIndex = (n - 1) / 2;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let sxy = 0;
  let ssx = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanIndex;
    sxy += dx * (ys[i] - meanY);
    ssx += dx * dx;
  }

  return ssx > 0 ? sxy / ssx : 0;
}

/** "1 mes" vs "14 meses" — never invent a plural for a singular ETA. */
function pluralizeMeses(months: number): string {
  return months === 1 ? "mes" : "meses";
}

/**
 * Project a metric's own trend forward and report how many months (if ever,
 * if honestly estimable) until it crosses its target. See the module header
 * for the full guard rationale — every branch below is a named, tested case,
 * never a fallthrough.
 */
export function forecastToTarget(input: ForecastToTargetInput): ForecastToTargetResult {
  const { current, target, trend } = input;
  const higherIsBetter = input.higherIsBetter ?? true;
  const stepMonths = input.stepMonths ?? 1;

  // Guard: target already met (or beaten) — evidence, not a forecast. Checked
  // BEFORE the data-sufficiency guard: a metric already at/beyond its target
  // needs no ETA regardless of how thin its trend is.
  const alreadyMet = higherIsBetter ? current >= target : current <= target;
  if (alreadyMet) return { kind: "met", line: null };

  // Guard: too few real observations to fit a trustworthy line.
  if (trend.length < MIN_TREND_POINTS) return { kind: "insufficient", line: null };

  const ys = trend.map((p) => p.value);
  const slopePerStep = olsSlopePerStep(ys);
  const slopePerMonth = stepMonths > 0 ? slopePerStep / stepMonths : slopePerStep;

  // Signed "closing speed" toward the target, positive regardless of
  // higherIsBetter direction: for a lower-is-better metric, a NEGATIVE raw
  // slope (values falling) is the metric closing the gap, so it flips sign.
  const closingSpeed = higherIsBetter ? slopePerMonth : -slopePerMonth;

  // Guard: trend moving AWAY from the target — no honest ETA exists.
  if (closingSpeed < 0) {
    return { kind: "receding", line: "→ tendencia en retroceso" };
  }

  // Guard: perfectly flat trend (zero measured movement) — nothing to
  // extrapolate toward the target at all.
  if (closingSpeed === 0) {
    return { kind: "unreachable", line: "→ al ritmo actual no se alcanza" };
  }

  const gap = Math.abs(target - current);
  const monthsRaw = gap / closingSpeed;

  // Guard: technically-positive but glacial progress — beyond the sane
  // horizon, "unreachable" is the honest read, not a three-digit ETA.
  if (!Number.isFinite(monthsRaw) || monthsRaw > MAX_HORIZON_MONTHS) {
    return { kind: "unreachable", line: "→ al ritmo actual no se alcanza" };
  }

  // Round sensibly — never false precision (14.3 → "~14", never "~14.3").
  // Floor of 1: "~0 meses" would misreport a within-this-bucket crossing.
  const months = Math.max(1, Math.round(monthsRaw));
  return {
    kind: "months",
    months,
    line: `→ a este ritmo: meta en ~${months} ${pluralizeMeses(months)}`,
  };
}

// ---------------------------------------------------------------------------
// resourceGap — PO-interview decision 2, item 2: forecasts state WHAT is
// missing, not just WHEN. A "meta en ~14 meses" line answers "cuándo" but
// never "qué" — an operator reading it has no idea whether closing that gap
// needs 50 doses or 50,000. This is the sibling honesty fix: the ABSOLUTE
// real-world units still missing to hit the target, right now (a snapshot,
// not a projection) — "faltan ~1.200 dosis", never an abstract percentage.
//
// SAME MATH FAMILY AS lib/metrics/impact-ranking.ts's computeImpact
// (gap% × denominator), but a DIFFERENT question: impact-ranking PRIORITIZES
// across jurisdictions (which province matters most); resourceGap STATES the
// resource count for ONE metric's own tile/alert, right where its value
// already renders (zero new screen, same FORECAST-A-META philosophy as
// forecastToTarget above).
//
// HONESTY GUARDS
//   - target already met → no line (this is evidence, not a resource ask).
//   - no denominator (null/non-finite/<=0) → no line — never invented.
//   - a real gap that rounds to 0 whole units (a sub-1-unit gap — e.g. 0.3 of
//     a dose over a tiny denominator) → no line either; "faltan ~0 dosis"
//     would read as "nothing missing" while the % is still technically short,
//     which is exactly the false-precision class this module fences.
//   - the line ALWAYS says "sobre el padrón registrado" — every current
//     caller's denominator is a REGISTRY count (the same denominator the
//     ratio's own % was computed against), not an independent census
//     estimate, so the honest caveat is baked into the engine, not left to
//     each render site to remember.

/** Input for {@link resourceGap} — mirrors ForecastToTargetInput's current/
 *  target/higherIsBetter shape, minus the trend (this is a snapshot, not a
 *  projection). */
export type ResourceGapInput = {
  /** The metric's current (live) value, same unit as `target` (0–100 for a percent). */
  current: number;
  /** The metric's target, from lib/metrics/targets.ts (TARGETS.*). */
  target: number;
  /**
   * The population/registry count this ratio's OWN percentage was computed
   * over (e.g. the registry-total pets/dogs, or a briefing candidate's `n`).
   * `null` → no resource line (no denominator to multiply against).
   */
  denominator: number | null;
  /** true (default): higher is better — see forecastToTarget's same field. */
  higherIsBetter?: boolean;
};

export type ResourceGapResult =
  | { kind: "units"; units: number; line: string }
  | { kind: "met"; line: null }
  | { kind: "negligible"; line: null }
  | { kind: "no_denominator"; line: null };

const AR_INTEGER_FORMAT = new Intl.NumberFormat("es-AR");

/**
 * Compute the absolute real-world units still missing to hit `target`, for
 * ONE metric's own render surface — "faltan ~N {unit}". `unit` is the
 * KPI-specific noun (see lib/metrics/kpi-catalog.ts's `resourceUnit` field —
 * "dosis", "cirugías", "chips") — this function never guesses one.
 */
export function resourceGap(input: ResourceGapInput, unit: string): ResourceGapResult {
  const higherIsBetter = input.higherIsBetter ?? true;
  const met = higherIsBetter ? input.current >= input.target : input.current <= input.target;
  if (met) return { kind: "met", line: null };

  if (input.denominator === null || !Number.isFinite(input.denominator) || input.denominator <= 0) {
    return { kind: "no_denominator", line: null };
  }

  const gapPct = Math.abs(input.target - input.current);
  const units = Math.round((gapPct / 100) * input.denominator);
  if (units <= 0) return { kind: "negligible", line: null };

  return {
    kind: "units",
    units,
    line: `faltan ~${AR_INTEGER_FORMAT.format(units)} ${unit} sobre el padrón registrado`,
  };
}
