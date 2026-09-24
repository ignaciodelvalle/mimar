// lib/analytics/territorial-data-quality.ts — Per-province data-quality score
// (Task #44.3).
//
// A per-jurisdiction AGGREGATE completeness/reconciliation scorecard. Signal
// definitions are NOT invented here — each one mirrors, verbatim, an existing
// blessed definition:
//
//   missingLocality / missingSex / missingChip / orphans
//     → lib/metrics/program-health.ts fetchDataQuality (same EXISTS SQL)
//   dormant (no owner activity in N months, credential_scanned excluded)
//     → lib/metrics/census.ts registryCounts (same NOT EXISTS SQL + cutoff rule)
//   replaced chips
//     → pet_identifications.status = 'replaced' (identificationStatusEnum),
//       the same reconciliation state the microchip.replace flow writes.
//
// This module only adds the per-province GROUP BY and the composite score.
//
// GHOST RECORDS (record-level reconciliation — NOT citizen scoring)
// -----------------------------------------------------------------
// ghost = active/lost pet with NO ownerships row at all AND no qualifying
// owner-activity event in the dormancy window. These are registrations that
// exist on paper but show no human behind them — the classic reconciliation
// backlog (bulk imports, abandoned sign-ups). The flag lives on the RECORD;
// it is only ever COUNTED per province here. No owner/citizen is scored —
// by definition a ghost record has no active owner attached.
//
// SCORE (documented per Task #44 requirement)
// -------------------------------------------
// Five health ratios, each 0–1, unweighted mean × 100, rounded:
//
//   locality   = 1 − missingLocality / total
//   sex        = 1 − missingSex / total
//   chip       = 1 − missingChip / total
//   ownership  = 1 − orphans / total
//   activity   = 1 − dormant / total
//
// Replaced chips are shown as a context column but EXCLUDED from the score:
// a replacement is correct reconciliation behaviour (the system working),
// not a data defect.
//
// K-ANONYMITY & HONEST RESIDUALS
// ------------------------------
// Provinces with < 5 active pets are suppressed (k=5, AGENTS.md policy) and
// disclosed as a count. Pets with NO province at all cannot appear in any
// per-province row — they are surfaced as `unassigned` following the panorama
// no-locality residual disclosure model (commit 0a47d912): the gap is shown,
// never silently dropped.

import { count, sql } from "drizzle-orm";

// POOL: analyticsDb (session pooler), NOT the OLTP transaction pooler — these are
// read-only multi-statement dashboard aggregates. supavisor transaction mode (6543)
// has a measured >100x pathology for this fan-out shape (db/index.ts); session mode
// serves it normally. Locally analyticsDb falls back to DATABASE_URL (identical dev/test).
import { analyticsDb as db, pets } from "@/db";
import type { ProjectionContext } from "@/lib/metrics";
import { DORMANT_MONTHS_DEFAULT, suppressSmallCells } from "@/lib/metrics";
import { ANONYMITY_K } from "@/lib/metrics/anonymity";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Small-cell suppression floor (AGENTS.md "Aggregation & privacy policy").
 *
 * DERIVED from ANONYMITY_K (2026-08-17), not a literal of its own. This one is
 * load-bearing beyond the maths: `app/admin/inteligencia/inteligencia-panels.tsx`
 * INTERPOLATES it into the operator-facing copy ("… por k<{N} (privacidad)").
 * The suppression itself runs through `suppressSmallCells`, which now applies
 * ANONYMITY_K and accepts no override — so a bare literal here would be a label
 * free to disagree with the behaviour it describes.
 */
export const DATA_QUALITY_K_ANON = ANONYMITY_K;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProvinceDataQualitySignals = {
  /** Active/lost pets registered in the province. */
  total: number;
  /** jurisdiction_locality IS NULL (province known, locality missing). */
  missingLocality: number;
  /** sex = 'unknown'. */
  missingSex: number;
  /** No active microchip_iso identification. */
  missingChip: number;
  /** No ownerships row at all (structural orphan). */
  orphans: number;
  /** No qualifying owner-activity event in the dormancy window. */
  dormant: number;
  /** Orphan AND dormant — reconciliation backlog (record-level flag, counted). */
  ghosts: number;
  /** Pets with ≥1 replaced identification (context column, not scored). */
  replacedChips: number;
};

export type ProvinceDataQualityRow = ProvinceDataQualitySignals & {
  province: string;
  /** Composite data-quality score 0–100 (see module docstring for formula). */
  score: number;
  /** 1-based rank, highest score first. Ties broken alphabetically. */
  rank: number;
};

export type ProvinceDataQualityResult = {
  rows: ProvinceDataQualityRow[];
  /** Provinces hidden by the k=5 suppression (disclose in the UI). */
  suppressedProvinces: number;
  /** Active/lost pets with NO province assigned — the honest residual. */
  unassigned: number;
};

// ---------------------------------------------------------------------------
// Pure computation (unit-tested, DB-free)
// ---------------------------------------------------------------------------

/**
 * Composite score: unweighted mean of the five health ratios × 100, rounded.
 * Returns 100 for an empty province (nothing is missing in an empty set) —
 * consistent with lib/metrics/program-health.ts completeness(); in practice
 * empty provinces are k-anon-suppressed before display.
 */
