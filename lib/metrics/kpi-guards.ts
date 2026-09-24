/**
 * Presentation guards, AS DATA — extracted from kpi-catalog.ts on 2026-08-01.
 *
 * WHY ITS OWN FILE: the delta-implausibility guard added 122 lines to a
 * catalog that was already at its file-size baseline, and the fence's own
 * message is the rule — "shrink it or split it; do not feed a file that is
 * already too large." Re-baselining would have bought silence, not room.
 *
 * The guards are a coherent unit: the shape a descriptor declares, plus the
 * shared thresholds those declarations point at. Enforced at render time by
 * presentation-guards.ts. Re-exported from kpi-catalog.ts so no consumer
 * import had to move.
 */
/**
 * Presentation guards, AS DATA — the render-time honesty guards the plan's
 * C1/S4 sections describe, declared on the descriptor instead of re-invented
 * per screen. Enforced by lib/metrics/presentation-guards.ts.
 */
export type KpiGuards = {
  /**
   * Below this sample size (n — the count the ratio/rate is computed over,
   * e.g. lost episodes, recovered count), the renderer keeps the numeric
   * value visible (a real "100% · 2 de 2" fact) but FORCES a neutral tone
   * and surfaces a small-sample note — never a confident green/red on a tiny
   * N. Kills the "100% reunificación junto a 2 casos" class.
   */
  smallN?: { min: number };
  /**
   * When the ratio's denominator is 0, render "—" instead of a fabricated
   * 0/0 → 0% value. Kills the "0 muertes → 0% trazable" class. The union
   * leaves room for a future alternative strategy without a breaking change.
   */
  zeroDenominator?: "dash";
  /**
   * Flow-tile guard: suppress the period-over-period delta chip when the
   * PRIOR period's base count is below `minPriorBase` — a swing computed
   * against a near-zero base (e.g. 1 → 0) is not a stable trend. Kills the
   * "−95% MoM on an unstable base" class.
   */
  unstableDeltaBase?: { minPriorBase: number };
  /**
   * External red-team 2026-07-30 (H16) — the "implausible delta" class, the
   * SIBLING of unstableDeltaBase above and the case it does NOT cover.
   *
   * `unstableDeltaBase` only knows how to distrust a TINY prior base (1 → 0 is
   * "−100%"). Live on /gob it let this through: "Esterilizaciones / mes: 1
   * ↓ −99,6% vs mes anterior (desde 274)" — a perfectly stable prior base of
   * 274, and a swing no sanitary programme produces. That is the signature of
   * an INCOMPLETE LOAD (a partial month, a stalled ingest), yet it rendered
   * with the same red arrow a genuine collapse would get. A funcionario who
   * cites it in a meeting is exposed.
   *
   * The rule is a FOLD CHANGE, not a raw |Δ%|, and that distinction is
   * load-bearing. A naive "|Δ%| ≥ 90" is an order of magnitude on the way DOWN
   * (×0.1) but merely a near-doubling on the way UP (×1.9) — a campaign month
   * that legitimately doubles its output would be flagged as fabricated, which
   * is how a guard earns alarm fatigue and stops being read.
   * `minFoldChange: f` means: implausible when current ≤ prior/f OR
   * current ≥ prior×f. At f = 10 the downside threshold is exactly the −90%
   * the critique asked for, and the upside is its honest mirror (+900%).
   *
   * `minPriorBase` is where a prior period stops being a handful of events.
   * Below it, a full stop has ordinary explanations (one campaign, one clinic
   * on holiday) and the delta keeps its normal valence colour — deliberately,
   * so small jurisdictions where big swings are the norm don't paint the note
   * on every tile.
   *
   * WHAT FIRING COSTS, BOTH WAYS (why the threshold sits where it does): the
   * guard NEVER hides anything. The value, the signed delta and the prior base
   * all still render; only the red/green VERDICT is withheld and a "verificar
   * carga" suffix is added. So a false positive on a real collapse costs a
   * muted colour on a line that still reads "1 · ↓ −99,6% (desde 274)" — and
   * "verify the load before citing this" is sound advice even then. A false
   * negative costs the credibility of the whole board. The detector is tuned
   * accordingly: sensitive, but only past an order of magnitude.
   *
   * Enforced by presentation-guards.ts's `deltaImplausibleGate`, wired through
   * OpKpi's `guardInput.priorBase` (the same input unstableDeltaBase uses —
   * no new fetcher work at any call site).
   */
  deltaImplausible?: { minFoldChange: number; minPriorBase: number };
  /**
   * Cursor red-team 2026-07-23 (claim #1) — "dual-denominator hero" class:
   * below this floor (a percent, 0-100), the registry rate's own coverage OF
   * THE CENSUS ESTIMATE is too thin to imply population-level protection
   * (e.g. 65% of a padrón that is itself ~0.4% of the estimated population).
   * Enforced by presentation-guards.ts's censusCoverageLowGate / applyCensus-
   * CoverageGuard — forces tone neutral + censusCoverageWarningNote, same
   * posture as smallN. Only meaningful for KPIs whose fetcher also returns a
   * `censusCoveragePct` (currently only rabies_coverage_dogs_12m).
   */
  censusCoverageFloor?: number;
  /** Dead-guard fence (check-metric-contract.ts rule 2): guards enforced by a
   *  dedicated helper path (named in a comment) instead of OpKpi guardInput. */
  manualEnforcement?: true;
};

/**
 * The fold change past which a period-over-period delta stops reading as a
 * programme and starts reading as an ingest gap: an ORDER OF MAGNITUDE in
 * either direction (×0.1 → Δ = −90%, ×10 → Δ = +900%). See
 * `KpiGuards.deltaImplausible` for the full reasoning, including why this is
 * a fold change and not a raw |Δ%|.
 */
export const DELTA_IMPLAUSIBLE_FOLD_CHANGE = 10;

/**
 * The prior-period base below which an order-of-magnitude swing is left
 * alone. Sits an order of magnitude above the `unstableDeltaBase` floor (5):
 * under 50 events in a period, a full stop has ordinary real-world
 * explanations and flagging it would be noise.
 */
export const DELTA_IMPLAUSIBLE_MIN_PRIOR_BASE = 50;

/**
 * The shared `deltaImplausible` rule every delta-bearing flow descriptor
 * carries. One object, not eight repeated literals — the same reason
 * targets.ts exists (a re-typed threshold is a threshold that drifts).
 */
export const DELTA_IMPLAUSIBLE_GUARD: NonNullable<KpiGuards["deltaImplausible"]> = {
  minFoldChange: DELTA_IMPLAUSIBLE_FOLD_CHANGE,
  minPriorBase: DELTA_IMPLAUSIBLE_MIN_PRIOR_BASE,
};
