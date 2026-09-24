// Mounting the D.5(b) no-data stipple onto a MapLibre map.
//
// WHY ITS OWN MODULE: SituationalMap is over the file-size ratchet's budget and
// the fence's instruction is to split rather than feed it. This logic also
// simply belongs beside the pattern it paints (no-data-pattern.ts) rather than
// buried in a 3400-line component — the tile, the layer that uses it, and the
// legend swatch that mirrors it are one idea.
//
// WHAT IT IS FOR: on the light operator canvas the no-data fill sits ΔE00 1.48
// from the land basemap, so an area nobody reported on was indistinguishable
// from map background. Colour cannot fix that — four states do not fit on one
// achromatic axis (see viz-scales.ts) — so no-data is separated by FORM, the
// way k-anon suppression already is with its 45° hatch.

// Namespace type import, not a default import: maplibre-gl v6 is ESM-only
// and publishes NO default export, so `import type maplibregl from ...` no
// longer names anything. The namespace carries the same type members, which
// is what keeps every `maplibregl.Xxx` reference below unchanged.
import type * as maplibregl from "maplibre-gl";

import { divisionNoDataFilter } from "@/components/panorama/division-fill";
import { NO_DATA_IMAGE_ID } from "@/components/panorama/no-data-pattern";
import { provinceNoDataFilter } from "@/components/panorama/province-choropleth-style";
import {
  DIVISION_LINE_ID,
  DIVISION_NO_DATA_ID,
  DIVISION_SRC,
  DIVISION_SUPPRESS_ID,
  NO_DATA_FILL_OPACITY,
  provinceNoDataLayerId,
} from "@/components/panorama/situational-map-config";
import type { FeatureCollection } from "@/src/modules/panorama/domain/types";

const STIPPLE_PAINT: maplibregl.FillLayerSpecification["paint"] = {
  "fill-pattern": NO_DATA_IMAGE_ID,
  "fill-opacity": NO_DATA_FILL_OPACITY,
};

/**
 * Stipple the divisions (departamento / barrio) this layer has no data on.
 *
 * Mounted BELOW the suppression hatch. A partially-suppressed division is not a
 * no-data division and the complement filter already excludes it; the ordering
 * is a second line of defence, so if the two ever did overlap the stronger
 * claim ("protected") stays legible instead of the textures interfering.
 *
 * No pattern image (SSR / no canvas) → mount nothing. Unlike suppression, which
 * falls back to a solid tone because its alternative is being mistaken for
 * no-data, no-data ALREADY has its own solid fill underneath: a fallback would
 * change nothing and only risk darkening it into the suppressed band.
 */
export function mountDivisionNoDataLayer(
  map: maplibregl.Map,
  layerId: string,
  values: ReadonlyMap<string, number>,
  suppressed: ReadonlySet<string>,
): void {
  if (!map.getSource(DIVISION_SRC)) return;
  if (!map.hasImage(NO_DATA_IMAGE_ID)) return;
  const id = DIVISION_NO_DATA_ID(layerId);
  const filter = divisionNoDataFilter(values, suppressed);
  if (map.getLayer(id)) {
    map.setFilter(id, filter);
    return;
  }
  const suppressLayer = DIVISION_SUPPRESS_ID(layerId);
  const before = map.getLayer(suppressLayer)
    ? suppressLayer
    : map.getLayer(DIVISION_LINE_ID)
      ? DIVISION_LINE_ID
      : undefined;
  map.addLayer({ id, type: "fill", source: DIVISION_SRC, paint: STIPPLE_PAINT, filter }, before);
}

/**
 * Stipple the provinces this layer has no value for.
 *
 * This is the grain the 2026-07-28 live review caught: a vista whose entire
 * mainland was COLOR_NO_DATA and read as bare basemap. Mounted on the same
 * chrome anchor as the province fill so province edges stay crisp on top.
 */
export function mountProvinceNoDataLayer(
  map: maplibregl.Map,
  layerId: string,
  features: FeatureCollection,
  before?: string,
): void {
  if (!map.getSource("ar-provinces")) return;
  if (!map.hasImage(NO_DATA_IMAGE_ID)) return;
  const id = provinceNoDataLayerId(layerId);
  const filter = provinceNoDataFilter(features);
  if (map.getLayer(id)) {
    map.setFilter(id, filter);
    return;
  }
  map.addLayer({ id, type: "fill", source: "ar-provinces", paint: STIPPLE_PAINT, filter }, before);
}

/**
 * Resolve WHICH province choropleth owns the no-data stipple, and act on it.
 *
 * PO report 2026-08-01 ("los puntitos se ven por todos lados, en varios
 * colores"). Every province choropleth used to mount its own stipple, so with
 * two layers active, layer B's grey dots painted over layer A's coloured fill
 * wherever B had no value — and grey at 45% over a saturated fill reads as dots
 * IN that province's colour, which is why it looked like a multi-coloured
 * texture instead of a mark.
 *
 * Worse than ugly. The stipple MEANS "nothing was reported here". Painting it
 * over a province that reported perfectly well on the layer the operator is
 * reading is the map contradicting itself — the same class of defect as a
 * legend naming a mark the canvas does not paint, pointed the other way.
 *
 * The TOP layer is the one being read; its absence of data is the only one that
 * answers "why is this province blank". The layers underneath contribute
 * colour, not absence.
 *
 * The REMOVE branch is not symmetry for its own sake: ownership changes without
 * a remount (activating a second choropleth demotes the incumbent), so a layer
 * that stops being top has to give the mark back or it survives the swap and
 * the bug returns looking like a caching problem.
 */
export function syncProvinceNoDataOwnership(
  map: maplibregl.Map,
  layerId: string,
  features: FeatureCollection,
  isTop: boolean,
  before?: string,
): void {
  if (isTop) {
    mountProvinceNoDataLayer(map, layerId, features, before);
    return;
  }
  const id = provinceNoDataLayerId(layerId);
  if (map.getLayer(id)) map.removeLayer(id);
}
