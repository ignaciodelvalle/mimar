// Panorama ViewState P2 — the declarative capability gate (task #65 / WS-4).
//
// `capabilitiesFor(view, runtime)` is the SINGLE pure function that answers
// "given what the operator selected (the canonical ViewState) plus the runtime
// facts a projection cannot know statically (live zoom, the caller-derived
// aggregation level), HOW must the panorama be shown?". Every surface reads THIS
// instead of re-deriving its own copy of the decision — the coherence invariant
// (map = legend = numbers = caption) stops being defended per-fix and becomes
// structurally impossible: two surfaces reading one value cannot diverge.
//
// This module REPLACES four families of scattered predicates (design §2):
//   1. isMeta ×4 — the `dataType==="rate" && complianceTarget!=null` copy-paste
//      (SituationalMap ×2, MapLegends, map-popup) → the resolved `encoding.kind`.
//   2. bivariate gating — the hardcoded `preset==="brotes-activos"` string
//      (PanoramaConsole) → `allowedControls.bivariateEligible`, a registry
//      predicate that names NO preset id.
//   3. temporal ×~10 — `layer.temporal` reads → `allowedControls.scrubber` +
//      `allowedRepresentations`.
//   4. (P4) points-mode / LOD → `representationPerZoom` (declared here from
//      `renderPolicy`; the runtime band selection is wired in P4).
//
// Pure — NO @/db, NO next, NO React, NO maplibre (hexagonal domain purity,
// enforced by the biome noRestrictedImports override for src/modules/*/domain/**).
// DERIVATION ONLY: this file computes; it never reads component state.

import { bivariatePairFor } from "./bivariate";
import { roleOf } from "./compatibility";
import { PANORAMA_LAYERS, getLayer, isTemporalLayer } from "./layers";
import { percapitaEligibleFor } from "./percapita";
import type {
  AggregationLevel,
  LayerId,
  PanoramaLayer,
  RenderMode,
  SuppressionStyle,
} from "./types";
import type { EncodingId, PanoramaViewState, Representation } from "./view-state";

// ---------------------------------------------------------------------------
// Runtime inputs — the facts a static projection cannot know
// ---------------------------------------------------------------------------

/**
 * The runtime facts the gate needs beyond the canonical ViewState.
 *
 * `level` is DERIVED (not stored) by the console from the SCOPE alone (P4c,
 * design §5.5): a committed province/locality reads the locality axis; national
 * reads province at any zoom — the camera never flips the data axis. The gate
 * ECHOES it in `capabilities.level` so every surface reads the ONE value
 * instead of re-deriving its own (design §1.1 / §4.3).
 */
export type CapabilityRuntime = {
  /** live camera zoom — the only continuous input; labels LOD bands (P4). */
  zoom: number;
  /** the caller-derived aggregation level (single source once echoed). */
  level: AggregationLevel;
};

// ---------------------------------------------------------------------------
// Output shape (design §2)
// ---------------------------------------------------------------------------

/** Which modifiers apply — replaces every scattered `layer.temporal` /
 *  preset-string read site. */
export type AllowedControls = {
  /** temporal layers present ⇒ the time-scrubber is live. */
  scrubber: boolean;
  /** scrubbing AND a temporal base ⇒ the valid/transaction bitemporal lens. */
  basisToggle: boolean;
  /** base is a rate-with-target AND a signal is active AND province level ⇒ the
   *  bivariate "riesgo de brotes" 3×3 encoding is offered. NO preset id here. */
  bivariateEligible: boolean;
  /** every aggregating active layer is a per-cápita-eligible count layer AND
   *  province level ⇒ the "por 10.000 hab." encoding is offered
   *  (panorama-percapita v1 — the registry predicate, NO preset id here). */
  percapitaEligible: boolean;
};

/**
 * The encoding for what is painted (P2 resolves `kind` only — the full first-class
 * Encoding value object, with the scale + legend model, is the P3 consolidation).
 * `kind` is the single source the former isMeta copy-paste read: `choropleth-meta`
 * for a rate layer with a compliance target, `choropleth-seq` otherwise.
 */
export type ResolvedEncoding = {
  kind: EncodingId;
  /** the feature property painted (the rollup value in v1). */
  field: string;
  /** how a k-anon-suppressed cell is drawn (from the base layer's declaration). */
  suppression: SuppressionStyle;
};

