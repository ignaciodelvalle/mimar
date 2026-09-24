// Pure helpers for SituationalMap viewport and empty-state logic.
//
// Extracted from SituationalMap.tsx so they can be unit-tested without a DOM
// or maplibre-gl runtime. The component imports these directly; tests import
// from this module to avoid pulling in maplibre-gl which is unavailable in
// the Vitest environment.

import {
  isLayerId,
  isSurveillanceLayer,
  shortLayerLabel,
} from "@/src/modules/panorama/domain/layers";
import type { PresetFraming } from "@/src/modules/panorama/domain/presets";
import type {
  AggregationLevel,
  FeatureCollection,
  PanoramaScope,
} from "@/src/modules/panorama/domain/types";

// ---------------------------------------------------------------------------
// panorama-ia-v2 §1.1 — derived aggregation level (replaces AggregationToggle)
// ---------------------------------------------------------------------------

/**
 * Camera zoom around which programmatic frames snap (see FRAMING_SNAP_MAX_ZOOM)
 * and the P4b national LOD band ends (`autoLevel.belowZoom` in the layer
 * registry declares 5 per layer).
 *
 * P4c (design §5.5): the camera-driven LEVEL derivation that used to live here
 * (`derivedLevel` + the `derivedLevelWithHysteresis` Schmitt trigger over
 * Z_LOCALITY_ENTER/EXIT) is GONE — the data axis follows the SCOPE alone
 * (committed province/locality ⇒ locality axis; national ⇒ province axis at any
 * zoom), and rendering granularity is the P4b LOD bands' job (`markForZoom`).
 */
export const Z_LOCALITY = 5;

/**
 * Max-zoom a PROGRAMMATIC camera move (initial fit, jurisdiction viewport, preset
 * frame) should clamp to so it lands DECISIVELY below the province↔locality flip.
 * A frame is only "magnetic" when its natural landing zoom falls within ±0.5 of
 * the old Z_LOCALITY line — otherwise it keeps its default max-zoom and lands
 * wherever it naturally would. This snaps the near-boundary case to just under
 * the flip so an automated frame never leaves the level teetering.
 */
export const FRAMING_SNAP_MAX_ZOOM = Z_LOCALITY - 0.25;

/** True when a programmatic landing zoom is close enough to the flip to snap. */
export function shouldSnapFraming(landingZoom: number): boolean {
  return Math.abs(landingZoom - Z_LOCALITY) <= 0.5;
}

// ---------------------------------------------------------------------------
// panorama-event-points Slice 1 — near-zoom real-location dot mode (design D1/D2)
// ---------------------------------------------------------------------------
//
// P4b (ViewState WS-4): the `Z_POINTS` threshold + `pointsEligible` predicate
// that lived here moved into the DOMAIN declaration — the LOD bands are part of
// each layer's `renderPolicy`, projected by the capability gate. The console now
// resolves the near band via `markForZoom(ZOOM_REPRESENTATIONS[id], zoom,
// provinceInScope)` (src/modules/panorama/domain/capabilities.ts). The SECURITY
// boundary is unchanged and stays server-side: get-layer-features independently
// re-derives points mode; a crafted `?mode=points` with no province never
// returns dots.

// ---------------------------------------------------------------------------
// Empty-state helpers (PR-6)
// ---------------------------------------------------------------------------
//
// Fixes the empty-state overlay firing incorrectly when the only active layer
// is a province choropleth (geometry: null features that color the shared
// basemap polygons). Province choropleth layers ARE visible on the map even
// though their GeoJSON features carry no Point geometry — they drive the polygon
// fill-color expression on the shared ar-provinces basemap source.

/**
 * Minimal subset of ActiveLayer used by the pure helpers here.
 * Must stay structurally compatible with the full ActiveLayer in SituationalMap.tsx.
 */
export type ActiveLayerLike = {
  geomType: "point" | "choropleth";
  level?: string;
  features: FeatureCollection;
};

