// Panorama IA v2 — the plain-language per-view caption builder (design §2.4).
//
// captionFor(layer, level, period) turns a layer's declarative `caption` material
// + `renderPolicy[level]` into the es-AR sentence rendered between the preset row
// and the suppression notice. It is the vehicle of the "context switch": when the
// VISTA (preset), scope, or period change, the caption is recomputed.
//
// Pure module — no DB, no React, no Next. The descriptor declares the WORDS; this
// builder assembles the sentence, so the domain stays framework-free.

import { pluralizeEs } from "@/lib/utils/format";

import { isNationalDepartmentGrain } from "./layers";
import type { AggregationLevel, PanoramaLayer, PanoramaPeriod, RenderMode } from "./types";

const MS_PER_DAY = 86_400_000;

/** Whole days spanned by a period (inclusive-lower / inclusive-upper ISO dates). */
function periodDays(period: PanoramaPeriod): number {
  const from = Date.parse(period.from);
  const to = Date.parse(period.to);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, Math.round((to - from) / MS_PER_DAY));
}

/**
 * Humanize a whole-day window into the es-AR period phrase. Year-shaped windows
 * read as years — visual review 2026-07-23 (#14): the dock caption said
 * "últimos 1095 días" while its sibling description (view-state-caption's
 * PERIOD_PHRASE) said "últimos 3 años" for the SAME window. A ±2-day slack per
 * year absorbs leap days (a 3y window spanning a 29/2 measures 1096 days, not
 * 1095), so every year-preset window lands on the year phrase; anything that is
 * not year-shaped (7/30/90d, custom ranges) keeps the exact day count.
 */
export function periodDaysPhrase(days: number, presetId?: string): string {
  // C1 (map plan) — "Año en curso" is a FIXED-START window (Jan 1 → today), not
  // a trailing one. Measuring it in days made the console contradict its own
  // picker ("Año en curso" in the chip, "últimos 205 días" in the caption) AND
  // implied a rolling window that slides every day — the opposite of what YTD
  // means. The day count is right; the FRAME is wrong, so name the frame.
  if (presetId === "ytd") return "año en curso";
  const years = Math.round(days / 365.25);
  if (years >= 1 && Math.abs(days - years * 365.25) <= 2) {
    return years === 1 ? "último año" : `últimos ${years} años`;
  }
  return `últimos ${days} ${pluralizeEs(days, "día")}`;
}

/** The time phrase: current-state rollups say "estado actual"; windowed layers
 *  say "últimos N días" (year-shaped windows: "últimos N años") from the active
 *  period. `presetId` lets a fixed-start window (ytd) name its FRAME instead —
 *  it MUST be threaded here, not only into the dock's buildViewMeta, or the
 *  on-canvas caption and the dock contradict each other on the same screen. */
function windowPhrase(
  window: "period" | "current",
  period: PanoramaPeriod,
  presetId?: string,
): string {
  if (window === "current") return "estado actual";
  return periodDaysPhrase(periodDays(period), presetId);
}

/** Encoding verb + mark noun for a render mode (the word the map actually shows). */
function markWords(mode: RenderMode): { subject: string; encoding: string } {
  switch (mode) {
    case "choropleth-fill":
      return { subject: "área", encoding: "Relleno" };
    case "graduated-symbol":
      return { subject: "burbuja", encoding: "Tamaño" };
    case "clustered-points":
      return { subject: "punto", encoding: "Ubicación" };
  }
}

/**
 * Build the plain es-AR caption for a layer at a given administrative level and
 * period. Template (design §2.4):
 *
 *   "Cada {área|burbuja} es una {unit}. {Relleno|Tamaño} = {measure}, {window}."
 *   + " Meta {target}%." when the layer declares a complianceTarget.
 *
 * Reference layers (clustered-points) never aggregate into a unit, so they get a
 * simpler "Puntos individuales: {measure}, {window}." sentence and never a Meta
 * clause (they carry no complianceTarget).
 */
export function captionFor(
  layer: PanoramaLayer,
  level: AggregationLevel,
  period: PanoramaPeriod,
  /** panorama-percapita: while the per-cápita encoding paints per-10k rates the
   *  caption must not claim raw counts — the measure gains the denominator. */
  opts?: { perCapita?: boolean; presetId?: string },
): string {
  const mode = layer.renderPolicy[level];
  const when = windowPhrase(layer.caption.window, period, opts?.presetId);
  const { subject, encoding } = markWords(mode);
  const measure =
    opts?.perCapita === true
      ? `${layer.caption.measure} por 10.000 habitantes`
      : layer.caption.measure;

  if (mode === "clustered-points") {
    return `Puntos individuales: ${measure}, ${when}.`;
  }

  // A NATIONAL_DEPARTMENT_GRAIN layer (zoonosis) renders one graduated symbol per
  // DEPARTMENT even at the national/province request (PO 2026-07-16), so its caption
  // must name the "división" unit — the bubbles ARE departments, so "provincia" would
  // be a label≠map lie. Per-layer: every other layer keeps `level` verbatim. The render
  // MARK is unchanged (renderPolicy.province === renderPolicy.locality === graduated
  // for zoonosis), so only the unit noun flips.
  const unitLevel: AggregationLevel =
    level === "province" && isNationalDepartmentGrain(layer.id) ? "locality" : level;
  const unit = layer.caption.unit[unitLevel];

  // Honesty branch (v1 rate limitation — repository.ts rate-layer note): a `rate`
  // layer paints its true ratePct ONLY at province grain. At any FINER grain
  // (locality/department) the v1 loader falls back to a COUNT per unit
  // (count-density), not a percentage. So the caption must NOT promise a "%"
  // measure or a "Meta X%" target there — it names the fill as a per-unit count,
  // matching the division-fill legend ("conteos por …") and the dock. This keeps
  // the panorama canon (label = number = map): the words never claim a % the fill
  // is not painting. v2 follow-up: compute a real per-department % (needs the
  // numerator/denominator per department); then this branch collapses back into
  // the % + Meta copy below.
  if (layer.dataType === "rate" && level !== "province") {
    return `Cada ${subject} es una ${unit}. ${encoding} = ${measure} — conteo por unidad (no porcentaje), ${when}.`;
  }

  const base = `Cada ${subject} es una ${unit}. ${encoding} = ${measure}, ${when}.`;
  return layer.complianceTarget !== undefined ? `${base} Meta ${layer.complianceTarget}%.` : base;
}
