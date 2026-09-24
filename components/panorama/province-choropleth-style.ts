// Pure styling helpers for the U5 province-choropleth render mode.
//
// Extracted from SituationalMap so they are unit-testable WITHOUT importing
// maplibre-gl (and its CSS side-effect). These build the data-driven fill-color
// expression and the legend bounds from a layer's province features — no map
// mutation, no DOM, no external provider. The SituationalMap consumes them.
//
// The color expression mirrors the MapChoropleth approach (a value lookup +
// linear interpolation across a tokenized ramp) but joins on the LOCAL polygon
// `code` property — so it colors the ar-provinces basemap polygons, never an
// external raster.

import type { ExpressionSpecification, FilterSpecification } from "maplibre-gl";

import {
  type ClassScale,
  computeClassScale,
  stepColorExpr,
} from "@/components/panorama/class-scale";
import { PROVINCES } from "@/lib/reference/ar-provincias";
import type { FeatureCollection } from "@/src/modules/panorama/domain/types";
import { COLOR_NO_DATA } from "@dim/contract/viz";

/** A province feature's properties (as emitted by buildProvinceChoroplethFeatures). */
type ProvinceFeatureProps = { provinceCode?: string; value?: number | null; suppressed?: boolean };

/**
 * Adversarial-review fix (2026-07-11, MED #3): NaN hardening for the MAPLIBRE
 * fill path, not just the JS mirror (colorForValue). `typeof value === "number"`
 * is true for NaN, so a NaN-carrying feature entered the `match` pairs and the
 * `["step", …]` expression painted it as the LOWEST class — indistinguishable
 * from a genuinely low value. A finite check routes NaN to the match default
 * (-1 → COLOR_NO_DATA) instead. Type predicate so the narrowing survives.
 */
function isFiniteValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** value min/max over a province layer's features (for the scale legend). */
export type ScaleBounds = { min: number; max: number };

/** Collect the (provinceCode, value) pairs — the value-by-code join the fill
 *  `match` reads. Non-finite / code-less features are dropped (NaN hardening). */
function provincePairs(features: FeatureCollection): Array<[string, number]> {
  const pairs: Array<[string, number]> = [];
  for (const f of features.features) {
    const p = f.properties as ProvinceFeatureProps;
    if (typeof p.provinceCode !== "string" || !isFiniteValue(p.value)) continue;
    pairs.push([p.provinceCode, p.value]);
  }
  return pairs;
}

/**
 * D.5(b) — the MapLibre `filter` selecting the province polygons this layer has
 * NO VALUE for, so the stipple overlay can mark them.
 *
 * It is the exact complement of the `match` inside the fill expressions above:
 * every code those map to a real value is excluded, everything else — a province
 * absent from the feature set, or present with a non-finite value — is stippled.
 * Deriving it from the same `provincePairs()` the fill reads is the point: the
 * overlay cannot disagree with the colour about which provinces have data.
 *
 * A layer with no pairs at all yields a constant-`true` filter, which is the
 * honest render: the live review of 2026-07-28 found views where the ENTIRE
 * mainland was no-data and read as plain land. On a light canvas that fill is
 * only ΔE00 1.48 from the basemap, so "nobody reported anything" was
 * indistinguishable from "this area is not in the analysis".
 *
 * ⚠️ k-ANON EXCLUSION (#40) — THE TRAP THIS FILTER WALKS INTO OTHERWISE. A
 * SUPPRESSED province carries `value: null`, so `provincePairs` drops it and the
 * naive complement stipples it. That renders "nadie reportó acá" over a province
 * that reported perfectly well — a LIE, and simultaneously a leak, because the
 * one province wearing the wrong texture is exactly the one whose count is
 * sub-k. `suppressed` is therefore KNOWN, not missing: the state is published by
 * the hatch (`provinceSuppressedCodes`), not by the absence of a value.
 *
 * Three states, three textures, no overlap: colour = value · hatch = protected ·
 * stipple = genuinely nothing reported.
 */
export function provinceNoDataFilter(features: FeatureCollection): FilterSpecification {
  const known = new Set(provincePairs(features).map(([code]) => code));
  for (const code of provinceSuppressedCodes(features)) known.add(code);
  if (known.size === 0) return true as unknown as FilterSpecification;
  return [
    "!",
    ["match", ["get", "code"], [...known], true, false],
  ] as unknown as FilterSpecification;
}