/**
 * Count features across all active layers that have renderable Point geometry.
 *
 * Province-choropleth layers (geomType="choropleth", level="province") carry
 * features with `geometry: null` — they color the basemap polygon by data-join,
 * not by plotting a GeoJSON Point. Those features are NOT renderable in the
 * traditional sense (countable as "points on the map") but the layer IS visible.
 * Counting them as zero here is intentional — `hasProvinceChoroplethLayer` is
 * the companion guard that tells callers whether to suppress the empty-state.
 */
export function countRenderableFeatures(layers: ActiveLayerLike[]): number {
  return layers.reduce((sum, l) => {
    const withGeometry = l.features.features.filter((f) => f.geometry !== null);
    return sum + withGeometry.length;
  }, 0);
}

/**
 * True when at least one active layer is a province-level choropleth.
 *
 * Province choropleth layers color the local ar-provinces basemap polygons via
 * a data-driven fill expression. Their features carry `geometry: null` (no
 * Point to plot), so `countRenderableFeatures` returns 0 for them. The
 * SituationalMap must NOT show the "Sin datos" overlay when this returns true,
 * because the province fills ARE visible regardless of the point count.
 */
export function hasProvinceChoroplethLayer(layers: ActiveLayerLike[]): boolean {
  return layers.some((l) => l.geomType === "choropleth" && l.level === "province");
}

/**
 * Pick the honest es-AR copy for the map's empty-state overlay.
 *
 * Cowork QA ronda 3 §5 (privacy invariant §5 / C3): when a scope-level aggregate
 * EXISTS (the KPI card shows e.g. "64,4%") but every per-unit cell is k-anon
 * suppressed, the generic "Sin datos para esta capa" read as a bug — a
 * contradiction with the card. Distinguish the three cases so a PROTECTED
 * aggregate never reads as "sin datos":
 *   1. `rateProvinceOnlyEmpty` — a rate layer drilled below province (coverage is
 *      a province-only figure in v1). Its own honest copy (unchanged).
 *   2. `detailKAnonSuppressed` — the aggregate exists but the per-unit detail is
 *      protected by k-anonymity. Say so; affirm the aggregate IS available.
 *   3. genuinely no data — the generic scope-aware "Sin datos" (unchanged),
 *      EXCEPT when every active layer is a surveillance/risk layer, which gets
 *      a NAMED empty ("sin registros de zoonosis…") plus the epistemic caveat.
 *
 * WHY THE SURVEILLANCE BRANCH NO LONGER SAYS "BUENA NOTICIA" (demo review
 * 2026-08-01, finding #3). It used to close with "— buena noticia.", live on
 * /gob/panorama?period=30d while the SAME panel's KPI rail read "activas hoy: 1
 * (rabia + mordeduras + 30d)" and /gob published "Enfermedades notificadas 1"
 * with a Peligro badge. The three empties this function already separates —
 * "no pudimos calcular" (degraded), "hay dato pero está protegido" (k-anon) and
 * "no hay registros" (this branch) — are three different statements, and NONE
 * of them is good news: a surveillance layer only sees what somebody reported,
 * so its zero is the ABSENCE OF A CLAIM, not a claim of absence. The old copy
 * converted a reporting gap into an all-clear, which is exactly the reading a
 * sanitary authority must never be handed. The branch keeps naming its layers
 * (that part was honest and specific) and now states what the zero cannot rule
 * out — the same "la ausencia de X no implica ausencia de Y" phrasing
 * LnEmptyState's nature="no-signal" and /gob/vigilancia's own cards use.
 */
