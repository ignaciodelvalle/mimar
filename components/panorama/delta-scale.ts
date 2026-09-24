// Zero-anchored classed DIVERGING scale for DELTA-encoded choropleth layers
// (new-vistas wave — the "tendencia" two-window event delta).
//
// A delta layer's `value` is SIGNED (current window − prior window), so neither
// classed path fits:
//   - the META scale anchors on an attainment target (a delta has none), and
//   - the QUANTILE scale would happily split all-positive deltas into blues,
//     hiding the one distinction that matters (more vs fewer events than before).
//
// POLARITY (deliberately INVERTED relative to the compliance meta scale): for
// event counts, MORE events than the prior period is the WARNING pole and FEWER
// is the good pole. The classes reuse the CVD-validated divergent tokens
// (@dim/contract/viz — the tested constants beat any handoff doc):
// COLOR_DIVERGENT_ABOVE (teal) paints the DECREASE classes, COLOR_DIVERGENT_BELOW
// (amber) paints the INCREASE classes, COLOR_DIVERGENT_NEUTRAL the "sin cambio"
// class. Mid-shades are derived by lerping a pole toward neutral — no new raw
// palette hex is introduced.
//
// Pure (no maplibre runtime) so the class layout is unit-testable; the caller
// builds the MapLibre `["step", …]` fill and the legend swatches from the SAME
// ClassScale via the shared class-scale machinery, so paint and legend cannot
// disagree.

import type { FeatureCollection } from "@/src/modules/panorama/domain/types";
import {
  COLOR_DIVERGENT_ABOVE,
  COLOR_DIVERGENT_BELOW,
  COLOR_DIVERGENT_NEUTRAL,
  lerpHex,
} from "@dim/contract/viz";

import type { ClassScale } from "./class-scale";

/**
 * The 5 delta class colors, ascending by value:
 *   [strong decrease, decrease, no change, increase, strong increase].
 * Poles are the validated divergent tokens; the two mid-shades lerp each pole
 * 55% toward neutral (derived, never a new raw hex).
 */
export const DELTA_CLASS_COLORS: readonly string[] = [
  COLOR_DIVERGENT_ABOVE,
  lerpHex(COLOR_DIVERGENT_ABOVE, COLOR_DIVERGENT_NEUTRAL, 0.55),
  COLOR_DIVERGENT_NEUTRAL,
  lerpHex(COLOR_DIVERGENT_BELOW, COLOR_DIVERGENT_NEUTRAL, 0.55),
  COLOR_DIVERGENT_BELOW,
];

/**
 * Resolve the zero-anchored delta ClassScale for a set of signed deltas, or
 * null when there is nothing numeric to classify (the caller paints neutral).
 *
 * Breaks are `[-h, 0, 1, h]` with the hinge `h = max(2, round(maxAbs / 2))` —
 * strictly ascending by construction (the MapLibre `step` monotonicity fence).
 * Under step semantics that yields exactly the honest integer-delta classes:
 *   Δ < -h      → strong decrease        -h ≤ Δ < 0 → decrease
 *   0 ≤ Δ < 1   → "sin cambio" (Δ = 0 for integer deltas)
 *   1 ≤ Δ < h   → increase               Δ ≥ h      → strong increase
 * The 0 anchor is frame-stable (comparable across scrub frames); only the ±h
 * hinge tracks the current frame's observed magnitude.
 */
export function deltaClassScale(values: readonly number[]): ClassScale | null {
  const finite = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (finite.length === 0) return null;
  const maxAbs = Math.max(...finite.map((v) => Math.abs(v)));
  const h = Math.max(2, Math.round(maxAbs / 2));
  return {
    breaks: [-h, 0, 1, h],
    colors: [...DELTA_CLASS_COLORS],
    method: "interval",
  };
}

/** Feature props the delta scale reads (the province choropleth value carrier). */
type DeltaProps = { value?: number | null; suppressed?: boolean };

/**
 * The delta ClassScale for a province choropleth FeatureCollection — collects
 * every non-suppressed numeric `value` (a suppressed cell never shapes the
 * class hinge, mirroring the sibling scales) and classifies over them.
 */
export function deltaProvinceClassScale(fc: FeatureCollection): ClassScale | null {
  const values: number[] = [];
  for (const f of fc.features) {
    const p = (f.properties ?? {}) as DeltaProps;
    if (p.suppressed === true) continue;
    if (typeof p.value === "number") values.push(p.value);
  }
  return deltaClassScale(values);
}