/** One province's published state, as the popups and readouts must read it. */
export type ProvinceCellState = { value: number | null; suppressed: boolean };

/**
 * Look up a province's cell state by code.
 *
 * #40: the two call sites in SituationalMap (the hover popup and the
 * multi-layer readout) both did `p.value ?? 0`, which published a confident
 * ZERO for a k-anon-protected province — the exact false zero the rule forbids,
 * and the most misleading substitution available on a coverage layer. They now
 * share this one lookup, which returns the FLAG so the caller can render
 * "protegido" instead of a number or a wrong "sin datos".
 */
export function provinceCellAt(
  features: FeatureCollection | undefined,
  code: string,
): ProvinceCellState {
  for (const f of features?.features ?? []) {
    const p = f.properties as ProvinceFeatureProps;
    if (p.provinceCode === code)
      return { value: p.value ?? null, suppressed: p.suppressed === true };
  }
  return { value: null, suppressed: false };
}

/** Whether a province layer has at least one k-anon-suppressed cell — the
 *  condition the legend's "Protegido por privacidad" row renders on, so the key
 *  never announces a mark the current frame does not paint. */
export function hasSuppressedProvince(features: FeatureCollection): boolean {
  return provinceSuppressedCodes(features).length > 0;
}

/**
 * Whether this layer's frame actually paints the no-data STIPPLE on at least one
 * province — the gate the legend's "Sin datos" key must pass.
 *
 * RA-7 F9 (2026-07-31). The k-anon key learned this discipline (#40, and again
 * on 2026-07-30 for the pill and the bivariate/graduated rows); the "Sin datos"
 * key beside it never did, and rendered on EVERY province legend. On a frame
 * where all 24 jurisdictions carry a value there is no stipple anywhere on the
 * canvas, and the key promised a mark the map does not paint. That is the same
 * defect as announcing a hatch that is not there, and it costs the same thing:
 * an operator who learns the legend is decoration stops reading the row that
 * matters, and the row that matters is the privacy one.
 *
 * Derived as the EXACT complement `provinceNoDataFilter` paints with — the same
 * `known` set (valued ∪ suppressed) measured against the basemap's jurisdiction
 * count — so the key and the overlay cannot disagree about whether the mark
 * exists. `PROVINCES` is the authoritative ISO 3166-2:AR list and matches
 * public/geo/ar-provinces.geojson one-for-one (24 polygons, same codes), which
 * is what makes counting a valid stand-in for enumerating the source.
 *
 * A layer with nothing known stipples the whole country (the filter's
 * constant-`true` branch) and correctly answers true.
 */
export function provincePaintsNoData(features: FeatureCollection): boolean {
  const known = new Set(provincePairs(features).map(([code]) => code));
  for (const code of provinceSuppressedCodes(features)) known.add(code);
  return known.size < PROVINCES.length;
}

/**
 * The province codes whose cell is k-anon SUPPRESSED — the set the hatch overlay
 * paints and the set `provinceNoDataFilter` must treat as KNOWN.
 *
 * Reads the `suppressed` FLAG, never "value is null". Inferring suppression from
 * a missing value would conflate it with a province that is simply absent from
 * the layer, and those two must render differently (hatch vs stipple).
 */
export function provinceSuppressedCodes(features: FeatureCollection): string[] {
  const codes: string[] = [];
  for (const f of features.features) {
    const p = f.properties as ProvinceFeatureProps;
    if (typeof p.provinceCode !== "string" || p.provinceCode.length === 0) continue;
    if (p.suppressed === true) codes.push(p.provinceCode);
  }
  return codes;
}

/**
 * P3 consolidation — the SINGLE classed-province `fill-color` assembly shared by
 * BOTH the sequential (provinceColorExpr) and META (provinceMetaColorExpr) paths,
 * and by the first-class `ChoroplethEncoding` value object (encoding.ts). Given a
 * feature set and its ALREADY-RESOLVED ClassScale, it builds the exact
 * `case → match → step` expression both paths used to assemble independently:
 *  1. a `match` maps each province code → its value (default -1 = "no data");
 *  2. a `case` short-circuits the -1 no-data cells to COLOR_NO_DATA (k-anon /
 *     absence honesty — a suppressed or absent cell never enters a color class);
 *  3. the rest are THRESHOLD-CLASSED via `stepColorExpr(valueMatch, scale)`.
 * The scale is passed in (never recomputed here), so the fill and any legend /
 * inset sampling that read the SAME scale object cannot drift. Returns a flat
 * COLOR_NO_DATA expression when the layer carries no values.
 */
