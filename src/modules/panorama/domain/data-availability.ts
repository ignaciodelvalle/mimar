// P2-1 — the tri-state that tells "empty" apart from "empty", so P2 can hide a
// structure without ever hiding a privacy declaration.
//
// PO principle P2 (2026-08-04): do not render the structure of something empty
// — hide it, or show the MINIMUM. Applied to the ranking: "la tarjeta no va"
// when no data justifies it.
//
// THE LIMIT THAT CANNOT BE CROSSED (PO, same decision): there are TWO different
// empties and collapsing them breaks a privacy obligation.
//
//   ABSENT     — there is no data. Hide the whole structure. This is P2.
//   SUPPRESSED — there IS data, withheld by k-anonymity. The notice is
//                MANDATORY: if it disappears in silence the operator reads
//                "nothing is happening" where something protected IS happening,
//                and we lose the suppression declaration the product promises.
//
// A single boolean cannot decide that, which is exactly why `dataUnavailable`
// (one bool travelling from the console to both the dock table and the printed
// informe) had to become a three-value state.

/**
 * What an operator-facing structure actually has to say.
 *
 *  - `"data"`      — render it. Either there are rows, or there is a
 *                    MEASURED result to state (an all-clear backed by
 *                    measurement), or the calculation FAILED and that failure
 *                    must be declared. A failure is not an absence: hiding it
 *                    would print silence over "we are blind", the exact
 *                    trust/safety defect the 2026-07-10 honesty invariant
 *                    exists to kill.
 *  - `"absent"`    — nothing was measured, nothing was withheld, nothing broke.
 *                    Hide the structure entirely (P2).
 *  - `"suppressed"`— units DID report, k-anonymity withheld the values. The
 *                    structure STAYS so the suppression notice stays. Never
 *                    hidden.
 */
export type DataAvailability = "data" | "absent" | "suppressed";

/** Hide the structure? True only for the middle state. */
export function shouldHideStructure(availability: DataAvailability): boolean {
  return availability === "absent";
}

export type RankingAvailabilityInput = {
  /** Rows the ranking can actually print. */
  rowCount: number;
  /** In-scope units the ranking could MEASURE (regardless of the worst-N cut). */
  measuredUnits: number;
  /** In-scope units that WERE measured but had to be withheld by k-anonymity. */
  suppressedUnits: number;
  /**
   * The base layer produced no data at all — the console's former
   * `rankingDataUnavailable`. A rate ranking over an EMPTY feature collection
   * has nothing to compare against meta, so the panel must not claim "sin
   * jurisdicciones bajo meta". That is a DECLARED failure, not an absence.
   */
  calculationFailed: boolean;
  /**
   * There is no rankable base layer in the active view at all (the console's
   * `effectiveRankingKind === null || rankingLayer === null`). The purest
   * absence: the operator did not ask for a ranking and none exists.
   */
  noRankableLayer?: boolean;
};

/**
 * Classify the ranking's emptiness. Order matters and each branch is a claim:
 *
 *  1. rows       → there is something to print.
 *  2. suppressed → SOMETHING IS THERE and privacy withheld it. This outranks
 *     every hiding rule below, including `noRankableLayer`: a suppression that
 *     vanishes silently is the one outcome P2 may never produce.
 *  3. no rankable layer → absent.
 *  4. measured units → a measured all-clear is a result, not an empty.
 *  5. calculation failed → declare it (see `DataAvailability["data"]`).
 *  6. otherwise → absent.
 */
export function rankingAvailability(input: RankingAvailabilityInput): DataAvailability {
  if (input.rowCount > 0) return "data";
  if (input.suppressedUnits > 0) return "suppressed";
  if (input.noRankableLayer === true) return "absent";
  if (input.measuredUnits > 0) return "data";
  if (input.calculationFailed) return "data";
  return "absent";
}
