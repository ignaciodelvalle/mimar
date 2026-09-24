// Pure helper for the drill-level place labels (task #64).
//
// At department/barrio drill there was not a single place NAME on the map — the
// operator could orient only by hovering. This computes a representative label
// anchor (the geometry's bounding-box center) per division polygon so the map can
// render a subtle NAME at each division.
//
// WHY a bbox center + HTML markers rather than a MapLibre `symbol`/`text-field`
// layer: SituationalMap ships NO glyph server (a deliberate privacy-architecture
// constraint — see the file's top docblock: "we ship no glyph server, map layers
// carry NO on-canvas text; counts and details are surfaced via HTML"). A symbol
// layer's `text-field` renders NOTHING without glyphs, so the honest in-repo path
// is HTML text anchored to a lng/lat (maplibregl.Marker auto-repositions it). This
// helper stays PURE (no maplibre, no DOM) so the anchor math is unit-testable; the
// map wires the markers.

/** A place-label anchor: the division code, its display name, a lng/lat, and a
 * `weight` (the geometry's bbox area in deg²) used to rank labels for
 * progressive disclosure — largest units surface first (task #36 fix 3/6). */
export type DivisionLabelAnchor = {
  code: string;
  name: string;
  lng: number;
  lat: number;
  weight: number;
};

/** Minimal division feature shape (raw GeoJSON from the departments/barrios files).
 * `geometry` is typed `unknown` because it comes from untyped GeoJSON — bboxCenter
 * narrows it at runtime. */
type MinimalFeature = {
  geometry?: unknown;
  properties?: { code?: unknown; name?: unknown } | null;
};

/**
 * The bounding-box CENTER of a polygon/multipolygon geometry, or null when the
 * geometry is absent, an unsupported type, or has no finite coordinates. A bbox
 * center is cheap and stable; for the compact, mostly-convex administrative
 * divisions it lands inside (or very near) the shape, which is all a subtle label
 * needs — it is an anchor, not a centroid guarantee.
 */
function bboxExtent(
  geometry: unknown,
): { minLng: number; minLat: number; maxLng: number; maxLat: number } | null {
  let minLng = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let seen = false;

  const visit = (pt: unknown): void => {
    if (!Array.isArray(pt)) return;
    const lng = pt[0];
    const lat = pt[1];
    if (typeof lng !== "number" || typeof lat !== "number") return;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
    seen = true;
  };

  if (typeof geometry !== "object" || geometry === null) return null;
  const g = geometry as { type?: unknown; coordinates?: unknown };
  if (g.type === "Polygon" && Array.isArray(g.coordinates)) {
    for (const ring of g.coordinates as number[][][]) for (const pt of ring) visit(pt);
  } else if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
    for (const poly of g.coordinates as number[][][][])
      for (const ring of poly) for (const pt of ring) visit(pt);
  } else {
    return null;
  }
  if (!seen) return null;
  return { minLng, minLat, maxLng, maxLat };
}

export function bboxCenter(geometry: unknown): [number, number] | null {
  const e = bboxExtent(geometry);
  if (e === null) return null;
  return [(e.minLng + e.maxLng) / 2, (e.minLat + e.maxLat) / 2];
}

/**
 * Build label anchors for the division features that carry BOTH a `code` and a
 * `name`. Features with no resolvable center, code, or name are skipped (no label
 * rather than a mispositioned one).
 */
export function divisionLabelAnchors(features: readonly MinimalFeature[]): DivisionLabelAnchor[] {
  const out: DivisionLabelAnchor[] = [];
  for (const f of features) {
    const code = f.properties?.code;
    const name = f.properties?.name;
    if (typeof code !== "string" || code.length === 0) continue;
    if (typeof name !== "string" || name.length === 0) continue;
    const e = bboxExtent(f.geometry);
    if (e === null) continue;
    const weight = (e.maxLng - e.minLng) * (e.maxLat - e.minLat);
    out.push({
      code,
      name,
      lng: (e.minLng + e.maxLng) / 2,
      lat: (e.minLat + e.maxLat) / 2,
      weight,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Zoom-gated legibility + progressive disclosure (task #36 fix 3/6)
// ---------------------------------------------------------------------------
//
// PO: place labels must appear "solo cuando se esté muy cerca" — not the moment
// divisions activate (Z_DIVISIONS 6.5), where a whole province of ~130
// departments renders an illegible name soup. Gate by zoom and reveal the
// LARGEST units first (bbox-area weight — "ir mostrando los más grandes
// primero"), growing the visible count as the camera zooms in until, past
// Z_LABELS_ALL, every division is named.

/** Zoom below which NO division labels render (names are illegible / overlap). */
export const Z_LABELS_MIN = 8;
/** Zoom at/above which EVERY division label renders. */
export const Z_LABELS_ALL = 9.6;

/**
 * The subset of label anchors to render at the given zoom (task #36 fix 3/6).
 *
 *  - `forceAll` (opt-in "Nombres") → every label, regardless of zoom.
 *  - zoom < `min` → none (too far to read).
 *  - zoom ≥ `all` → every label.
 *  - in-between → the largest-`weight` units first, the count growing linearly
 *    with zoom (progressive disclosure). At most `maxLabels` are ever returned
 *    so a dense province never floods the canvas with markers.
 *
 * Pure — no map, no DOM.
 */
export function visibleDivisionLabels(
  anchors: readonly DivisionLabelAnchor[],
  zoom: number,
  opts?: { forceAll?: boolean; min?: number; all?: number; maxLabels?: number },
): DivisionLabelAnchor[] {
  const min = opts?.min ?? Z_LABELS_MIN;
  const all = opts?.all ?? Z_LABELS_ALL;
  const maxLabels = opts?.maxLabels ?? 60;
  // Largest units first — the ranking is stable and drives progressive reveal.
  const ranked = [...anchors].sort((a, b) => b.weight - a.weight || a.code.localeCompare(b.code));
  if (opts?.forceAll) return ranked.slice(0, maxLabels);
  if (zoom < min) return [];
  if (zoom >= all) return ranked.slice(0, maxLabels);
  const t = (zoom - min) / (all - min); // 0 → 1 across the reveal band
  const count = Math.min(maxLabels, Math.max(1, Math.ceil(ranked.length * t)));
  return ranked.slice(0, count);
}