export function classedProvinceFill(
  features: FeatureCollection,
  scale: ClassScale,
): ExpressionSpecification {
  const pairs = provincePairs(features);
  if (pairs.length === 0) return COLOR_NO_DATA as unknown as ExpressionSpecification;

  const valueMatch = [
    "match",
    ["get", "code"],
    ...pairs.flatMap(([code, value]) => [code, value] as [string, number]),
    -1,
  ] as unknown as ExpressionSpecification;

  return [
    "case",
    ["==", valueMatch, -1],
    COLOR_NO_DATA,
    stepColorExpr(valueMatch, scale),
  ] as unknown as ExpressionSpecification;
}

/**
 * Build the data-driven `fill-color` for a province choropleth.
 *  1. a `match` maps each province code → its value (default -1 = "no data");
 *  2. provinces with no value (-1) get COLOR_NO_DATA;
 *  3. the rest are THRESHOLD-CLASSED into the dark-map ramp via a MapLibre
 *     `["step", …]` expression — each class a distinct color so tight-clustered
 *     values read at a glance (see class-scale.ts). Sequential province layers
 *     carry no policy meta (rate layers with a `complianceTarget` take the classed
 *     META path — provinceMetaColorExpr — instead), so the breaks are QUANTILE over
 *     the value set — frozen across a scrub via `lockedBreaks` (still quantile).
 * Returns a flat COLOR_NO_DATA expression when the layer has no values.
 */
/**
 * The province values a choropleth actually paints — one number per feature
 * that carries a province code and a finite value.
 *
 * Shared so the legend's extremes and the ramp's classing read the SAME set.
 * They used to be derived separately, and the legend published a range the map
 * never painted (P1-F3): a duplicated filter is a drift waiting to happen.
 */
export function provinceValues(features: FeatureCollection): number[] {
  const values: number[] = [];
  for (const f of features.features) {
    const p = f.properties as ProvinceFeatureProps;
    if (typeof p.provinceCode !== "string" || !isFiniteValue(p.value)) continue;
    values.push(p.value);
  }
  return values;
}

/** True min/max of what the province choropleth paints, or null when empty. */
export function provinceValueExtent(
  features: FeatureCollection,
): { min: number; max: number } | null {
  const values = provinceValues(features);
  if (values.length === 0) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}

/**
 * The THRESHOLD-CLASSED scale (breaks + colors) a SEQUENTIAL province choropleth
 * renders — the single source of truth shared by the map fill (provinceColorExpr,
 * below) and the off-canvas legend (lifted through SituationalMap so the swatch
 * ranges always describe the painted colors, including under a scrub scale-lock).
 * `lockedBreaks` are the frozen live-edge quantile breaks a scrub reuses; when
 * present the scale renders those exact breaks instead of re-deriving quantiles
 * from the current frame (frame-stable colors, still quantile-balanced).
 * Returns null when the layer has no numeric values (the fill paints all neutral).
 *
 * `opts.invert` carries the layer's declared POLARITY (PanoramaLayer.
 * higherIsBetter). The sequential ramp darkens with value, which is the alarm
 * reading for a harm magnitude and the exact inverse for the layers where a HIGH
 * value is the good news (`acceso-veterinario`, `indice-territorial`). This call
 * site used to drop the flag on the floor, so the mechanism existed
 * (`computeClassScale({ invert })`) while the map still painted the best-served
 * jurisdictions as the alarm — which is why `acceso-veterinario` could not be
 * given a vista. Default (absent/false) is a no-op for every other layer.
 */
export function provinceSeqClassScale(
  features: FeatureCollection,
  lockedBreaks?: readonly number[] | null,
  opts?: { invert?: boolean },
): ClassScale | null {
  const values = provinceValues(features);
  if (values.length === 0) return null;
  return computeClassScale(values, {
    lockedBreaks: lockedBreaks ?? null,
    invert: opts?.invert === true,
  });
}

export function provinceColorExpr(
  features: FeatureCollection,
  // Optional frozen breaks (fix: time-scrub color-scale lock). When supplied, the
  // classed scale renders these frozen live-edge quantile breaks instead of the
  // frame's own quantiles, so a value keeps the same class-color across every
  // as-of frame.
  lockedBreaks?: readonly number[] | null,
  // The layer's polarity — see provinceSeqClassScale. Threaded through so the
  // painted fill and the lifted legend can never disagree about which end is bad.
  opts?: { invert?: boolean },
): ExpressionSpecification {
  const scale = provinceSeqClassScale(features, lockedBreaks, opts);
  // No data at all — paint everything neutral.
  if (scale === null) return COLOR_NO_DATA as unknown as ExpressionSpecification;
  // P3: the fill is assembled from the ONE resolved scale (classedProvinceFill),
  // the same assembly the META path and the ChoroplethEncoding value object use.
  return classedProvinceFill(features, scale);
}

