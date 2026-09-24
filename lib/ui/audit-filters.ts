// Pure parsing/validation helpers for the /admin/auditoria filters.
//
// Extracted so the multi-action + date-range filtering the auditoría page
// applies is unit-testable without a running database. The page reads these
// helpers to turn raw searchParams into validated filter inputs; the admin
// KPI strip uses `decisionsAuditDrillHref` to build a drill that lands on the
// exact rows the "Decisiones 7d" tile counts (a date-scoped, decision-action
// filtered view — not the all-time, all-action log).

import type { AuditLogAction } from "@/db";
import { AUDIT_ACTION_LABELS } from "@/lib/ui/audit-action-labels";
import { isoDateInAr } from "@/lib/utils/format";

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The audit actions the "Decisiones 7d" KPI counts (approvals + rejections). */
export const DECISION_AUDIT_ACTIONS = ["request_approved", "request_rejected"] as const;

/**
 * Parse a (possibly comma-separated) `action` param into a validated, de-duped
 * list of audit actions. Unknown codes are dropped so an attacker-shaped param
 * can never reach the SQL layer. Order of first appearance is preserved.
 *
 * Accepts `string[]` because Next hands a page an array when the key repeats
 * (`?action=a&action=b`) and `raw.split` then throws — a raw 500 on
 * /admin/auditoria, /admin/historial and /gob/historial, all three of which
 * call this. A repeated key is unambiguously "both of these" for a param that
 * is ALREADY a list, so the values are concatenated rather than first-wins.
 */
export function parseAuditActions(raw: string | string[] | null | undefined): AuditLogAction[] {
  if (!raw) return [];
  const joined = Array.isArray(raw) ? raw.join(",") : raw;
  const seen = new Set<string>();
  const out: AuditLogAction[] = [];
  for (const part of joined.split(",")) {
    const code = part.trim();
    if (code && code in AUDIT_ACTION_LABELS && !seen.has(code)) {
      seen.add(code);
      out.push(code as AuditLogAction);
    }
  }
  return out;
}

export type AuditDateRange = {
  /** Inclusive lower bound (performedAt >= since), or null when absent/invalid. */
  since: Date | null;
  /** Exclusive upper bound (performedAt < until), or null when absent/invalid. */
  until: Date | null;
};

/**
 * Parse a YYYY-MM-DD string to the ARGENTINE midnight of that day (03:00Z —
 * AR is UTC-3 year-round, no DST since 2009, so a fixed offset is exact), or
 * null when malformed. PO decision 2026-07-16: filter days are Argentine
 * calendar days, not UTC days — a "2026-07-18" filter must span
 * 2026-07-18T00:00 AR through 24:00 AR.
 */
function parseArDateOnly(raw: string): Date | null {
  if (!DATE_ONLY_RE.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00.000-03:00`);
  if (Number.isNaN(d.getTime())) return null;
  // Reject rolled-over dates like 2026-02-30 (JS would silently normalise to Mar 2).
  if (isoDateInAr(d) !== raw) return null;
  return d;
}

/**
 * Parse `from`/`to` (date-only, YYYY-MM-DD, Argentine calendar days) into a
 * half-open [since, until) range. `to` is treated as inclusive of the whole AR
 * day by advancing `until` to the next AR midnight, so a single-day filter
 * (from === to) still matches.
 */
export function parseAuditDateRange(
  from: string | null | undefined,
  to: string | null | undefined,
): AuditDateRange {
  const since = from ? parseArDateOnly(from) : null;
  const toDate = to ? parseArDateOnly(to) : null;
  const until = toDate ? new Date(toDate.getTime() + DAY_MS) : null;
  return { since, until };
}

/**
 * Build the drill href for the admin "Decisiones 7d" KPI: the decision actions
 * it counts, scoped to the trailing 7 days. `now` is injectable for testing.
 * The `from` day is the ARGENTINE calendar day 7 days back — it feeds
 * parseAuditDateRange, which reads it as an AR day.
 */
export function decisionsAuditDrillHref(now: number = Date.now()): string {
  const from = isoDateInAr(new Date(now - 7 * DAY_MS));
  return `/admin/auditoria?action=${DECISION_AUDIT_ACTIONS.join(",")}&from=${from}`;
}

/** One <option> for the auditoría action filter: a UNIQUE visible label and the
 *  action code(s) it selects. `value` is a comma-separated list of every code
 *  that shares this label — parseAuditActions() already splits on comma, so
 *  selecting the option filters by all of them at once. */
export type AuditActionOption = { value: string; label: string };

/**
 * Build the auditoría action-filter options, UNIQUE by visible label.
 *
 * AUDIT_ACTION_LABELS legitimately maps several ALIAS codes to one label — an old
 * and a new code for the same real action (revocation_org / revocation_org_verified,
 * self_resignation_govt / govt_self_deactivated, "microchip.replace" /
 * microchip_replaced). Emitting one <option> per code (the old inline
 * `Object.entries(AUDIT_ACTION_LABELS)`) rendered visibly DUPLICATE dropdown
 * rows (admin QA). This builder groups by label so each label appears once, with
 * `value` carrying every aliased code (comma-joined) so filtering still matches
 * all of them. Sorted by label (es-AR).
 */
export function buildAuditActionOptions(): AuditActionOption[] {
  const codesByLabel = new Map<string, string[]>();
  for (const [code, label] of Object.entries(AUDIT_ACTION_LABELS)) {
    const codes = codesByLabel.get(label);
    if (codes) codes.push(code);
    else codesByLabel.set(label, [code]);
  }
  return [...codesByLabel.entries()]
    .map(([label, codes]) => ({ label, value: [...codes].sort().join(",") }))
    .sort((a, b) => a.label.localeCompare(b.label, "es-AR"));
}
