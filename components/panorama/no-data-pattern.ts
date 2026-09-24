// Shared stipple fill-pattern for choropleth areas with NO DATA.
//
// WHY (plan D.5, option (b), PO decision 2026-07-29)
// ---------------------------------------------------------------------------
// Four states compete on the operator map: land, no-data, k-anon-suppressed,
// and the lowest data class. Measured in ΔE00, no achromatic grey separates
// no-data from all three at once — the axis is simply full. The colour budget
// went to the pair that actually MISREPRESENTED (class-1 vs land, 4.21 → 16.38,
// see viz-scales.ts), and no-data gets separated by FORM instead, the way
// suppression already is.
//
// WHY DOTS AND NOT A SECOND HATCH: suppression owns the 45° hatch. A 135° hatch
// would be its mirror image — at a glance, on small divisions, two sets of
// parallel diagonals read as the same mark. A dot grid differs in KIND, not in
// angle, so "protected" and "empty" stay distinguishable even in a thumbnail.
//
// WHY IT IS DELIBERATELY FAINT: the live review of 2026-07-28 found views where
// the ENTIRE mainland was no-data. A bold texture over the whole country would
// read as a broken render. This tile is sparse and low-contrast: legible as a
// deliberate "nothing here" when you look, quiet when you don't. It is meant to
// say "outside the data", not to compete with the data.
//
// Kept framework-light (DOM canvas only) so the SituationalMap and the CABA
// inset share ONE pattern — the same no-data mark on every surface.

import { patternPixelRatio } from "@/components/panorama/hatch-pattern";

/** The map-image id every map registers the stipple tile under. */
export const NO_DATA_IMAGE_ID = "pano-stipple-no-data";

/**
 * The dot colour — the SINGLE source of truth shared by the canvas tile and the
 * off-canvas legend swatch (MapLegends), so the map mark and its legend key can
 * never drift apart. Same contract as HATCH_STROKE_RGBA.
 *
 * A muted slate at low alpha: darker than the no-data fill it sits on so the
 * texture is perceivable, far lighter than the suppression hatch (slate-600 at
 * 0.85) so the two marks stay ranked — "protected" is a stronger statement than
 * "empty" and should look like one.
 */
export const NO_DATA_DOT_RGBA = "rgba(100,116,139,0.45)"; // slate-500, deliberately quiet

/**
 * The legend swatch's CSS `background-image`. Defined here, beside the canvas
 * tile, so the legend and the map cannot drift.
 */
export const NO_DATA_SWATCH_CSS = `radial-gradient(${NO_DATA_DOT_RGBA} 1px, transparent 1px)`;

/** Tile size in CSS px; the legend swatch repeats on the same pitch. */
export const NO_DATA_SWATCH_SIZE = "5px 5px";

/**
 * Build the stipple tile as ImageData: a transparent tile carrying two offset
 * dots, which repeats into an even diagonal grid rather than obvious rows and
 * columns (a square grid reads as a UI texture; an offset one reads as
 * cartographic stippling).
 *
 * Returns null when no canvas is available (SSR / no DOM), in which case the
 * caller keeps the solid no-data fill — still honest, just without the mark.
 */
export function buildNoDataImageData(): ImageData | null {
  if (typeof document === "undefined") return null;
  const tile = 10;
  const scale = patternPixelRatio(); // matches the addImage pixelRatio callers pass
  const w = tile * scale;
  const h = tile * scale;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = NO_DATA_DOT_RGBA;
  const r = 0.9 * scale;
  // Two dots per tile, offset by half the tile on both axes, so the repeat
  // forms a staggered lattice with no visible rows.
  for (const [cx, cy] of [
    [w * 0.25, h * 0.25],
    [w * 0.75, h * 0.75],
  ]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return ctx.getImageData(0, 0, w, h);
}
