// Panorama ViewState P3 — the first-class `Encoding` value object (task #65 / WS-4).
//
// An encoding = (data field, scale, legend, suppression style), declared once and
// resolved for the active base layer. This module is the PRESENTATION-layer home
// of that value object: it owns the ONE resolved `scale` object from which BOTH
// the MapLibre fill AND the off-canvas legend are derived, so "scale matches paint"
// stops being defended per-fix (the inline `isMeta` copy-paste + a legend recompute
// that could drift from the fill) and becomes STRUCTURAL — the fill, the legend
// swatches, and the CABA-inset flat fill all read the SAME `scale`.
//
// WHY here and not the domain gate (src/modules/panorama/domain/capabilities.ts):
// the gate resolves the encoding KIND (`choropleth-meta` vs `choropleth-seq`) purely
// (design §3, P2) and stays free of maplibre by hexagonal purity. The RESOLVED scale
// carries a MapLibre `ExpressionSpecification` (the fill) and is built from the
// layer's loaded feature data + the scrub-lock breaks the React map layer owns —
// runtime facts that belong in the presentation layer. So the gate names the kind;
// this value object carries the kind's scale + fill + legend. The kind vocabulary is
// the gate's (`isMetaLayer`), imported so the two cannot disagree on what META means.
//
// SCOPE (P3, this pass): the classed CHOROPLETH encodings (sequential + META) — the
// drift-prone pair that shared `computeClassScale` yet branched at four call sites.
// The bivariate (bivariate-fill.ts: one palette constant feeds fill + legend) and
// graduated (graduated-scale.ts: one GraduatedScale lifted to fill + legend) systems
// are ALREADY single-source by construction; they are declared as their own encodings
// when the domain-gate scale-carrying lands (see the P4/P5 deferral in the plan).
//
// English identifiers, es-AR user copy (project invariant #4).

import type { ExpressionSpecification } from "maplibre-gl";

import {
  type ClassScale,
  type ClassSwatch,
  classSwatches,
} from "@/components/panorama/class-scale";
import { deltaProvinceClassScale } from "@/components/panorama/delta-scale";
import {
  classedProvinceFill,
  provinceMetaClassScale,
  provinceSeqClassScale,
} from "@/components/panorama/province-choropleth-style";
import { isMetaLayer } from "@/src/modules/panorama/domain/capabilities";
import type { FeatureCollection } from "@/src/modules/panorama/domain/types";

/** The classed-choropleth encoding kinds this value object resolves (a subset of
 *  the domain gate's EncodingId — the two that share the ClassScale machinery). */
export type ChoroplethEncodingKind = "choropleth-seq" | "choropleth-meta";

/** The minimal layer shape the resolver reads (structurally an ActiveLayer). */
export type ChoroplethLayerLike = {
  features: FeatureCollection;
  dataType?: string;
  complianceTarget?: number;
  /** POLARITY: a HIGH value is GOOD news → the SEQUENTIAL ramp runs backwards
   *  (PanoramaLayer.higherIsBetter). Ignored on the META path, where the target
   *  already declares the good pole, and on the delta path, which anchors at 0. */
  higherIsBetter?: boolean;
  /** new-vistas wave: the value is a SIGNED DELTA → zero-anchored diverging
   *  classes (delta-scale.ts) instead of the quantile/META paths. */
  deltaEncoded?: boolean;
};

/**
 * The first-class choropleth encoding value object: the ONE resolved `scale` and
 * everything derived from it. The fill (`fillColorExpr`), the legend (`legend`),
 * and any off-map sampling (`scale`, read by the CABA-inset flat fill via
 * `colorForValue`) are ALL built from `scale` — they cannot drift.
 */
export type ChoroplethEncoding = {
  kind: ChoroplethEncodingKind;
  /** THE single resolved scale — the fill, legend, and inset flat-fill all read this. */
  scale: ClassScale;
  /** MapLibre `fill-color` — built from `scale` via the shared classedProvinceFill. */
  fillColorExpr: ExpressionSpecification;
  /** Off-canvas legend swatch rows — built from the SAME `scale` via classSwatches. */
  legend: ClassSwatch[];
  /** "%" for META'd rate layers; undefined for sequential layers. */
  unit?: string;
  /** Whether the top (open-above) class is the compliance target ("≥ 80% (meta)"). */
  meta: boolean;
};

/**
 * Resolve the first-class choropleth encoding for a province base layer, or null
 * when the layer carries no numeric values (the caller paints neutral —
 * COLOR_NO_DATA — exactly as the standalone fill functions did).
 *
 * @param opts.lockedSeqBreaks the scrub-frozen live-edge QUANTILE breaks for the
 *   SEQUENTIAL path (the React map layer owns the lock and passes them in). Ignored
 *   for the META path, whose target-anchored breaks are frame-stable by construction.
 *
 * The encoding KIND is decided by the ONE shared registry predicate `isMetaLayer`
 * (the gate's `encoding.kind` source) — never a local copy of the rate+target check.
 */
export function resolveChoroplethEncoding(
  layer: ChoroplethLayerLike,
  opts?: { lockedSeqBreaks?: readonly number[] | null },
): ChoroplethEncoding | null {
  // Delta-encoded layer (tendencia): zero-anchored diverging classes with
  // inverted polarity — resolved FIRST so a delta can never fall into the
  // quantile path (which would class all-positive deltas as ordinary blues).
  // The 0 anchor is frame-stable, so no scrub-lock breaks apply here (META
  // precedent: anchored breaks are frame-stable by construction).
  if (layer.deltaEncoded === true) {
    const scale = deltaProvinceClassScale(layer.features);
    if (scale === null) return null;
    return {
      kind: "choropleth-seq",
      scale,
      fillColorExpr: classedProvinceFill(layer.features, scale),
      legend: classSwatches(scale),
      meta: false,
    };
  }
  if (isMetaLayer(layer)) {
    const scale = provinceMetaClassScale(layer.features, layer.complianceTarget);
    if (scale === null) return null;
    return {
      kind: "choropleth-meta",
      scale,
      fillColorExpr: classedProvinceFill(layer.features, scale),
      legend: classSwatches(scale),
      unit: "%",
      meta: true,
    };
  }
  // Sequential (quantile) path — the ONE place a target-less layer's declared
  // polarity has to be honoured, or a higher-is-better layer paints its
  // best-served units the alarm colour.
  const scale = provinceSeqClassScale(layer.features, opts?.lockedSeqBreaks ?? null, {
    invert: layer.higherIsBetter === true,
  });
  if (scale === null) return null;
  return {
    kind: "choropleth-seq",
    scale,
    fillColorExpr: classedProvinceFill(layer.features, scale),
    legend: classSwatches(scale),
    meta: false,
  };
}
