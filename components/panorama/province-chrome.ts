// Mount the province choropleth's two chrome layers: the fill and the boundary
// line, both anchored below the division chrome.
//
// EXTRACTED from SituationalMap (file-size ratchet, 2026-08-01) because it is
// the part of addProvinceChoroplethLayer that closes over nothing — the color
// expression arrives as an argument, and everything else is a module constant.
// The interaction wiring stayed behind: it reaches into the console's own
// handlers and would have to drag them along.
//
// THE ANCHOR IS THE WHOLE POINT of this function, and it is not obvious.
// Without it, a province choropleth mounted AFTER division chrome already
// exists lands at the ABSOLUTE top of the stack — above the outline and hover
// chrome, and above the raised outbreak/signal marks, which raiseMarksAboveFills
// anchors to the same layer. The visible symptom is "brotes" briefly painting
// UNDER the province fill. Anchoring to DIVISION_LINE_ID (the lowest chrome
// layer) puts it back where addDivisionFillLayer already puts its own fill.
//
// In the common national case no division chrome is mounted, the anchor
// resolves to undefined, and MapLibre appends to the top exactly as before —
// so this only bites when chrome pre-exists.

// Namespace type import, not a default import: maplibre-gl v6 is ESM-only
// and publishes NO default export, so `import type maplibregl from ...` no
// longer names anything. The namespace carries the same type members, which
// is what keeps every `maplibregl.Xxx` reference below unchanged.
import type * as maplibregl from "maplibre-gl";

import {
  COLOR_ADMIN_STROKE,
  DIVISION_LINE_ID,
  PROV_LINE_OPACITY,
  PROV_LINE_WIDTH,
  choroplethFillPaint,
  provinceFillLayerId,
  provinceLineLayerId,
} from "@/components/panorama/situational-map-config";

/**
 * Idempotent: each layer is added only when absent, so this is safe on every
 * sync. Returns the resolved chrome anchor so the caller can mount its own
 * overlays (the no-data stipple) into the same slot.
 */
export function mountProvinceChrome(
  map: maplibregl.Map,
  layerId: string,
  colorExpr: Parameters<typeof choroplethFillPaint>[0],
): string | undefined {
  const fillId = provinceFillLayerId(layerId);
  const lineId = provinceLineLayerId(layerId);
  const chromeAnchor = map.getLayer(DIVISION_LINE_ID) ? DIVISION_LINE_ID : undefined;

  if (!map.getLayer(fillId)) {
    map.addLayer(
      { id: fillId, type: "fill", source: "ar-provinces", paint: choroplethFillPaint(colorExpr) },
      chromeAnchor,
    );
  }

  if (!map.getLayer(lineId)) {
    // cursor #1: admin-neutral stroke (NOT COLOR_CANVAS) so province edges read
    // as boundaries over the fill, never as near-black cracks. Faded by
    // updateChromeHierarchy when divisions are active (cursor #5).
    map.addLayer(
      {
        id: lineId,
        type: "line",
        source: "ar-provinces",
        paint: {
          "line-color": COLOR_ADMIN_STROKE,
          "line-width": PROV_LINE_WIDTH,
          "line-opacity": PROV_LINE_OPACITY,
        },
      },
      chromeAnchor,
    );
  }

  return chromeAnchor;
}
