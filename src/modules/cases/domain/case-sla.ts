// The case domain's SLA deadline rule — a PURE module (no "use client").
//
// CRITICAL boundary note: this const/fn is consumed by BOTH a client component
// (CaseQueue.tsx, "use client") and the RSC server graph (/gob/acciones'
// worklist-core.ts). It cannot live in CaseQueue.tsx: in the server graph every
// export of a "use client" module becomes a client-reference Proxy that THROWS
// when coerced to a number (`CASE_SLA_WARNING_DAYS * ms` → valueOf trap), which
// silently killed the worklist's "caso" domain. Both graphs import from here.
//
// Visual-only: no auto-close occurs. 14 days aligns with the typical org
// review window for escalated/unresolved cases.

export const CASE_SLA_WARNING_DAYS = 14;

/**
 * The case domain's deadline rule for the shared due-state normalization
 * (lib/domain/due-state.ts): a case is "due" CASE_SLA_WARNING_DAYS after it was
 * opened. The ONE place an openedAt becomes a dueAt — callers hand the result
 * to computeDueInfo/dueDateBadge so "days past due" math is never hand-rolled.
 */
export function caseSlaDueAt(openedAt: Date): Date {
  return new Date(openedAt.getTime() + CASE_SLA_WARNING_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Days a pending DECOMISO handoff may sit before it is stale (DC8, Ley 14.346).
 *
 * Lives in the pure domain module rather than beside the cron that enforces it
 * because it now has THREE consumers on two graphs: the escalation job
 * (src/modules/cases/application/escalate-stale-decomiso-handoffs.ts), the org
 * landing's queue signal (lib/analytics/org-dashboard.ts), and that landing's
 * pure display helper — same boundary rationale as CASE_SLA_WARNING_DAYS above.
 * One constant is what stops a tile from reading "en plazo" while the cron is
 * already paging the authority about the very same case.
 */
export const DECOMISO_HANDOFF_STALE_DAYS = 7;
