// Panorama freshness/liveness caption (staging QA 2026-07-17 Cursor I2; reshaped
// by the cube-ON decision, Metrics review K4 + Scale S3, 2026-07-24).
//
// The choropleth layers can be served from the precomputed panorama_cube, which
// refreshes once daily (vercel.json cron `0 3 * * *`; sub-daily cadence needs
// Vercel Pro). The operator must always be able to tell which of the two worlds
// the view comes from:
//   - cube-served → "Datos precalculados al {fecha/hora AR}" — the data is a
//     daily snapshot, and its age is declared;
//   - live-served → "Datos en vivo" — computed on request; and when any active
//     layer hit the per-layer row cap, the caption names the capped layers so a
//     truncated live view is never presented as complete (the same disclosure
//     the LayerPanel badge and the map-table CSV comment carry).
//
// Pure domain helper: it turns (build timestamp, truncated-layer labels) into
// the es-AR caption line. The CALLER decides WHAT to pass — the cube-vs-live
// decision lives in the application layer (load-layer-features-cube.ts); this
// only formats what it's given. No DB, no React, no Next.

import { formatDateTimeNumericAr } from "@/lib/utils/format";

/**
 * The es-AR freshness/liveness caption for the panorama map chrome, e.g.
 *   "Datos precalculados al 17/07/2026 04:30"          (fresh cube)
 *   "Datos en vivo"                                     (live)
 *   "Datos en vivo · capas al tope (2.000): Perdidas"   (live, capped layer)
 *
 * `builtAt` null/undefined/unparseable → the view is live-served (or the cube
 * has nothing honest to claim), so the caption says so instead of fabricating a
 * freshness the cube can't back.
 *
 * RA-7 F7 (2026-07-31) — THE CAP NOTICE IS NEVER SWALLOWED. This used to
 * `return` inside the `builtAt` branch, on the reasoning that "a cube-served
 * view is not subject to the live cap". That reasoning does not survive contact
 * with either caller. `builtAt` is ONE stamp for the WHOLE board: the shared
 * board builder (lib/panorama/build-panorama-board.ts) takes the FIRST seeded
 * layer actually served from the cube, so any single cubeable layer produces
 * it. And
 * `truncatedLayers` is not "the cube layer's residual truncation" — it is the
 * label list of every ACTIVE layer whose own response came back `truncated`
 * (PanoramaConsole's `mapTableTruncatedLayers`), which on a mixed board is a
 * set of LIVE layers that genuinely hit the 2.000-row cap. So one cubeable
 * layer silently deleted the incompleteness disclosure of every other layer on
 * screen — a notice vanishing because of a layer the operator is not looking
 * at. The two facts are independent and are now both stated:
 *
 *   "Datos precalculados al 17/07/2026 04:30 · capas al tope (2.000): Perdidas"
 *
 * The LayerPanel badge is a per-layer disclosure one panel away; it is not a
 * substitute for the board-level line, which is the one that ends up in the
 * screenshot.
 */
export function panoramaFreshnessCaption(
  builtAt: Date | string | null | undefined,
  truncatedLayers: string[] = [],
): string {
  const cap =
    truncatedLayers.length > 0 ? ` · capas al tope (2.000): ${truncatedLayers.join(", ")}` : "";
  if (builtAt) {
    const date = builtAt instanceof Date ? builtAt : new Date(builtAt);
    if (!Number.isNaN(date.getTime())) {
      return `Datos precalculados al ${formatDateTimeNumericAr(date)}${cap}`;
    }
  }
  return `Datos en vivo${cap}`;
}
