// Result types for alert-firings use-cases.

export type FiringActionResult = { ok: true } | { error: string };

export type RecordFiringsResult = {
  /** Subscriptions evaluated. */
  evaluated: number;
  /** Subscriptions currently breaching. */
  breaching: number;
  /** New firings inserted (after dedup). */
  opened: number;
  /** Fleet-wide sweep only: total distinct admin owners with an active sub. */
  ownersTotal?: number;
  /** Fleet-wide sweep only: owners actually evaluated this run. */
  ownersEvaluated?: number;
  /** Fleet-wide sweep only: true when the wall-clock budget stopped the sweep early. */
  budgetExhausted?: boolean;
  /** Fleet-wide sweep only: keyset resume point (last owner id) when the budget
   *  was hit; null when the sweep fully wrapped this cycle. */
  nextOwnerCursor?: string | null;
};
