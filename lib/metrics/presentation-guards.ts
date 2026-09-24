// lib/metrics/presentation-guards.ts — the C1 guard engine (dim-interno:docs/reviews/
// results/2026-07-22-plan-maestro-integridad.md, §2 "C1 · Contrato de
// Métrica").
//
// WHY THIS EXISTS
// ----------------
// lib/metrics/kpi-catalog.ts turned KPI documentation into an executable
// contract by adding `guards`/`semaphore`/`target` fields to each descriptor.
// This module is what actually ENFORCES those fields at render time — ONCE,
// here, instead of every /gob screen re-inventing its own "if N < 5 don't
// paint red" logic (the exact ad-hoc-per-screen failure S1/S4 describe).
//
// Each guard below kills ONE red-team-verified class of dishonest rendering:
//   - zeroDenominatorGate      → the "0/0 → 0%" class (mortality, reunification)
//   - smallNGate                → the "100% con N=2" class (reunification)
//   - shouldSuppressDelta       → the "−95% MoM sobre base inestable" class
//   - resolveSemaphoreTone      → the "semáforo como veredicto legal" class
//                                 (PPP self-serve uptake painted "Peligro")
//
// PURE — no DB, no React, no side effects. Every export is unit-testable in
// isolation and is also what components/ui/dashboard/OpKpi.tsx's optional
// `descriptorId`/`guardInput` path calls into.

import type { KpiDefinition } from "./kpi-catalog";

/** Mirrors components/ui/dashboard/OpKpi.tsx's `Tone` union — kept as an
 *  independently-declared, structurally-compatible type (same posture as
 *  kpi-catalog.ts's KpiInfoTooltip vs OpKpi's InfoTooltip) so this module
 *  stays component-free. */
export type Tone = "neutral" | "danger" | "warn" | "ok" | "blue";

/** The dash literal every zero-denominator guard renders instead of a
 *  fabricated 0/0 value. Exported so render sites and tests share one
 *  literal instead of retyping "—". */
export const ZERO_DENOMINATOR_DASH = "—";

/** Note appended when a rate is shown despite a sample size below the
 *  descriptor's `guards.smallN.min` — the value stays honest ("100% · 2 de
 *  2") but the tone is forced neutral and this note explains why. */
export function smallNNote(min: number): string {
  return `Muestra chica (n<${min}) — no interpretar como tendencia.`;
}

/** Note appended when a period-over-period delta chip is suppressed because
 *  the PRIOR period's base was below `guards.unstableDeltaBase.minPriorBase`. */
export const UNSTABLE_DELTA_BASE_NOTE =
  "Base del período anterior inestable — variación no mostrada.";

// ---------------------------------------------------------------------------
// zeroDenominatorGate — the "0/0 → 0%" class
// ---------------------------------------------------------------------------

/**
 * True when `descriptor.guards.zeroDenominator === "dash"` AND `n` (the
 * ratio's denominator/sample-size — e.g. total deaths, lost episodes) is 0.
 * Callers render ZERO_DENOMINATOR_DASH instead of a fabricated ratio when
 * this returns true — a genuine "nothing happened" state, not a measured 0%.
 */
export function zeroDenominatorGate(descriptor: Pick<KpiDefinition, "guards">, n: number): boolean {
  return descriptor.guards?.zeroDenominator === "dash" && n === 0;
}

// ---------------------------------------------------------------------------
// smallNGate — the "100% con N=2" class
// ---------------------------------------------------------------------------

/**
 * True when `n` is strictly positive but below `descriptor.guards.smallN.min`
 * — the exact "100% reunificación con N=2" shape. Distinct from
 * zeroDenominatorGate: n=0 is a DIFFERENT state (no data at all), not a
 * small sample of real data. Callers that get `true` here must keep the
 * numeric value visible (it's a real fact) but force the tone to "neutral"
 * and surface `smallNNote(min)`.
 */
export function smallNGate(descriptor: Pick<KpiDefinition, "guards">, n: number): boolean {
  const min = descriptor.guards?.smallN?.min;
  if (min === undefined) return false;
  return n > 0 && n < min;
}

// ---------------------------------------------------------------------------
// guardRatioTone — compose zeroDenominatorGate + smallNGate into a single
// value/tone/note decision for a rate-shaped KPI tile.
// ---------------------------------------------------------------------------

export type GuardedRatio = {
  /** Either `ZERO_DENOMINATOR_DASH` (zero-denominator gate fired) or the
   *  caller-supplied `formattedValue` unchanged — this module never formats
   *  numbers itself, callers own their own percent/count formatting. */
  value: string;
  /** The tone to render — forced "neutral" by either gate; otherwise the
   *  caller's `computedTone` passed through unchanged. */
  tone: Tone;
  /** Present only when the smallN gate fired — callers should render this
   *  next to the value (e.g. in the tile's `sub`), never silently. */
  note?: string;
};

