// Panorama (Centro de Situación Nacional) — pure domain types.
//
// Hexagonal-lite domain layer: NO @/db, NO next, NO React. The biome
// `noRestrictedImports` override for src/modules/*/domain/** enforces this, so
// this module is provably free of infrastructure/framework coupling.
//
// Spec: docs/superpowers/specs/2026-06-21-national-situational-console-design.md
// Plan: docs/superpowers/plans/2026-06-21-national-situational-console.md (F1).

/** The v1 layer catalogue (spec §4 / §13.5). Adding a layer = a new id here +
 * a registry entry in layers.ts + a loader in the infrastructure repository. */
export type LayerId =
  | "perdidas"
  | "mordeduras"
  | "denuncias"
  | "zoonosis"
  | "sintomas"
  | "reunificacion"
  | "refugios"
  | "clinicas"
  | "decomisos"
  | "cobertura"
  | "esterilizacion"
  | "microchip"
  | "ppp"
  | "mortalidad"
  | "acceso-veterinario"
  | "antiparasitario"
  | "indice-territorial"
  | "desierto-veterinario"
  | "tendencia";

/** Point/cluster layers plot individual features; choropleth layers shade
 * locality rollups (computed via lib/metrics with k-anon suppression). */
export type GeomType = "point" | "choropleth";

/**
 * The AGGREGATION AXIS of a choropleth layer (U5). This is DISTINCT from the
 * scope filter (PanoramaScope) — the scope narrows WHAT the viewer sees; the
 * level changes HOW it is aggregated and rendered:
 *  - `locality` — per (province, locality) rollup → centroid graduated symbols
 *                 (k-anon k=5 suppression on small cells).
 *  - `province` — per provinceCode rollup → filled choropleth over the local
 *                 ar-provinces polygons. ALSO k-anon k=5 (tasks #40 / #40b): the
 *                 "province cells are large" exemption was retired — it described
 *                 a province's POPULATION, not the DENOMINATOR k protects.
 * Point layers ignore the level entirely.
 */
export type AggregationLevel = "locality" | "province";

/**
 * Privacy level of a layer's rendered geometry (spec §8).
 *  - `none`   — shown as stored: public data (lost last-seen, opt-in) or
 *               operational data the viewer is cleared for, plus k-anon rollups.
 *  - `coarse` — snapped to the locality centroid; the exact coordinate is NEVER
 *               part of the layer payload (denuncias default).
 *  - `gated`  — exact coordinate only on an authorized, audited open
 *               (emits `welfare_location_viewed`); never in the layer payload.
 */
export type LayerPrivacy = "none" | "coarse" | "gated";

/**
 * The data-type taxonomy used for F1 aggregation routing (Panorama v2).
 *
 *  - `"rate"`      — current-state rollup expressing a *rate/coverage* (cobertura).
 *                    Rendered as a province/locality choropleth. Not aggregated by
 *                    the per-unit point aggregation path.
 *  - `"density"`   — event-count-based density layer (perdidas, mordeduras, denuncias).
 *                    F1: one graduated circle per administrative unit (province or
 *                    locality) encoding the event count. Toggle axis applies.
 *  - `"signal"`    — public-health surveillance signal layer (zoonosis).
 *                    Same graduated-circle aggregation as density in F1.
 *  - `"reference"` — individual operational locations that MUST NOT be aggregated
 *                    (refugios, decomisos). Each represents a distinct entity or
 *                    expediente; spatial merging would destroy that identity.
 *                    Rendered as discrete pins regardless of the toggle axis.
 */
export type LayerDataType = "rate" | "density" | "signal" | "reference";

// --- panorama-ia-v2 descriptor extension (design §2) -------------------------

/**
 * How a layer is drawn at a given administrative level.
 *  - `choropleth-fill`  — fill the polygon (a rate at province; a rate at
 *                         locality once locality polygons exist — Fase 2).
 *  - `graduated-symbol` — bubble/circle sized (or diverging-colored) by value;
 *                         used for counts and for the interim locality path of
 *                         rate layers before real locality polygons land.
 *  - `clustered-points` — discrete pins, optionally clustered (reference layers —
 *                         never aggregated).
 */
