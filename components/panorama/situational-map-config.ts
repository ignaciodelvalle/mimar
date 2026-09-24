// SituationalMap — module-level types, constants, id-namespacing helpers, and
// pure per-layer maplibre helpers (removeLayer / applyDim / pointPopupHtml).
//
// Extracted mechanically from SituationalMap.tsx (file-size split, behavior-
// preserving): everything here is standalone (no closure over the component's
// map ref / state) and unchanged, only moved. SituationalMap.tsx re-exports
// `PointRenderMode`, `ActiveLayer`, `DivisionLegendDescriptor`, and
// `ProvinceSeqLegend` so external imports keep working unchanged.

// Namespace type import, not a default import: maplibre-gl v6 is ESM-only
// and publishes NO default export, so `import type maplibregl from ...` no
// longer names anything. The namespace carries the same type members, which
// is what keeps every `maplibregl.Xxx` reference below unchanged.
import type * as maplibregl from "maplibre-gl";
import type { ReactNode } from "react";

import {
  INCIDENT_LABEL,
  PET_STATUS_LABEL,
  SEVERITY_LABEL,
} from "@/components/panorama/DetailDrawer";
import { fetchGeojsonCached } from "@/components/panorama/geojson-cache";
import type { GraduatedScale } from "@/components/panorama/graduated-scale";
import { HATCH_IMAGE_ID } from "@/components/panorama/hatch-pattern";
import {
  FRAMING_SNAP_MAX_ZOOM,
  shouldSnapFraming,
} from "@/components/panorama/situational-map-utils";
import { AR_BBOX } from "@/lib/ui/map-bounds";
import type { MapCamera } from "@/lib/ui/map-layer-nav";
import { escapeHtml } from "@/lib/utils/escape-html";
import { formatDate } from "@/lib/utils/format";
import type { BivariateCell, BivariatePair } from "@/src/modules/panorama/domain/bivariate";
import type { PresetFraming } from "@/src/modules/panorama/domain/presets";
import type { AggregationLevel, FeatureCollection } from "@/src/modules/panorama/domain/types";
import { COLOR_SUPPRESSED } from "@dim/contract/viz";

// ---------------------------------------------------------------------------
// SituationalMap — the Panorama console's geospatial canvas.
//
// PRIVACY (spec §13.4): the basemap is built ENTIRELY from a local GeoJSON
// asset (public/geo/ar-provinces.geojson). There is NO external tile/glyph
// provider — a government situational map must not beacon the operator's
// viewport or the plotted locations to a third party. This is why we do NOT
// reuse components/charts/MapChoropleth's OpenStreetMap raster style.
//
// Because we ship no glyph server, map layers carry NO on-canvas text; counts
// and details are surfaced via HTML popups (same approach as MapChoropleth).
//
// Slice 2 renders MULTIPLE simultaneous layers:
//   - point layers (clustered natively by MapLibre), and
//   - graduated-symbol choropleth layers (circle radius + color by value;
//     suppressed cells muted via COLOR_SUPPRESSED).
// Layers are added/removed dynamically as the LayerPanel toggles them. The map
// keeps a registry of mounted layer ids and reconciles against the prop on each
// render. Perdidas is the default-on layer (mounted by the parent on load).
// ---------------------------------------------------------------------------

/**
 * The rendering mode for a point-geometry layer (F1 Panorama v2).
 *
 *  - `"graduated"` — density+signal layers: one NON-clustered circle per
 *    administrative unit, radius scaled by the feature's `count` property.
 *    The toggle axis (province/locality) drives which granularity was used
 *    server-side; the client renders whatever the server sent.
 *  - `"reference"` — individual-entity layers (refugios, decomisos): discrete
 *    pins with MapLibre native clustering. The toggle axis is ignored for these.
 *  - `"points"` — panorama-event-points Slice 1: REAL event-location dots
 *    (perdidas sightings) at near zoom inside a jurisdiction. Shares the
 *    reference clustered-pin renderer (design D3) with per-layer color; an
 *    individual dot opens the DetailDrawer (the pet card the operator already
 *    accesses — no new PII surface, D7).
 */
export type PointRenderMode = "graduated" | "reference" | "points";

/** One active layer the map must render. `geomType` decides point vs choropleth;
 * for point layers, `renderMode` further decides graduated (F1) vs discrete pins. */
export type ActiveLayer = {
  id: string;
  color: string;
  label: string;
  /** Claim #3 (cursor red-team 2026-07-23) — count-truthful label for the
   *  division-fill count-fallback mode, threaded from PanoramaLayer.countLabel.
   *  Undefined for layers that don't declare one (falls back to `label`). */
  countLabel?: string;
  geomType: "point" | "choropleth";
  /**
   * Point-layer rendering mode (F1 Panorama v2). Only set for geomType="point":
   *   - `"graduated"` → density/signal layers: per-unit circles sized by count.
   *   - `"reference"` → reference layers: discrete pins with native MapLibre clustering.
   * Undefined (or ignored) for choropleth layers.
   */
  renderMode?: PointRenderMode;
  features: FeatureCollection;
  /**
   * U5 aggregation axis (choropleth layers only, and graduated point layers).
   * For choropleth: "province" → fill the local ar-provinces polygons by value;
   * "locality" → centroid graduated symbols. For graduated point layers: reflects
   * which grouping the server used (province or locality). Reference layers and
   * choropleth layers leave this following U5 semantics.
   */
  level?: AggregationLevel;
  /** F4: muted while a time scrub is active because the layer has no time
   * dimension (refugios) or is a current-state rollup (cobertura/mortalidad) —
   * it shows live data, not as-of-t, so it is rendered dimmed (not as if as-of). */
  dimmed?: boolean;
  /**
   * F5: the layer's data-type taxonomy from the registry (threaded from
   * PanoramaLayer.dataType). Used to choose the divergent vs sequential
   * choropleth rendering path. Undefined for layers that pre-date F5 or for
   * point layers where dataType drives aggregation, not coloring.
   */
  dataType?: "rate" | "density" | "signal" | "reference";
  /**
   * F5: compliance target for `dataType: "rate"` layers (e.g. 80 for the
   * antirrábica 80% legal goal). When present alongside `dataType === "rate"`,
   * the province choropleth renders as a DIVERGENT scale anchored at this value.
   * Undefined for density/signal/reference layers (sequential coloring).
   */
  complianceTarget?: number;
  /**
   * POLARITY (PanoramaLayer.higherIsBetter): `true` when a HIGH value is GOOD
   * news, so the SEQUENTIAL ramp must be reversed and the darkest class must
   * land on the LOWEST value. Only meaningful for a target-less sequential
   * choropleth — a `complianceTarget` already declares which pole is good, and
   * the META scale reads it. Absent = higher is worse (every other layer).
   */
  higherIsBetter?: boolean;
  /**
   * new-vistas wave (tendencia): the layer's `value` is a SIGNED DELTA — the
   * province fill renders the zero-anchored diverging classes (delta-scale.ts)
   * instead of the quantile/META paths. Threaded from the layer registry.
   */
  deltaEncoded?: boolean;
  /**
   * map-QOL: per-layer opacity multiplier 0.2..1 (default 1), set from the
   * Personalizar panel. Multiplies the layer's base opacity expressions — the
   * suppressed-cell muting and the F4 dim behavior are preserved underneath.
   */
  opacity?: number;
  /**
   * task #63 (bivariate "riesgo-brotes"): when present, this province choropleth
   * is rendered as the 3×3 bivariate encoding (coverage terciles × signal
   * terciles) INSTEAD of its normal single-value fill. The cells carry both raw
   * values, both classes, and the k-anon suppression that PROPAGATED from either
   * input (a suppressed province is hatched, never colored). Only meaningful for
   * a province-level choropleth layer. Absent → normal single-value rendering.
   */
  bivariateCells?: BivariateCell[];
  /**
   * new-vistas wave: the declared axis pair behind `bivariateCells` — carries
   * the es-AR axis vocabulary (popup row labels, legend axes/title) so every
   * surface names the SAME crossed axes. Absent → the original brotes wording.
   */
  bivariatePair?: BivariatePair;
  /**
   * panorama-percapita: this graduated layer's `count` props carry PER-10K RATES
   * (the console's projectPerCapita swap), not raw counts. The graduated scale
   * then builds in FRACTIONAL mode — per-10k maxima are routinely < 1 and the
   * integer flooring would collapse the scale (no legend, floor-size bubbles).
   */
  perCapita?: boolean;
};

