// queue-aging — what a home-screen queue tile may honestly say about TIME.
//
// D-4 (Lote D, 2026-08-16). The /gob home's "Cola operativa" tiles showed a
// bare count per queue: "Denuncias de maltrato — 12". Twelve denuncias one day
// old and twelve denuncias six weeks past their SLA render identically, and the
// operator has to open the queue to learn which they are. The worklist screen
// (/gob/acciones) already computes exactly that distinction for the same rows,
// through lib/domain/due-state.ts — the home simply never asked for it.
//
// PURE module — no Drizzle, no React. It owns two things and nothing else:
// the SHAPE of an aging summary, and the es-AR sentence that renders it. Every
// deadline decision upstream stays where it already lives (WELFARE_SLA_DAYS /
// slaDaysForSeverity for denuncias, CASE_SLA_WARNING_DAYS / caseSlaDueAt for
// casos, computeDueInfo for the day math) — this module never re-derives an SLA
// and never invents one.
//
// WHY A SEPARATE oldestAgeDays FROM overdueCount: they answer different
// questions, and collapsing them is how a queue hides its worst row. A queue
// can be entirely within SLA and still hold something 40 days old (a low-
// severity denuncia has a long tier); it can also be fully overdue with nothing
// older than a week. The tile states both, or says the one it has.

import { calendarDaysAgoInAr, pluralizeEs } from "@/lib/utils/format";

/** The aging facts a queue tile carries beside its count. */
export type QueueAging = {
  /**
   * AR calendar days since the OLDEST still-open row entered the queue.
   * null when the queue is empty — never 0-as-unknown.
   */
  oldestAgeDays: number | null;
  /** How many rows are already past their OWN deadline (per-row SLA tier). */
  overdueCount: number;
};

/**
 * Grammatical gender of the queue's subject noun, for the "N vencidas/vencidos"
 * fragment. es-AR: la denuncia → vencidas, el caso → vencidos. Required rather
 * than defaulted, so a new caller has to state which its rows are instead of
 * silently inheriting the wrong agreement.
 */
export type QueueSubjectGender = "f" | "m";

/** "{n} día" / "{n} días" with correct agreement — never a bare "1 días". */
function daysLabel(n: number): string {
  return `${n} ${pluralizeEs(n, "día")}`;
}

/**
 * The es-AR sub-line for a queue tile, or null when there is nothing honest to
 * add (an empty queue has no oldest row and no overdue rows — the "0" says it
 * all, and a fabricated "la más antigua: 0 días" would be worse than silence).
 *
 * Overdue leads when present: it is the actionable half. The oldest-row age
 * always follows, because a queue fully within SLA still deserves the reader's
 * sense of how long its tail has been waiting.
 */
export function queueAgingNote(aging: QueueAging, gender: QueueSubjectGender): string | null {
  if (aging.oldestAgeDays === null) return null;
  const oldest = `la más antigua: ${daysLabel(aging.oldestAgeDays)}`;
  if (aging.overdueCount === 0) {
    // Capitalized: it is the whole sentence when nothing is overdue.
    return `${oldest.charAt(0).toUpperCase()}${oldest.slice(1)}`;
  }
  const word = gender === "f" ? "vencida" : "vencido";
  return `${aging.overdueCount} ${pluralizeEs(aging.overdueCount, word)} · ${oldest}`;
}

/**
 * How old the oldest row is, in AR calendar days, floored at 0.
 *
 * Delegates to `calendarDaysAgoInAr` — the SAME day-math due-state's badges use,
 * not a parallel ms/86400 division. That matters: an operator reading "la más
 * antigua: 3 días" on the home and "Venció hace 3 días" on the worklist must be
 * reading one calendar, and Argentina's is the one both screens speak. The
 * floor covers a clock-skewed future timestamp, which would otherwise render a
 * negative age.
 */
export function ageInDays(since: Date, now: Date = new Date()): number {
  return Math.max(0, calendarDaysAgoInAr(since, now));
}
