// Pure helpers for the graduated-symbol (bubble) encoding of density/signal
// point layers.
//
// Two encoding-honesty rules live here, independent of maplibre-gl so they are
// unit-testable:
//
//  1. AREA-proportional sizing (not radius-proportional). A bubble's perceived
//     magnitude is its AREA, so area — not radius — must scale with the value:
//     r ∝ √value. A radius that grows linearly with value reads ~4× bigger for a
//     2× value (the classic exaggeration bug). We size every bubble by
//     `bubbleRadius`, which anchors √(value / observedMax) between a floor and a
//     cap radius.
//
//  2. DATA-DRIVEN legend bins. The legend's sample values are derived from the
//     ACTUAL observed maximum, never a hardcoded 1–9 / … / 500+ ladder. When the
//     real per-unit signals only run 1–4, the legend shows 1–4 (not five buckets
//     that all collapse into the first). Nice-rounded sample values span the
//     observed range so the reader sees the scale the data actually occupies.
//
// The SituationalMap consumes `buildGraduatedScale` to drive BOTH the MapLibre
// `circle-radius` interpolate stops and the HTML legend from the SAME numbers, so
// a legend bubble is always the exact size of the on-map bubble for that value.

/** Smallest bubble radius (px) — a unit with the minimum visible count. */
export const BUBBLE_R_MIN = 5;
/** Largest bubble radius (px) — a unit at the observed maximum. */
export const BUBBLE_R_MAX = 30;

/**
 * AREA-proportional radius for `value` given the observed `maxValue`.
 * `r = R_MIN + (R_MAX - R_MIN) · √(value / maxValue)` so bubble AREA (∝ r²) grows
 * with the value and equal areas encode equal magnitudes. Non-positive inputs
 * (no data, suppressed coalesced to 0) collapse to the floor.
 */
export function bubbleRadius(value: number, maxValue: number): number {
  if (maxValue <= 0 || value <= 0) return BUBBLE_R_MIN;
  const frac = Math.min(1, value / maxValue);
  return BUBBLE_R_MIN + (BUBBLE_R_MAX - BUBBLE_R_MIN) * Math.sqrt(frac);
}

/** A legend sample: a representative value, its label, and its bubble radius. */
export type GraduatedBin = { value: number; label: string; r: number };

/** The graduated-symbol scale: legend bins + MapLibre interpolate stops. */
export type GraduatedScale = {
  /** The observed maximum the scale is anchored on (0 when there is no data). */
  maxValue: number;
  /** Ascending legend sample values (empty when there is no data). */
  bins: GraduatedBin[];
  /** `[value, radius]` pairs for a MapLibre `interpolate` (always ≥ 2, ascending by value). */
  radiusStops: Array<[number, number]>;
};

/** Round a radius to the nearest 0.5px (crisp, stable legend/map parity). */
function roundR(r: number): number {
  return Math.round(r * 2) / 2;
}

/**
 * A "nice" step (1, 2, 5 × 10ⁿ) at or just below `rough` — the standard
 * nice-number rounding used to place legend breakpoints on human values.
 */
function niceStep(rough: number): number {
  if (rough <= 0) return 1;
  const exp = Math.floor(Math.log10(rough));
  const base = 10 ** exp;
  const frac = rough / base;
  let nice: number;
  if (frac < 1.5) nice = 1;
  else if (frac < 3) nice = 2;
  else if (frac < 7) nice = 5;
  else nice = 10;
  return Math.max(1, nice * base);
}

/**
 * Derive ascending representative sample values spanning [1, max] from the
 * observed maximum. Tiny ranges (max ≤ 6) list every integer so the legend
 * reflects the true small scale (e.g. 1–4, not five collapsing buckets); larger
 * ranges use nice-rounded breakpoints and always end exactly at the observed max.
 */