/**
 * Legend descriptor for the active locality-choropleth DIVISION fill (min/max
 * over the visible barrio/departamento polygons). Computed inside syncLayers
 * (from the rendered division data) and lifted to the console so the "Referencias"
 * rail section can render this legend off-canvas (ARCHETYPE A).
 */
export type DivisionLegendDescriptor = {
  label: string;
  unitNoun: string;
  min: number;
  max: number;
  /** Whether a value ramp is shown (there is at least one visible division). */
  hasRamp: boolean;
  /**
   * panorama redesign Theme 3 — the THRESHOLD-CLASSED breaks + colors actually
   * rendered on the map (computed from the same values + locked domain the fill
   * expression uses, so the off-canvas legend swatches never disagree with the
   * on-map class colors). Empty for a flat single-class fill.
   */
  breaks: number[];
  colors: string[];
  /**
   * cursor #2 — at least one visible division is k-anon suppressed (hatched), so
   * the legend shows the "Suprimido (k-anon)" hatch swatch.
   */
  suppressed: boolean;
  /**
   * RA-7 F9 — at least one polygon in the division source is neither valued nor
   * suppressed, i.e. the no-data STIPPLE is actually painted, so the legend may
   * show its "Sin datos (solo contorno)" key. Lifted (not recomputed in the
   * legend) because only syncLayers knows how many polygons the shared division
   * source holds; see `divisionPaintsNoData`. Optional so an older serialized
   * descriptor keeps rendering the key — absence means "unknown", and for a key
   * that already over-rendered, unknown must not silently start hiding it.
   */
  noData?: boolean;
};

/**
 * The THRESHOLD-CLASSED breaks + colors a SEQUENTIAL province choropleth renders,
 * keyed by layer id. Lifted from syncLayers (computed WITH the scrub-locked
 * `seqDomain` where a scrub is active) exactly like DivisionLegendDescriptor, so
 * the off-canvas province legend swatch ranges describe the PAINTED colors — even
 * mid-scrub, where a per-frame recompute would diverge from the locked map fill.
 * META'd rate layers are ALSO lifted here (their breaks are fixed by the compliance
 * target, so frame-stable and lift-parity-safe without a scrub lock).
 */
export type ProvinceSeqLegend = Record<
  string,
  {
    breaks: number[];
    colors: string[];
    /**
     * True min/max of the values this layer paints. The legend's endpoints come
     * from here; `breaks` are interior class boundaries and describe the
     * classifier, not the data (P1-F3 — Mortalidad published "4 … 15" against a
     * real 24,6 → 80,7, on an exportable PNG).
     */
    extent?: { min: number; max: number };
  }
>;

