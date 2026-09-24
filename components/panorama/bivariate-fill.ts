// Client-side rendering helpers for the bivariate "riesgo-brotes" choropleth
// (task #63). Extracted from SituationalMap so the palette + maplibre expression
// are unit-testable WITHOUT importing maplibre-gl (only its expression TYPE is
// imported). The PURE classification lives in the domain module
// (src/modules/panorama/domain/bivariate.ts); this file owns the PRESENTATION:
// the validated dark-surface palette, the fill/hatch expressions, the 3×3 legend
// matrix data, and the pinned-popup readout.
//
// English identifiers, es-AR user copy (project invariant #4).

import type { ExpressionSpecification, FilterSpecification } from "maplibre-gl";

import type { LayerReadout } from "@/components/panorama/map-popup";
import {
  type BivariateCell,
  type TercileClass,
  bivariateIndex,
  coverageClassLabel,
  riskLabel,
  signalClassLabel,
} from "@/src/modules/panorama/domain/bivariate";
import { COLOR_NO_DATA } from "@dim/contract/viz";

/**
 * The 3×3 bivariate palette, flat-indexed `sig * 3 + cov` (see bivariateIndex).
 * Coverage runs LEFT→RIGHT low→high (neutral slate → teal); the signal runs
 * BOTTOM→TOP low→high (dim → hot). The RISK corner (index 6, low coverage × high
 * signal) is a warm pink-red that reads as ALARM against the two cool teal
 * "calm" cells — salient by HUE, not merely luminance, on the dark navy surface.
 *
 * VALIDATED for the LIGHT v2C canvas (#eef1f4 land), PO-approved 2026-07-14
 * (design §8 fork #2 closed): hill-climbed over Lab targets with the hue
 * families preserved (slate→teal coverage axis, dim→hot signal axis, crimson
 * RISK corner) and a luminance-diagonal structure that survives dichromacy.
 * Measured (Machado 2009 severity-1.0 + CIE76, fence in
 * __tests__/bivariate-cvd.test.ts): every cell ≥ 3.19:1 vs the land (WCAG
 * 1.4.11), normal-vision min all-pairs dE 13.2, protanopia/deuteranopia min
 * dE 9.4, RISK vs the calm teals ≥ 18.9 under both simulations. It replaces
 * the dark-navy-validated palette whose light-canvas measurement showed the
 * RISK corner collapsing into a calm teal for protanopes (dE 3.8). Do not
 * reorder — the domain's bivariateIndex and the legend grid both assume this
 * layout.
 */
export const BIVARIATE_PALETTE: readonly string[] = [
  // signal LOW (bottom row): slate → teal
  "#698ba2",
  "#4f8b8b",
  "#4e8771",
  // signal MID
  "#905270",
  "#505274",
  "#066461",
  // signal HIGH (top row): RISK crimson → deep violet
  "#8f072e",
  "#551f5e",
  "#0b3578",
] as const;

/** The palette hex of the RISK corner (low coverage × high signal). */
export const BIVARIATE_RISK_COLOR = BIVARIATE_PALETTE[6];

/**
 * The fill color for one cell, or null when no color may be shown:
 *  - `suppressed` → null (the caller renders the shared k-anon hatch instead — a
 *    bivariate color must never stand in for a protected value);
 *  - either class unresolved (no-data in an input) → null (transparent no-data).
 */
export function bivariateCellColor(cell: BivariateCell): string | null {
  if (cell.suppressed) return null;
  if (cell.coverageClass === null || cell.signalClass === null) return null;
  return BIVARIATE_PALETTE[bivariateIndex(cell.coverageClass, cell.signalClass)];
}

/**
 * Build the data-driven `fill-color` for the bivariate province choropleth: a
 * `match` on the polygon `code` → the cell's bivariate color, defaulting to
 * COLOR_NO_DATA for provinces with no classified cell (no-data OR suppressed —
 * suppressed provinces are additionally painted by the hatch overlay on top).
 * Returns a flat COLOR_NO_DATA expression when nothing is classified.
 */
export function bivariateFillColorExpr(cells: readonly BivariateCell[]): ExpressionSpecification {
  const pairs: Array<[string, string]> = [];
  for (const c of cells) {
    const color = bivariateCellColor(c);
    if (color !== null) pairs.push([c.provinceCode, color]);
  }
  if (pairs.length === 0) return COLOR_NO_DATA as unknown as ExpressionSpecification;
  return [
    "match",
    ["get", "code"],
    ...pairs.flatMap(([code, color]) => [code, color] as [string, string]),
    COLOR_NO_DATA,
  ] as unknown as ExpressionSpecification;
}

/** The province codes whose bivariate cells are k-anon SUPPRESSED (→ hatch). */
export function bivariateSuppressedCodes(cells: readonly BivariateCell[]): string[] {
  return cells.filter((c) => c.suppressed).map((c) => c.provinceCode);
}

/**
 * How the current bivariate frame USES the grey (COLOR_NO_DATA) fill.
 *
 * RA-7 F10 (2026-07-31) — A PAINTED STATE THAT WAS NEVER DECLARED. The 3×3
 * legend names nine colours and (since 2026-07-30) the hatch, and stops there.
 * But `bivariateFillColorExpr` defaults to COLOR_NO_DATA for every province
 * `bivariateCellColor` refuses to colour, and that refusal covers TWO different
 * situations plus one that is separately marked:
 *
 *   - `missingAxis` — the jurisdiction reported one of the two layers and not
 *     the other, so the CROSS cannot be classified even though half the data
 *     exists. There is something there; we just cannot say where it falls on
 *     the matrix.
 *   - `noData`      — neither axis reported.
 *   - suppressed    — declared already, by the hatch key.
 *
 * "no hay nada" and "no pudimos cruzarlo" are opposite conclusions for a
 * municipality, and the map paints them the SAME grey with no key at all: the
 * operator sees a colour and the legend offers no reading for it. The colour
 * genuinely cannot separate the two (one hue, two meanings) — inventing two
 * swatches would be a fresh lie — so the honest fix is a key that names the
 * grey, says which of the two situations this frame contains, and points at the
 * popup, which DOES resolve it per jurisdiction (`bivariateReadouts` marks each
 * axis row `nodata` individually).
 *
 * Suppressed cells are excluded from both counts: they carry their own mark and
 * their own key, and folding them in here would double-declare them.
 */