export type RenderMode = "choropleth-fill" | "graduated-symbol" | "clustered-points";

/**
 * Per-administrative-level render policy — the design §3.1 fix for the national
 * "green blob": nationally a layer fills province polygons; entering a province
 * (scope or zoom) switches to the locality mark. `autoLevel.belowZoom` is the
 * camera threshold that forces `level` (nacional → province) regardless of the
 * point count. P4b: the render branch resolves the mark via `markForZoom`
 * (capabilities.ts) reading these declared bands against the live camera.
 */
export type RenderPolicy = {
  province: RenderMode;
  locality: RenderMode;
  /** Below this camera zoom, force `level` (nacional overview → province fill). */
  autoLevel?: { belowZoom: number; level: AggregationLevel };
  /**
   * panorama-event-points (design D5): the NEAR-ZOOM mark drawn when the layer's
   * LOD band resolves NEAR (camera ≥ Z_POINTS AND a province is in scope).
   * Absence = the layer NEVER shows real dots (reference layers): the near band
   * falls back to the `locality` mark. A7 CLOSED at P4b: the runtime now READS
   * this declaration — the capability gate projects it as
   * `representationPerZoom[layer]` and the console resolves the live band via
   * `markForZoom` (capabilities.ts); the old imperative `pointsEligible` /
   * `POINTS_LAYER_IDS` client switch is gone. `POINTS_LAYER_IDS` remains only as
   * the server-side gate's derived set (get-layer-features).
   */
  points?: RenderMode;
};

/**
 * How a k-anon-suppressed cell is drawn (spatial honesty of the k=5 rule).
 *  - `hatched` — diagonal hatch, perceptually distinct from "no data" (rate /
 *                choropleth layers, where a suppressed area must not read as
 *                a plain grey no-data polygon).
 *  - `muted`   — dimmed neutral (density-point layers; reference layers never
 *                aggregate, so this is a no-op for them).
 */
export type SuppressionStyle = "muted" | "hatched";

/**
 * Declarative raw material for the plain-language per-view caption (design §2.4).
 * The pure builder `captionFor(layer, level, period)` assembles the es-AR
 * sentence; the descriptor only declares the WORDS (never the final sentence),
 * so the domain stays framework-free.
 */
export type LayerCaption = {
  /** Unit noun per level, e.g. { province: "provincia", locality: "localidad" }. */
  unit: Record<AggregationLevel, string>;
  /** The measure in plain es-AR: "cobertura antirrábica", "denuncias de bienestar". */
  measure: string;
  /**
   * How the sentence is anchored in time:
   *  - `period`  → "últimos N días" (event-windowed layers).
   *  - `current` → "estado actual"  (current-state rollups: cobertura, mortalidad).
   */
  window: "period" | "current";
};