export function emptyOverlayMessage(opts: {
  rateProvinceOnlyEmpty: boolean;
  detailKAnonSuppressed: boolean;
  emptyStateScope: string;
  /** Panorama QA 2026-07-14: the layer's last fetch was the server's
   *  budget/failure fallback — a TIMEOUT, not an empty dataset. Highest
   *  priority: painting it as "sin datos" was the PBA cobertura lie. */
  layerDegraded?: boolean;
  /** Sentiment review #6: ids of the ACTIVE layers behind this empty view.
   *  When every one is a surveillance layer (SURVEILLANCE_LAYER_IDS), a true
   *  zero frames positively. Absent/empty → the generic copy (unchanged). */
  activeLayerIds?: readonly string[];
}): string {
  if (opts.layerDegraded) {
    return "No pudimos calcular esta capa a tiempo. Tocá Actualizar para reintentar.";
  }
  if (opts.rateProvinceOnlyEmpty) {
    return "La cobertura se calcula solo a nivel provincia. Volvé al nivel provincia para verla.";
  }
  if (opts.detailKAnonSuppressed) {
    return "Detalle por localidad protegido por privacidad (k<5). El agregado del alcance sí está disponible.";
  }
  const ids = (opts.activeLayerIds ?? []).filter(isLayerId);
  if (
    ids.length > 0 &&
    ids.length === (opts.activeLayerIds?.length ?? 0) &&
    ids.every(isSurveillanceLayer)
  ) {
    const names = ids.map((id) => shortLayerLabel(id).toLocaleLowerCase("es-AR")).join(" ni ");
    return `Sin registros de ${names} en el período. La ausencia de reportes no implica ausencia de casos.`;
  }
  return `Sin datos para esta capa ${opts.emptyStateScope}.`;
}

/**
 * Q12 — copy for the map's reset-view control, named per operator type so the
 * home-icon tooltip is honest. ONLY a bounded-jurisdiction govt operator returns
 * to "mi jurisdicción"; admin/universal (including a DRILLED admin, who receives
 * `initialBounds` but has no personal jurisdiction) returns to "Vista nacional".
 * Keyed on `boundedJurisdiction`, never on `initialBounds` (a drilled admin has
 * the latter but not the former).
 */
export function resetViewLabel(boundedJurisdiction: boolean): string {
  return boundedJurisdiction ? "Volver a mi jurisdicción" : "Vista nacional";
}

// ---------------------------------------------------------------------------
// A1 — Autozoom viewport helper (PR-7)
// ---------------------------------------------------------------------------

/**
 * A typed descriptor of the viewport transition the map should execute.
 *
 *  - `fitBounds` — fit the map to a [[minLng,minLat],[maxLng,maxLat]] bounding box.
 *    Used for national (no selection) and province-level zoom.
 *  - `flyTo` — animate (or jump) to a specific coordinate at a given zoom level.
 *    Used for locality-level zoom (locality centroid, no polygon available).
 */
export type ViewportDescriptor =
  | { kind: "fitBounds"; bbox: [[number, number], [number, number]] }
  | { kind: "flyTo"; center: [number, number]; zoom: number };

/** Minimal GeoJSON feature shape needed for bbox computation. */
type ProvinceLike = {
  properties: { code: string; [key: string]: unknown } | null;
  geometry: {
    type: string;
    coordinates: unknown;
  } | null;
};

/**
 * Compute the bounding box of a single GeoJSON Polygon or MultiPolygon feature.
 * Returns null when the geometry is null or an unrecognised type.
 */
function polygonBbox(feature: ProvinceLike): [[number, number], [number, number]] | null {
  const geom = feature.geometry;
  if (!geom) return null;

  let minLng = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;

  function visitRing(ring: [number, number][]) {
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
    }
  }

  if (geom.type === "Polygon") {
    for (const ring of geom.coordinates as [number, number][][]) {
      visitRing(ring);
    }
  } else if (geom.type === "MultiPolygon") {
    for (const polygon of geom.coordinates as [number, number][][][]) {
      for (const ring of polygon) {
        visitRing(ring);
      }
    }
  } else {
    return null;
  }

  if (!Number.isFinite(minLng) || maxLng <= minLng || maxLat <= minLat) return null;
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

/**
 * Compute the viewport descriptor for the current jurisdiction selection.
 *
 * Priority (most → least specific):
 *  1. Locality centroid provided → `flyTo` at that centroid, zoom 9.5.
 *  2. Province code provided → `fitBounds` to the province polygon's bbox.
 *  3. Neither → `fitBounds` to the national fallback bbox.
 *
 * The function never throws; it returns the national bbox in all error cases
 * (unknown province code, missing geometry, empty feature list).
 *
 * @param provinceCode  ISO 3166-2:AR code (e.g. "AR-X") or null for national.
 * @param localityCenter  [lng, lat] centroid of the selected locality, or null.
 * @param provinceFeatures  The loaded ar-provinces basemap features. Expected
 *   to have `properties.code` (ISO code) and Polygon/MultiPolygon geometry.
 * @param nationalBbox  Fallback bbox used when no selection is active or when
 *   the province feature cannot be found.
 */
