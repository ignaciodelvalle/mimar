// Bivariate choropleth domain — the "riesgo-brotes" encoding (task #63).
//
// The "Señales de brote" preset stacks a rabies-COVERAGE choropleth (cobertura,
// a rate) under a ZOONOSIS-signal overlay. The operator's real question is the
// INTERSECTION: where is coverage LOW and the signal HIGH? A bivariate choropleth
// answers it directly — coverage terciles × signal terciles = a 3×3 class matrix,
// and the low-coverage / high-signal corner is the RISK corner.
//
// This module is PURE (no DB, no React, no maplibre — the domain purity the
// biome noRestrictedImports override enforces for src/modules/*/domain/**). It
// classifies into terciles, joins the two layer results per administrative unit,
// and PROPAGATES k-anon suppression: a unit suppressed in EITHER input is
// suppressed here too, so a bivariate color can NEVER be used to infer a value
// the k=5 rule protected. The maplibre fill/legend live in the client helper
// components/panorama/bivariate-fill.ts; the palette hexes live there (colors are
// a presentation concern) — this module reasons only in class indices.

import type { FeatureCollection, LayerId } from "./types";

// ---------------------------------------------------------------------------
// Declared bivariate PAIRS — the axis combinations the join supports
// ---------------------------------------------------------------------------

/**
 * One supported bivariate axis pair: a coverage-style RATE choropleth (the x
 * axis, joined by provinceCode/value) crossed with a per-unit COUNT overlay
 * (the y axis, joined by province/count). Carries the es-AR presentation
 * vocabulary so every surface (map label, legend card, popup rows, mode
 * switcher) names the SAME axes.
 *
 * WHY a declared table and not a shape predicate (the P2 constraint, kept): a
 * broad "any rate × any count" rule would offer the toggle for hand-edited
 * combos nobody vetted for tercile sanity. A pair is added HERE deliberately,
 * with its copy, and everything downstream generalizes from it.
 */
export type BivariatePair = {
  /** The RATE choropleth layer (x axis — joined by provinceCode + value). */
  coverage: LayerId;
  /** The per-unit COUNT layer (y axis — joined by province + count). */
  signal: LayerId;
  /** Map-layer label while the encoding paints (also the legend subtitle). */
  mapLabel: string;
  /** Popup row label for the x axis ("Cobertura" / "Registro PPP"). */
  coverageLabel: string;
  /** Popup row label for the y axis ("Señales" / "Mordeduras"). */
  signalLabel: string;
  /** Legend x-axis caption. */
  coverageAxis: string;
  /** Legend y-axis caption. */
  signalAxis: string;
  /** Legend card title. */
  legendTitle: string;
  /** ModeSwitcher sub copy — what the risk read crosses, honestly. */
  switcherSub: string;
  /** Legend risk-corner tooltip — names the corner in this pair's vocabulary. */
  riskCornerNote: string;
};

/** The vetted pairs. Order matters only for documentation. */
export const BIVARIATE_PAIRS: readonly BivariatePair[] = [
  {
    coverage: "cobertura",
    signal: "zoonosis",
    // C2 language contract (2026-07-22, red-team #5): this pair crosses LOW
    // VACCINE-REGISTRY COVERAGE × HIGH SIGNAL COUNT — reporting/registration
    // INTENSITY, not measured epidemiological risk (a thin padrón alone can
    // rank a province "high" here with zero real outbreaks). Renamed from
    // "Riesgo de brotes" — the computation is unchanged, only the copy.
    mapLabel: "Intensidad de reporte de brotes (cobertura × señales)",
    coverageLabel: "Cobertura",
    signalLabel: "Señales",
    coverageAxis: "Cobertura →",
    signalAxis: "Señales ↑",
    legendTitle: "Intensidad de reporte (brotes)",
    switcherSub:
      "Cómo se pinta la vista — la intensidad de reporte cruza cobertura baja × señales altas",
    riskCornerNote: "Intensidad alta: cobertura baja · señales altas",
  },
  {
    coverage: "ppp",
    signal: "mordeduras",
    mapLabel: "Riesgo PPP (registro × mordeduras)",
    coverageLabel: "Registro PPP",
    signalLabel: "Mordeduras",
    coverageAxis: "Registro PPP →",
    signalAxis: "Mordeduras ↑",
    legendTitle: "Riesgo PPP",
    switcherSub: "Cómo se pinta la vista — el riesgo cruza registro PPP bajo × mordeduras altas",
    riskCornerNote: "Riesgo alto: registro PPP bajo · mordeduras altas",
  },
];