export type SituationalMapProps = {
  /** The set of currently-active layers (perdidas default-on). */
  layers: ActiveLayer[];
  /** Accessible name for the map region. */
  label: string;
  /** Map height: a px number, or any valid CSS height (e.g. a `clamp()`). */
  height?: number | string;
  /**
   * Fired when an INDIVIDUAL feature is clicked (not a cluster — clusters zoom).
   * Bubbles the layer id + the feature's GeoJSON properties up to the console,
   * which opens the DetailDrawer. Choropleth cells and points both emit this.
   */
  onFeatureClick?: (layerId: string, properties: Record<string, unknown>) => void;
  /**
   * Click-to-drill (task #55): fired when a PROVINCE polygon is clicked at
   * NATIONAL scope. The console commits the province to the scope (reusing the
   * existing `?province` param + the JurisdictionSwitcher full-navigation
   * pattern) so the scope-wins rule forces locality/department level and the map
   * re-renders the province's divisions. Absent → province clicks fall back to
   * pinning the popup (no drill target).
   */
  onProvinceDrill?: (provinceCode: string) => void;
  /**
   * Click-to-drill: fired by the in-map "← Volver" control to pop the scope drill
   * back to the national view. Provided ONLY when the operator can return to
   * national (an explicit province pick, not a forced jurisdiction) — its
   * presence is what renders the control.
   */
  onReturnNational?: () => void;
  /**
   * Pre-zoomed bounding box for the map's initial viewport.
   * When provided (govt operators with assigned jurisdictions), the map opens
   * fitted to this bbox instead of the data-extent bbox.
   * Admin (no assigned jurisdictions) leaves this undefined and keeps the
   * national/data-extent fit.
   */
  initialBounds?: [[number, number], [number, number]];
  /**
   * Q12: TRUE only for an operator whose HOME is a bounded jurisdiction (a govt
   * actor with assigned jurisdictions). Drives the reset-view control's copy so
   * only a bounded operator reads "Volver a mi jurisdicción"; admin/universal
   * reads "Vista nacional". NOT derivable from `initialBounds` alone — a DRILLED
   * admin also receives `initialBounds` (the drilled province bbox) yet has no
   * personal jurisdiction. Undefined/false → admin/universal.
   */
  boundedJurisdiction?: boolean;
  /**
   * H14 (cowork QA): frame the `selectedProvinceCode` polygon ONCE on load even
   * when a server `initialBounds` was supplied. Set by the console only for a
   * deep link that pins an explicit ?province with NO restored camera and an
   * un-pinned operator — so a shared province URL flies the camera exactly like a
   * click/select drill does, instead of stranding the view at national.
   */
  frameProvinceOnLoad?: boolean;
  /**
   * H14 (cowork QA H2): the active base is a RATE coverage layer drilled below
   * province, where coverage is not computed (repository V1 limitation). Swaps the
   * generic "Sin datos" empty overlay for an honest "la cobertura se calcula solo a
   * nivel provincia" so the operator does not read it as "no coverage here".
   */
  rateProvinceOnlyEmpty?: boolean;
  /**
   * Panorama QA 2026-07-14: TRUE when an ACTIVE layer's last fetch was the
   * server's budget/failure fallback (a timeout, not data). The empty overlay
   * must read "no pudimos calcular esta capa a tiempo", never "sin datos" —
   * the PBA cobertura drill painted a silent blank for exactly this case.
   */
  layerDegraded?: boolean;
  /**
   * Cowork QA ronda 3 §5 (privacy invariant §5 / C3): TRUE when the active base
   * layer HAS a scope-level aggregate (its KPI value exists) but every per-unit
   * cell is k-anon suppressed — so the empty overlay must read "detalle protegido
   * por privacidad", NOT "sin datos" (which contradicts the card's aggregate).
   * Computed by the console from the base layer's suppressed-cell count.
   */
  detailKAnonSuppressed?: boolean;
  /**
   * Visual review 2026-07-23 (#1): the TOTAL-suppression notice — non-null when
   * the base layer has data in scope but EVERY plotted unit is k-anon
   * suppressed (100% hatch/grey canvas). Rendered as an anchored corner card
   * (same styling family as the on-canvas control cards) so the state never
   * reads as a broken map; the console composes the copy (privacy treatment +
   * the scope aggregate its KPI strip already discloses). Suppressed while the
   * centered empty overlay is showing — the two must never stack.
   */
  allSuppressedNotice?: string | null;
  /**
   * A1 PR-7: ISO 3166-2:AR province code currently selected in the
   * JurisdictionSwitcher (e.g. "AR-X"). null = national (no province filter).
   * When this changes, the map autozoom to the province's polygon bbox.
   */
  selectedProvinceCode?: string | null;
  /**
   * A1 PR-7: [lng, lat] centroid of the currently selected locality, or null
   * when no locality is selected. When non-null, the map fliesTo this center
   * at zoom 9.5 (locality takes precedence over province autozoom).
   */
  selectedLocalityCenter?: [number, number] | null;
  /**
   * panorama-redesign Fase 1: preset map framing. Set by PanoramaConsole when
   * the operator activates a preset that carries a `framing` field. `token`
   * is a monotonic counter so re-clicking the same preset re-frames. CAMERA
   * ONLY — data scope is untouched. null/undefined = no framing (behavior
   * identical to pre-change).
   */
  frame?: { framing: PresetFraming; token: number } | null;
  /**
   * panorama-ia-v2 §1.1: reports the camera zoom after each zoom gesture. The
   * console derives the aggregation level from it (locality once the camera
   * crosses Z_LOCALITY), replacing the removed manual AggregationToggle — the
   * level is now a property of (scope, zoom), never a control.
   */
  onZoom?: (zoom: number) => void;
  /**
   * "Copiar vista" fidelity (map-QOL): the camera to reproduce on load, decoded
   * from a shared URL. Applied ONCE via a programmatic jumpTo INSTEAD of the
   * computed jurisdiction/data frame so the reproduced view matches the sender's
   * exactly. Captured at mount (a stable per-load value); null/undefined → keep
   * today's computed-frame behavior.
   */
  initialCamera?: MapCamera | null;
  /**
   * "Copiar vista" fidelity (map-QOL): reports the full camera (zoom + center)
   * after every settle so the console can mirror it into the URL. Fires on the
   * same moveend as the zoom derivation (both user and programmatic moves).
   */
  onCameraChange?: (camera: MapCamera) => void;
  /**
   * panorama-ia-v2 §3.3: the unit key (province code) currently highlighted in
   * the RankedUnitsPanel, or null. Drives a feature-state highlight outline on
   * the matching province polygon (row → map sync).
   */
  highlightedUnitKey?: string | null;
  /**
   * panorama-ia-v2 §3.3: fired when the pointer enters/leaves a province
   * polygon on the map, bubbling its code up so the console can highlight the
   * matching ranked row (map → row sync). null on leave.
   */
  onUnitHover?: (key: string | null) => void;
  /**
   * panorama-ia-v2 §3.6: metadata for the "Exportar PNG" footer (auditable
   * provenance). Absent → the export/copy chrome is hidden.
   */
  viewMeta?: {
    asOf: Date | null;
    scopeLabel: string;
    periodLabel: string;
    suppressedCount: number;
    /** L-7 — cube build stamp when the board was cube-served (see ExportFooterInput). */
    cubeBuiltAt?: Date | string | null;
  };
  /**
   * ARCHETYPE A (situation-room full-bleed): when true the map card fills its
   * parent's height (`h-full`) instead of the fixed `height` px. The console
   * wraps it in a viewport-relative sizer so the geography is the dominant
   * viewport element. A ResizeObserver keeps MapLibre's canvas in sync as the
   * card grows/shrinks with the viewport.
   */
  fill?: boolean;
  /**
   * Camera lockdown (gob/map-zoom-lockdown follow-up, 2026-07-21): when
   * explicitly `false`, disables ALL free camera navigation — dragPan,
   * scrollZoom, boxZoom, doubleClickZoom, touchZoomRotate, dragRotate,
   * keyboard, touchPitch, PLUS the manual affordances that bypass those
   * MapLibre handlers entirely (the NavigationControl/Scale/Fullscreen
   * controls, the "Vista nacional" reset button, and the custom
   * arrow-key pan handler) — mirrors MapChoropleth's embed lockdown
   * exactly. Region click-to-drill and hover/click tooltips stay wired;
   * only camera movement is gated.
   *
   * Defaults to `true` (fully interactive) so the full `/gob/panorama`
   * console — which never passes this prop — is completely unaffected.
   * `PanoramaEmbed` (the read-only `/gob/poblacion` surface) is currently
   * the ONLY caller that passes `false`.
   */
  interactive?: boolean;
  /**
   * ARCHETYPE A: the time scrubber, DOCKED to the map card's bottom edge (inside
   * the map's own chrome, always visible with the map) rather than floating as a
   * separate block below it. Rendered in a bordered strip under the canvas.
   */
  bottomDock?: ReactNode;
  /**
   * ARCHETYPE A: the on-canvas aggregation-level badge copy — "Provincias" at
   * national rollup, "Departamentos/partidos" / "Comunas" when drilled. Announces
   * that a map mark's MEANING changed with the granularity. Absent → no badge.
   */
  aggregationLabel?: string;
  /**
   * ARCHETYPE A: the condition chips (scope / period / data cutoff) that qualify
   * what the map is painting. Rendered in the map card's TOP chrome (left of the
   * briefing tools) so the map leads the fold — the conditions read as the map's
   * own header ("this map shows: …") instead of a separate row pushing the
   * geography below the fold.
   */
  conditionsSlot?: ReactNode;
  /**
   * v2C overlay mode: the console's top-right cluster row (scope pill +
   * period segmented). When present the map's OLD top chrome bar is NOT
   * rendered — instead a floating card overlays the canvas top-right holding
   * this slot on the first row and the map-owned actions (Copiar vista /
   * Vistas guardadas / Exportar PNG) on the second, per the v2C spec. The
   * actions stay inside SituationalMap because copy/export need map internals
   * (canvas capture, camera URL).
   */
  topRightSlot?: ReactNode;
  /**
   * ARCHETYPE A: lift the imperatively-computed legend descriptors OUT of the
   * canvas so the "Referencias" rail section can render them off-canvas. Fired
   * whenever the committed division-fill legend / graduated-symbol scale changes
   * (including → null when the layer set no longer produces one). The province
   * ramp + bivariate legends are render-derived from `layers` and don't need a
   * callback — the console recomputes them itself.
   */
  onDivisionLegendChange?: (legend: DivisionLegendDescriptor | null) => void;
  onGraduatedScaleChange?: (scale: GraduatedScale | null) => void;
  /**
   * Lift the sequential province choropleth's classed breaks/colors (keyed by
   * layer id, computed WITH the scrub-locked domain) so the off-canvas province
   * legend paints the SAME scale as the map fill — instead of recomputing a
   * live-edge scale that diverges mid-scrub. Empty object when no sequential
   * province layer is active.
   */
  onProvinceSeqLegendChange?: (legends: ProvinceSeqLegend) => void;
  /**
   * task #38 v3 rail: the console owns the chrome now (a floating vertical rail
   * replaces the legacy top toolbar / the v2C floating clusters). When true the
   * map renders NO legacy top chrome bar and NO top-right briefing card — the
   * rail (Vista/Filtro/Período/Línea de tiempo/Exportar/Actualizar/Acerca) and
   * the scope pill float over the map from the console instead. Direct
   * (non-console) callers omit it and keep the legacy bar. Default false.
   */
  overlayChrome?: boolean;
  /**
   * task #38 v3 rail: register the map's `exportPng` action so the console's
   * "Exportar" rail panel can trigger it. exportPng is map-ref coupled (needs the
   * live GL canvas), so it stays here; this callback hands a stable wrapper up to
   * the console on mount and clears it (null) on unmount.
   */
  registerExportPng?: (fn: (() => void) | null) => void;
};

