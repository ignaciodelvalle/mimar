// Pure helpers for THRESHOLD-CLASSED choropleth color scales (panorama redesign
// Theme 3 — "solid, classed, high-contrast fills").
//
// The situation-room choropleths used to color every unit by a CONTINUOUS 2-stop
// linear interpolation over the observed min/max. When real values cluster tight
// (e.g. rabies coverage ~34–65% against an 80% meta) that compresses every unit
// into a narrow low-contrast slice and the map "reads flat" — a failure the legend
// code itself documented (legend-histogram.ts). Classing fixes it: values are
// bucketed into a handful of discrete CLASSES, each painted a distinct color from
// the light-map sequential ramp, so differences read at a glance.
//
// Two classing policies (PO decision, threshold-by-meta):
//   - META  : a policy-meaningful target exists → fixed cutoffs anchored on it
//             (e.g. meta 80% → break at 40 / 60 / 80: below-half / approaching /
//             near / met). Comparable across jurisdictions, stable over time.
//   - QUANTILE: no meta → data-driven quantile breaks over the value set, so each
//             class holds roughly the same number of units (balanced contrast).
//
// LOCKED BREAKS (time-scrub scale-lock) reuse the QUANTILE breaks captured at the
// live edge, so a unit keeps the same class-color across every as-of frame of a
// scrub (no per-frame rebasing = no flicker) WITHOUT collapsing the classing to
// equal-interval. Older code froze a [min,max] domain and re-derived EQUAL-INTERVAL
// cutoffs from it — but because the live edge ALSO passed a domain, quantile never
// fired and skewed distributions read flat (the "dead quantile branch" bug). Freezing
// the quantile breaks themselves keeps the classing quantile-balanced on skew while
// staying frame-stable across the scrub.
//
// Kept pure (no maplibre runtime, no DOM) so the bucketing + color assignment are
// unit-testable in isolation. Callers (province-choropleth-style, division-fill,
// MapLegends) build the MapLibre `["step", …]` expression / legend swatches from
// the SAME breaks + colors, so on-map fill and off-canvas legend never disagree.

import { SCALE_BLUE_SEQ } from "@dim/contract/viz";

/** How many classes a classed scale renders (→ CLASS_COUNT-1 interior breaks). */
export const CLASS_COUNT = 5;

/** A resolved classed scale: ascending interior breaks + one color per class.
 *  Invariant: `colors.length === breaks.length + 1`.
 *
 *  `method` — how the breaks were derived: `meta` (target-anchored cutoffs),
 *  `quantile` (data-driven), `interval` (equal-interval, < CLASS_COUNT units),
 *  `flat` (degenerate single class), or `locked` (frozen live-edge breaks
 *  reused verbatim under a time-scrub scale-lock — the lock stores breaks only,
 *  so the ORIGIN method (quantile vs interval) is not reconstructable here;
 *  labeling it "quantile" unconditionally was a lie when the live edge had
 *  fallen to equal-interval — adversarial review 2026-07-11, LOW #4). */
export type ClassScale = {
  breaks: number[];
  colors: string[];
  method: "meta" | "quantile" | "interval" | "flat" | "locked";
};

/**
 * Pick `n` colors evenly sampled from the 5-stop light sequential ramp
 * (SCALE_BLUE_SEQ — ColorBrewer Blues, luminance DECREASES with value so a hot
 * class is the darkest blue on the light canvas). n=5 → the whole ramp; n=4 →
 * [0,1,3,4] (drops one mid stop but keeps both poles); n=1 → the mid stop (a
 * single flat class). No new palette is introduced — this only re-samples the
 * existing ramp.
 *
 * `invert` REVERSES the assignment so the darkest stop lands on the LOWEST
 * class. What the sequential family communicates is "dark = the alarm": on
 * mortalidad, denuncias or días sin actividad veterinaria the alarm is the high
 * end, so the default ramp is already right. On a HIGHER-IS-BETTER layer
 * (PanoramaLayer.higherIsBetter — visitas veterinarias por 1.000) the alarm is
 * the LOW end, and painting it with the pale "barely anything here" stop while
 * the best-served territory gets the darkest ink tells the operator the opposite
 * of the truth. Inverting keeps the one convention true in both directions.
 * (The META path needs none of this: its target already declares which pole is
 * good, and there "dark = meta cumplida" is the established reading.)
 */
export function classColors(n: number, opts?: { invert?: boolean }): string[] {
  const scale = SCALE_BLUE_SEQ;
  if (n <= 1) return [scale[Math.floor(scale.length / 2)]];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i * (scale.length - 1)) / (n - 1));
    out.push(scale[idx]);
  }
  return opts?.invert === true ? out.reverse() : out;
}

/** Sort ascending, drop non-finite, keep only STRICTLY increasing values —
 *  MapLibre `step` throws on duplicate/non-ascending thresholds. */
function dedupeAscending(values: number[]): number[] {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (out.length === 0 || v > out[out.length - 1]) out.push(v);
  }
  return out;
}

/** Linear-interpolated quantile over an ASCENDING-sorted array, p ∈ [0,1]. */
function quantileSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Resolve the classed scale (breaks + colors) for a value set.
 *
 * @param values  every unit's value (no-data / suppressed cells are excluded by
 *                the caller — they are painted their own category, never a class).
 * @param opts.target       a policy meta → META policy (fixed cutoffs on the meta).
 * @param opts.lockedBreaks frozen interior breaks (scrub scale-lock) captured from
 *                          the live-edge QUANTILE scale → reused verbatim so a unit
 *                          keeps its class-color across frames. Wins over target.
 * @param opts.invert       the layer is HIGHER-IS-BETTER → reverse the ramp so the
 *                          darkest class is the LOWEST value (see `classColors`).
 *                          Breaks are untouched: only the colour assignment flips.
 *                          Callers pass `layer.higherIsBetter` for a sequential
 *                          (target-less) layer; a META'd layer must not pass it.
 */
