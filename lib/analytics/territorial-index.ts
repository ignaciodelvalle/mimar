// lib/analytics/territorial-index.ts — Jurisdiction composite index (Task #44.1).
//
// A per-province "how is this jurisdiction doing" score composed EXCLUSIVELY
// from the existing parity-guaranteed per-province rates produced by
// fetchCrossJurisdictionOutliers (lib/metrics/program-health.ts). No new KPI
// truth is defined here: this module only NORMALIZES and AVERAGES rates that
// already exist, against the targets that already govern them (lib/metrics/targets.ts).
//
// WEIGHTING (documented per Task #44 requirement)
// -----------------------------------------------
// Each component is converted to "target attainment":
//
//   attainment = min(100, rate / target * 100)
//
// i.e. a province at or above its programme target scores 100 for that
// component; below target it scores proportionally. The composite score is the
// UNWEIGHTED MEAN of the available attainments:
//
//   score = round(mean(attainment_i))
//
// Components (all sourced from fetchCrossJurisdictionOutliers):
//   - rabies        → RABIES_COVERAGE_PCT target        (sanitary coverage)
//   - sterilization → STERILIZATION_COVERAGE_PCT target (population control)
//   - microchip     → MICROCHIP_PENETRATION_PCT target  (identification)
//
// Equal weights are intentional: the three programmes are peers and no legal
// instrument ranks one above another. Change the weights ONLY with a PO
// decision, and document it here.
//
// K-ANONYMITY (inherited, not re-implemented)
// -------------------------------------------
// fetchCrossJurisdictionOutliers already skips provinces with < 5 active pets
// entirely, and omits the rabies component when a province has < 5 active dogs.
// A province can therefore appear with 2 of 3 components; `componentsUsed`
// discloses that so the UI can annotate partial scores instead of hiding them.
//
// RED LINE — Ley 25.326 / habeas data
// -----------------------------------
// This index scores TERRITORIES (provinces), never people. It consumes only
// population-level aggregate rates; no individual-level input exists anywhere
// in the pipeline.

import type { OutlierMetric, OutlierRow } from "@/lib/metrics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IndexComponent = {
  /** Observed coverage rate for the province (0–100, from OutlierRow.rate). */
  rate: number;
  /** Programme target the rate is normalized against (0–100). */
  target: number;
  /** min(100, rate / target * 100), rounded to one decimal. */
  attainment: number;
};

export type JurisdictionIndexRow = {
  /** Province display name (pets.jurisdiction_province canonical form). */
  province: string;
  /** Composite score 0–100 (unweighted mean of available attainments). */
  score: number;
  /** Per-component detail, keyed by the OutlierMetric it derives from. */
  components: Partial<Record<OutlierMetric, IndexComponent>>;
  /** How many of the 3 components were available (rabies may be k-anon-omitted). */
  componentsUsed: number;
  /** 1-based rank, highest score first. Ties broken alphabetically by province. */
  rank: number;
};

/** The metrics that participate in the composite, in display order. */
export const INDEX_COMPONENT_ORDER: readonly OutlierMetric[] = [
  "rabies",
  "sterilization",
  "microchip",
] as const;

// ---------------------------------------------------------------------------
// Pure computation (unit-tested, DB-free)
// ---------------------------------------------------------------------------

/** Normalize a rate to target attainment: min(100, rate/target*100), 1 decimal. */
export function targetAttainment(rate: number, target: number): number {
  if (target <= 0) return 0;
  return Math.min(100, Math.round((rate / target) * 1000) / 10);
}

/**
 * Fold the per-(province, metric) rows from fetchCrossJurisdictionOutliers
 * into one composite row per province, ranked highest-score first.
 *
 * Rows arrive already k-anon-filtered upstream; this function never sees
 * (and never needs) any small-cell data.
 */
export function computeJurisdictionIndex(rows: OutlierRow[]): JurisdictionIndexRow[] {
  const byProvince = new Map<string, Partial<Record<OutlierMetric, IndexComponent>>>();

  for (const row of rows) {
    const entry = byProvince.get(row.province) ?? {};
    entry[row.metric] = {
      rate: row.rate,
      target: row.target,
      attainment: targetAttainment(row.rate, row.target),
    };
    byProvince.set(row.province, entry);
  }

  const unranked = [...byProvince.entries()].map(([province, components]) => {
    const attainments = INDEX_COMPONENT_ORDER.filter((m) => components[m] !== undefined).map(
      (m) => (components[m] as IndexComponent).attainment,
    );
    const score =
      attainments.length === 0
        ? 0
        : Math.round(attainments.reduce((sum, a) => sum + a, 0) / attainments.length);
    return { province, components, componentsUsed: attainments.length, score };
  });

  return unranked
    .sort((a, b) => b.score - a.score || a.province.localeCompare(b.province, "es"))
    .map((row, i) => ({ ...row, rank: i + 1 }));
}

/**
 * The N LOWEST-scoring jurisdictions — the outlier tail of an already-computed
 * index, worst first.
 *
 * D-2 (Lote D, 2026-08-16): the /admin home had no compliance content at all.
 * The national portal owns the territorial index and the policy→outcome lens,
 * and asked its admin to go find them. This is the teaser that ends that: the
 * few provinces furthest from their programmatic targets, on the landing.
 *
 * PURE, and a REORDERING — never a recomputation. It takes the output of
 * `computeJurisdictionIndex` and returns a subset of those exact rows, `rank`
 * intact, so the teaser's "puesto 23 de 24" is literally the same rank the full
 * table on /admin/inteligencia shows. Re-deriving a private "worst" score here
 * would be a second opinion about the same question, which is the class of bug
 * the whole catalog/contract effort exists to prevent.
 *
 * `componentsUsed < 3` rows are KEPT, not dropped: a province whose rabies
 * component was k-anon-suppressed is still a real jurisdiction with a real
 * score, and hiding it would quietly bias the tail. The caller must disclose the
 * partial index, exactly as the full table's asterisk does.
 */
export function selectLowestScoringJurisdictions(
  rows: readonly JurisdictionIndexRow[],
  limit: number,
): JurisdictionIndexRow[] {
  if (limit <= 0) return [];
  // Sorted explicitly rather than by slicing computeJurisdictionIndex's tail:
  // the tail trick is correct only while the input happens to arrive best-first,
  // and a caller that filters or re-sorts upstream would silently get the wrong
  // provinces. The tiebreak follows `rank`, which already encodes the alphabetic
  // tiebreak the full table uses, so equal scores order identically on both.
  return [...rows].sort((a, b) => a.score - b.score || b.rank - a.rank).slice(0, limit);
}
