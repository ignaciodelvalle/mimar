// Pure view-model helpers for the TimeScrubber rule-change markers
// (política → resultado on the timeline — research-locked design 2026-08-02).
//
// TRANSACTION BASIS BY CONSTRUCTION: each marker is an audit_log row's
// performed_at — the instant the rule change was ENTERED INTO DIM. The
// real-world decision/effective date is unknowable from the audit spine, so
// marker copy is ALWAYS "Cambio registrado el {fecha}" and NEVER "vigente
// desde", regardless of the scrubber's replay-basis toggle (that toggle
// governs pet_events replay, not this annotation layer).
//
// Kept pure (no React, no DOM, no db) so the bucketing is unit-testable. It
// reuses the scrubber's own track math (dateToDayIndex / win.steps) so a
// marker lands at the exact percentage the thumb would occupy on that day,
// and the signal histogram's 48-bucket index math (signal-histogram.ts) so
// co-located markers merge into one "N cambios" chip instead of overlapping
// glyphs. Volume is low by nature (rule changes are rare) — real clustering
// is deliberately out of scope.

import { RULE_TYPE_REGISTRY } from "@/lib/domain/rule-types-registry";
import { type ScrubWindow, dateToDayIndex } from "@/src/modules/panorama/domain/time-scrub";

/** One rule change as served by GET /api/panorama/rule-changes. */
export type RuleChangeMarkerDatum = {
  auditId: string;
  action:
    | "govt_business_rule_created"
    | "govt_business_rule_updated"
    | "govt_business_rule_deleted";
  ruleType: string;
  /** Canonical province display name, or null for national rules. */
  province: string | null;
  locality: string | null;
  /** ISO timestamp of audit_log.performed_at — transaction basis. */
  changedAt: string;
};

/** es-AR action labels — same vocabulary as /admin/inteligencia's table. */
export const RULE_CHANGE_ACTION_LABELS: Record<RuleChangeMarkerDatum["action"], string> = {
  govt_business_rule_created: "creada",
  govt_business_rule_updated: "modificada",
  govt_business_rule_deleted: "eliminada",
};

/**
 * es-AR rule-type label, registry-backed. Total over unknown/legacy rule types
 * (falls back to the raw id) — the API filters to known types, but a stale
 * client must never crash on a type it does not know yet.
 */
export function ruleChangeRuleLabel(ruleType: string): string {
  return (
    (RULE_TYPE_REGISTRY as Record<string, { label: string } | undefined>)[ruleType]?.label ??
    ruleType
  );
}

/** Jurisdiction label — same shape as /admin/inteligencia's ruleScopeLabel. */
export function ruleChangeScopeLabel(
  m: Pick<RuleChangeMarkerDatum, "province" | "locality">,
): string {
  if (!m.province) return "Nacional";
  return m.locality ? `${m.province} · ${m.locality}` : m.province;
}

/** Same 48-bucket track the signal histogram bins into (task #65). */
export const RULE_CHANGE_TRACK_BUCKETS = 48;

export type RuleChangeMarkerBucket = {
  /** Stable key — the track bucket index the members fall into. */
  key: string;
  /** Track position in [0, 1] — mean of the members' day-index fractions. */
  fraction: number;
  /** Member changes, oldest first (chronological reading inside the card). */
  changes: RuleChangeMarkerDatum[];
};

/**
 * Place rule changes on the scrub track and merge co-located ones.
 *
 * Position: `dateToDayIndex(win, changedAt) / win.steps` — the exact fraction
 * the scrubber thumb occupies on that day, so a marker and the playhead agree
 * on where a date IS. Markers outside [since, until] are DROPPED (never
 * clamped to an edge — an edge-clamped marker would claim a date it is not).
 * Merge: two markers whose fractions land in the same 1/48 track bucket
 * (the histogram's bucket-index math) collapse into one bucket whose chip
 * reads "N cambios". Returns [] for a degenerate window (steps <= 0).
 */
export function bucketRuleChangeMarkers(
  markers: ReadonlyArray<RuleChangeMarkerDatum>,
  win: ScrubWindow,
  binCount: number = RULE_CHANGE_TRACK_BUCKETS,
): RuleChangeMarkerBucket[] {
  if (win.steps <= 0 || binCount <= 0) return [];
  const sinceMs = win.since.getTime();
  const untilMs = win.until.getTime();
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) return [];

  const byBucket = new Map<number, { fractions: number[]; changes: RuleChangeMarkerDatum[] }>();
  for (const m of markers) {
    const t = Date.parse(m.changedAt);
    if (!Number.isFinite(t) || t < sinceMs || t > untilMs) continue;
    const fraction = dateToDayIndex(win, new Date(t)) / win.steps;
    const idx = Math.min(binCount - 1, Math.max(0, Math.floor(fraction * binCount)));
    const bucket = byBucket.get(idx) ?? { fractions: [], changes: [] };
    bucket.fractions.push(fraction);
    bucket.changes.push(m);
    byBucket.set(idx, bucket);
  }

  return Array.from(byBucket, ([idx, b]) => ({
    key: String(idx),
    fraction: b.fractions.reduce((a, f) => a + f, 0) / b.fractions.length,
    changes: [...b.changes].sort((a, c) => Date.parse(a.changedAt) - Date.parse(c.changedAt)),
  })).sort((a, b) => a.fraction - b.fraction);
}
