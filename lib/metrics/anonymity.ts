// k-Anonymity suppression for locality-grouped projections.
//
// This is the boundary that was mandated by AGENTS.md § "Aggregation & privacy policy"
// (k=5 suppression) but never implemented. Every fetcher that groups by locality
// MUST route its output through suppressSmallCells before returning.
//
// The branded SuppressedCells type (defined in types.ts) enforces this at compile
// time: a raw Row[] is not assignable to SuppressedCells.

import type { Cell, MetricResult, SuppressedCells } from "./types";

export type { Cell, MetricResult, SuppressedCells };

/**
 * THE k. One constant so every grain (locality, department, province, open
 * data) reads the same policy number instead of re-typing `5`. Changing the
 * policy is a one-line change here, not a grep.
 *
 * NOT OVERRIDABLE PER CALL SITE (2026-08-17). Every k-anon entry point in this
 * module used to accept a `k` argument, and four call sites answered it with a
 * literal `5` — no-ops that read like decisions. The cost of that shape is not
 * the redundancy: it is that WEAKENING the floor was one token away, in a
 * caller, reviewed as a number rather than as a privacy change. A policy floor
 * that any caller may lower is not a floor. Raising or lowering k is now a
 * one-line edit HERE, on the line that documents itself as the policy — where
 * a reviewer cannot miss what changed.
 */
export const ANONYMITY_K = 5;

/** Options for suppressSmallCells. There is deliberately no `k` — see ANONYMITY_K. */
export type SuppressOpts<Row> = {
  /** Extract the population count for a row (compared against ANONYMITY_K). */
  count: (r: Row) => number;
  /** Extract the grouping key (e.g. locality name) for audit/reporting. */
  key: (r: Row) => string;
  /**
   * Optional rollup: fold suppressed rows into a coarser jurisdiction instead
   * of dropping them. Receives the array of suppressed rows; return a
   * replacement rolled-up row (or null to discard instead of rolling up).
   */
  rollup?: (suppressed: Row[]) => Row | null;
};

/**
 * Suppress cells below the k-anonymity threshold.
 *
 * Behavior:
 *  - Rows with `count(row) >= k` → visible (pass through).
 *  - Rows with `count(row) < k`  → suppressed.
 *  - If `rollup` is provided, the suppressed rows are passed to it and the
 *    result (if non-null) is added to visible. Otherwise they are discarded.
 *  - Returns { visible, suppressed, suppressedCount } so the UI can show
 *    "N localities hidden (privacy)" when suppressedCount > 0.
 *
 * The returned `visible` array carries the brand that satisfies SuppressedCells
 * when `Row extends Cell`. For generic Row types, callers can use the raw
 * `visible`/`suppressed` arrays directly.
 */
export function suppressSmallCells<Row>(
  rows: Row[],
  opts: SuppressOpts<Row>,
): {
  visible: SuppressedCells;
  suppressed: Row[];
  suppressedCount: number;
} {
  const k = ANONYMITY_K;
  const visible: Row[] = [];
  const suppressed: Row[] = [];

  for (const row of rows) {
    if (opts.count(row) >= k) {
      visible.push(row);
    } else {
      suppressed.push(row);
    }
  }

  if (suppressed.length > 0 && opts.rollup) {
    const rolled = opts.rollup(suppressed);
    if (rolled !== null) visible.push(rolled);
  }

  // Brand the visible array as SuppressedCells.
  // The cast is safe: suppressSmallCells is the ONLY place that can construct
  // a SuppressedCells value — that is the enforcement boundary.
  return {
    visible: visible as unknown as SuppressedCells,
    suppressed,
    suppressedCount: suppressed.length,
  };
}