export function graduatedSampleValues(max: number): number[] {
  const m = Math.floor(max);
  if (m <= 0) return [];
  if (m <= 6) return Array.from({ length: m }, (_, i) => i + 1);
  const step = niceStep(m / 4);
  const out: number[] = [1];
  for (let v = step; v < m; v += step) {
    if (v > 1) out.push(v);
  }
  out.push(m);
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

/**
 * A "nice" step (1, 2, 5 × 10ⁿ) at or just below `rough`, WITHOUT the ≥1 clamp
 * — n may be negative, so fractional domains (per-10k rates like 0,8) get honest
 * decimal breakpoints (0,2 / 0,4 / …) instead of collapsing to integers.
 */
function niceStepFractional(rough: number): number {
  if (!(rough > 0) || !Number.isFinite(rough)) return 1;
  const exp = Math.floor(Math.log10(rough));
  const base = 10 ** exp;
  const frac = rough / base;
  let nice: number;
  if (frac < 1.5) nice = 1;
  else if (frac < 3) nice = 2;
  else if (frac < 7) nice = 5;
  else nice = 10;
  return nice * base;
}

/** Round to 2 decimals (kills float noise like 0.30000000000000004 in samples). */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Ascending decimal sample values spanning (0, max] — the fractional-mode
 * counterpart of {@link graduatedSampleValues}. Nice decimal steps, ending
 * exactly at the observed max; the penultimate step is skipped when it would
 * crowd the max (within half a step), so the legend never shows two
 * near-identical top bubbles.
 *
 * F1 defense (a): the 2-decimal `round2` collapses a sub-0.005 nice step to 0
 * for a very small max (e.g. max 0.01 → step 0.002 → round2 → 0). A 0 sample
 * would seed a DUPLICATE `[0, …]` interpolate stop (see buildGraduatedScale) and
 * a "0" legend label, so samples are filtered to strictly-positive and deduped.
 */
function fractionalSampleValues(max: number): number[] {
  if (!(max > 0) || !Number.isFinite(max)) return [];
  const step = niceStepFractional(max / 4);
  const out: number[] = [];
  for (let v = step; v < max - step / 2; v += step) out.push(round2(v));
  out.push(round2(max));
  return [...new Set(out)].filter((v) => v > 0).sort((a, b) => a - b);
}

/**
 * Build the full graduated scale from the observed maximum count across the
 * active graduated layers. Returns an empty scale when there is no data.
 *
 * `opts.fractional` (panorama-percapita): the per-cápita encoding feeds per-10k
 * RATES, routinely fractional (12 events over 17,5 M hab. ≈ 0,01) — the default
 * integer flooring would yield an empty scale and floor-size every bubble.
 * Fractional mode keeps the real max and derives nice DECIMAL bins, labeled
 * es-AR with up to 2 decimals. Integer counts (every existing caller) are
 * byte-identical without the flag.
 */
export function buildGraduatedScale(
  maxValue: number,
  opts?: { fractional?: boolean },
): GraduatedScale {
  const fractional = opts?.fractional === true;
  const max = fractional ? round2(maxValue) : Math.floor(maxValue);
  if (max <= 0) {
    return { maxValue: 0, bins: [], radiusStops: [[0, BUBBLE_R_MIN]] };
  }
  const samples = fractional ? fractionalSampleValues(max) : graduatedSampleValues(max);
  const bins: GraduatedBin[] = samples.map((v) => ({
    value: v,
    label: v.toLocaleString("es-AR", { maximumFractionDigits: 2 }),
    r: roundR(bubbleRadius(v, max)),
  }));
  // Stops start at 0 → floor radius (covers coalesced null / zero counts) so the
  // interpolate always has ≥ 2 strictly-ascending input values.
  //
  // F1 defense (b): a STRUCTURAL guard for all callers — never push a stop whose
  // input is ≤ the previous input. MapLibre's `interpolate` throws on a duplicate
  // or out-of-order input, and a fractional sampler that ever emitted a repeated
  // value (or one equal to the seeded 0) would take the graduated layer down.
  const radiusStops: Array<[number, number]> = [[0, BUBBLE_R_MIN]];
  let prevInput = 0;
  for (const v of samples) {
    if (v <= prevInput) continue;
    radiusStops.push([v, roundR(bubbleRadius(v, max))]);
    prevInput = v;
  }
  return { maxValue: max, bins, radiusStops };
}

/** Minimal feature shape carrying an aggregated `count`. */
type CountFeature = { properties?: { count?: number | null } | null };
/** Minimal FeatureCollection shape for max-count scanning. */
type CountCollection = { features: ReadonlyArray<CountFeature> };

/**
 * Observed maximum `count` across every feature of the given collections
 * (the active graduated layers). Suppressed cells (count null) are ignored.
 * Returns 0 when there is no positive count.
 */
export function graduatedMaxCount(collections: Iterable<CountCollection>): number {
  let max = 0;
  for (const fc of collections) {
    for (const f of fc.features) {
      const c = f.properties?.count;
      if (typeof c === "number" && c > max) max = c;
    }
  }
  return max;
}