/**
 * Apply the zero-denominator + smallN guards to a single ratio-shaped KPI
 * tile in one call. `n` is the SAMPLE SIZE the ratio is computed over (the
 * denominator for a rate, or the count of recovered episodes for a median) —
 * NOT the rate/percentage value itself.
 *
 * Precedence: zeroDenominatorGate is checked FIRST (n===0 is a strictly
 * "no data" state that smallNGate deliberately excludes via its `n > 0`
 * check, so the two never fire simultaneously — this ordering only matters
 * for readability).
 *
 * `valueIsRatio: false` disables BOTH gates. Some tiles swap their headline
 * for a live count when there is an active breach — "4 fuera de plazo ahora"
 * instead of the period's compliance rate (rabiesComplianceHeadline,
 * enoSlaHeadline). Both guards reason about a RATIO's denominator, and a live
 * count has no denominator to be empty or small; applying them anyway replaces
 * a statutory breach with a neutral dash.
 *
 * Which is what happened. Live on /gob/vigilancia, 2026-07-27: the rabies-10d
 * tile rendered "—" in neutral while a red banner two centimetres below read
 * "4 observaciones rábicas fuera del plazo legal" and the sibling ENO tile read
 * "3 vencidas ahora". The tile had already computed the right headline; the
 * gate, seeing `closed === 0`, threw it away (external design review C8/U1).
 */
export function guardRatioTone(
  descriptor: Pick<KpiDefinition, "guards">,
  input: {
    n: number;
    computedTone: Tone;
    formattedValue: string;
    /** False when the headline is a live count rather than the rate. Default true. */
    valueIsRatio?: boolean;
  },
): GuardedRatio {
  if (input.valueIsRatio === false) {
    return { value: input.formattedValue, tone: input.computedTone };
  }
  if (zeroDenominatorGate(descriptor, input.n)) {
    return { value: ZERO_DENOMINATOR_DASH, tone: "neutral" };
  }
  if (smallNGate(descriptor, input.n)) {
    const min = descriptor.guards?.smallN?.min as number;
    return { value: input.formattedValue, tone: "neutral", note: smallNNote(min) };
  }
  return { value: input.formattedValue, tone: input.computedTone };
}

// ---------------------------------------------------------------------------
// shouldSuppressDelta — the "−95% MoM sobre base inestable" class
// ---------------------------------------------------------------------------

/**
 * True when `descriptor.guards.unstableDeltaBase` is set AND `priorBase` (the
 * PRIOR period's raw count — e.g. last month's sterilization count) is below
 * its `minPriorBase` floor. A swing computed against a near-zero base (1 → 0
 * reads as "−100%") is not a stable trend; callers should omit the delta
 * chip entirely and show `UNSTABLE_DELTA_BASE_NOTE` instead.
 */
export function shouldSuppressDelta(
  descriptor: Pick<KpiDefinition, "guards">,
  priorBase: number,
): boolean {
  const floor = descriptor.guards?.unstableDeltaBase?.minPriorBase;
  if (floor === undefined) return false;
  return priorBase < floor;
}

// ---------------------------------------------------------------------------
// deltaImplausibleGate — the "−99,6% sobre una base sana" class (external
// red-team 2026-07-30, H16). The SIBLING of shouldSuppressDelta above: that
// one distrusts a tiny prior base, this one distrusts a swing no programme
// produces even when the base is perfectly stable. See kpi-catalog.ts's
// KpiGuards.deltaImplausible for the threshold reasoning.
// ---------------------------------------------------------------------------

/** Short chip suffix rendered inline next to the delta itself — where the eye
 *  already is. Deliberately an instruction ("check the load"), not a verdict
 *  ("this is wrong"): the guard cannot know which it is, and saying so would
 *  be the same overclaim it exists to stop. */
export const DELTA_IMPLAUSIBLE_SUFFIX = "verificar carga";

/** The explanation line, rendered as the tile's guard note. States the
 *  MEASURED fact (the swing is real in the data) and the likelier cause,
 *  without asserting either as settled. */
export const DELTA_IMPLAUSIBLE_NOTE =
  "Variación de un orden de magnitud sobre una base estable — suele indicar carga incompleta del período, no una caída real. Verificá la carga antes de citarla.";

/**
 * True when the descriptor declares `guards.deltaImplausible`, the PRIOR
 * period's base is at or above its `minPriorBase`, and the period-over-period
 * change is at least `minFoldChange`-fold in EITHER direction.
 *
 * `deltaPct` is a percentage CHANGE (computeDeltaPct / campaign-metrics'
 * computeDelta — `(current − prior) / prior × 100`), never a percentage-POINT
 * difference between two rates; every descriptor carrying this guard is
 * `basis: "flow"`, `unit: "count"`, which is what makes the fold-change
 * reading valid.
 *
 * Ratio form (current/prior = 1 + Δ/100) rather than |Δ%| on purpose — see
 * KpiGuards.deltaImplausible: |Δ%| ≥ 90 would flag a legitimate near-doubling
 * as fabricated while treating ×0.1 and ×1.9 as the same magnitude.
 */