// Continental Argentina centroid + a zoom that frames the mainland.
export const AR_CENTER: [number, number] = [-63.6167, -40.0];
export const AR_ZOOM = 3.4;
export const BASEMAP_URL = "/geo/ar-provinces.geojson";
// Always-visible admin divisions for a single-province scope (PO directive
// "siempre mostrar la división"). Loaded LAZILY (same-origin — CSP allows only
// 'self') and ONLY when a province scope is active, never on the national view:
// caba-barrios (353 KB) for CABA, ar-departments (~2.0 MB on disk, filtered
// client-side to the active province) for everyone else. The national view keeps
// the provinces basemap untouched.
export const CABA_BARRIOS_URL = "/geo/caba-barrios.geojson";
export const AR_DEPARTMENTS_URL = "/geo/ar-departments.geojson";
// Regional context basemap: neighbouring South American countries (Chile,
// Uruguay, Brazil, Paraguay, Bolivia, Peru), heavily simplified. Drawn as a
// NON-interactive muted layer BELOW the Argentine provinces so the country no
// longer floats alone on the canvas. Malvinas is NEVER here — it renders only
// as part of Argentina (see scripts/prep-geo-context.ts).
export const CONTEXT_URL = "/geo/sudamerica-context.geojson";

// map-QOL zoom-bounds clamp: the camera can never wander away from the
// national territory. AR_BBOX (lib/ui/map-bounds) padded so border
// jurisdictions aren't pinned against the viewport edge.
//
// v2C QA fix (2026-07-11) — the pads are now ASYMMETRIC and the longitude pad
// is wide, because MapLibre's maxBounds also acts as a MINIMUM-ZOOM clamp: the
// camera can never zoom out past the point where the viewport would exceed the
// bounds. Argentina is portrait (≈23° wide × 33° tall) while the v2C
// full-bleed console is landscape (≈1700×900 css px at 1920), so fitting the
// country's HEIGHT requires the viewport to span ≈60-90° of LONGITUDE. The old
// symmetric 1.5° pad (tuned for the narrow v1 map card) capped min-zoom ABOVE
// the national frame — «Vista nacional» / «← Volver a Nacional» / fitBounds
// silently no-opped and the constrained transform even mis-painted fills
// (live-QA find: unqueryable choropleth color over the open ocean). 31° of
// longitude headroom admits the national fit up to ~2560px-wide consoles while
// panning stays bounded (no roaming to other continents); latitude keeps a
// tight 2° so the country never scrolls away vertically.
export const MAX_BOUNDS_PAD_LNG_DEG = 31;
export const MAX_BOUNDS_PAD_LAT_DEG = 2;
export const AR_MAX_BOUNDS: [[number, number], [number, number]] = [
  [AR_BBOX[0][0] - MAX_BOUNDS_PAD_LNG_DEG, AR_BBOX[0][1] - MAX_BOUNDS_PAD_LAT_DEG],
  [AR_BBOX[1][0] + MAX_BOUNDS_PAD_LNG_DEG, AR_BBOX[1][1] + MAX_BOUNDS_PAD_LAT_DEG],
];
export const MIN_ZOOM = 3;
// The default max-zoom every programmatic fitBounds uses (before the magnetic
// snap can clamp it lower). Kept as a named constant so all three camera sites
// pass the same ceiling to `framingMaxZoom`.
export const FRAME_MAX_ZOOM = 11;
export const FRAME_PADDING = 56;

/**
 * panorama magnetic-zoom Phase 2 — resolve the max-zoom a PROGRAMMATIC fitBounds
 * should use. If the frame's NATURAL landing zoom (what fitBounds would pick with
 * no ceiling) falls within ±0.5 of the province↔locality flip, clamp it to
 * `FRAMING_SNAP_MAX_ZOOM` so the frame lands decisively BELOW the flip; otherwise
 * keep the default ceiling. Only programmatic frames route through here — a user
 * wheel/pinch (originalEvent present on the maplibre event) never does, so manual
 * zoom still crosses the boundary freely.
 */
