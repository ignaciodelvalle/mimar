// due-state — the ONE deadline normalization every "Acciones que vencen"
// domain speaks (G4, obligations-worklist 2026-08).
//
// PURE module — no Drizzle, no Next.js, no React. Each deadline-bearing
// domain (observaciones antirrábicas, denuncias de maltrato, casos
// regulatorios) computes its OWN dueAt with its own domain rule
// (resolveObservationDeadline, WELFARE_SLA_DAYS, CASE_SLA_WARNING_DAYS) and
// hands the resulting Date here; this module owns everything AFTER that
// point — state, day counts, ranking and the badge words — so two domains
// can never disagree on what "vencida" means or how far overdue a row is.
//
// Generalized from app/gob/maltrato/_lib/welfare-sla.ts WITHOUT copying the
// tier-vs-count bug SlaBadge.tsx exists to kill: the day count rendered by
// `dueDateBadge` is ALWAYS the distance between dueAt and now (AR calendar
// days via calendarDaysAgoInAr — one shared day-math opinion), NEVER a
// domain's SLA tier number. A caller cannot pass a tier where an overdue
// count belongs because the caller never supplies any day count at all —
// only the deadline.
//
// The observation-overdue predicate deliberately does NOT live here: the
// caller supplies the observation's deadline via resolveObservationDeadline
// (src/modules/surveillance/domain/rabies-observation.ts) and this module
// normalizes it like any other dueAt — no duplicated 10-day math.

import { calendarDaysAgoInAr, pluralizeEs } from "@/lib/utils/format";

/**
 * The three honest deadline states:
 *  - "overdue": the deadline is in the past (millisecond compare — matches
 *    isSlaBreached's `ageMs > tier` posture, so a row never reads "en plazo"
 *    here while the maltrato queue badges it VENCIDO).
 *  - "dueSoon": due within `dueSoonDays` AR calendar days (including today).
 *  - "onTime": due later than that, or no deadline at all (dueAt null —
 *    callers should rank such rows last, which compareDueInfo does).
 */
export type DueState = "overdue" | "dueSoon" | "onTime";

export type DueInfo = {
  /** The domain-computed deadline. null = the domain could not compute one. */
  dueAt: Date | null;
  /** AR calendar days PAST the deadline. 0 unless state === "overdue". */
  overdueDays: number;
  /** AR calendar days UNTIL the deadline (0 = due today). 0 when overdue. */
  dueInDays: number;
  state: DueState;
};

/** Default "vence pronto" window (AR calendar days, inclusive of today). */
export const DEFAULT_DUE_SOON_DAYS = 3;

/**
 * Normalize a domain deadline into the worklist's common currency.
 *
 * A null/invalid dueAt yields the honest "no deadline" shape: state "onTime"
 * with both day counts at 0 and dueAt null — compareDueInfo ranks it last
 * and dueDateBadge renders "Sin plazo", never a fabricated date.
 */
export function computeDueInfo(
  dueAt: Date | null,
  now: Date = new Date(),
  dueSoonDays: number = DEFAULT_DUE_SOON_DAYS,
): DueInfo {
  if (dueAt === null || Number.isNaN(dueAt.getTime())) {
    return { dueAt: null, overdueDays: 0, dueInDays: 0, state: "onTime" };
  }

  // Overdue is a millisecond fact (deadline passed), but the COUNT shown to
  // the operator is AR calendar days — the same split SlaBadge already uses
  // (isSlaBreached in ms, calendarDaysAgoInAr for display). A deadline missed
  // earlier today is overdue with overdueDays 0 → "Venció hoy".
  const daysSinceDue = calendarDaysAgoInAr(dueAt, now); // >0 past, <0 future
  if (now.getTime() > dueAt.getTime()) {
    return { dueAt, overdueDays: Math.max(daysSinceDue, 0), dueInDays: 0, state: "overdue" };
  }

  const dueInDays = Math.max(-daysSinceDue, 0);
  return {
    dueAt,
    overdueDays: 0,
    dueInDays,
    state: dueInDays <= dueSoonDays ? "dueSoon" : "onTime",
  };
}

// Sort rank per state — overdue first (the whole point of the worklist).
const STATE_RANK: Record<DueState, number> = { overdue: 0, dueSoon: 1, onTime: 2 };

/**
 * The worklist ordering: state (overdue → dueSoon → onTime), then MOST
 * overdue first, then SOONEST due first. Rows without a deadline sink to the
 * very end regardless of state (nothing honest to rank them by). Final
 * tiebreak is the raw dueAt timestamp so the order is deterministic.
 */
export function compareDueInfo(a: DueInfo, b: DueInfo): number {
  if (a.dueAt === null || b.dueAt === null) {
    if (a.dueAt === null && b.dueAt === null) return 0;
    return a.dueAt === null ? 1 : -1;
  }

  const byState = STATE_RANK[a.state] - STATE_RANK[b.state];
  if (byState !== 0) return byState;
  if (a.overdueDays !== b.overdueDays) return b.overdueDays - a.overdueDays;
  if (a.dueInDays !== b.dueInDays) return a.dueInDays - b.dueInDays;
  return a.dueAt.getTime() - b.dueAt.getTime();
}

export type DueBadge = {
  label: string;
  tone: "danger" | "open" | "ok" | "neutral";
};

/** es-AR "{n} día(s)" with correct agreement — never a bare "1 días". */
function daysLabel(n: number): string {
  return `${n} ${pluralizeEs(n, "día")}`;
}

/**
 * The honest deadline badge: label + OpPill tone. The number is ALWAYS the
 * days-to/past-deadline distance computed by computeDueInfo — a severity
 * tier or legal-window constant can never reach this text.
 *
 *   overdue  → danger  "Venció hoy" / "Venció hace {N} día(s)"
 *   dueSoon  → open    "Vence hoy" / "Vence mañana" / "Vence en {N} días"
 *   onTime   → ok      "Vence en {N} días"   (neutral "Sin plazo" when null)
 *
 * "Venció"/"Vence" (the DEADLINE expired/expires) rather than
 * "Vencida/Vencido" — the subject nouns differ in gender across domains
 * (la denuncia, el caso), and the verb form needs no agreement.
 */
export function dueDateBadge(due: DueInfo): DueBadge {
  if (due.dueAt === null) {
    return { label: "Sin plazo", tone: "neutral" };
  }
  if (due.state === "overdue") {
    return {
      label: due.overdueDays === 0 ? "Venció hoy" : `Venció hace ${daysLabel(due.overdueDays)}`,
      tone: "danger",
    };
  }
  if (due.state === "dueSoon") {
    if (due.dueInDays === 0) return { label: "Vence hoy", tone: "open" };
    if (due.dueInDays === 1) return { label: "Vence mañana", tone: "open" };
    return { label: `Vence en ${daysLabel(due.dueInDays)}`, tone: "open" };
  }
  return { label: `Vence en ${daysLabel(due.dueInDays)}`, tone: "ok" };
}