/**
 * Camera zoom at/above which points-capable layers swap their aggregated mark
 * for REAL event-location dots — with a province in scope (design D1). Moved
 * here from `situational-map-utils` at P4b: the LOD thresholds are part of the
 * layer DECLARATION the gate projects, not map-component trivia. Deeper than
 * Z_DIVISIONS (6.5): real dots are only legible — and only defensible (the
 * operator is looking INSIDE their turf) — at street scale.
 */
export const Z_POINTS = 10;

/** The representation to draw at each zoom band, per layer — declared from
 *  `renderPolicy` (design §5). P2 DECLARED it; P4b makes the map READ it against
 *  live zoom (`markForZoom`), replacing the imperative `pointsEligible` /
 *  `POINTS_LAYER_IDS` switch (A7). */
export type ZoomRepresentation = {
  /** below the locality band → the national mark (province choropleth / bubble). */
  national: RenderMode;
  /** province/locality in scope, mid zoom → the drilled mark. */
  drilled: RenderMode;
  /** near zoom in scope → real points (if `renderPolicy.points`) else drilled. */
  near: RenderMode;
  /**
   * Camera zoom below which the NATIONAL mark applies regardless of the
   * scope-derived level (from `renderPolicy.autoLevel.belowZoom`). `null` = the
   * layer never forces the national mark (reference pins render at any zoom).
   * This is the structural GHOST fix: scope-wins keeps `level="locality"` at any
   * zoom, so before P4b a scoped operator zooming out to the national frame
   * painted hundreds of stale locality marks — the declared autoLevel was never
   * read at runtime.
   */
  nationalBelowZoom: number | null;
  /** Camera zoom at/above which — with a province in scope — the NEAR band applies. */
  nearAtZoom: number;
  /** near is a REAL-dots mark that needs the dedicated points fetch. */
  pointsCapable: boolean;
};

/** The LOD band the camera is in for one layer (design §5). */
export type ZoomBand = "national" | "drilled" | "near";

/**
 * P4b — resolve the LOD band + mark for one layer at the live camera. Pure
 * `(declaration, zoom, scope) → mark`: evaluated on every render, so no stale
 * imperative state can linger (the A7 fix). Band boundaries come from the
 * layer's own declaration; the near band additionally requires a province in
 * scope (real dots are an inside-your-turf mark — the server independently
 * re-derives this, see get-layer-features).
 */
export function markForZoom(
  rep: ZoomRepresentation,
  zoom: number,
  provinceInScope: boolean,
): { band: ZoomBand; mark: RenderMode } {
  if (provinceInScope && zoom >= rep.nearAtZoom) return { band: "near", mark: rep.near };
  if (rep.nationalBelowZoom !== null && zoom < rep.nationalBelowZoom) {
    return { band: "national", mark: rep.national };
  }
  return { band: "drilled", mark: rep.drilled };
}

/**
 * es-AR disclosure shown on a layer row when its live LOD band paints the coarser
 * province/national rollup while the operator has drilled into a province/locality
 * scope. Matches the panel's secondary-hint copy tone (plain, says what is happening
 * and what to do).
 */
export const LOD_PROVINCE_ROLLUP_HINT =
  "Vista provincial por el nivel de zoom — acercá para ver el detalle.";

/**
 * Pure derivation for the LOD-band disclosure (panorama campaign C2 coherence
 * canon: label = number = map = table). A layer whose declared zoom band resolved
 * `national` while the console scope/level is a drilled province or locality is
 * silently painting a coarser rollup than the scope suggests — the exact gap the PO
 * flagged ("algunas capas te sacan del zoom pero el scope queda en localidad").
 * Surface a per-row hint so the operator understands why the mark is coarse and how
 * to get the detail. Reference layers (refugios/decomisos — always discrete pins,
 * `nationalBelowZoom = null`, never national) and the national overview
 * (`scopeIsDrilled = false`, the national band is expected) show nothing. Purely
 * presentational — never mutates camera, scope, or level.
 *
 * @returns the hint string to render, or `null` when no disclosure is warranted.
 */
export function lodProvinceRollupHint(args: {
  band: ZoomBand;
  /** The console scope/level is a drilled province or locality (not national overview). */
  scopeIsDrilled: boolean;
  /** Reference layers (refugios/decomisos) are exempt — they always render pins. */
  isReferenceLayer: boolean;
}): string | null {
  const { band, scopeIsDrilled, isReferenceLayer } = args;
  if (isReferenceLayer) return null;
  if (!scopeIsDrilled) return null;
  return band === "national" ? LOD_PROVINCE_ROLLUP_HINT : null;
}