export function deltaImplausibleGate(
  descriptor: Pick<KpiDefinition, "guards">,
  input: { deltaPct: number; priorBase: number },
): boolean {
  const rule = descriptor.guards?.deltaImplausible;
  if (rule === undefined) return false;
  if (!Number.isFinite(input.deltaPct)) return false;
  if (input.priorBase < rule.minPriorBase) return false;
  const ratio = 1 + input.deltaPct / 100;
  // ONE comparison for both directions, deliberately. Written as the pair
  // `ratio <= 1/f || ratio >= f`, the downside operator is untestable: at
  // Δ = −90% the ratio computes to 0.09999999999999998, strictly under 0.1 in
  // IEEE-754, so `<` and `<=` behave identically and nothing can ever pin the
  // downside boundary (found by mutation testing 2026-07-30 — `<=` → `<`
  // survived, and the test claiming to cover that boundary was the thing at
  // fault). Folding to a magnitude means the two directions share the ONE
  // operator that IS exactly reachable: Δ = +900% gives a ratio of exactly 10.
  // A ratio at or below zero (Δ ≤ −100%, only reachable from impossible data)
  // folds to Infinity, which is the right answer for input that cannot be real.
  const fold = ratio >= 1 ? ratio : 1 / Math.max(ratio, 0);
  return fold >= rule.minFoldChange;
}

// ---------------------------------------------------------------------------
// censusCoverageLowGate — the "dual-denominator hero" class (cursor red-team
// 2026-07-23, claim #1). A registry-coverage rate (e.g. rabies_coverage_dogs_12m)
// can read a confident 65% while the padrón it's computed over covers well
// under 1% of the census-estimated population — the registry % answers "of
// the dogs we KNOW about, how many are covered", not "is the population
// protected". Below the descriptor's `guards.censusCoverageFloor`, the tone
// must degrade to neutral (never a green/red verdict painted from the
// registry % alone) and an explicit low-confidence note must accompany it.
// ---------------------------------------------------------------------------

/** Note appended when the registry's own coverage of the census-estimated
 *  population sits below the descriptor's `guards.censusCoverageFloor` — the
 *  headline rate is real but does NOT represent population-level protection. */
export function censusCoverageWarningNote(censusCoveragePct: number): string {
  return `El padrón cubre ~${censusCoveragePct}% de la población estimada — el % de registro NO representa protección poblacional.`;
}

/**
 * True when the descriptor declares `guards.censusCoverageFloor` AND the
 * render actually has a census estimate (`censusCoveragePct !== null`) AND
 * that coverage sits below the floor. Returns false whenever there is no
 * census row at all — that is a DIFFERENT, already-handled "sin estimación
 * censal" state, not a low-confidence one.
 */
export function censusCoverageLowGate(
  descriptor: Pick<KpiDefinition, "guards">,
  censusCoveragePct: number | null,
): boolean {
  const floor = descriptor.guards?.censusCoverageFloor;
  if (floor === undefined || censusCoveragePct === null) return false;
  return censusCoveragePct < floor;
}

export type CensusGuardedTone = {
  tone: Tone;
  /** Present only when the gate fired — callers must render this alongside
   *  the value (never silently), same convention as `GuardedRatio.note`. */
  note?: string;
};

/**
 * Apply the census-coverage-floor guard to a single tile's tone. The VALUE
 * itself is never altered (the registry % is a real, honestly-computed fact)
 * — only the TONE is forced neutral, plus a note explaining why, exactly the
 * same posture `guardRatioTone`'s smallN branch takes for sample size.
 */
export function applyCensusCoverageGuard(
  descriptor: Pick<KpiDefinition, "guards">,
  input: { censusCoveragePct: number | null; computedTone: Tone },
): CensusGuardedTone {
  if (censusCoverageLowGate(descriptor, input.censusCoveragePct)) {
    return {
      tone: "neutral",
      note: censusCoverageWarningNote(input.censusCoveragePct as number),
    };
  }
  return { tone: input.computedTone };
}

// ---------------------------------------------------------------------------
// resolveSemaphoreTone — the "semáforo como veredicto legal" class
// ---------------------------------------------------------------------------

/**
 * Resolve the tone a KPI's semaphore POLICY actually permits.
 *
 *  - `semaphore.paintAgainst === "none"`: the renderer must NEVER produce an
 *    ok/warn/danger "legal verdict" tone for this KPI — always returns
 *    `fallback` (an informational tone; "blue" by default, matching the
 *    historic-rabies/uptake convention already used elsewhere in the app).
 *  - `semaphore.paintAgainst === "target"`, or `semaphore` unset (backward
 *    compat for KPIs the C1 sweep hasn't reached yet): `computedTone` passes
 *    through unchanged — this function is a GATE, not a tone calculator; the
 *    caller still owns `toneForTarget` or whatever produced `computedTone`.
 */
export function resolveSemaphoreTone(
  descriptor: Pick<KpiDefinition, "semaphore">,
  computedTone: Tone,
  fallback: Tone = "blue",
): Tone {
  if (descriptor.semaphore?.paintAgainst === "none") return fallback;
  return computedTone;
}