export function bivariateGreyStates(cells: readonly BivariateCell[]): {
  missingAxis: boolean;
  noData: boolean;
} {
  let missingAxis = false;
  let noData = false;
  for (const c of cells) {
    if (c.suppressed) continue;
    const hasCoverage = c.coverageClass !== null;
    const hasSignal = c.signalClass !== null;
    if (hasCoverage && hasSignal) continue;
    if (hasCoverage || hasSignal) missingAxis = true;
    else noData = true;
  }
  return { missingAxis, noData };
}

/**
 * A MapLibre `filter` selecting the suppressed province polygons (for the
 * diagonal-hatch overlay), matching the `code` property against the suppressed
 * set. Constant-`false` when empty so the hatch layer renders nothing.
 */
export function bivariateSuppressedFilter(codes: readonly string[]): FilterSpecification {
  if (codes.length === 0) return false as unknown as FilterSpecification;
  return ["match", ["get", "code"], [...codes], true, false] as unknown as FilterSpecification;
}

// ---------------------------------------------------------------------------
// Legend (the 3×3 matrix itself is the legend)
// ---------------------------------------------------------------------------

/** One legend swatch: its palette color + the (cov, sig) class it represents. */
export type BivariateLegendSwatch = {
  color: string;
  cov: TercileClass;
  sig: TercileClass;
  /** True for the risk corner (low coverage × high signal) — marked in the grid. */
  risk: boolean;
};

/**
 * The 3×3 legend grid in ROW-MAJOR display order, TOP row = high signal. Consumers
 * render it as a 3×3 matrix with axes "Cobertura →" (x) and "Señales ↑" (y); the
 * risk-flagged swatch gets the corner marker.
 */
export const BIVARIATE_LEGEND_GRID: readonly BivariateLegendSwatch[] = (() => {
  const grid: BivariateLegendSwatch[] = [];
  for (let sig = 2 as TercileClass; sig >= 0; sig = (sig - 1) as TercileClass) {
    for (let cov = 0 as TercileClass; cov <= 2; cov = (cov + 1) as TercileClass) {
      grid.push({
        color: BIVARIATE_PALETTE[bivariateIndex(cov, sig)],
        cov,
        sig,
        risk: cov === 0 && sig === 2,
      });
    }
  }
  return grid;
})();

// ---------------------------------------------------------------------------
// Pinned-popup readout
// ---------------------------------------------------------------------------

/** Format a coverage percentage in es-AR ("48%"). */
function fmtPct(value: number): string {
  return `${value.toLocaleString("es-AR", { maximumFractionDigits: 1 })}%`;
}

/** Axis row labels for the popup — defaults keep the original brotes wording;
 *  a declared pair (BivariatePair) supplies its own (e.g. Registro PPP ×
 *  Mordeduras) so the readout names the axes actually crossed. */
export type BivariateReadoutLabels = { coverageLabel: string; signalLabel: string };

const DEFAULT_READOUT_LABELS: BivariateReadoutLabels = {
  coverageLabel: "Cobertura",
  signalLabel: "Señales",
};

/**
 * Build the pinned-popup rows for a bivariate cell: BOTH raw values with their
 * class, plus the combined intensity band — e.g.
 *   Cobertura → "48% (baja)"   Señales → "12 (altas)"   Intensidad → "alta".
 * (C2, 2026-07-22: row renamed from "Riesgo" — low coverage × high signals is
 * reporting intensity, not measured epidemiological risk; riskLabel's
 * underlying bajo/medio/alto classification is UNCHANGED, only the row label.)
 * A suppressed cell shows the protected state on every value row (never a class),
 * so the popup can no more infer a hidden value than the color can.
 */
export function bivariateReadouts(
  cell: BivariateCell,
  labels: BivariateReadoutLabels = DEFAULT_READOUT_LABELS,
): LayerReadout[] {
  if (cell.suppressed) {
    return [
      { label: labels.coverageLabel, valueText: null, state: "suppressed" },
      { label: labels.signalLabel, valueText: null, state: "suppressed" },
    ];
  }
  const rows: LayerReadout[] = [];
  rows.push({
    label: labels.coverageLabel,
    valueText:
      cell.coverageValue != null
        ? `${fmtPct(cell.coverageValue)}${cell.coverageClass !== null ? ` (${coverageClassLabel(cell.coverageClass)})` : ""}`
        : null,
    state: cell.coverageValue == null ? "nodata" : undefined,
  });
  rows.push({
    label: labels.signalLabel,
    valueText:
      cell.signalValue != null
        ? `${cell.signalValue.toLocaleString("es-AR")}${cell.signalClass !== null ? ` (${signalClassLabel(cell.signalClass)})` : ""}`
        : null,
    state: cell.signalValue == null ? "nodata" : undefined,
  });
  if (cell.coverageClass !== null && cell.signalClass !== null) {
    rows.push({
      label: "Intensidad",
      valueText: riskLabel(cell.coverageClass, cell.signalClass),
    });
  }
  return rows;
}