export function computeQualityScore(signals: ProvinceDataQualitySignals): number {
  const { total } = signals;
  if (total === 0) return 100;
  const ratios = [
    1 - signals.missingLocality / total,
    1 - signals.missingSex / total,
    1 - signals.missingChip / total,
    1 - signals.orphans / total,
    1 - signals.dormant / total,
  ];
  const mean = ratios.reduce((sum, r) => sum + r, 0) / ratios.length;
  return Math.round(mean * 100);
}

/**
 * Score, sort (best first, alphabetical ties) and rank the visible provinces.
 */
export function rankProvinceQuality(
  rows: Array<ProvinceDataQualitySignals & { province: string }>,
): ProvinceDataQualityRow[] {
  return rows
    .map((row) => ({ ...row, score: computeQualityScore(row) }))
    .sort((a, b) => b.score - a.score || a.province.localeCompare(b.province, "es"))
    .map((row, i) => ({ ...row, rank: i + 1 }));
}

// ---------------------------------------------------------------------------
// DB fetcher
// ---------------------------------------------------------------------------

/**
 * Per-province data-quality signals in one GROUP BY query, k-anon-suppressed
 * and ranked. Admin-only surface (the page guards with requireAdminOrRedirect);
 * the ProjectionContext is accepted for period awareness (dormancy cutoff is
 * anchored to ctx.period.until, mirroring registryCounts).
 */
export async function fetchProvinceDataQuality(
  ctx: ProjectionContext,
  dormantMonths: number = DORMANT_MONTHS_DEFAULT,
): Promise<ProvinceDataQualityResult> {
  // Dormancy cutoff — same anchor + ISO-string binding as registryCounts
  // (a raw JS Date inside sql`` crashes postgres-js with prepare:false).
  const dormancyCutoff = new Date(ctx.period.until);
  dormancyCutoff.setMonth(dormancyCutoff.getMonth() - dormantMonths);
  const dormancyCutoffIso = dormancyCutoff.toISOString();

  // Signal definitions — verbatim mirrors of fetchDataQuality / registryCounts.
  const hasActiveChip = sql`EXISTS (
    SELECT 1 FROM pet_identifications pi
    WHERE pi.pet_id = ${pets.id}
      AND pi.kind = 'microchip_iso'
      AND pi.status = 'active'
  )`;
  const hasOwnership = sql`EXISTS (
    SELECT 1 FROM ownerships o
    WHERE o.pet_id = ${pets.id}
  )`;
  const hasRecentOwnerActivity = sql`EXISTS (
    SELECT 1 FROM pet_events pe
    WHERE pe.pet_id = ${pets.id}
      AND pe.event_type <> 'credential_scanned'
      AND pe.occurred_at >= ${dormancyCutoffIso}
  )`;
  const hasReplacedIdentification = sql`EXISTS (
    SELECT 1 FROM pet_identifications pi
    WHERE pi.pet_id = ${pets.id}
      AND pi.status = 'replaced'
  )`;

  const rows = await db
    .select({
      province: pets.jurisdictionProvince,
      total: count(),
      missingLocality: sql<number>`COUNT(*) FILTER (WHERE ${pets.jurisdictionLocality} IS NULL)::int`,
      missingSex: sql<number>`COUNT(*) FILTER (WHERE ${pets.sex} = 'unknown')::int`,
      missingChip: sql<number>`COUNT(*) FILTER (WHERE NOT (${hasActiveChip}))::int`,
      orphans: sql<number>`COUNT(*) FILTER (WHERE NOT (${hasOwnership}))::int`,
      dormant: sql<number>`COUNT(*) FILTER (WHERE NOT (${hasRecentOwnerActivity}))::int`,
      ghosts: sql<number>`COUNT(*) FILTER (WHERE NOT (${hasOwnership}) AND NOT (${hasRecentOwnerActivity}))::int`,
      replacedChips: sql<number>`COUNT(*) FILTER (WHERE (${hasReplacedIdentification}))::int`,
    })
    .from(pets)
    .where(sql`${pets.status} IN ('active', 'lost')`)
    .groupBy(pets.jurisdictionProvince);

  const toSignals = (r: (typeof rows)[number]): ProvinceDataQualitySignals => ({
    total: r.total,
    missingLocality: Number(r.missingLocality),
    missingSex: Number(r.missingSex),
    missingChip: Number(r.missingChip),
    orphans: Number(r.orphans),
    dormant: Number(r.dormant),
    ghosts: Number(r.ghosts),
    replacedChips: Number(r.replacedChips),
  });

  // Honest residual: pets with no province cannot join any territorial row.
  const unassigned = rows.filter((r) => r.province === null).reduce((sum, r) => sum + r.total, 0);

  const named = rows
    .filter((r): r is typeof r & { province: string } => r.province !== null)
    .map((r) => ({ province: r.province, ...toSignals(r) }));

  // Suppression via the canonical boundary (lib/metrics/anonymity.ts), which
  // owns the floor — DATA_QUALITY_K_ANON exists only so the panel copy can NAME
  // the same number this call applies.
  const { suppressed, suppressedCount } = suppressSmallCells(named, {
    count: (r) => r.total,
    key: (r) => r.province,
  });
  const suppressedSet = new Set(suppressed.map((r) => r.province));
  const visible = named.filter((r) => !suppressedSet.has(r.province));

  return {
    rows: rankProvinceQuality(visible),
    suppressedProvinces: suppressedCount,
    unassigned,
  };
}