/**
 * Complementary suppression (statistical-disclosure control) against a
 * differencing attack.
 *
 * When a group total is published while its finer breakdown is k-anon
 * suppressed, a group with EXACTLY ONE suppressed cell leaks that cell's exact
 * count by subtraction: `hidden = groupTotal − Σ(visible cells)`. Suppressing
 * the small cell alone is not enough — its value is recoverable from the
 * siblings.
 *
 * The textbook fix is COMPLEMENTARY (a.k.a. secondary) suppression: whenever a
 * group has exactly one primary-suppressed cell AND at least one visible
 * sibling, ALSO suppress the next-smallest visible cell in that group. After
 * this pass every group holds 0 or ≥2 suppressed cells — EXCEPT a group with a
 * lone suppressed cell and NO visible sibling, which has nothing to complement.
 *
 * ⚠️ WHAT THIS FUNCTION DOES **NOT** GUARANTEE. Read this before relying on it:
 * "0 or ≥2 suppressed cells" is NOT "no hidden value can be isolated", and this
 * docblock used to promise the second while delivering only the first (RA-3
 * finding C2; independently logged as KA1, dim-interno:docs/reviews/tier1-decisions.md).
 * Counterexample: cells `[1, 1, 998]` with a published total of 1000. Two cells
 * are hidden, yet the residual `1000 − 998 = 2` spread over two cells that are
 * each ≥ 1 pins BOTH at exactly 1 — one animal, one household, per cell.
 *
 * THE GUARANTEE, precisely: after this pass no single cell is the ONLY unknown
 * in the subtraction. That is a statement about the number of unknowns, not
 * about how tightly they are bounded.
 *
 * THE OTHER HALF IS THE CALLER'S: publish a group total only while the withheld
 * MASS is itself protected — `Σ(suppressed) >= k`, the same comparison
 * `suppressSmallCells` applies per cell, applied to the residual the total
 * exposes. `planProvinceDisclosure` (./province-disclosure.ts,
 * `publishableRowTotal`) is the reference implementation; every caller that
 * publishes a group total beside suppressed cells owes the same check.
 *
 * RETIRED PREMISE, recorded so it is not re-imported: this block used to justify
 * itself with "the Panorama province choropleth totals are published
 * UNSUPPRESSED (spec §U5)" and called that an accepted disclosure. Task #40
 * retired it — `provinceCell` (src/modules/panorama/…/build-features.ts) routes
 * every province cell's DENOMINATOR through `suppressSmallCells` at
 * `PROVINCE_K === ANONYMITY_K`. §U5 is not a live accepted risk and must not be
 * cited as one.
 *
 * Pure and generic: `group` extracts the aggregation group (e.g. province) and
 * `count` the cell population. Returns re-partitioned visible/suppressed arrays;
 * the caller renders the complementary cell with the SAME k-anon hatch (its
 * value is withheld identically — the user cannot tell primary from secondary).
 */
export function complementarySuppress<Row>(
  visible: readonly Row[],
  suppressed: readonly Row[],
  opts: { group: (r: Row) => string; count: (r: Row) => number },
): { visible: Row[]; suppressed: Row[] } {
  // Count primary-suppressed cells per group.
  const suppressedPerGroup = new Map<string, number>();
  for (const r of suppressed) {
    const g = opts.group(r);
    suppressedPerGroup.set(g, (suppressedPerGroup.get(g) ?? 0) + 1);
  }

  // For each group with exactly one suppressed cell, pick the smallest visible
  // sibling to promote into suppression (the complementary cell).
  const toPromote = new Set<Row>();
  for (const [g, n] of suppressedPerGroup) {
    if (n !== 1) continue;
    let smallest: Row | null = null;
    for (const r of visible) {
      if (opts.group(r) !== g) continue;
      if (smallest === null || opts.count(r) < opts.count(smallest)) smallest = r;
    }
    // No visible sibling → single-cell group; nothing to complement (see jsdoc).
    if (smallest !== null) toPromote.add(smallest);
  }

  if (toPromote.size === 0) return { visible: [...visible], suppressed: [...suppressed] };
  return {
    visible: visible.filter((r) => !toPromote.has(r)),
    suppressed: [...suppressed, ...toPromote],
  };
}

/**
 * Convenience wrapper that returns the MetricResult shape expected by
 * locality-grouped fetchers.
 *
 * Example:
 *   return suppressedMetric(rows, { count: r => r.count, key: r => r.locality });
 */
export function suppressedMetric<Row>(
  rows: Row[],
  opts: SuppressOpts<Row>,
): MetricResult<SuppressedCells> {
  const { visible, suppressedCount } = suppressSmallCells(rows, opts);
  return { value: visible, suppressedCount };
}

// ---------------------------------------------------------------------------
// Delta suppression (viz-suite wave 0 — THE differencing privacy rule)
// ---------------------------------------------------------------------------