export function framingMaxZoom(
  map: maplibregl.Map,
  bbox: [[number, number], [number, number]],
): number {
  const camera = map.cameraForBounds(bbox, { padding: FRAME_PADDING });
  const landing = camera?.zoom;
  return typeof landing === "number" && shouldSnapFraming(landing)
    ? FRAMING_SNAP_MAX_ZOOM
    : FRAME_MAX_ZOOM;
}

// LIGHT operator-console palette (canvas / land / borders) — v2C retired the
// dark "situation-room" skin (PO decision 2026-07-11). Values track the
// operator DS ln-op-* tokens: canvas = --card (#ffffff), idle land = --page,
// borders = --line / --line-2, admin stroke = --faint.
export const COLOR_CANVAS = "#ffffff";
export const COLOR_LAND = "#eef1f4";
export const COLOR_BORDER = "#dbe1e7";
// Regional-context (neighbour countries) palette: a faint neutral that sits
// just above COLOR_CANVAS, so the surrounding landmass is legible but clearly
// recedes behind Argentina.
export const COLOR_CONTEXT_LAND = "#f4f6f8";
export const COLOR_CONTEXT_BORDER = "#e8ecf0";
// Division outlines: a light neutral so barrio / departamento lines read over
// COLOR_LAND, but still subtle (they must never compete with the data fill on
// top). Matches the prototype's dashed-border neutral.
export const COLOR_DIVISION_LINE = "#c7cfd6";
// Admin-boundary stroke for province outlines. A hierarchy-aware neutral slate
// (--faint) that reads as a boundary over both the land basemap and the data
// fill without painting near-black seams that read as CRACKS (map-polish #1).
export const COLOR_ADMIN_STROKE = "#95a0a8";
// Circle-layer edge definition on the LIGHT canvas. Colored dots get a white
// halo so overlapping marks separate cleanly (the standard light-map "donut"
// separator). Suppressed cells (light COLOR_SUPPRESSED fill) instead keep a mid
// slate edge (POINT_STROKE_SUPPRESSED) — a darker edge defines the light fill,
// preserving the honest "suppressed looks different" treatment.
export const POINT_STROKE = "rgba(255,255,255,0.9)";
export const POINT_STROKE_SUPPRESSED = "#9aa4ad";
// map-polish cursor #4 — data/basemap luminance separation. When a data layer
// fills polygons the basemap land dims so the choropleth "sits on" the territory
// instead of tinting it uniformly; outlines keep full opacity.
export const DATA_FILL_OPACITY = 0.92;
export const BASEMAP_FILL_ACTIVE = 0.55;
export const BASEMAP_FILL_IDLE = 1;
// map-polish cursor #5 — border hierarchy. Province admin lines read normally
// when provinces are the finest division on screen, and fade when departamento /
// barrio lines are active so the subordinate divisions dominate.
export const PROV_LINE_WIDTH = 0.9;
export const PROV_LINE_OPACITY = 0.7;
export const PROV_LINE_OPACITY_FADED = 0.3;
// map-polish cursor #7 — division outlines fade IN over DIVISION_FADE_MS on
// drill (prefetch + transition) instead of a hard pop after the camera settles.
export const DIVISION_LINE_OPACITY = 0.85;
export const DIVISION_FADE_MS = 300;
// cursor #2 — the k-anon hatch overlay opacity, and a SOLID fallback opacity for
// when the diagonal-hatch pattern image is unavailable (SSR / no canvas). The
// fallback keeps suppressed divisions visually distinct from genuine no-data so
// the legend's fill / hatch / no-data trichotomy never silently collapses.
export const HATCH_FILL_OPACITY = 0.85;
export const SUPPRESS_SOLID_OPACITY = 0.5;
// D.5(b) — the no-data stipple sits BELOW the suppression hatch's weight on
// purpose. "Protected" is a stronger statement than "empty" and has to keep
// reading as the louder mark; the tile itself is already faint (slate-500 at
// 0.45), and this holds the ranking at the layer level too.
export const NO_DATA_FILL_OPACITY = 0.55;

// B1 (map plan) — ABANDONED, and deliberately not left wired.
//
// The plan wanted period/scope/vista/asOf changes to INTERPOLATE so the eye can
// follow which units moved. maplibre cannot do it here: it refuses to transition
// DATA-DRIVEN paint — src/style/properties.ts, TransitioningPropertyValue:
// "Transitions to data-driven properties are not supported. We snap immediately
// to the data-driven value" — and both choropleths colour through an expression.
// Measured with a control on the live map: a CONSTANT colour blends at t=120ms;
// the real expression snaps. (perf review 2026-07-25.)
//
// The transitions were removed rather than kept "harmless": paint properties
// that read as an animation but produce none are a claim the code does not
// honour, and the next reader would have trusted them. Reviving the data fade
// needs a different mechanism — a two-layer cross-fade on the CONSTANT
// fill-opacity — which is a product decision, not a tweak (PO: abandoned
// 2026-07-25).
//
// What survives is the part that works and matters: the reduced-motion FLOOR on
// camera moves and on the division-outline fade (see use-choropleth-motion.ts).

/** The paint object for a choropleth fill: colour expression + shared opacity. */
export const choroplethFillPaint = (
  colorExpr: maplibregl.ExpressionSpecification | string,
): maplibregl.FillLayerSpecification["paint"] => ({
  "fill-color": colorExpr,
  "fill-opacity": DATA_FILL_OPACITY,
});

// Per-layer maplibre object ids are namespaced by layer id so multiple layers
// coexist without collision.
export const srcId = (id: string) => `pano-src-${id}`;
export const clusterLayerId = (id: string) => `pano-cluster-${id}`;
export const pointLayerId = (id: string) => `pano-point-${id}`;
export const choroLayerId = (id: string) => `pano-choro-${id}`;
// U5 province-choropleth: a fill (+ its hover outline) over the SHARED
// ar-provinces basemap source, colored by a per-layer data-join on the polygon
// `code` property. Namespaced by layer id so two province-choropleths coexist.
export const provinceFillLayerId = (id: string) => `pano-prov-fill-${id}`;
// D.5(b) — the stipple overlay for provinces this layer has no value for.
export const provinceNoDataLayerId = (id: string) => `pano-prov-nodata-${id}`;
export const provinceLineLayerId = (id: string) => `pano-prov-line-${id}`;
// Always-visible admin divisions for a scoped province. ONE shared source
// (barrios or the active province's departamentos), a single always-on outline
// layer, and a per-choropleth-layer data fill over that shared source (namespaced
// by layer id, like the province choropleth over ar-provinces).
export const DIVISION_SRC = "pano-divisions";
export const DIVISION_LINE_ID = "pano-div-line";
// cursor #6: feature-state hover glow over the division polygons.
export const DIVISION_HOVER_ID = "pano-div-hover";
// cursor #2: hatched k-anon suppression overlay for divisions whose only cells
// are suppressed — a diagonal fill-pattern that is perceptually distinct from
// both the colored data fill and the outline-only no-data cell.
export const DIVISION_SUPPRESS_ID = (id: string) => `pano-div-suppress-${id}`;
// D.5(b) — the stipple overlay for divisions with no data at all, so "empty"
// separates from bare land by FORM (the two are only ΔE00 1.48 apart in fill).
export const DIVISION_NO_DATA_ID = (id: string) => `pano-div-nodata-${id}`;
export const divisionFillLayerId = (id: string) => `pano-div-fill-${id}`;
// task #63: the bivariate k-anon hatch overlay over the SHARED ar-provinces
// source (province cells are structurally never suppressed today, but suppression
// PROPAGATES through the bivariate join, so the honest trichotomy is kept intact).
export const provinceSuppressLayerId = (id: string) => `pano-prov-suppress-${id}`;

