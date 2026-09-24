// Panorama auto-reading — one-line situational sentence (panorama-redesign Fase 1).
//
// Derives a headline clause (the KPI with the largest-magnitude period-over-
// period delta) plus a count-summary suffix, EXCLUSIVELY from the KpiDelta[]
// already computed by get-panorama-kpis.ts (deltaOf/priorWindowOf). It never
// issues a query and never touches the k-anon cell pipeline — deltas are
// jurisdiction-level dashboard aggregates, and deltaOf returns undefined when
// there is no meaningful prior base (privacy: no value is ever fabricated).
//
// Pure module — no DB, no React, no Next. The input type is STRUCTURAL so the
// domain stays framework-free: PanoramaKpi (application layer) satisfies it
// without an import in that direction.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Structural subset of PanoramaKpi the reading needs (id + optional delta). */
export type ReadingKpi = {
  id: string;
  delta?: { pct: number; direction: "up" | "down" | "flat"; unit?: "pct" | "pts" };
  /**
   * Pre-formatted display value from the KPI strip (e.g. "42%") — the SAME
   * jurisdiction-level dashboard aggregate PanoramaKpiStrip already renders.
   * Read ONLY to echo an absolute anchor when a compliance KPI headlines
   * (design-QA 2026-07-04 fast-follow); never a map-cell value, and only
   * echoed verbatim when it matches the strip's percentage format (see
   * PCT_VALUE_RE) — the reading never computes anything from it.
   */
  value?: string;
};

// ---------------------------------------------------------------------------
// Internal constants (es-AR copy — PO may adjust wording, flagged non-blocking)
// ---------------------------------------------------------------------------

/**
 * Known window-sensitive KPIs: short display name + valence.
 * `goodUp: true` means an UP direction is an improvement (coverage rising);
 * `goodUp: false` means UP is a deterioration (bites/zoonosis rising).
 * Ids outside this map are ignored — without a valence, mejora/empeora would
 * be a guess, and the reading must never guess.
 */
const KNOWN_KPIS: Record<string, { name: string; goodUp: boolean; anchor?: string }> = {
  cobertura: { name: "Cobertura antirrábica", goodUp: true, anchor: "cobertura actual" },
  mordeduras: { name: "Mordeduras", goodUp: false },
  zoonosis: { name: "Zoonosis activas", goodUp: false },
  // esterilizacion carries NO delta today (get-panorama-kpis attaches deltas to
  // the 3 window-sensitive KPIs only) so it cannot headline yet; the entry is
  // here so the anchor applies the day the backend adds its delta.
  esterilizacion: {
    name: "Cobertura de esterilización",
    goodUp: true,
    anchor: "esterilización actual",
  },
};

/** Fixed fallback when no delta qualifies (no prior window, or all flat). */
const FALLBACK_SENTENCE = "Sin variación destacable frente al período anterior.";

/**
 * Absolute-anchor gate: the display value must LOOK like the strip's own
 * percentage aggregate ("42%", "42,5%") before it may anchor the sentence.
 * Anything else — a raw count, or a smuggled cell-level decoy field — is
 * ignored. Privacy invariant: the anchor never computes a rate; it only
 * echoes the KPI strip's already-public display value verbatim.
 */
const PCT_VALUE_RE = /^\d{1,3}(?:[.,]\d+)?\s?%$/;

// ---------------------------------------------------------------------------
// Reading builder
// ---------------------------------------------------------------------------

type QualifiedKpi = {
  name: string;
  pct: number;
  /** Unit of `pct` — drives the "% " vs " pts" suffix in the sentence (H9). */
  unit: "pct" | "pts";
  /** True when direction × valence is an improvement. */
  improves: boolean;
  /** True when the delta is non-flat (eligible for the headline). */
  moves: boolean;
  /**
   * Pre-built absolute-anchor clause ("; cobertura actual 42%") — present only
   * for anchor-bearing compliance KPIs whose display value passes the
   * percentage gate. Appended ONLY when this KPI wins the headline.
   */
  anchorClause?: string;
};

function qualify(kpi: ReadingKpi): QualifiedKpi | null {
  const known = KNOWN_KPIS[kpi.id];
  if (!known || !kpi.delta) return null;
  const { pct, direction } = kpi.delta;
  const unit = kpi.delta.unit ?? "pct";
  const moves = direction !== "flat";
  const improves = moves && (direction === "up") === known.goodUp;
  const value = kpi.value?.trim();
  const anchorClause =
    known.anchor !== undefined && value !== undefined && PCT_VALUE_RE.test(value)
      ? `; ${known.anchor} ${value}`
      : undefined;
  return { name: known.name, pct, unit, improves, moves, anchorClause };
}

/**
 * Build the one-line auto-reading sentence:
 *
 *   "{KPI} {empeora|mejora} {N}% vs período anterior; {X} de {Y} indicadores mejoran."
 *
 * Headline = the largest |pct| among non-flat deltas (tie-break: input array
 * order — deterministic). Suffix: X = improving KPIs, Y = KPIs carrying a
 * delta (flat deltas count in Y, never in X). Singular agreement when X = 1.
 * When the headline is a compliance coverage (cobertura / esterilización) and
 * its strip display value is a percentage, one absolute anchor is appended:
 *
 *   "…; 0 de 2 indicadores mejoran; cobertura actual 42%."
 *
 * Returns the fixed fallback when nothing qualifies.
 */
export function buildPanoramaReading(kpis: readonly ReadingKpi[]): string {
  const qualified = kpis.map(qualify).filter((q): q is QualifiedKpi => q !== null);

  let headline: QualifiedKpi | null = null;
  for (const q of qualified) {
    if (!q.moves) continue;
    // Strict > keeps the FIRST of equal magnitudes (input-order tie-break).
    if (headline === null || Math.abs(q.pct) > Math.abs(headline.pct)) headline = q;
  }
  if (headline === null) return FALLBACK_SENTENCE;

  const verb = headline.improves ? "mejora" : "empeora";
  const magnitude = Math.abs(headline.pct).toLocaleString("es-AR");
  // H9: a percentage-valued KPI (cobertura) reports its delta in POINTS, not a
  // relative %. Render the honest unit so the sentence never says "mejora 28%".
  const magnitudeText = headline.unit === "pts" ? `${magnitude} pts` : `${magnitude}%`;

  const total = qualified.length;
  const improving = qualified.filter((q) => q.improves).length;
  const suffixVerb = improving === 1 ? "mejora" : "mejoran";

  return `${headline.name} ${verb} ${magnitudeText} vs período anterior; ${improving} de ${total} indicadores ${suffixVerb}${headline.anchorClause ?? ""}.`;
}