/** Declarative registry entry. The layer list IS the legend (spec §4). */
export type PanoramaLayer = {
  id: LayerId;
  /** Human label (es-AR) shown in the LayerPanel legend. */
  label: string;
  /**
   * Cursor red-team 2026-07-23 (claim #3) — count-truthful label for the
   * DRILLED division-fill count-fallback mode (division-fill.ts sums raw
   * per-unit COUNTS, not the rate `label` names). A `dataType: "rate"` layer
   * whose canonical label reads "Cobertura X" is a lie once the paint is a
   * bare count (e.g. "Cobertura antirrábica … (conteo)" over a 6→235 scale —
   * "cobertura" implies a percentage, not a headcount). Only set on rate
   * layers that CAN drill to a division count fill; SituationalMap.tsx's
   * division-legend builder uses `countLabel ?? label` as the ramp title's
   * source (components/panorama/panorama-labels.ts's legendRampTitle then
   * appends " (conteo)"). Omitted layers fall back to `label` unchanged.
   */
  countLabel?: string;
  /**
   * task #38 (Filtro panel): one honest es-AR method line stating EXACTLY what
   * this layer measures and how it is located — shown in the Filtro panel's
   * Detalle mode under each layer row. Written to be truthful about aggregation
   * and privacy (e.g. "ubicadas por localidad (centroide)"), never marketing
   * copy. Synergy with the KPI method notes (task #15).
   */
  description: string;
  geomType: GeomType;
  /** Loader key the infrastructure repository switches on (e.g. "pet_events:lost"). */
  source: string;
  /** Legend swatch color (hex). */
  color: string;
  /** Whether features are filtered by the viewer's jurisdiction scope.
   * Govt always intersects with its assigned jurisdiction; admin is universal. */
  scopeFilterable: boolean;
  privacy: LayerPrivacy;
  /**
   * Whether the layer is event-windowable in time (spec F4 temporal reproduction).
   * `true`  — the loader filters an `occurred_at/created_at/opened_at` so the layer
   *           can be reconstructed "as of t" while the TimeScrubber plays.
   * `false` — no usable time dimension in v1 (refugios) or a CURRENT-STATE rollup
   *           (cobertura/mortalidad are pets.status / EXISTS snapshots, not windowed).
   *           These are DIMMED while a scrub is active rather than shown as if as-of-t.
   */
  temporal: boolean;
  /**
   * F1 data-type taxonomy. Drives which aggregation/rendering path the layer
   * takes in Panorama v2:
   *  - `"rate"` / `"density"` / `"signal"` → see LayerDataType JSDoc.
   *  - `"reference"` → discrete pins; never aggregated by the point-aggregation path.
   */
  dataType: LayerDataType;
  /**
   * F5: the legal/public-health ATTAINMENT target of the layer's value.
   *
   * A target is always a FLOOR to reach, never a ceiling to stay under: below it
   * is the warning pole, at/above it is the good pole. The province choropleth
   * classes on it (`isMetaLayer` → the META scale anchored at [0.5T, 0.75T, T])
   * and the ranking orders by the gap to it, worst gap first.
   *
   * Every `dataType: "rate"` layer declares one. A NON-rate layer may declare one
   * ONLY when its value is a bounded ATTAINMENT whose target is definitional
   * rather than invented — `indice-territorial` is the one case: its 0-100 score
   * IS the mean attainment of three metas, so 100 means "the three metas met",
   * not a number someone picked. A count/duration/delta layer must NOT declare a
   * target: there is no "meta de mordeduras", and classing a density on a
   * fabricated target would paint policy fiction.
   *
   * Unit: same as the layer's `value` property (percentage for cobertura: 0–100).
   */
  complianceTarget?: number;
  /**
   * POLARITY: `true` when a HIGH value is GOOD news for this layer.
   *
   * The console was polarity-BLIND for the sequential (no-target) family: the
   * ranking sorted every such layer descending under a "Peores N" title and the
   * sequential ramp darkened with value. That is right for the layers whose
   * value is an amount of harm (mortalidad, denuncias, días sin actividad
   * veterinaria, Δ de incidentes) — more IS worse — and it inverts the meaning
   * for the two layers where more is better: `acceso-veterinario` (visitas por
   * 1.000 mascotas) and `indice-territorial` (índice de cumplimiento 0-100).
   * Wiring those without declaring polarity would list the BEST-served
   * jurisdictions as "las peores" and paint them as the alarm.
   *
   * DEFAULT (absent) = higher is WORSE — today's behaviour for all 17 other
   * layers, so this is additive and no layer had to be migrated.
   *
   * Redundant-but-true on a layer that also declares a `complianceTarget`: a
   * target already tells the ranking and the fill which pole is good, so the
   * consumers that only read the target stay correct. It is declared anyway
   * because the polarity is a fact about the METRIC, and a reader should not
   * have to infer it from the presence of a second field.
   */
  higherIsBetter?: boolean;
  /**
   * new-vistas wave (tendencia): the layer's `value` is a SIGNED DELTA
   * (current window − prior equivalent window), not a magnitude. The province
   * fill renders a zero-anchored classed DIVERGING scale with INVERTED
   * polarity relative to the compliance meta scale: MORE events than before is
   * the WARNING pole, FEWER is the good pole (components/panorama/delta-scale
   * derives the classes from the validated COLOR_DIVERGENT_* tokens). Mutually
   * exclusive with `complianceTarget` — a delta has no attainment target.
   */
  deltaEncoded?: boolean;
  /**
   * What a per-unit `value` MEANS — and therefore whether it can be summed.
   *
   * The dock's "Registros" total used to be defined by EXCLUSION (sum everything
   * that is not `dataType: "rate"`), so any layer whose values are not counts
   * but whose dataType is not literally "rate" leaked into the sum. Live
   * consequences on 2026-07-25: "Registros −13.288" on Tendencia (signed deltas
   * summed), "Registros 1.394,7" on Pérdidas y reunificación (a rate summed with
   * counts), and "Registros 2.138" on Desierto veterinario (days summed).
   *
   * A negative or fractional record count on a government console destroys trust
   * in every other number on the screen, so summability is now DECLARED rather
   * than inferred: only "count" is summable, and everything else is reported as
   * a unit count instead.
   *
   * Defaults to "count" — correct for the six genuine event layers (perdidas,
   * mordeduras, denuncias, zoonosis, sintomas, mortalidad). A NEW layer whose
   * value is anything else MUST say so here.
   */
  valueKind?: "count" | "rate" | "delta" | "duration" | "index";
  /**
   * The value at which this layer STOPS MEASURING — a right-censoring bound.
   *
   * `desierto-veterinario` computes "days since the last vet visit" capped at
   * the window length, so a unit with no visit at all reports the cap. That
   * number is NOT a measurement of 90 days; it is "we stopped looking at 90",
   * and rendering it as a value produced two lies at once (2026-07-25): a
   * legend reading "90 / 90" as if that were a range, and a ranking presenting
   * a 23-way tie at the cap as if it were the ten worst jurisdictions.
   *
   * Declared here so the legend can render "≥N" and the ranking can disclose
   * the tie instead of pretending to order it. Undefined = the layer measures
   * its full range and nothing is censored.
   */
  censoredAtMax?: number;

  // --- panorama-ia-v2 descriptor extension (design §2.2) ---------------------

  /**
   * Per-level render policy (design §3.1). Resolves the "green blob": nationally
   * a layer fills province polygons; entering a province switches to the locality
   * mark. Replaces the render rule previously implicit in SituationalMap.
   */
  renderPolicy: RenderPolicy;

  /**
   * How suppressed (k<5) cells are drawn. Rate/choropleth → "hatched" (distinct
   * from no-data); density-point/reference → "muted".
   */
  suppressionStyle: SuppressionStyle;

  /** Declarative material for the plain-language per-view caption (design §2.4). */
  caption: LayerCaption;
};