export function computeJurisdictionViewport(
  provinceCode: string | null,
  localityCenter: [number, number] | null,
  provinceFeatures: ProvinceLike[],
  nationalBbox: [[number, number], [number, number]],
): ViewportDescriptor {
  // Locality is most specific — always zooms to the centroid.
  if (localityCenter !== null) {
    return { kind: "flyTo", center: localityCenter, zoom: 9.5 };
  }

  // Province selected — zoom to the province polygon bbox.
  if (provinceCode !== null && provinceFeatures.length > 0) {
    const feature = provinceFeatures.find((f) => f.properties?.code === provinceCode);
    if (feature) {
      const bbox = polygonBbox(feature);
      if (bbox) return { kind: "fitBounds", bbox };
    }
    // Province code provided but feature not found (e.g. basemap failed to
    // load) — fall through to national.
  }

  // No selection (or province not in basemap) → national bbox.
  return { kind: "fitBounds", bbox: nationalBbox };
}

// ---------------------------------------------------------------------------
// Zoom-driven division activation (PO directive 2026-07-07)
// ---------------------------------------------------------------------------
//
// "A partir de cierto punto SIEMPRE mostrar las localidades" — the admin
// divisions (departamentos / barrios) must appear automatically once the camera
// zooms past a sensible threshold, for ANY operator, with or without an explicit
// province selection. Standard web-map behavior: country → provinces; zoom in →
// departamentos/barrios of whatever province(s) are in view.

/**
 * Camera zoom at/above which admin divisions activate for the province(s) in
 * view. Chosen empirically from the provinces GeoJSON extents: at z≈6.5 roughly
 * one large province fills the viewport width (~7° of longitude at a typical
 * width), so departamento outlines read legibly without clutter; below it the
 * national multi-province view stays clean (provinces only). CABA shares this
 * cutoff — its ~0.19° extent is only reached when the camera is well past it, so
 * its barrios naturally appear only when deeply zoomed in.
 */
export const Z_DIVISIONS = 6.5;

/** A [[minLng,minLat],[maxLng,maxLat]] bounding box. */
export type Bbox = [[number, number], [number, number]];

// ---------------------------------------------------------------------------
// CABA / AMBA inset visibility (task #36 fix 1 + PBA addendum)
// ---------------------------------------------------------------------------
//
// The old gate keyed on ZOOM alone (`insetZoom < Z_DIVISIONS`), which was wrong
// in both directions: it kept the inset up when the operator panned AWAY from
// CABA at regional zoom, and it hid the inset in the national overview where the
// AMBA magnifier is most useful. The correct predicate keys on SCOPE + whether
// CABA is actually in the viewport.

/** The CABA bbox used for the in-viewport intersection test (mirrors
 * CabaInset's own CABA_BBOX camera frame). */
export const CABA_INSET_BBOX: Bbox = [
  [-58.531, -34.705],
  [-58.335, -34.526],
];

/** True when CABA falls inside the current camera viewport bbox. */
export function cabaInView(cameraBbox: Bbox | null): boolean {
  return cameraBbox != null && bboxesIntersect(cameraBbox, CABA_INSET_BBOX);
}

/**
 * Whether the CABA/AMBA inset should render right now (task #36 fix 1).
 *
 *  - No inset layer available → never.
 *  - A province is in scope (drilled): the inset stays ONLY for CABA itself and
 *    for Provincia de Buenos Aires (addendum — PBA surrounds CABA, so its framed
 *    view keeps the magnifier). Any OTHER province hides it, even though BA's own
 *    bbox would enclose CABA — the scope decision beats the geometry test.
 *  - National scope: show the AMBA magnifier only when CABA is actually within
 *    the viewport (true at the zoomed-out national overview; false once the
 *    operator has panned/zoomed CABA off-screen).
 *
 * Pure — the caller supplies `cabaInView` (computed from the live camera bbox)
 * so this stays testable without a map.
 */
