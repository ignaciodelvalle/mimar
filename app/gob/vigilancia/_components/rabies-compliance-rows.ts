// Rows of the "Cumplimiento legal — observación rábica" card on /gob/vigilancia.
// Pure, so the wording can be tested against the numbers it labels.
//
// ---------------------------------------------------------------------------
// THE DEFECT THIS FIXES (demo review 2026-08-01, finding #6)
// ---------------------------------------------------------------------------
// The card rendered ONE row, `{closedWithinWindow}/{closed}`, under the term
// "Cerradas en el período" — while the KPI tile above it published, from the
// SAME metric, "18,8% · 16 cerradas en el período".
//
//   nacional : tile "18,8% · 16 cerradas"   card "Cerradas en el período 3/16"
//   CABA     : tile "75% · 4 cerradas"      card "Cerradas en el período 3/4"
//
// A reviewer reading the card concluded the tile was inflating a legal
// compliance figure by printing its denominator. The tile is right: `closed` IS
// the number of observations closed in the period (18.8% = 3/16 confirms it).
// The CARD's term was the lie — 3 is `closedWithinWindow`, the subset that
// closed inside the 10-day statutory deadline, and calling it "cerradas en el
// período" hands the same three words two different meanings one card apart.
//
// Fixed by giving each number its own row and its own term, which also makes
// the tile's headline count appear verbatim in the card instead of only as a
// denominator: nothing on the screen says "16" and "3" are answers to the same
// question any more.
//
// English identifiers, es-AR user copy (project invariant #4).

/** One `<dt>/<dd>` pair of the compliance card. */
export type RabiesComplianceRow = {
  term: string;
  value: string;
  /** Render the value in the danger colour — a live statutory breach. */
  danger?: boolean;
};

/** The metric fields this card reads (lib/analytics/surveillance-metrics.ts's
 *  RabiesComplianceMetric — declared structurally so this module stays pure). */
export type RabiesComplianceFacts = {
  /** Observations with a closing event inside the period. */
  closed: number;
  /** Of those closed, how many closed within the 10-day legal window. */
  closedWithinWindow: number;
  /** closedWithinWindow / closed, or null when nothing closed in the period. */
  compliancePct: number | null;
  /** Still open with no closing event, started more than 10 days ago. */
  openBreaches: number;
};

/**
 * Build the card's rows.
 *
 * @param formatPct - the screen's own percent formatter (renders "—" for null),
 *                    passed in so this module never re-decides how a missing
 *                    ratio is printed.
 */
export function rabiesComplianceRows(
  rabies: RabiesComplianceFacts,
  formatPct: (v: number | null) => string,
): RabiesComplianceRow[] {
  return [
    { term: "Cumplimiento 10 días", value: formatPct(rabies.compliancePct) },
    // Named exactly as the KPI tile names it, and carrying the SAME number, so
    // the two can be checked against each other instead of read as a conflict.
    { term: "Cerradas en el período", value: rabies.closed.toLocaleString("es-AR") },
    // The subset. "De esas" is load-bearing: without it this is the number the
    // old single row was passing off as the total.
    {
      term: "De esas, dentro del plazo (≤10 días)",
      value: rabies.closedWithinWindow.toLocaleString("es-AR"),
    },
    {
      term: "Abiertas > 10 días",
      value: rabies.openBreaches.toLocaleString("es-AR"),
      danger: rabies.openBreaches > 0,
    },
  ];
}