export function computeClassScale(
  values: readonly number[],
  opts?: {
    target?: number | null;
    lockedBreaks?: readonly number[] | null;
    invert?: boolean;
  },
): ClassScale {
  const target = opts?.target ?? null;
  const lockedBreaks = opts?.lockedBreaks ?? null;
  const invert = opts?.invert === true;
  const finite = values.filter((v) => typeof v === "number" && Number.isFinite(v));

  // Scrub scale-lock: reuse the FROZEN breaks captured at the live edge
  // (frame-stable colors; quantile-balanced when the live edge had ≥ CLASS_COUNT
  // units). Reported as "locked" — the origin method is not reconstructable
  // from the breaks alone, so claiming "quantile" would be dishonest when the
  // live edge fell to equal-interval (adversarial review 2026-07-11, LOW #4).
  if (lockedBreaks && lockedBreaks.length > 0) {
    const breaks = dedupeAscending([...lockedBreaks]);
    if (breaks.length > 0) {
      return { breaks, colors: classColors(breaks.length + 1, { invert }), method: "locked" };
    }
  }

  // Meta policy: fixed cutoffs at half / three-quarters / the meta itself.
  // For a meta of 80 → [40, 60, 80] → classes <40 / 40–60 / 60–80 / ≥80.
  if (target != null && Number.isFinite(target) && target > 0) {
    const breaks = dedupeAscending([0.5 * target, 0.75 * target, target]);
    return { breaks, colors: classColors(breaks.length + 1, { invert }), method: "meta" };
  }

  if (finite.length === 0)
    return { breaks: [], colors: classColors(1, { invert }), method: "flat" };

  const min = Math.min(...finite);
  const max = Math.max(...finite);
  // Degenerate range (all equal) → a single flat class; MapLibre `step` needs a
  // real ascending threshold, so a break-less scale is a flat fill (see stepExpr).
  if (!(max > min)) return { breaks: [], colors: classColors(1, { invert }), method: "flat" };

  // Too few units for meaningful quantiles → equal-interval over the range.
  if (finite.length < CLASS_COUNT) {
    const breaks = dedupeAscending(
      Array.from(
        { length: CLASS_COUNT - 1 },
        (_, i) => min + ((max - min) * (i + 1)) / CLASS_COUNT,
      ),
    );
    return { breaks, colors: classColors(breaks.length + 1, { invert }), method: "interval" };
  }

  // Quantile breaks: each class holds ~1/CLASS_COUNT of the units.
  const sorted = [...finite].sort((a, b) => a - b);
  const breaks = dedupeAscending(
    Array.from({ length: CLASS_COUNT - 1 }, (_, i) =>
      quantileSorted(sorted, (i + 1) / CLASS_COUNT),
    ),
  );
  return { breaks, colors: classColors(breaks.length + 1, { invert }), method: "quantile" };
}

/**
 * Build a MapLibre `["step", input, c0, t1, c1, t2, c2, …]` output expression
 * from a resolved ClassScale. `input` is the value-lookup sub-expression (e.g. a
 * `match` on the polygon `code`). A break-less scale (single flat class) returns
 * the lone color string — MapLibre `step` requires ≥ 1 ascending threshold.
 */
export function stepColorExpr(input: unknown, scale: ClassScale): unknown {
  if (scale.breaks.length === 0) return scale.colors[0];
  const out: unknown[] = ["step", input, scale.colors[0]];
  for (let i = 0; i < scale.breaks.length; i++) {
    out.push(scale.breaks[i], scale.colors[i + 1]);
  }
  return out;
}

/**
 * The class color a single scalar value lands in — the JS mirror of the MapLibre
 * `["step", …]` semantics (value < breaks[0] → colors[0]; breaks[i-1] ≤ value <
 * breaks[i] → colors[i]; value ≥ last break → last color). Used off-map where a
 * lone value must be painted its class color (e.g. the CABA inset uniform fill),
 * so the inset chip matches the main choropleth's class palette exactly.
 *
 * NaN hardening: every `value >= breaks[i]` comparison is false for NaN, so an
 * unguarded version silently fell through to `idx = 0` (the LOWEST class) —
 * indistinguishable from a genuinely low real value. Returns `null` for a
 * non-finite value instead, so the caller can render its own no-data state
 * rather than paint a fake "low" color.
 */
export function colorForValue(scale: ClassScale, value: number): string | null {
  if (!Number.isFinite(value)) return null;
  let idx = 0;
  for (let i = 0; i < scale.breaks.length; i++) {
    if (value >= scale.breaks[i]) idx = i + 1;
  }
  return scale.colors[idx];
}

/** One legend swatch row: the class color + its half-open value range [lo, hi).
 *  `lo` is null for the first (open-below) class; `hi` is null for the last
 *  (open-above) class. Callers format the numbers for display. */
export type ClassSwatch = { color: string; lo: number | null; hi: number | null };

/** Expand a ClassScale into legend swatch rows (color + value range per class). */
export function classSwatches(scale: ClassScale): ClassSwatch[] {
  const { breaks, colors } = scale;
  return colors.map((color, i) => ({
    color,
    lo: i === 0 ? null : breaks[i - 1],
    hi: i === colors.length - 1 ? null : breaks[i],
  }));
}
