// Risk + SLA ordering domain for the maltrato triage queue (UI/UX audit
// 2026-07: "default order = risk + SLA, not date").
//
// PURE module — no Drizzle, no Next.js, no React. The SQL fragments that apply
// this ordering live in the page (app/gob/maltrato/page.tsx); this module owns
// the numbers so the row badge, the ORDER BY rank and the keyset cursor can
// never disagree on what "risk" or "breached" means.
//
// SLA TIERS (documented convention — no severity→SLA mapping existed before
// this module): the queue already had ONE hard SLA signal, the "Atrasadas" tab
// (status open, older than 7 days — SEVEN_DAYS_MS in
// lib/analytics/govt-dashboards.buildMaltratoListConditions). That 7-day
// convention anchors the MEDIUM tier; the tiers tighten for high/critical and
// relax for low:
//
//   critical → 1 day   (peligro inmediato — same-day/next-day response)
//   high     → 3 days  (urgente)
//   medium   → 7 days  (the pre-existing "Atrasadas" convention)
//   low      → 14 days (preocupante, no urgente)
//
// A report BREACHES its SLA when it is still in a NON-terminal status and its
// age exceeds the tier. Terminal reports (cerrada / duplicada / sin sustento)
// never breach — there is nothing left to escalate.

import type {
  WelfareReportSeverity,
  WelfareReportStatus,
} from "@/src/modules/welfare/domain/types";
import { isTerminalStatus } from "@/src/modules/welfare/domain/welfare-status-rules";

// ---------------------------------------------------------------------------
// Severity risk rank — the ORDER BY key (higher = riskier = first).
// ---------------------------------------------------------------------------

export const WELFARE_SEVERITY_RANK: Record<WelfareReportSeverity, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
};

/** Rank for a severity value; unknown/legacy values sink to the bottom (-1). */
export function severityRank(severity: string): number {
  return WELFARE_SEVERITY_RANK[severity as WelfareReportSeverity] ?? -1;
}

// ---------------------------------------------------------------------------
// SLA tiers + breach predicate.
// ---------------------------------------------------------------------------

export const WELFARE_SLA_DAYS: Record<WelfareReportSeverity, number> = {
  critical: 1,
  high: 3,
  medium: 7,
  low: 14,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** SLA window (days) for a severity; unknown values get the loosest tier. */
export function slaDaysForSeverity(severity: string): number {
  return WELFARE_SLA_DAYS[severity as WelfareReportSeverity] ?? 14;
}

/**
 * True when the report is past its severity-tiered SLA and still actionable.
 * Terminal statuses never breach (nothing left to escalate).
 */
export function isSlaBreached(
  severity: string,
  status: WelfareReportStatus | string,
  createdAt: Date,
  now: Date = new Date(),
): boolean {
  if (isTerminalStatus(status as WelfareReportStatus)) return false;
  const ageMs = now.getTime() - createdAt.getTime();
  return ageMs > slaDaysForSeverity(severity) * DAY_MS;
}

// ---------------------------------------------------------------------------
// Historical backlog demotion (C2 language contract, 2026-07-22 — PO-locked).
//
// A non-terminal report can be legitimately ancient (a seed/import row, or a
// genuinely stale case nobody closed). Rendering "SLA vencido (1 d)" — the
// SEVERITY TIER, not days overdue — on a 900-day-old row read as "overdue by
// 1 day" (the #1 trust bug this contract kills). SlaBadge fixes the honesty
// of the BREACHED case, but a 900-day-old breach is still a different KIND of
// signal than one that slipped yesterday: it is backlog, not an active alarm.
// This threshold demotes it from urgency chrome — the breach math above
// stays TRUE (nothing is hidden from the data), only the PRESENTATION calms
// down for rows this old.
//
// 180 days (~6 months) is a defensible cutoff: it is well past every SLA tier
// (max 14 days, low severity) — a report can only be "historical" once it has
// ALSO been breached for months — while staying inside a single operational
// year, so a report does not sit in limbo indefinitely before being named.
export const HISTORICAL_BACKLOG_DAYS = 180;

/**
 * True when a NON-TERMINAL report is old enough to be presented as historical
 * backlog rather than an active SLA alarm. Always false for terminal reports
 * (nothing to demote — they never breach in the first place) and false for
 * anything younger than HISTORICAL_BACKLOG_DAYS, even if already breached.
 */
export function isHistoricalBacklog(
  status: WelfareReportStatus | string,
  createdAt: Date,
  now: Date = new Date(),
): boolean {
  if (isTerminalStatus(status as WelfareReportStatus)) return false;
  const ageMs = now.getTime() - createdAt.getTime();
  return ageMs > HISTORICAL_BACKLOG_DAYS * DAY_MS;
}

// ---------------------------------------------------------------------------
// Risk keyset cursor — (rank, createdAt, id).
//
// The shared lib/utils/keyset-pagination cursor is (ts, id) under a plain
// createdAt DESC contract. The risk ordering is rank DESC, createdAt ASC
// (oldest-first within a tier — age IS the SLA pressure), id ASC — so this
// page carries its own 3-part cursor: base64url of "<rank>|<iso>|<uuid>".
// Malformed/legacy 2-part cursors decode to null → caller falls back to page 1
// (same posture as decodeCursor).
// ---------------------------------------------------------------------------

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RiskCursor = { rank: number; ts: string; id: string };

export function encodeRiskCursor(rank: number, ts: Date | string, id: string): string {
  const iso = ts instanceof Date ? ts.toISOString() : new Date(ts).toISOString();
  return Buffer.from(`${rank}|${iso}|${id}`, "utf8").toString("base64url");
}

export function decodeRiskCursor(raw: string | null | undefined): RiskCursor | null {
  if (!raw) return null;
  try {
    const payload = Buffer.from(raw, "base64url").toString("utf8");
    const parts = payload.split("|");
    if (parts.length !== 3) return null;
    const [rankRaw, iso, id] = parts;
    // Rank is a small non-negative integer (0..3 today; -1 never encodes).
    if (!/^\d{1,2}$/.test(rankRaw)) return null;
    const rank = Number(rankRaw);
    // Strict ISO + UUID validation — both values are cast (::timestamptz /
    // ::uuid) in the page's SQL, so attacker-shaped ?cursor= must die HERE,
    // not as a Postgres error (mirrors lib/utils/keyset-pagination.decodeCursor).
    if (!ISO_8601_RE.test(iso)) return null;
    if (!UUID_RE.test(id)) return null;
    return { rank, ts: iso, id };
  } catch {
    return null;
  }
}