export function cabaInsetVisible(params: {
  hasInsetLayer: boolean;
  scopeProvince: string | null;
  scopeIsCaba: boolean;
  scopeIsPba: boolean;
  cabaInView: boolean;
}): boolean {
  const { hasInsetLayer, scopeProvince, scopeIsCaba, scopeIsPba, cabaInView } = params;
  if (!hasInsetLayer) return false;
  if (scopeProvince != null) {
    // Drilled into CABA itself: the MAIN map now renders CABA at barrio scale,
    // so the inset would be a redundant "double CABA" (PO #49 item 6) — hide it.
    // PBA surrounds CABA, so keep the magnifier there; any other province drops
    // it (scope decision beats the geometry test).
    if (scopeIsCaba) return false;
    return scopeIsPba;
  }
  return cabaInView;
}

// ---------------------------------------------------------------------------
// MAP-1 — the frame the PNG export is taken from (PO decision, 2026-08-04)
// ---------------------------------------------------------------------------
//
// "Hoy exporta lo que entra en pantalla, así que el país nunca entra." The
// export used to grab the operator's live viewport verbatim, so a NATIONAL
// funcionario could pan to Salta, hit Exportar, and get Salta — the one thing
// their mandate is not. The image now frames the CHOSEN SCOPE, takes the shot,
// and puts the operator's camera back exactly where it was.
//
// Pure, and separate from the capture, so the decision that matters (which
// bbox) is testable without a WebGL context.

export type ExportFrame = {
  /** Where the camera must sit for the shot. */
  viewport: ViewportDescriptor;
  /**
   * TRUE when the on-screen CABA/AMBA inset is carrying data this PNG will not.
   *
   * The inset is a SEPARATE MapLibre map with its own canvas and its own
   * (non-preserved) GL buffer; the export composes ONE canvas. Rather than
   * pretend, the footer says the magnifier is missing — the PO's own rule for
   * this case. A CABA-scoped export needs no caveat: at that scope the inset is
   * hidden BY DESIGN (cabaInsetVisible) because the main map already renders
   * CABA at barrio scale, which is exactly the frame this helper picks.
   */
  losesCabaInset: boolean;
};

/**
 * Resolve the export frame from the operator's chosen scope.
 *
 * Deliberately the SAME resolver the map already uses to frame a scope on load
 * and on drill (`computeJurisdictionViewport`) — an export that framed the
 * country differently from the console would be a second source of truth about
 * what "national" means.
 */
export function computeExportFrame(params: {
  provinceCode: string | null;
  localityCenter: [number, number] | null;
  provinceFeatures: ProvinceLike[];
  nationalBbox: Bbox;
  /** Whether an inset layer/bubble exists at all (nothing to lose without one). */
  hasInsetLayer: boolean;
  /** ISO code test, injected so this module keeps no province-code table. */
  isCabaCode: (code: string) => boolean;
}): ExportFrame {
  const { provinceCode, localityCenter, provinceFeatures, nationalBbox } = params;
  const viewport = computeJurisdictionViewport(
    provinceCode,
    localityCenter,
    provinceFeatures,
    nationalBbox,
  );
  // Evaluated against the EXPORT frame, not the live camera: after the reframe
  // a national export always has CABA in view, and a province export never
  // shows the magnifier unless it is PBA (cabaInsetVisible's own rule).
  const losesCabaInset = cabaInsetVisible({
    hasInsetLayer: params.hasInsetLayer,
    scopeProvince: provinceCode,
    scopeIsCaba: provinceCode !== null && params.isCabaCode(provinceCode),
    scopeIsPba: provinceCode === "AR-B",
    cabaInView: true,
  });
  return { viewport, losesCabaInset };
}

/** True when two bounding boxes overlap (inclusive edges). Cheap AABB test. */
export function bboxesIntersect(a: Bbox, b: Bbox): boolean {
  const [[aMinLng, aMinLat], [aMaxLng, aMaxLat]] = a;
  const [[bMinLng, bMinLat], [bMaxLng, bMaxLat]] = b;
  return aMinLng <= bMaxLng && aMaxLng >= bMinLng && aMinLat <= bMaxLat && aMaxLat >= bMinLat;
}