/** Compute a [[minLng,minLat],[maxLng,maxLat]] bbox over many feature sets. */
export function layersBbox(layers: ActiveLayer[]): [[number, number], [number, number]] | null {
  let minLng = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const layer of layers) {
    for (const f of layer.features.features) {
      if (!f.geometry) continue;
      const [lng, lat] = f.geometry.coordinates;
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
    }
  }
  if (!Number.isFinite(minLng) || maxLng <= minLng || maxLat <= minLat) return null;
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

/** One feature of a local division GeoJSON, as much of it as the join reads. */
export type DivisionRawFeature = {
  geometry?: unknown;
  properties?: { code?: string; name?: string } | null;
};

/** Same-origin fetch of a local GeoJSON asset → its features (null on failure).
 * Routed through the shared session cache so a repeat/concurrent request for the
 * same asset (province drills, re-mounts, the CABA inset) reuses one fetch. */
export async function fetchGeojsonFeatures(url: string): Promise<DivisionRawFeature[] | null> {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: runtime JSON from local GeoJSON asset.
    const raw = await fetchGeojsonCached<any>(url);
    return (raw.features ?? []) as DivisionRawFeature[];
  } catch {
    return null; // Divisions unavailable — the provinces basemap still renders.
  }
}

export function removeLayer(map: maplibregl.Map, id: string) {
  for (const lid of [
    clusterLayerId(id),
    pointLayerId(id),
    choroLayerId(id),
    provinceFillLayerId(id),
    provinceLineLayerId(id),
    provinceSuppressLayerId(id),
    divisionFillLayerId(id),
    DIVISION_SUPPRESS_ID(id),
  ]) {
    if (map.getLayer(lid)) map.removeLayer(lid);
  }
  // Only the per-layer GeoJSON source is removed; the SHARED ar-provinces basemap
  // and pano-divisions sources are never removed here (their fills borrow them).
  if (map.getSource(srcId(id))) map.removeSource(srcId(id));
}

// F4: mute a layer (and re-restore it) by scaling circle-opacity. We never hide
// dimmed layers — the operator keeps the current-state context while scrubbing —
// but the reduced opacity signals "not reproducible in time" on the canvas.
export const DIM_OPACITY = 0.18;
// A1 (motion review) — the dim/undim toggle now transitions instead of snapping,
// same floor as DIVISION_FADE_MS: 0ms under prefers-reduced-motion. Applied only
// to CONSTANT-valued opacity paint props (fill-opacity here, and the reference
// layers' circle-opacity below) — maplibre snaps immediately when the destination
// is a data-driven expression (see the ABANDONED note above), so the two
// case-expression circle-opacity sites (choropleth cells, F1 graduated points)
// are deliberately left untouched: a transition there would only ever animate
// one direction and give a false sense of symmetry.
export const DIM_TRANSITION_MS = 150;
function setOpacityTransitioned(
  map: maplibregl.Map,
  layerId: string,
  prop: "fill-opacity" | "circle-opacity",
  value: number,
  reducedMotion: boolean,
) {
  map.setPaintProperty(layerId, `${prop}-transition`, {
    duration: reducedMotion ? 0 : DIM_TRANSITION_MS,
    delay: 0,
  });
  map.setPaintProperty(layerId, prop, value);
}
export function applyDim(map: maplibregl.Map, layer: ActiveLayer, reducedMotion: boolean) {
  const dim = layer.dimmed === true;
  // map-QOL: the per-layer opacity multiplier (Personalizar slider) scales the
  // BASE opacities; the F4 dim state and the suppressed-cell muting win under it.
  const op = typeof layer.opacity === "number" ? Math.min(Math.max(layer.opacity, 0.2), 1) : 1;
  const scaled = (base: number) => base * op;
  if (layer.geomType === "choropleth") {
    // U5 province mode: mute the polygon fill instead of the centroid circles.
    if (layer.level === "province") {
      const fid = provinceFillLayerId(layer.id);
      if (map.getLayer(fid))
        setOpacityTransitioned(
          map,
          fid,
          "fill-opacity",
          dim ? DIM_OPACITY : scaled(DATA_FILL_OPACITY),
          reducedMotion,
        );
      return;
    }
    // Locality mode with a division fill: mute the polygon fill alongside the
    // fallback circles so the whole layer dims as one while scrubbing.
    const dfid = divisionFillLayerId(layer.id);
    if (map.getLayer(dfid)) {
      setOpacityTransitioned(
        map,
        dfid,
        "fill-opacity",
        dim ? DIM_OPACITY : scaled(DATA_FILL_OPACITY),
        reducedMotion,
      );
    }
    // cursor #2 + #8: scale the k-anon hatch overlay in lockstep with the data
    // fill. Without this the hatch stays at full opacity while the fill dims to
    // DIM_OPACITY during a time-scrub, making suppressed cells visually DOMINATE
    // the muted layer. The base opacity depends on whether the pattern rendered
    // (hatch) or fell back to a solid tone (no-canvas).
    const sid = DIVISION_SUPPRESS_ID(layer.id);
    if (map.getLayer(sid)) {
      const hatchBase = map.hasImage(HATCH_IMAGE_ID) ? HATCH_FILL_OPACITY : SUPPRESS_SOLID_OPACITY;
      setOpacityTransitioned(
        map,
        sid,
        "fill-opacity",
        dim ? DIM_OPACITY : scaled(hatchBase),
        reducedMotion,
      );
    }
    const cid = choroLayerId(layer.id);
    if (!map.getLayer(cid)) return;
    // Suppressed cells were 0.45, visible 0.78; restore via the original case expr.
    map.setPaintProperty(
      cid,
      "circle-opacity",
      dim
        ? DIM_OPACITY
        : ([
            "case",
            ["==", ["get", "suppressed"], true],
            scaled(0.45),
            scaled(0.78),
          ] as unknown as number),
    );
    return;
  }
  // F1 graduated point layers: single circle per unit (no cluster layer).
  if (layer.renderMode === "graduated") {
    const pl = pointLayerId(layer.id);
    if (map.getLayer(pl)) {
      map.setPaintProperty(
        pl,
        "circle-opacity",
        dim
          ? DIM_OPACITY
          : ([
              "case",
              ["==", ["get", "suppressed"], true],
              scaled(0.45),
              scaled(0.82),
            ] as unknown as number),
      );
    }
    return;
  }
  // Reference layers (discrete pins with clustering).
  const pl = pointLayerId(layer.id);
  const cl = clusterLayerId(layer.id);
  if (map.getLayer(pl))
    setOpacityTransitioned(map, pl, "circle-opacity", dim ? DIM_OPACITY : scaled(1), reducedMotion);
  if (map.getLayer(cl))
    setOpacityTransitioned(
      map,
      cl,
      "circle-opacity",
      dim ? DIM_OPACITY : scaled(0.8),
      reducedMotion,
    );
}

