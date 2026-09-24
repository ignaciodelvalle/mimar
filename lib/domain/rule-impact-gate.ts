// Pure confirmation-gate predicate for PPP business-rule saves (C9).
//
// Saving a PPP breed list triggers automatic pet re-evaluation and notifies the
// affected owners. The RuleImpactBanner already CALCULATES the blast radius
// (fresh-sweep A2: it returns a real affected-pet count). C9 forces the operator
// to ACKNOWLEDGE that count before the save fires — a confirmation gate, not a
// silent submit.
//
// This module holds the gate logic as a pure predicate so it can be unit-tested
// without the React form. The form threads the count it already has from the
// banner (no second preview call) into `acknowledged`.

export type ImpactStatus = "idle" | "loading" | "done" | "error";

export interface ImpactGateState {
  /** Banner status for the current candidate rule. */
  status: ImpactStatus;
  /** Affected-pet count from the preview (null until known). */
  count: number | null;
  /** Operator explicitly acknowledged the impact in the confirm step. */
  acknowledged: boolean;
}

/**
 * Whether a confirmation step is REQUIRED before the save may fire.
 *
 * A confirmation is required only when the impact preview reports that real pets
 * would be affected (count > 0). When the preview is still loading we also
 * require confirmation defensively — the operator must not be able to outrun the
 * estimate. When the count is 0 (or the preview errored / is idle), the save is
 * advisory-only and no acknowledgement is forced (the banner already explains
 * the error path is non-blocking).
 */
export function requiresImpactConfirmation(state: ImpactGateState): boolean {
  if (state.status === "loading") return true;
  if (state.status === "done" && state.count !== null && state.count > 0) return true;
  return false;
}

/**
 * Whether the save action may proceed given the current gate state.
 *
 * - If no confirmation is required → always allowed.
 * - If confirmation IS required → allowed only once the operator acknowledged
 *   AND a concrete count is known (never let them confirm an unknown blast
 *   radius mid-load).
 */
export function canSaveWithImpactGate(state: ImpactGateState): boolean {
  if (!requiresImpactConfirmation(state)) return true;
  return state.acknowledged && state.status === "done" && state.count !== null && state.count > 0;
}
