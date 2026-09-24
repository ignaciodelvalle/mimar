// queue-signal-display — how the org landing's "Pendientes" rows read (D-7 / D-10).
//
// PURE module (no Drizzle, no React, no DB import graph — the type imports below
// are erased at compile time). It exists so the two decisions that used to sit
// inline in app/org/[orgToken]/page.tsx can be asserted directly instead of
// through a page render:
//
//   D-7  `pendingQueueTone` was a pure KEY SWITCH, blind to time. A decomiso
//        handoff 20 days past the 7-day window of Ley 14.346 painted the same
//        calm "open" as one proposed this morning — on the landing of the org
//        that owes the answer, while the escalation cron was already paging the
//        authority about that exact case.
//   D-10 A queue's count said nothing about how long its oldest row had waited.
//        The page's own comment documented the real failure: "Todo en orden"
//        beside 2 postulaciones and 2 casos, one of them 35 days old.

import type { OrgQueueKey, OrgQueueSignal } from "@/lib/analytics/org-dashboard";
import { queueAgingNote } from "@/lib/domain/queue-aging";
import { DECOMISO_HANDOFF_STALE_DAYS } from "@/src/modules/cases/domain/case-sla";

export type QueuePillTone = "open" | "danger" | "neutral";

/**
 * Pill tone for one queue row.
 *
 * Zero is always the calm neutral "all clear". Otherwise a breached STATUTORY
 * deadline (`signal.hasOverdue`) wins outright — it outranks any per-queue
 * convention about how loud a queue is allowed to be — and only then does the
 * key's own default apply: derived welfare reports and overdue post-adoption
 * check-ins are legally/temporally sensitive by nature, everything else is
 * ordinary work.
 *
 * `n === null` (that one queue's count query failed — adversarial review
 * 2026-07-10, HIGH 4) never reaches here: the caller omits the pill entirely
 * rather than asking for a tone it has no number for.
 */
export function pendingQueueTone(
  key: OrgQueueKey,
  n: number,
  signal?: Pick<OrgQueueSignal, "hasOverdue">,
): QueuePillTone {
  if (n === 0) return "neutral";
  if (signal?.hasOverdue) return "danger";
  if (key === "derivedWelfare" || key === "overdueCheckins") return "danger";
  return "open";
}

/**
 * The muted line under a queue row, or null when there is nothing honest to add.
 *
 * The aging half reuses `queueAgingNote` — the SAME copy the /gob home renders —
 * so "la más antigua: 35 días" reads identically on both portals. The breach
 * half names the law rather than only shading the pill red: the tone says
 * "urgent", this says WHY it is urgent and under which rule.
 *
 * `overdueCount: 0` is passed deliberately: an org queue's signal knows THAT a
 * legal deadline was blown, not how many rows blew it, and printing a count it
 * did not measure would be a fabricated number.
 */
export function queueSignalNote(signal: OrgQueueSignal | undefined): string | null {
  if (!signal) return null;
  const aging = queueAgingNote({ oldestAgeDays: signal.oldestAgeDays, overdueCount: 0 }, "f");
  if (!signal.hasOverdue) return aging;
  const breach = `Fuera del plazo legal de ${DECOMISO_HANDOFF_STALE_DAYS} días (Ley 14.346)`;
  return aging ? `${breach} · ${aging.charAt(0).toLowerCase()}${aging.slice(1)}` : breach;
}
