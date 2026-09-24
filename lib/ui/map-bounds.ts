// lib/ui/map-bounds.ts — Framework-agnostic, CLIENT-SAFE map-bounds helpers
// (map-QOL P0 primitive). No React and — critically — no server imports here:
// this module is imported by client map components (SituationalMap,
// StaticFirstMap hosts), so it must never pull in lib/infra/gov-scope.ts
// (DB-bound via db/index.ts — a webpack build error in any client bundle).
// The server-side bridge to jurisdictionBounds lives in
// lib/ui/map-bounds.server.ts.
//
// AR_BBOX — Argentina's national bounding box, in the SAME
// [[minLng,minLat],[maxLng,maxLat]] order lib/infra/gov-scope.ts's
// jurisdictionBounds/computeBounds already return (MapLibre `fitBounds`
// bbox order) — so callers never need to reorder coordinates between the two
// modules.
//
// fitBoundsOptions — generalizes the padding/maxZoom pair
// components/charts/MapChoropleth.tsx's auto-fitBounds call already hardcodes
// (`{ padding: 24, animate: false, maxZoom: 9 }`) into one reusable, tuned
// default so later map-QOL callers don't re-guess these numbers per component.

/** A MapLibre-style bounding box: [[minLng,minLat],[maxLng,maxLat]]. */
export type Bbox = [[number, number], [number, number]];

/**
 * Argentina's national bounding box (continental + islands), MapLibre bbox
 * order. Widely-cited extremes: SW ≈ (-73.6, -55.1), NE ≈ (-53.6, -21.8)
 * (https://en.wikipedia.org/wiki/Argentina — Extreme points).
 */
export const AR_BBOX: Bbox = [
  [-73.6, -55.1],
  [-53.6, -21.8],
];

export type FitBoundsOptions = {
  padding: number;
  maxZoom: number;
  animate: boolean;
};

/**
 * Builds a consistent MapLibre `map.fitBounds(bbox, options)` options object.
 * Defaults mirror MapChoropleth.tsx's existing auto-fitBounds call (padding:
 * 24, maxZoom: 9, animate: false) — pass a partial override for a caller that
 * needs a different value, everything else stays on the shared default.
 */
export function fitBoundsOptions(opts?: Partial<FitBoundsOptions>): FitBoundsOptions {
  return {
    padding: opts?.padding ?? 24,
    maxZoom: opts?.maxZoom ?? 9,
    animate: opts?.animate ?? false,
  };
}

/**
 * Shared national-map container height (gob/map-zoom-lockdown follow-up,
 * 2026-07-21; refined same day — national-read pass): Argentina's bbox is
 * tall/narrow (~2.8:1 height:width), so a short/underfilled card leaves
 * fitBounds letterboxing the territory and the national view "reads far".
 * A CSS `clamp()` keeps the fix purely a container-size change (the
 * camera/fitBounds logic is untouched — MapLibre re-derives its fit from the
 * container's actual rendered aspect at fitBounds time, so a taller box
 * alone makes the territory fill more of the frame).
 *
 * Refinement rationale: the first pass (420px/60vh/720px) still read "a
 * touch far" nationally. The math showed WHY the 720px ceiling rarely even
 * engages: at the vh term alone, a typical laptop viewport (~800-950px tall)
 * only reaches ~480-570px — well under the OLD 720px cap — so for most
 * everyday desktop sessions the vh COEFFICIENT, not the ceiling, was the
 * binding constraint; only unusually tall viewports (>1200px, e.g. a
 * maximized browser on a 1440p+ monitor) ever hit the old cap at all. Bumped
 * BOTH terms a proportionate ~10%: 60vh → 66vh (moves the needle for the
 * common desktop case) and 720px → 800px (keeps helping the tall-monitor
 * case the ceiling already existed for). Floor held at 420px on purpose —
 * short/mobile viewports (<~640px tall) are still governed by the floor and
 * see effectively no change, so mobile framing is untouched.
 *
 * Used identically by MapChoropleth and SituationalMap (via PanoramaEmbed)
 * so all 4 gob map screens (perdidas, censo, vigilancia, poblacion) get the
 * SAME height treatment. Province/CABA framing is unaffected in substance:
 * `maxZoom: 13` (MapChoropleth.tsx) already caps how far any scope can zoom
 * in regardless of container size, so a taller box for those scopes only
 * ever adds a little vertical padding around an already-well-fit view, never
 * a wrong zoom level.
 */
export const GOB_MAP_HEIGHT = "clamp(420px, 66vh, 800px)";