/**
 * The declared pair the ACTIVE layer set matches, or null. The set must be
 * EXACTLY the pair (both axes active, nothing else) — a third stacked layer
 * would paint marks the 3×3 read does not encode.
 */
export function bivariatePairFor(layers: readonly LayerId[]): BivariatePair | null {
  const active = new Set(layers);
  if (active.size !== 2) return null;
  for (const pair of BIVARIATE_PAIRS) {
    if (active.has(pair.coverage) && active.has(pair.signal)) return pair;
  }
  return null;
}

/** True when {a, b} is exactly a declared pair's axis set (order-free). Used by
 *  the F2 compatibility exception that lets a pair's two layers co-activate. */
export function isDeclaredBivariatePair(a: LayerId, b: LayerId): boolean {
  return BIVARIATE_PAIRS.some(
    (p) => (p.coverage === a && p.signal === b) || (p.coverage === b && p.signal === a),
  );
}

/**
 * Plain-language caption for the bivariate encoding — the Informe caption and the
 * LegendPill expanded description both read THIS, so neither hardcodes a specific
 * pair's axis names. PO fix (validacion-A 2026-07-23): both call sites used to spell
 * out "cobertura antirrábica × señales de zoonosis" unconditionally, which named the
 * zoonosis pair's vocabulary even while the ppp × mordeduras pair was the one active —
 * the reference then lied about what the matrix actually crossed. Building the
 * sentence from the ACTIVE pair's own declared axis/risk-corner copy keeps it honest
 * for every declared pair, present and future.
 */
export function bivariateCaptionText(pair: BivariatePair | null): string {
  const coverage = (pair?.coverageAxis ?? "Cobertura →").replace(" →", "").toLowerCase();
  const signal = (pair?.signalAxis ?? "Señales ↑").replace(" ↑", "").toLowerCase();
  const risk = pair?.riskCornerNote ?? "Intensidad alta: cobertura baja · señales altas";
  return `Intensidad combinada por provincia: ${coverage} (terciles) × ${signal} (terciles). ${risk}.`;
}

/**
 * Compact "x × y" axis caption for the COLLAPSED legend strip (LegendPill) —
 * the pair's own declared axis captions with their arrows stripped.
 *
 * PO 2026-08-01: the strip had the literal `"cobertura × señal"` inlined and
 * rendered it for every bivariate frame, so `riesgo-ppp` (registro PPP ×
 * mordeduras) was captioned with the OTHER pair's vocabulary. Same defect
 * {@link bivariateCaptionText} was written to close for the expanded caption —
 * the collapsed surface just never got the fix. Returns null when no pair is
 * resolved: a strip that does not know what the matrix crosses says nothing.
 */
export function bivariateAxesLabel(pair: BivariatePair | null): string | null {
  if (!pair) return null;
  return `${pair.coverageAxis.replace(" →", "")} × ${pair.signalAxis.replace(" ↑", "")}`;
}

// ---------------------------------------------------------------------------
// Terciles
// ---------------------------------------------------------------------------

/** A tercile bucket: 0 = low, 1 = mid, 2 = high. */
export type TercileClass = 0 | 1 | 2;

/** The two cut-points that split a distribution into thirds (33rd / 67th pct). */
export type TercileThresholds = { t1: number; t2: number };

