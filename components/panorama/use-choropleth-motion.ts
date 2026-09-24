"use client";

// use-choropleth-motion — B1 (map plan): the map's reduced-motion floor.
//
// Extracted from SituationalMap so that file stops growing (it is already past
// its budget in scripts/check-file-size.ts), and so the floor lives in ONE
// named place instead of being an anonymous effect halfway down a 3400-line
// component.
//
// Returns a ref carrying the live preference. The map's paint and camera code
// runs inside imperative maplibre handlers that close over their first render,
// so they read `.current` rather than the reactive value.

// Namespace type import, not a default import: maplibre-gl v6 is ESM-only
// and publishes NO default export, so `import type maplibregl from ...` no
// longer names anything. The namespace carries the same type members, which
// is what keeps every `maplibregl.Xxx` reference below unchanged.
import type * as maplibregl from "maplibre-gl";
import { type RefObject, useEffect, useRef } from "react";

import { DIVISION_FADE_MS, DIVISION_LINE_ID } from "@/components/panorama/situational-map-config";
import { useReducedMotion } from "@/lib/hooks/useReducedMotion";

// The division outline's fade-in is chrome — same floor, same sweep. Imported,
// not re-declared, so the id can never drift from the layer that uses it.

export function useChoroplethMotion(mapRef: RefObject<maplibregl.Map | null>): RefObject<boolean> {
  const reducedMotion = useReducedMotion();
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  // Turning the OS preference ON must stop the animation NOW, not at the next
  // data update — a floor is a promise, not a default. Walks the mounted
  // division-outline fade and re-sets its transition when the preference flips.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || typeof map.getStyle !== "function") return;
    if (!map.getLayer(DIVISION_LINE_ID)) return;
    map.setPaintProperty(DIVISION_LINE_ID, "line-opacity-transition", {
      duration: reducedMotion ? 0 : DIVISION_FADE_MS,
      delay: 0,
    });
  }, [reducedMotion, mapRef]);

  return reducedMotionRef;
}