// --- Typed GeoJSON (minimal subset the layers emit; RFC 7946) ----------------

/** [longitude, latitude] — GeoJSON coordinate order (RFC 7946 §3.1.1). */
export type GeoCoordinate = [number, number];

export type PointGeometry = { type: "Point"; coordinates: GeoCoordinate };

export type PanoramaFeature<P extends Record<string, unknown> = Record<string, unknown>> = {
  type: "Feature";
  /** null for a non-located feature (missing/invalid coordinate pair). */
  geometry: PointGeometry | null;
  properties: P;
};

export type FeatureCollection<P extends Record<string, unknown> = Record<string, unknown>> = {
  type: "FeatureCollection";
  features: Array<PanoramaFeature<P>>;
};

// --- Filters (spec §6) -------------------------------------------------------

export type PanoramaScope = {
  /** Always "AR" in v1. */
  country: string;
  province?: string | null;
  locality?: string | null;
};

export type PanoramaPeriod = {
  /** ISO date (inclusive lower bound). */
  from: string;
  /** ISO date (inclusive upper bound). */
  to: string;
};

export type PanoramaFilters = {
  scope: PanoramaScope;
  period: PanoramaPeriod;
  species?: string | null;
  severity?: string | null;
  caseStatus?: string | null;
};

// --- panorama-vista-redesign: per-vista metrics column ----------------------

/**
 * Stable id for a headline KPI (mirrors `PanoramaKpi.id` in
 * application/get-panorama-kpis.ts). Lives in the domain layer so
 * `PanoramaPreset.metrics` can reference it without the domain importing the
 * application layer (application → domain purity direction preserved).
 */
export type PanoramaKpiId =
  | "cobertura"
  | "esterilizacion"
  | "microchip"
  | "ppp"
  | "perdidas"
  | "reunificacion"
  | "mordeduras"
  | "zoonosis"
  | "denuncias"
  | "mortalidad";
