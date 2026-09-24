// Recent-activity feed grouping (G3 — govt/admin dashboard honesty).
//
// The gob/admin "Actividad reciente" feed is a chronological (DESC) slice of the
// operator's own audit log. In practice it is dominated by repeated
// "Búsqueda de información personal" (pii_queried) rows, which bury the real
// decisions (assignments, triages, closes) beneath a wall of identical lines.
//
// This collapses CONSECUTIVE same-type search entries that fall on the SAME
// Argentine day into a single row carrying a count ("3 búsquedas de información
// personal · hoy"). It is a DISPLAY-ONLY fold: the underlying audit_log is
// append-only and completely unchanged — only how the feed renders.

import { isoDateInAr } from "@/lib/utils/format";

/** One raw audit entry as read by the feed. */
export type ActivityFeedEntry = {
  id: string;
  action: string;
  performedAt: Date;
};

/** A rendered feed row — either a single entry or a collapsed same-day group. */
export type ActivityFeedRow = {
  /** Stable key (the newest entry's id for a group). */
  id: string;
  action: string;
  /** Newest instant in the row (entries arrive DESC, so this is the first seen). */
  performedAt: Date;
  /** Number of entries folded into this row. 1 for a normal entry. */
  count: number;
  /** Argentine day (YYYY-MM-DD) — set only for a collapsed group (count may be >1). */
  day?: string;
};

/**
 * Collapse CONSECUTIVE entries whose `action === collapseAction` and that share
 * the same Argentine calendar day into one row with a count. The input MUST be
 * ordered newest-first (DESC by performedAt) — the same order the feed query
 * returns; the newest entry of a run supplies the row's id + timestamp.
 *
 * Non-matching entries pass through untouched (count 1). A run that crosses a
 * day boundary splits into one group per day. Defaults to folding the
 * `pii_queried` action (the PII-search spam this exists to tame).
 */
export function collapseActivityFeed(
  entries: ReadonlyArray<ActivityFeedEntry>,
  opts: { collapseAction?: string } = {},
): ActivityFeedRow[] {
  const collapseAction = opts.collapseAction ?? "pii_queried";
  const rows: ActivityFeedRow[] = [];

  for (const entry of entries) {
    if (entry.action !== collapseAction) {
      rows.push({ id: entry.id, action: entry.action, performedAt: entry.performedAt, count: 1 });
      continue;
    }

    const day = isoDateInAr(entry.performedAt);
    const prev = rows[rows.length - 1];
    if (prev && prev.action === collapseAction && prev.day === day) {
      // Extend the current same-day group. performedAt stays the newest (first seen).
      prev.count += 1;
      continue;
    }
    rows.push({
      id: entry.id,
      action: entry.action,
      performedAt: entry.performedAt,
      count: 1,
      day,
    });
  }

  return rows;
}