/**
 * A selectable MAP MODE (task #24 — the "Modo" switcher, IA axis 2: how the map
 * paints). `"auto"` is the layer-derived encoding (choropleth-seq/meta,
 * graduated, reference — whatever the base implies); every other entry is an
 * explicit `EncodingId` the current view is ELIGIBLE for. The #33 viz-suite
 * modes (delta, reporting-lag, as-of, heatmap) extend this list — declared
 * here, never as ad-hoc console toggles, so availability stays structural.
 */
export type MapMode = "auto" | EncodingId;

export type PanoramaCapabilities = {
  /** the resolved aggregation level — DERIVED, echoed as the single source. */
  level: AggregationLevel;
  /** which modifiers apply. */
  allowedControls: AllowedControls;
  /**
   * The map modes the CURRENT view may select (task #24, always ≥ ["auto"]).
   * One switcher on the map projects this list; a mode that does not apply is
   * ABSENT, not disabled — the operator sees the options that exist.
   */
  mapModes: MapMode[];
  /** which dock tabs / representations light up (temporal off ⇒ no timeline). */
  allowedRepresentations: Representation[];
  /** the encoding for what is painted (scale ALWAYS matches paint — P3 structural). */
  encoding: ResolvedEncoding;
  /** CABA inset: visibility + the SAME encoding the main map uses (P3 structural). */
  insetBehavior: { visible: boolean; encoding: ResolvedEncoding | null };
  /** LOD — the representation per zoom band, per active layer (P4 wires the read). */
  representationPerZoom: Record<string, ZoomRepresentation>;
};

// ---------------------------------------------------------------------------
// Shared registry predicates — the SINGLE definition every former copy reads.
// ---------------------------------------------------------------------------

/** The minimal shape the META predicate needs — every isMeta call site (an
 *  ActiveLayer, a legend row, a popup readout input) is structurally compatible. */
export type MetaLayerLike = { dataType?: string; complianceTarget?: number };

/**
 * The former `isMeta` predicate, defined ONCE. A layer with an ATTAINMENT TARGET
 * renders the classed-step META choropleth (`choropleth-meta`) — fixed cutoffs
 * at [0.5T, 0.75T, T], where the dark class is the met meta; every other
 * choropleth base renders the sequential scale (`choropleth-seq`), where the
 * dark class is simply "more". This is the single source the four copy-pasted
 * call sites read, so they cannot drift from each other or from the gate's
 * resolved `encoding.kind`.
 *
 * WIDENED 2026-07-26: it used to also require `dataType === "rate"`, which
 * conflated two independent axes — the AGGREGATION routing (what dataType is
 * for) and whether the value has a meta to be read against. The cost was paid by
 * `indice-territorial`: a 0-100 attainment score routed as a density, so it fell
 * to the sequential ramp and painted the best-performing provinces the same dark
 * "more of it" colour the harm layers use. What makes a scale a meta scale is
 * the target, so the predicate now asks only for the target. No existing layer
 * changes behaviour — until this commit only rate layers declared one, and
 * `complianceTarget` is documented as an attainment floor for every dataType.
 */
export function isMetaLayer<T extends MetaLayerLike>(
  layer: T,
): layer is T & { complianceTarget: number } {
  return typeof layer.complianceTarget === "number";
}

/** The base (rate|density) layer among the active set, or null. F2 guarantees at
 *  most one base is active — EXCEPT a declared bivariate pair (ppp × mordeduras),
 *  where a density point overlay legally stacks over a rate choropleth SURFACE.
 *  The surface (geomType choropleth) is the encoding-driving base then, so a
 *  choropleth base wins over a point base deterministically (never the active
 *  list's iteration order, which follows the registry, not the activation). */
function baseLayerOf(layers: readonly LayerId[]): PanoramaLayer | null {
  let pointBase: PanoramaLayer | null = null;
  for (const id of layers) {
    const layer = getLayer(id);
    if (!layer || roleOf(layer) !== "base") continue;
    if (layer.geomType === "choropleth") return layer;
    if (pointBase === null) pointBase = layer;
  }
  return pointBase;
}

/**
 * Bivariate eligibility. The "riesgo de brotes" 3×3 encoding crosses a coverage
 * axis with an outbreak-signal axis at province framing.
 *
 * GENERALIZED to the declared-pair table (new-vistas wave; the P3 the P2 review
 * anticipated): eligibility is `bivariatePairFor(layers) !== null` at province
 * framing. Still NEVER a shape predicate — a broad "any rate × any count" rule
 * would offer the toggle for hand-edited combos nobody vetted (the original P2
 * concern, kept). The join reads the pair the console resolves, so an offered
 * toggle is by construction one the join can render. Layer ids, not preset ids
 * (design §2.1).
 */