/**
 * The THRESHOLD-CLASSED scale (breaks + colors) a META'd rate province choropleth
 * renders — the classed-step META path (class-scale.ts): fixed cutoffs anchored on
 * the compliance target T at [0.5T, 0.75T, T] → 4 classes (<0.5T / 0.5–0.75T /
 * 0.75–T / ≥T). PO decision (ratified in live QA): cobertura / esterilización /
 * microchip / ppp render on these fixed threshold classes, NOT the amber/teal
 * divergent scale they used before — the meta breaks are comparable across
 * jurisdictions and stable over time, and the classes read at a glance on the navy
 * canvas.
 *
 * Frame-stable BY CONSTRUCTION: the breaks depend only on the target, never on the
 * frame's values, so a time-scrub needs no domain lock here (contrast the
 * sequential path, which locks its quantile domain). The single source of truth
 * shared by the map fill (provinceMetaColorExpr) and the off-canvas legend swatches
 * (lifted through SituationalMap, parity with provinceSeqClassScale). Returns null
 * when the layer has no numeric values (the fill paints all neutral).
 */
export function provinceMetaClassScale(
  features: FeatureCollection,
  target: number,
): ClassScale | null {
  for (const f of features.features) {
    const p = f.properties as ProvinceFeatureProps;
    if (typeof p.provinceCode === "string" && isFiniteValue(p.value)) {
      // The META path ignores the value set (breaks come from the target only);
      // an empty array is enough to trigger it once we know data exists.
      return computeClassScale([], { target });
    }
  }
  return null;
}

/**
 * Build the data-driven `fill-color` for a META'd rate province choropleth — the
 * classed-step META replacement for the divergent path (see provinceMetaClassScale).
 *  1. a `match` maps each province code → its value (default -1 = "no data");
 *  2. provinces with no value (-1) get COLOR_NO_DATA (k-anon honesty: a suppressed
 *     or absent cell never enters a color class — the short-circuit stays in front);
 *  3. the rest are THRESHOLD-CLASSED into the dark-map ramp via a MapLibre
 *     `["step", …]` expression using the META breaks [0.5T, 0.75T, T].
 * Returns a flat COLOR_NO_DATA expression when the layer has no values.
 */
export function provinceMetaColorExpr(
  features: FeatureCollection,
  target: number,
): ExpressionSpecification {
  // The META scale's breaks come from the target only ([0.5T, 0.75T, T]) — frame-
  // stable, value-independent. P3: assembled through the SAME classedProvinceFill
  // as the sequential path (single fill assembly), from the ONE resolved scale.
  return classedProvinceFill(features, computeClassScale([], { target }));
}

/** Compute the value min/max for a province layer's features (scale legend).
 * Returns null when the layer has no numeric values. */
export function provinceValueBounds(features: FeatureCollection): ScaleBounds | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const f of features.features) {
    const v = (f.properties as ProvinceFeatureProps).value;
    if (!isFiniteValue(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}

/**
 * The legend entry for a province choropleth: the scale that paints it, plus the
 * TRUE extremes of what it paints.
 *
 * Built here, next to the scale, so the legend and the ramp can never be derived
 * from different sets — the drift that let Mortalidad publish "4 … 15" over data
 * running 24,6 → 80,7 (P1-F3).
 */
export function provinceSeqLegendEntry(
  scale: ClassScale,
  features: FeatureCollection,
): { breaks: number[]; colors: string[]; extent?: { min: number; max: number } } {
  return {
    breaks: scale.breaks,
    colors: scale.colors,
    extent: provinceValueExtent(features) ?? undefined,
  };
}

/** The province scale for a LAYER, reading its declared polarity (D4). */
export function provinceSeqScaleForLayer(
  layer: { features: FeatureCollection; higherIsBetter?: boolean },
  lockedBreaks?: readonly number[] | null,
): ClassScale | null {
  return provinceSeqClassScale(layer.features, lockedBreaks, {
    invert: layer.higherIsBetter === true,
  });
}