/** Linear-interpolated quantile of an ASCENDING-sorted array (q ∈ [0,1]). */
function quantileSorted(sorted: readonly number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return sorted[0];
  const pos = (n - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const lo = sorted[base];
  const hi = sorted[base + 1];
  return hi === undefined ? lo : lo + rest * (hi - lo);
}

/**
 * Tercile cut-points over a value distribution (the CURRENT scope's values).
 * Returns null for an empty distribution (nothing to classify against). A
 * degenerate distribution (all equal) yields t1 === t2 — every value then lands
 * in the same bucket via {@link classifyTercile}, which is the honest outcome
 * (no spread ⇒ no low/high distinction to draw).
 */
export function tercileThresholds(values: readonly number[]): TercileThresholds | null {
  const clean = values.filter((v) => typeof v === "number" && !Number.isNaN(v));
  if (clean.length === 0) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  return { t1: quantileSorted(sorted, 1 / 3), t2: quantileSorted(sorted, 2 / 3) };
}

/**
 * Classify a value into its tercile. `value <= t1` → low (0); `<= t2` → mid (1);
 * otherwise high (2). Using `<=` keeps a value AT a cut-point in the lower bucket
 * (standard tercile boundary handling); with t1 === t2 every value below the
 * shared cut is low, at-or-above is high (never mid) — an honest degenerate split.
 */
export function classifyTercile(value: number, th: TercileThresholds): TercileClass {
  if (value <= th.t1) return 0;
  if (value <= th.t2) return 1;
  return 2;
}

// ---------------------------------------------------------------------------
// 3×3 bivariate class matrix
// ---------------------------------------------------------------------------

/**
 * Flat index into the 3×3 matrix from the two tercile classes: `sig * 3 + cov`.
 * Row = signal tercile (0 low … 2 high), column = coverage tercile. The client
 * palette is laid out in this exact order, so index N always names the same cell.
 */
export function bivariateIndex(cov: TercileClass, sig: TercileClass): number {
  return sig * 3 + cov;
}

/** The RISK cell: LOW coverage (0) × HIGH signal (2) → index 6. */
export const BIVARIATE_RISK_INDEX = bivariateIndex(0, 2);
/** The CALM cell: HIGH coverage (2) × LOW signal (0) → index 2. */
export const BIVARIATE_SAFE_INDEX = bivariateIndex(2, 0);

/**
 * A 0–4 combined-risk score: higher = worse. `sig + (2 - cov)` — a unit is most
 * at risk when the signal is high AND coverage is low (risk corner → 4), least
 * when coverage is high and the signal is absent (calm corner → 0).
 */
export function riskScore(cov: TercileClass, sig: TercileClass): number {
  return sig + (2 - cov);
}

/** es-AR risk band from the score: 0–1 → bajo, 2 → medio, 3–4 → alto. */
export function riskLabel(cov: TercileClass, sig: TercileClass): "bajo" | "medio" | "alto" {
  const s = riskScore(cov, sig);
  if (s >= 3) return "alto";
  if (s === 2) return "medio";
  return "bajo";
}

/** es-AR adjective for a COVERAGE tercile (feminine: "cobertura … baja"). */
export function coverageClassLabel(cls: TercileClass): "baja" | "media" | "alta" {
  return cls === 0 ? "baja" : cls === 1 ? "media" : "alta";
}

/** es-AR adjective for a SIGNAL tercile (feminine plural: "señales … altas"). */
export function signalClassLabel(cls: TercileClass): "bajas" | "medias" | "altas" {
  return cls === 0 ? "bajas" : cls === 1 ? "medias" : "altas";
}

// ---------------------------------------------------------------------------
// The join: coverage × signal → per-unit bivariate cells
// ---------------------------------------------------------------------------

/** Coverage (rate choropleth) feature props the join reads. */
type CoverageProps = {
  provinceCode?: string;
  province?: string;
  value?: number | null;
  suppressed?: boolean;
};

/** Signal (aggregated-point, province level) feature props the join reads. */
type SignalProps = {
  province?: string;
  count?: number | null;
  suppressed?: boolean;
};

/**
 * One administrative unit's bivariate state. `provinceCode` is the polygon join
 * key (from the coverage feature); `key` mirrors it for map lookups. A cell with
 * `suppressed: true` NEVER carries classes — its color is withheld (hatch), so a
 * k-anon-protected value can never be inferred from the bivariate color.
 */
export type BivariateCell = {
  /** Polygon join key (ISO 3166-2:AR province code). */
  provinceCode: string;
  /** Display label (province name). */
  place: string;
  /** Raw coverage value (percentage) or null when absent. */
  coverageValue: number | null;
  /** Raw signal count or null when absent/suppressed. */
  signalValue: number | null;
  coverageClass: TercileClass | null;
  signalClass: TercileClass | null;
  /** True when EITHER input suppressed this unit (k-anon propagation → hatch). */
  suppressed: boolean;
};

/** Normalize a province name for the coverage↔signal join. Case/space tolerant AND
 * accent-stripped (NFD + diacritic removal) to mirror the DB-side normNameSql
 * (which uses `unaccent`) — so "Córdoba" on one axis joins "Cordoba" on the other
 * even if one side lost its accent upstream (SUGGESTION 8). */
function normName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

/** Minimum comparable units for a non-degenerate bivariate encoding (WARNING 7). */
export const BIVARIATE_MIN_UNITS = 6;

/**
 * Above this share of hatched units on either axis the crossed map stops being
 * a map. Half is deliberately generous: below it the operator still sees enough
 * painted territory to read a pattern; above it the hatch IS the pattern.
 */
export const BIVARIATE_MAX_SUPPRESSED_SHARE = 0.5;

/**
 * WHY the bivariate encoding is refused, or `null` when it is viable (Item 2).
 *
 * Two distinct failure modes hid behind a single "requiere N unidades" note:
 *   - `"count"`  — an axis has fewer than `minUnits` non-suppressed values, so
 *                  there is simply not enough comparable data to classify.
 *   - `"tercile"`— there ARE enough units but the distribution is degenerate: the
 *                  tercile cut-points collapse (t1 === t2), so a lone 95%-coverage
 *                  province would still be mislabelled "baja cobertura / riesgo
 *                  medio". Nothing more data would fix — the values are too alike.
 *
 * Count is reported BEFORE tercile: when a scope is both too small AND flat, the
 * operator's actionable reading is "too few comparable units", not "too alike".
 * Values are extracted with the SAME rules as {@link buildBivariateCells}
 * (suppressed / null cells never count).
 */
export function bivariateRefusalReason(
  coverage: FeatureCollection,
  signal: FeatureCollection,
  minUnits: number = BIVARIATE_MIN_UNITS,
): "count" | "tercile" | "suppressed" | null {
  const coverageValues: number[] = [];
  for (const f of coverage.features) {
    const p = (f.properties ?? {}) as CoverageProps;
    if (p.suppressed === true) continue;
    if (typeof p.value === "number") coverageValues.push(p.value);
  }
  const signalValues: number[] = [];
  for (const f of signal.features) {
    const p = (f.properties ?? {}) as SignalProps;
    if (p.suppressed === true || p.count == null) continue;
    if (typeof p.count === "number") signalValues.push(p.count);
  }
  if (coverageValues.length < minUnits || signalValues.length < minUnits) return "count";
  const covTh = tercileThresholds(coverageValues);
  const sigTh = tercileThresholds(signalValues);
  // No thresholds at all (empty distribution) is a count/data problem, not a
  // spread one — but the count guard above already covers empty vs minUnits.
  if (!covTh || !sigTh) return "count";
  if (covTh.t1 === covTh.t2 || sigTh.t1 === sigTh.t2) return "tercile";
  // THIRD refusal reason (2026-07-25). Both axes can pass the checks above and
  // the JOIN still come back almost entirely hatched, because suppression
  // propagates per unit from either input at the grain the map paints. Live on
  // "Señales de brote": the province-grain signal is healthy (24 cells, 2
  // suppressed) but the rendered cross ran at DEPARTMENT grain, where zoonosis
  // is so thinly spread that only 11 of 1.983 departments clear k=5 — 0,6%,
  // and no window fixes it (measured at 90d/1y/2y/3y). The operator saw the
  // whole country hatched and read it as "the system knows nothing", while the
  // SAME vista without the bivariate paints a perfectly legible map.
  //
  // Refusing here makes the console fall back to that working rendering and
  // SAY why, instead of shipping a hatch field.
  const suppressedShare =
    coverage.features.length === 0
      ? 0
      : coverage.features.filter((f) => (f.properties as CoverageProps)?.suppressed === true)
          .length / coverage.features.length;
  const signalSuppressedShare =
    signal.features.length === 0
      ? 0
      : signal.features.filter((f) => (f.properties as SignalProps)?.suppressed === true).length /
        signal.features.length;
  if (Math.max(suppressedShare, signalSuppressedShare) > BIVARIATE_MAX_SUPPRESSED_SHARE) {
    return "suppressed";
  }
  return null;
}

/**
 * Whether the bivariate encoding is statistically viable for the current scope.
 *
 * Viable ⇔ {@link bivariateRefusalReason} finds no reason to refuse: BOTH axes
 * have ≥ `minUnits` non-suppressed values AND neither distribution is
 * tercile-degenerate. See that function for the two failure modes and why encoding
 * is refused (the caller shows an honest note instead of a false risk band).
 */
export function bivariateViable(
  coverage: FeatureCollection,
  signal: FeatureCollection,
  minUnits: number = BIVARIATE_MIN_UNITS,
): boolean {
  return bivariateRefusalReason(coverage, signal, minUnits) === null;
}

/**
 * Join the coverage and signal FeatureCollections into per-province bivariate
 * cells, classifying each over the CURRENT scope's tercile distribution.
 *
 * Suppression propagation (task #63c): a unit is `suppressed` when EITHER the
 * coverage OR the signal input suppressed it (a null signal `count` is treated as
 * suppressed — that is how the aggregated-point path k-anon-hides a small cell).
 * A suppressed cell gets NO classes and NO color; the caller renders the hatch.
 * A unit merely MISSING from the signal input is NOT suppressed — it is plain
 * no-data (no signal to classify), which also withholds a bivariate color but is
 * a distinct, honest state (never a hatch).
 *
 * Terciles are computed over the NON-suppressed values of each input separately
 * (coverage terciles over coverage, signal terciles over signal), so a protected
 * cell never influences the class boundaries either.
 *
 * The polygon set is defined by the COVERAGE features (they carry provinceCode,
 * the map's fill join key); a province present only in the signal input has no
 * polygon key here and is dropped (it would be coverage-no-data anyway).
 */
export function buildBivariateCells(
  coverage: FeatureCollection,
  signal: FeatureCollection,
): BivariateCell[] {
  // Index the signal by province name.
  const signalByName = new Map<string, { value: number | null; suppressed: boolean }>();
  const signalValues: number[] = [];
  for (const f of signal.features) {
    const p = (f.properties ?? {}) as SignalProps;
    if (typeof p.province !== "string" || p.province.length === 0) continue;
    const suppressed = p.suppressed === true || p.count == null;
    const value = typeof p.count === "number" ? p.count : null;
    signalByName.set(normName(p.province), { value, suppressed });
    if (!suppressed && value != null) signalValues.push(value);
  }

  // Coverage distribution (non-suppressed) for the coverage terciles.
  const coverageValues: number[] = [];
  for (const f of coverage.features) {
    const p = (f.properties ?? {}) as CoverageProps;
    if (p.suppressed === true) continue;
    if (typeof p.value === "number") coverageValues.push(p.value);
  }

  const covTh = tercileThresholds(coverageValues);
  const sigTh = tercileThresholds(signalValues);

  const cells: BivariateCell[] = [];
  for (const f of coverage.features) {
    const p = (f.properties ?? {}) as CoverageProps;
    if (typeof p.provinceCode !== "string" || p.provinceCode.length === 0) continue;
    const place = typeof p.province === "string" ? p.province : p.provinceCode;
    const covSup = p.suppressed === true;
    const covVal = typeof p.value === "number" ? p.value : null;

    const sig = signalByName.get(normName(place));
    const sigSup = sig?.suppressed === true;
    const sigVal = sig?.value ?? null;

    const suppressed = covSup || sigSup;
    const coverageClass =
      !suppressed && covVal != null && covTh ? classifyTercile(covVal, covTh) : null;
    const signalClass =
      !suppressed && sigVal != null && sigTh ? classifyTercile(sigVal, sigTh) : null;

    cells.push({
      provinceCode: p.provinceCode,
      place,
      coverageValue: covVal,
      signalValue: sigVal,
      coverageClass,
      signalClass,
      suppressed,
    });
  }
  return cells;
}