// Layer-specific point popup copy (es-AR). Coarse layers (denuncias) state the
// marker is a locality centroid, never a precise spot.
export function pointPopupHtml(layer: ActiveLayer, props: Record<string, unknown>): string {
  if (layer.id === "denuncias") {
    const place = [props.locality, props.province].filter(Boolean).join(", ") || "Localidad";
    return `<div style="font-size:12px;padding:2px 6px"><strong>${escapeHtml(place)}</strong><br/><em style="font-size:11px;color:#94a3b8">Ubicación aproximada (centroide de localidad)</em></div>`;
  }
  if (layer.id === "refugios") {
    const name = String(props.name ?? "Refugio");
    const v = props.verified ? " · verificado" : "";
    return `<div style="font-size:12px;padding:2px 6px"><strong>${escapeHtml(name)}</strong><span style="color:#94a3b8">${v}</span></div>`;
  }
  if (layer.id === "clinicas") {
    const name = String(props.name ?? "Clínica veterinaria");
    const v = props.verified ? " · verificada" : "";
    return `<div style="font-size:12px;padding:2px 6px"><strong>${escapeHtml(name)}</strong><span style="color:#94a3b8">${v}</span></div>`;
  }
  // panorama-event-points Slice 1: a perdidas REAL sighting dot (LostPointProps
  // carries `token` + `lastSeenAt`). Popup: "Avistaje" + date + a subtle
  // capture-precision hint. Clicking the dot opens the DetailDrawer (D7).
  if (layer.id === "perdidas" && typeof props.token === "string") {
    const name = String(props.name ?? "Mascota");
    const when =
      typeof props.lastSeenAt === "string" && props.lastSeenAt
        ? formatDate(props.lastSeenAt)
        : null;
    const precision =
      props.locationSource === "gps"
        ? "ubicación GPS"
        : props.locationSource === "pin_manual"
          ? "punto marcado en el mapa"
          : props.locationSource === "geocodificada"
            ? "ubicación aproximada por dirección"
            : null;
    const meta = ["Avistaje", when].filter(Boolean).join(" · ");
    const hint = precision
      ? `<br/><em style="font-size:11px;color:#94a3b8">${escapeHtml(precision)}</em>`
      : "";
    return `<div style="font-size:12px;padding:2px 6px"><strong>${escapeHtml(name)}</strong><br/><span style="color:#94a3b8">${escapeHtml(meta)}</span>${hint}</div>`;
  }
  // Generic: a primary label + a meta line built from common props.
  const primary = String(props.name ?? props.code ?? props.diseaseLabel ?? layer.label);
  const incidentType =
    typeof props.incidentType === "string"
      ? (INCIDENT_LABEL[props.incidentType] ?? props.incidentType)
      : undefined;
  const severity =
    typeof props.severity === "string"
      ? (SEVERITY_LABEL[props.severity] ?? props.severity)
      : undefined;
  const status =
    typeof props.status === "string" ? (PET_STATUS_LABEL[props.status] ?? props.status) : undefined;
  const meta = [incidentType, severity, status, props.diseaseLabel ? undefined : props.diseaseCode]
    .filter(Boolean)
    .join(" · ");
  return `<div style="font-size:12px;padding:2px 6px"><strong>${escapeHtml(primary)}</strong>${meta ? `<br/><span style="color:#94a3b8">${escapeHtml(meta)}</span>` : ""}</div>`;
}

// map-mapa-nivel-2 V2 (PO 2026-08-02): a subtle diffused edge on every data
// circle — softens the hard-edged dot without reading as a smudge. 0.15 keeps
// solidity; a full gaussian blur was NOT approved (scouted + explicitly
// rejected in the same review — see the paint sites below).
export const CIRCLE_BLUR = 0.15;

// panorama-mapa-nivel-2 V1 (PO 2026-08-02): fade a just-mounted CONSTANT-opacity
// circle layer in from 0, mirroring the division-outline fade-in above (same
// DIVISION_FADE_MS sweep, same reduced-motion floor). Case-expression
// circle-opacity sites (graduated points, choropleth cells) cannot use this —
// maplibre snaps data-driven paint immediately (see the ABANDONED note above);
// this only ever softens a plain-number target.
function fadeInOpacity(
  map: maplibregl.Map,
  layerId: string,
  prop: "fill-opacity" | "circle-opacity",
  target: number,
  reducedMotion: boolean,
) {
  map.setPaintProperty(layerId, `${prop}-transition`, {
    duration: reducedMotion ? 0 : DIVISION_FADE_MS,
    delay: 0,
  });
  window.requestAnimationFrame(() => {
    if (map.getLayer(layerId)) map.setPaintProperty(layerId, prop, target);
  });
}

/**
 * #6/#7 — the AREA-proportional, data-driven `circle-radius` expression for a
 * graduated layer. Suppressed cells keep the fixed small muted radius; visible
 * cells interpolate over `radiusStops` derived from the observed maximum count
 * (r ∝ √count — see graduated-scale.ts). Stops come from the shared scale so
 * the on-map bubble matches the legend bubble for any value.
 */
export function graduatedRadiusExpr(
  radiusStops: ReadonlyArray<readonly [number, number]>,
): maplibregl.ExpressionSpecification {
  return [
    "case",
    ["==", ["get", "suppressed"], true],
    5,
    ["interpolate", ["linear"], ["coalesce", ["get", "count"], 0], ...radiusStops.flat()],
  ] as unknown as maplibregl.ExpressionSpecification;
}

