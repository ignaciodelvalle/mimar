// SlaBadge — the typed vocabulary primitive for SLA copy (C2 · Contrato de
// Lenguaje Operativo, 2026-07-22).
//
// THE BUG THIS KILLS: WelfareDenunciaRow used to render
// `SLA vencido (${slaDaysForSeverity(severity)} d)` — that number is the
// SEVERITY TIER (critical=1d), NOT days overdue. On a 900-day-old case the
// badge read "SLA vencido (1 d)", which a reader parses as "overdue by 1
// day" — the #1 trust bug in the 2026-07-22 plan-maestro audit.
//
// THE FIX IS STRUCTURAL, not a copy edit: this component OWNS the semantic.
// It takes the raw domain inputs (severity, status, createdAt) — the SAME
// inputs isSlaBreached/slaDaysForSeverity already consume from
// ../../../app/gob/maltrato/_lib/welfare-sla.ts — and derives every word
// itself. A caller cannot pass a tier number where an overdue count belongs,
// because the caller never sees either number; it only sees the report.
//
// Three honest states for a NON-TERMINAL report (terminal → no badge, nothing
// left to escalate):
//   - breached, recent   → danger  "SLA {tier} · vencido hace {N}"
//   - breached, ancient  → neutral "Histórico · sin SLA activo · {age}" (backlog
//     demotion, HISTORICAL_BACKLOG_DAYS in welfare-sla.ts — the breach math
//     stays true in data; only the urgency CHROME is demoted for old rows)
//   - not breached        → ok     "SLA {tier} · en plazo · {age}"
//
// EVERY branch carries the report's AGE (A4, 2026-07-31). It used to appear
// only on the breached branch, so inside the largest bucket of the maltrato
// triage queue — the non-breached rows, the ones an operator is deciding
// between — a denuncia filed this morning and one filed 13 days ago rendered
// the BYTE-IDENTICAL pill "SLA 14 días · en plazo". This is a queue ordered by
// urgency (WELFARE_SEVERITY_RANK then oldest-first within a tier), so the badge
// was withholding the second sort key from the reader in exactly the cases
// where the first one ties. The row's absolute filing date was visible one line
// below, but a date is not an age: it makes the reader do the arithmetic the
// urgency pill exists to have already done.
//
// Reuses welfare-sla.ts's isSlaBreached / slaDaysForSeverity /
// isHistoricalBacklog for every decision — this file duplicates NO math, only
// renders it.

import { calendarDaysAgoInAr, pluralizeEs } from "@/lib/utils/format";
import type {
  WelfareReportSeverity,
  WelfareReportStatus,
} from "@/src/modules/welfare/domain/types";
import { isTerminalStatus } from "@/src/modules/welfare/domain/welfare-status-rules";

import {
  isHistoricalBacklog,
  isSlaBreached,
  slaDaysForSeverity,
} from "@/app/gob/maltrato/_lib/welfare-sla";

import { OpPill } from "./OpPill";

export type SlaBadgeProps = {
  severity: WelfareReportSeverity;
  status: WelfareReportStatus | string;
  createdAt: Date;
  /** Injectable clock for deterministic tests; defaults to the real now. */
  now?: Date;
};

/** es-AR "{n} día(s)" — the tier's OWN singular/plural, never hardcoded. */
function daysLabel(n: number): string {
  return `${n} ${pluralizeEs(n, "día")}`;
}

/**
 * es-AR age clause for a report filed `ageDays` AR-calendar days ago —
 * "ingresada hoy" / "ingresada ayer" / "hace {N} días". A bare "hace 0 días"
 * is not something anyone says, and "hoy" alone would read as a deadline
 * rather than a filing age, so the two nearest days name the verb. Feminine
 * agreement is safe: this badge only ever describes a `denuncia`
 * (SlaBadgeProps takes the welfare report's own severity/status types).
 */
function ageLabel(ageDays: number): string {
  if (ageDays <= 0) return "ingresada hoy";
  if (ageDays === 1) return "ingresada ayer";
  return `hace ${daysLabel(ageDays)}`;
}

export function SlaBadge({ severity, status, createdAt, now = new Date() }: SlaBadgeProps) {
  // Terminal reports (cerrada/duplicada/sin sustento) have nothing left to
  // escalate — no SLA badge at all, matching isSlaBreached's own terminal gate.
  if (isTerminalStatus(status as WelfareReportStatus)) return null;

  const tierDays = slaDaysForSeverity(severity);
  const breached = isSlaBreached(severity, status, createdAt, now);
  const historical = isHistoricalBacklog(status, createdAt, now);

  // Calendar-day age (AR timezone) — ONE age computation shared by all three
  // branches, so no branch can grow a second, divergent day-math opinion (the
  // failure mode that produced the original tier-as-overdue-count bug).
  const ageDays = calendarDaysAgoInAr(createdAt, now);

  if (historical) {
    return <OpPill tone="neutral">{`Histórico · sin SLA activo · ${ageLabel(ageDays)}`}</OpPill>;
  }

  if (breached) {
    // Age minus the tier — the actual overdue count, never the tier itself.
    const overdueDays = Math.max(ageDays - tierDays, 0);
    return (
      <OpPill tone="danger">{`SLA ${daysLabel(tierDays)} · vencido hace ${daysLabel(overdueDays)}`}</OpPill>
    );
  }

  return (
    <OpPill tone="ok">{`SLA ${daysLabel(tierDays)} · en plazo · ${ageLabel(ageDays)}`}</OpPill>
  );
}
