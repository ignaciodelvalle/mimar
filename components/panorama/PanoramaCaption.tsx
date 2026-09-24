"use client";

// PanoramaCaption — the plain-language per-view caption (panorama-ia-v2 §2.4).
//
// The vehicle of the "context switch": when the VISTA (preset), scope, or period
// change, this line re-states — in plain es-AR — what a mark on the map means at
// the current level ("Cada área es una provincia. Relleno = cobertura antirrábica,
// estado actual. Meta 80%."). Thin presentational wrapper over the pure domain
// builder captionFor; it derives NOTHING from data — no query, no cell value —
// so it can never leak a k-anon-suppressed number.

import { captionFor } from "@/src/modules/panorama/domain/caption";
import type {
  AggregationLevel,
  PanoramaLayer,
  PanoramaPeriod,
} from "@/src/modules/panorama/domain/types";

type Props = {
  /** The primary (captionable) layer of the active board, or null when none. */
  layer: PanoramaLayer | null;
  /** The derived aggregation level the map is currently rendering. */
  level: AggregationLevel;
  /** The active period window (feeds the "últimos N días" phrase for windowed layers). */
  period: PanoramaPeriod;
  /** Active period preset id, so a fixed-start window (ytd) names its frame —
   *  without it this caption day-counts while the dock says "año en curso". */
  presetId?: string;
  /** panorama-percapita: the map paints per-10k rates — the caption's measure
   *  gains "por 10.000 habitantes" so it never claims raw counts. */
  perCapita?: boolean;
};

export function PanoramaCaption({ layer, level, period, perCapita, presetId }: Props) {
  if (layer === null) return null;
  return (
    <p className="text-sm leading-snug text-ln-op-mute" aria-live="polite">
      {captionFor(layer, level, period, { perCapita: perCapita === true, presetId })}
    </p>
  );
}