/**
 * The k-anonymity DIFFERENCING rule for two-window deltas (viz-suite wave 0):
 * a delta cell is suppressed when EITHER window carries a PROTECTED count —
 * a count in (0, k). Publishing "Δ = current − prior" alongside one visible
 * window would otherwise reveal the hidden window by subtraction — the delta
 * must never leak a cell the single-window rule protects.
 *
 * The ZERO nuance: a count of exactly 0 is NOT protected — an empty window
 * produces no row under the single-window rule (nothing to re-identify), so a
 * "+N desde cero" delta is exactly as public as the visible current window
 * itself. Only sub-k POSITIVE counts suppress. (Event-window metrics only —
 * coverage/stock metrics have no windows and never route here.)
 *
 * ⚠️ RAW COUNTS ONLY: both arguments MUST be pre-suppression counts straight
 * from the aggregate query. A count that already went through
 * suppressSmallCells has lost its sub-k rows — feeding a "missing because
 * suppressed" side as 0 DEFEATS this rule (it would publish "+N desde cero"
 * against a protected prior). Route raw rows here FIRST; suppress the
 * single-window render separately.
 *
 * Pure predicate at the SHARED ANONYMITY_K. It used to carry a `k = 5` default
 * of its own — a second, unlinked copy of the policy number inside the module
 * whose docblock claims to hold the only one. Lowering ANONYMITY_K would have
 * left the delta rule protecting a wider interval than the single-window rule,
 * so the two would have disagreed about which counts are protected: exactly the
 * asymmetry the differencing rule exists to close.
 * Pin THIS before any delta render (verification contract, viz-suite plan).
 */
export function suppressDelta(currentCount: number, priorCount: number): boolean {
  const protectedCount = (n: number) => n > 0 && n < ANONYMITY_K;
  return protectedCount(currentCount) || protectedCount(priorCount);
}

/** One two-window delta cell after the differencing rule. `delta` is null when
 *  suppressed — a suppressed Δ has NO numeric value, not a hidden one. */
export type DeltaCell<Row> = {
  key: string;
  current: Row | null;
  prior: Row | null;
  /** current − prior, or null when the differencing rule suppresses the cell. */
  delta: number | null;
  suppressed: boolean;
};

/**
 * Pair two windows' rows by key and apply the differencing rule per cell —
 * `suppressDelta` is the single source of the rule (including its zero
 * nuance).
 *
 * ⚠️ RAW ROWS ONLY — THE CONTRACT THAT KEEPS THE RULE SOUND: both windows MUST
 * be raw pre-suppression aggregates (straight from the query). Only then is "a
 * key missing from one window" a TRUE zero. Rows that already went through
 * suppressSmallCells have their sub-k cells REMOVED — a missing key would be
 * ambiguous between zero and a PROTECTED count, and this helper would publish
 * "+N desde cero" against a suppressed prior: exactly the differencing leak
 * the rule exists to prevent. TypeScript cannot negate the SuppressedCells
 * brand, so this contract is documentation + review-enforced; the wave-2 delta
 * pipeline must wire raw query outputs directly here, and its RENDER must also
 * apply complementary suppression to any published group totals (mirroring
 * complementarySuppress).
 */
export function deltaCells<Row>(
  currentRows: readonly Row[],
  priorRows: readonly Row[],
  opts: { key: (r: Row) => string; count: (r: Row) => number },
): DeltaCell<Row>[] {
  const priorByKey = new Map(priorRows.map((r) => [opts.key(r), r]));
  const out: DeltaCell<Row>[] = [];
  const seen = new Set<string>();
  for (const cur of currentRows) {
    const key = opts.key(cur);
    seen.add(key);
    const prior = priorByKey.get(key) ?? null;
    const curN = opts.count(cur);
    const priN = prior ? opts.count(prior) : 0;
    const suppressed = suppressDelta(curN, priN);
    out.push({ key, current: cur, prior, delta: suppressed ? null : curN - priN, suppressed });
  }
  for (const pri of priorRows) {
    const key = opts.key(pri);
    if (seen.has(key)) continue;
    const priN = opts.count(pri);
    const suppressed = suppressDelta(0, priN);
    out.push({
      key,
      current: null,
      prior: pri,
      delta: suppressed ? null : 0 - priN,
      suppressed,
    });
  }
  return out;
}