/** A province code paired with its precomputed polygon bbox. */
export type ProvinceBbox = { code: string; bbox: Bbox };

/**
 * Precompute a simple bbox per province feature ONCE (perf: point 5 of the
 * directive). Features with unusable geometry are skipped. Cache the result and
 * reuse it across every viewport resolution — the bboxes never change.
 */
export function computeProvinceBboxes(features: ProvinceLike[]): ProvinceBbox[] {
  const out: ProvinceBbox[] = [];
  for (const f of features) {
    const code = f.properties?.code;
    if (typeof code !== "string") continue;
    const bbox = polygonBbox(f);
    if (bbox) out.push({ code, bbox });
  }
  return out;
}

/**
 * Resolve which province(s) should render admin divisions RIGHT NOW.
 *
 * Precedence (point 2 — compose, don't replace):
 *  1. An explicit province selection/scope ALWAYS wins, at any zoom → that one
 *     province (the existing single-province behavior, unchanged).
 *  2. No selection: the camera decides. Below the threshold → [] (clean national
 *     provinces view). At/above it → every province whose bbox intersects the
 *     camera viewport (approximate + cheap; a neighboring-province false positive
 *     is harmless — it just draws extra outlines).
 *
 * Pure — no map, no DOM. Returns ISO province codes; the caller splits CABA
 * (→ barrios) from the rest (→ departamentos).
 */
export function resolveDivisionProvinces(params: {
  selectedProvince: string | null;
  zoom: number;
  cameraBbox: Bbox | null;
  provinceBboxes: ProvinceBbox[];
  threshold?: number;
}): string[] {
  const { selectedProvince, zoom, cameraBbox, provinceBboxes, threshold = Z_DIVISIONS } = params;
  // Selection wins, regardless of zoom.
  if (selectedProvince) return [selectedProvince];
  // No selection: only the camera can activate divisions, past the cutoff.
  if (zoom < threshold || cameraBbox === null) return [];
  return provinceBboxes.filter((p) => bboxesIntersect(p.bbox, cameraBbox)).map((p) => p.code);
}

/**
 * Resolve the DATA aggregation axis (province vs locality/department) from
 * (scope, camera, active layers) — the automatic-by-view LOD decision.
 *
 * Precedence:
 *  1. A committed jurisdiction scope (province OR locality) ALWAYS reads the
 *     LOCALITY axis (department/barrio grain) — the existing drill behavior,
 *     unchanged: a scoped operator or an explicit ?province/?locality drills.
 *  2. National scope (no province, no locality): the PROVINCE axis is the default
 *     (the clean 24-province overview at the country-wide view). It flips to the
 *     LOCALITY axis ONLY once the camera zooms past `threshold` (Z_DIVISIONS) WITH
 *     an active CHOROPLETH layer — so departments fill automatically with the
 *     active metric as the operator looks closer, in the same color language.
 *
 * This reintroduces the camera half of the level derivation that P4c removed for
 * COST (it fetched every locality in the country at once, live). That cost is gone
 * now: national+department is cube-served (a precomputed superset), so the refetch
 * this flip triggers is near-free. Below the threshold the view stays province;
 * this is RENDER-detail-on-zoom only — it drives a data refetch + repaint, never a
 * camera move. Pure — no map, no DOM.
 */
export function resolveDataLevel(params: {
  hasProvinceScope: boolean;
  hasLocalityScope: boolean;
  zoom: number;
  hasActiveChoropleth: boolean;
  threshold?: number;
}): AggregationLevel {
  const {
    hasProvinceScope,
    hasLocalityScope,
    zoom,
    hasActiveChoropleth,
    threshold = Z_DIVISIONS,
  } = params;
  // A committed scope drills to the locality axis at any zoom (unchanged).
  if (hasProvinceScope || hasLocalityScope) return "locality";
  // National: departments reveal automatically past the threshold, but only when a
  // choropleth is active to fill them — otherwise keep the clean province overview.
  if (hasActiveChoropleth && zoom >= threshold) return "locality";
  return "province";
}