/**
 * F1 Panorama v2: graduated circles for density+signal layers.
 *
 * One NON-clustered circle per administrative unit (province or locality).
 * `circle-radius` is a step expression on the feature's `count` property so
 * higher event counts render as larger circles. Suppressed cells (count null
 * → coalesced to 0) render at a fixed small muted radius, same as the
 * choropleth's suppressed-cell treatment.
 *
 * This replaces MapLibre's generic point clustering for these layers so the
 * map shows a STABLE, DETERMINISTIC symbol per unit regardless of zoom level.
 *
 * Pure layer-creation only — the caller wires interactions (closes over
 * component state) right after calling this.
 */
export function addGraduatedPointLayer(
  map: maplibregl.Map,
  layer: ActiveLayer,
  data: GeoJSON.FeatureCollection,
  radiusStops: ReadonlyArray<readonly [number, number]>,
) {
  // Non-clustered source — one feature per unit is already the aggregation unit.
  map.addSource(srcId(layer.id), { type: "geojson", data });
  map.addLayer({
    id: pointLayerId(layer.id),
    type: "circle",
    source: srcId(layer.id),
    paint: {
      "circle-color": ["case", ["==", ["get", "suppressed"], true], COLOR_SUPPRESSED, layer.color],
      // Theme 3: raise the data-fill opacity (was 0.82) so a colored dot reads
      // solid, not translucent; suppressed dots stay clearly lower (was 0.45).
      // PO 2026-08-02: circle-blur softens the edge without losing that solidity
      // (a full gaussian was scouted and rejected — see CIRCLE_BLUR above).
      "circle-opacity": ["case", ["==", ["get", "suppressed"], true], 0.6, 0.92],
      "circle-blur": CIRCLE_BLUR,
      "circle-radius": graduatedRadiusExpr(radiusStops),
      // White halo on a colored fill; mid-slate edge on the light suppressed
      // fill — each keeps a crisp, contrasting outline on the light canvas.
      "circle-stroke-color": [
        "case",
        ["==", ["get", "suppressed"], true],
        POINT_STROKE_SUPPRESSED,
        POINT_STROKE,
      ],
      "circle-stroke-width": 1.5,
    },
  });
}

/**
 * Reference-layer rendering: discrete pins with MapLibre native clustering.
 * Used for refugios and decomisos — each feature represents an individual
 * entity (shelter / expediente) that must not be spatially merged.
 *
 * V1 (2026-08-02): both circle-opacity targets here are CONSTANT (not the
 * case-expression graduated/choropleth sites), so a mode-flip mount fades in
 * instead of popping — see fadeInOpacity above. Native cluster split/merge
 * pops (a point crossing clusterMaxZoom) stay unsoftened: that transition is
 * driven by maplibre's internal supercluster reassigning which features pass
 * the `has`/`!has point_count` FILTER, and maplibre does not animate features
 * newly passing a layer filter — only paint-property VALUE changes on
 * features already rendering. Reported, not forced.
 */
export function addReferencePointLayer(
  map: maplibregl.Map,
  layer: ActiveLayer,
  data: GeoJSON.FeatureCollection,
  reducedMotion: boolean,
) {
  map.addSource(srcId(layer.id), {
    type: "geojson",
    data,
    cluster: true,
    clusterRadius: 48,
    clusterMaxZoom: 12,
  });
  // Cluster bubbles (no on-canvas text: privacy).
  map.addLayer({
    id: clusterLayerId(layer.id),
    type: "circle",
    source: srcId(layer.id),
    filter: ["has", "point_count"],
    paint: {
      "circle-color": layer.color,
      "circle-opacity": 0,
      "circle-blur": CIRCLE_BLUR,
      "circle-radius": ["step", ["get", "point_count"], 14, 25, 18, 100, 24, 500, 32],
      "circle-stroke-color": COLOR_CANVAS,
      "circle-stroke-width": 2,
    },
  });
  // Fade in TO the resting opacity applyDim would set — never to a hardcoded
  // full value. Otherwise, mounting a reference layer during a PAUSED scrub
  // (F4 dim) fades it to full opacity one rAF after applyDim muted it, so it
  // reads as replayable as-of data until the next sync pass (adversarial
  // review 2026-08-02). Mirrors applyDim's dim/multiplier resolution exactly.
  const dim = layer.dimmed === true;
  const op = typeof layer.opacity === "number" ? Math.min(Math.max(layer.opacity, 0.2), 1) : 1;
  fadeInOpacity(
    map,
    clusterLayerId(layer.id),
    "circle-opacity",
    dim ? DIM_OPACITY : 0.8 * op,
    reducedMotion,
  );
  // Unclustered points.
  map.addLayer({
    id: pointLayerId(layer.id),
    type: "circle",
    source: srcId(layer.id),
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": layer.color,
      "circle-opacity": 0,
      "circle-blur": CIRCLE_BLUR,
      "circle-radius": 6,
      "circle-stroke-color": COLOR_CANVAS,
      "circle-stroke-width": 1.5,
    },
  });
  fadeInOpacity(
    map,
    pointLayerId(layer.id),
    "circle-opacity",
    dim ? DIM_OPACITY : 1 * op,
    reducedMotion,
  );
}

/**
 * Locality choropleth's centroid-circle fallback (unmatched cells with no
 * division polygon to fill). Pure layer-creation only — the caller wires
 * interactions right after calling this.
 */
export function addChoroplethLayer(
  map: maplibregl.Map,
  layer: ActiveLayer,
  data: GeoJSON.FeatureCollection,
) {
  map.addSource(srcId(layer.id), { type: "geojson", data });
  // Graduated symbol: radius scales with `value`; suppressed cells (value null
  // → coalesced to 0 by maplibre 'get') render muted at a fixed small radius.
  map.addLayer({
    id: choroLayerId(layer.id),
    type: "circle",
    source: srcId(layer.id),
    paint: {
      "circle-color": ["case", ["==", ["get", "suppressed"], true], COLOR_SUPPRESSED, layer.color],
      // Theme 3: raise the data-fill opacity (was 0.78) so a centroid dot reads
      // solid against the dark canvas; suppressed dots stay clearly lower (was
      // 0.45). PO 2026-08-02: circle-blur softens the edge without losing that
      // solidity (a full gaussian was scouted and rejected — see CIRCLE_BLUR).
      "circle-opacity": ["case", ["==", ["get", "suppressed"], true], 0.6, 0.92],
      "circle-blur": CIRCLE_BLUR,
      "circle-radius": [
        "case",
        ["==", ["get", "suppressed"], true],
        5,
        ["interpolate", ["linear"], ["coalesce", ["get", "value"], 0], 0, 6, 50, 16, 250, 26],
      ],
      // White halo on a colored fill; mid-slate edge on the light suppressed
      // fill — each keeps a crisp, contrasting outline on the light canvas.
      "circle-stroke-color": [
        "case",
        ["==", ["get", "suppressed"], true],
        POINT_STROKE_SUPPRESSED,
        POINT_STROKE,
      ],
      "circle-stroke-width": 1.5,
    },
  });
}
