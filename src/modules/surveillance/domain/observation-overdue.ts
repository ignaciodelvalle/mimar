// The shared due-soon window for the 10-day rabies observation deadline.
//
// G3 (2026-07-03 critique): /admin/observaciones rendered "Cierre estimado:
// {date}" but never compared it to now — an observation 20 days past its
// statutory deadline looked identical to one on time.
//
// Deadline normalization + badge copy now live in the ONE cross-domain place
// (lib/domain/due-state.ts `computeDueInfo` / `dueDateBadge`): both
// /admin/observaciones and the /gob/acciones worklist feed a deadline through
// that pair, so the same observation can never grow divergent day math or
// wording across the two screens. This module keeps only the window constant
// that both call sites pass as `computeDueInfo(..., OBSERVATION_DUE_SOON_DAYS)`.

/**
 * How many days before the deadline an observation starts warning.
 * 2 = the deadline day itself, tomorrow, and the day after.
 */
export const OBSERVATION_DUE_SOON_DAYS = 2;