export function bivariateEligibleFor(layers: readonly LayerId[], level: AggregationLevel): boolean {
  if (level !== "province") return false;
  return bivariatePairFor(layers) !== null;
}

/** Resolve the base layer's encoding kind (design §3 — P2 resolves kind only). */
function resolveEncoding(base: PanoramaLayer | null): ResolvedEncoding {
  if (base === null) {
    return { kind: "choropleth-seq", field: "value", suppression: "muted" };
  }
  let kind: EncodingId;
  if (base.geomType === "choropleth") {
    kind = isMetaLayer(base) ? "choropleth-meta" : "choropleth-seq";
  } else if (roleOf(base) === "reference") {
    kind = "reference";
  } else {
    // density / signal point base → aggregated graduated symbols. The near-zoom
    // real-points swap is an LOD band (representationPerZoom), resolved at P4.
    kind = "graduated";
  }
  return { kind, field: "value", suppression: base.suppressionStyle };
}

/** Declare the per-zoom-band representation for one layer from its renderPolicy. */
function zoomRepresentationOf(layer: PanoramaLayer): ZoomRepresentation {
  const rp = layer.renderPolicy;
  return {
    national: rp.province,
    drilled: rp.locality,
    near: rp.points ?? rp.locality,
    nationalBelowZoom: rp.autoLevel ? rp.autoLevel.belowZoom : null,
    nearAtZoom: Z_POINTS,
    pointsCapable: rp.points != null,
  };
}

/**
 * The per-layer zoom representation, precomputed ONCE from the static registry
 * (renderPolicy never changes at runtime). This is the SAME value
 * `capabilitiesFor` exposes per active layer — exported so render-path memos
 * that run before the gate memo (the console's activeLayers assembly) read the
 * one declaration instead of re-deriving their own copy.
 */
export const ZOOM_REPRESENTATIONS: Readonly<Record<LayerId, ZoomRepresentation>> = (() => {
  const out = {} as Record<LayerId, ZoomRepresentation>;
  for (const layer of PANORAMA_LAYERS) out[layer.id] = zoomRepresentationOf(layer);
  return out;
})();

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * The declarative capability gate. Pure `(view, runtime) → capabilities`. Every
 * panorama surface projects from this ONE value; none re-derives its own.
 */
export function capabilitiesFor(
  view: PanoramaViewState,
  runtime: CapabilityRuntime,
): PanoramaCapabilities {
  const { level } = runtime;
  const layers = view.layers;
  const base = baseLayerOf(layers);

  // Temporal: the scrubber is live iff at least one active layer is event-
  // windowable (isTemporalLayer over the ACTIVE set) — the aggregate that the
  // scattered `temporalAvailable` read reproduced.
  const scrubber = layers.some((id) => isTemporalLayer(id));
  const scrubbing = view.asOf !== null;
  const basisToggle = scrubbing && base !== null && isTemporalLayer(base.id);

  const bivariateEligible = bivariateEligibleFor(layers, level);
  const percapitaEligible = percapitaEligibleFor(layers, level);

  // Representations: registros + stats are always available; the timeline
  // (temporal reproduction) lights up only when the scrubber is live.
  const allowedRepresentations: Representation[] = ["registros", "stats"];
  if (scrubber) allowedRepresentations.push("timeline");

  const encoding = resolveEncoding(base);

  const representationPerZoom: Record<string, ZoomRepresentation> = {};
  for (const id of layers) {
    const rep = ZOOM_REPRESENTATIONS[id];
    if (rep) representationPerZoom[id] = rep;
  }

  // CABA inset: it projects the SAME encoding the main map paints (P3 structural).
  // Visibility depends on the live camera bbox (a runtime the map owns), so the
  // gate exposes the encoding the inset MUST adopt; the map supplies visibility.
  const insetBehavior = {
    visible: level === "province",
    encoding: base !== null ? encoding : null,
  };

  // task #24 — the declarative mode list the "Modo" switcher projects. "auto"
  // always; "bivariate" / "percapita" when the view is eligible. #33 modes
  // append here.
  const mapModes: MapMode[] = ["auto"];
  if (bivariateEligible) mapModes.push("bivariate");
  if (percapitaEligible) mapModes.push("percapita");

  return {
    level,
    allowedControls: { scrubber, basisToggle, bivariateEligible, percapitaEligible },
    mapModes,
    allowedRepresentations,
    encoding,
    insetBehavior,
    representationPerZoom,
  };
}