/**
 * The SSR seed axis for a panorama page, from the scope alone (no camera — the
 * server has none).
 *
 * A1 (2026-07-31). This exists so the two derivations that MUST agree are two
 * named functions in one file instead of a boolean inlined in a page and a
 * different boolean inlined in the console. They disagreed: the page asked "does
 * this operator have ANY jurisdiction assignment?" while the console asks "is
 * there a SINGLE committed province?" — so a govt operator whose assignments
 * span two provinces was seeded at "locality" and immediately re-derived
 * "province" on mount. That flip raced the mount fetch and painted the whole
 * country "sin datos".
 *
 * The contract is a FIXED POINT, pinned in panorama-landing-level.test.ts: the
 * level this returns must survive `resolveDataLevel` at the placeholder camera
 * that level implies (`mountPlaceholderZoom`). Anything else is level drift on
 * the landing state.
 */
export function resolveSeedLevel(params: {
  hasProvinceScope: boolean;
  hasLocalityScope: boolean;
}): AggregationLevel {
  return params.hasProvinceScope || params.hasLocalityScope ? "locality" : "province";
}

/**
 * The console's PRE-MAP-LOAD placeholder zoom for a seeded axis (P4b): a scoped
 * view's camera lands inside its province, so starting below Z_LOCALITY would
 * resolve the LOD band to NATIONAL on the very first render and read the wrong
 * (empty) cache — a blank first paint. Extracted from PanoramaConsole so the
 * seed/derivation fixed point can be tested against the REAL placeholder.
 */
export function mountPlaceholderZoom(seedLevel: AggregationLevel): number {
  return seedLevel === "locality" ? Z_LOCALITY + 1 : Z_LOCALITY - 1;
}

// ---------------------------------------------------------------------------
// panorama-redesign Fase 1 — preset frame viewport helper
// ---------------------------------------------------------------------------

/**
 * Resolve the viewport for a preset's optional map framing (camera-only —
 * data scope is untouched). Mirrors computeJurisdictionViewport so the frame
 * effect in SituationalMap stays a thin apply step.
 *
 *  - `{ kind: "national" }` → fitBounds to the captured national bbox, or the
 *    AR fallback when the first-load fit hasn't resolved yet.
 *  - `{ kind: "bbox" }` → fitBounds to the explicit bounds.
 *  - absent (null/undefined) → null: the camera MUST NOT move (backward-
 *    compatible presets keep today's behavior).
 *
 * @param framing  The preset's framing field, if any.
 * @param nationalBbox  The bbox captured after the map's initial fit, or null.
 * @param fallbackBbox  The static AR bbox used when no national bbox exists.
 */
export function computePresetFrameViewport(
  framing: PresetFraming | null | undefined,
  // Underscore-prefixed: kept in the signature on purpose (callers still pass
  // it, and a future framing kind may want the data extent) but NO LONGER read
  // for "national" — see the note below.
  _nationalBbox: [[number, number], [number, number]] | null,
  fallbackBbox: [[number, number], [number, number]],
): ViewportDescriptor | null {
  if (framing == null) return null;
  if (framing.kind === "bbox") return { kind: "fitBounds", bbox: framing.bounds };
  // A "national" frame uses the STATIC extent, never `nationalBbox`.
  //
  // `nationalBbox` is the DATA-EXTENT snapshot captured at map load. On a
  // camera-restored session it equals the restored REGIONAL view, so a preset
  // promising the national picture re-framed to the region the operator was
  // already looking at — a visible no-op ("cambié de vista y no pasó nada").
  //
  // This is the same defect v2C fixed on the «← Volver a Nacional» path, whose
  // comment states the rule outright (SituationalMap.tsx, the nationalBbox
  // assignment): "The reset promises the national picture; only the static
  // extent delivers it." The preset path kept the old preference and drifted
  // from it (plan unit C.3).
  //
  // What changed: "national" no longer means "whatever we happened to be
  // looking at".
  return { kind: "fitBounds", bbox: fallbackBbox };
}
