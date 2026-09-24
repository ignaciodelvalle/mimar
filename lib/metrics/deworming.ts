// lib/metrics/deworming.ts — sanitary-coverage KPI: deworming coverage.
//
// Surfaces the `deworming_administered` event (previously reaching NO dashboard)
// as a coverage KPI alongside rabies and sterilization coverage on /gob/poblacion.
//
// Mirrors fetchSterilizationCoverage (lib/metrics/population-control.ts) EXACTLY —
// same EXISTS-on-the-pet-base pattern (numerator/denominator share one population,
// no fan-out) and the same per-province breakdown for the choropleth — but adds a
// FIXED trailing-12-month window on the event (deworming is periodic protection,
// not a once-ever milestone like sterilization).
//
// SCOPE: deworming_administered carries NO payload jurisdiction snapshot (only
// outbreak_signal does), so scope is by the pet's HOME jurisdiction via
// petsScopeClause against the pets table — never petEventsScopeClause (that would
// be the ghost-payload bug: `false` for every scoped-govt row).

import { and, count, countDistinct, eq, sql } from "drizzle-orm";

// Heavy read-only analytics — routed through the ANALYTICS pool (session pooler
// in production; see db/index.ts dual-pool split), same as the sibling fetchers.
import { analyticsDb as db, pets } from "@/db";

import type { ProjectionContext } from "./context";
import { activePetsCondition } from "./population";
import { coverageRate } from "./population-control";

const DAY_MS = 24 * 60 * 60 * 1000;

/** True when a govt actor has no assigned jurisdictions — queries return zeros. */
function isEmptyScope(ctx: ProjectionContext): boolean {
  return ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0;
}

export type ProvinceDewormingRow = {
  /** Province name as stored in pets.jurisdiction_province. */
  province: string;
  /** Deworming coverage rate (0–100). */
  ratePct: number;
  /** Count of active pets in the province with a deworming in the trailing 12m. */
  dewormed: number;
  /** Total active pets in the province (denominator). */
  total: number;
};

export type DewormingCoverageResult = {
  /**
   * Deworming coverage as a percentage (0–100): dewormed / total * 100, one
   * decimal. 0 when total is 0.
   */
  rate: number;
  /** Count of distinct active pets with ≥1 deworming_administered in the trailing 12m. */
  dewormed: number;
  /** Count of active/lost pets in scope (denominator). */
  total: number;
  /** Per-province breakdown. RAW — `total` (the denominator) and `ratePct` with no
   * k-anon applied. Its ONLY consumer today is the Panorama desparasitacion
   * province layer, which routes these rows through `provinceCell(…, total)` and
   * suppresses on the denominator — so nothing publishes them raw. That is a
   * property of the consumer, NOT an exemption: any new reader of these rows must
   * suppress. See the KNOWN GAP note on SterilizationCoverageResult.byProvince,
   * whose dashboard consumers do not. */
  byProvince: ProvinceDewormingRow[];
};

/**
 * KPI: deworming_coverage_population (see lib/metrics/kpi-catalog.ts)
 *
 * NUMERATOR:   COUNT DISTINCT active/lost pets with ≥1 deworming_administered
 *              event in the trailing 12 months ending at ctx.period.until.
 * DENOMINATOR: COUNT active/lost pets in scope (any species — deworming is not
 *              dog-specific).
 * SOURCE:      pets, pet_events (deworming_administered).
 * CADENCE:     FIXED trailing 12 months ending at ctx.period.until — the window
 *              is intrinsic to "currently covered" (periodic antiparasitic
 *              protection), NOT the caller's display period.
 * SUPPRESSION: none at this layer — byProvince is RAW and its consumer suppresses
 *              on the denominator via `provinceCell`. ("Province rows are never
 *              small enough" was the premise task #40 retired; do not restore it.)
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
export async function fetchDewormingCoverage(
  ctx: ProjectionContext,
  opts?: { species?: string },
): Promise<DewormingCoverageResult> {
  const empty: DewormingCoverageResult = { rate: 0, dewormed: 0, total: 0, byProvince: [] };
  if (isEmptyScope(ctx)) return empty;

  const activeCond = activePetsCondition(ctx);
  // Species narrows total/dewormed/byProvince identically (domain-axes work).
  // Undefined → populationCond === activeCond, byte-identical to before.
  const populationCond = opts?.species
    ? and(activeCond, eq(pets.species, opts.species))
    : activeCond;

  // Trailing 12 months ending at ctx.period.until. Bind the window bounds as ISO
  // strings — a raw JS Date interpolated into sql`` crashes postgres-js
  // (prepare:false); the comparison casts the ISO string to timestamptz.
  const until = ctx.period.until;
  const since12m = new Date(until.getTime() - 365 * DAY_MS);

  // An active pet is "dewormed" if it has ≥1 deworming_administered event inside
  // the trailing-12m window. EXISTS keeps numerator/denominator on the SAME pet
  // base (no fan-out) — mirrors fetchSterilizationCoverage / fetchMicrochipPenetration.
  const dewormedExists = sql`EXISTS (
    SELECT 1 FROM pet_events pe
    WHERE pe.pet_id = ${pets.id}
      AND pe.event_type = 'deworming_administered'
      AND pe.occurred_at >= ${since12m.toISOString()}
      AND pe.occurred_at <= ${until.toISOString()}
  )`;

  const [totalRows, dewormedRows, provinceRows] = await Promise.all([
    db.select({ n: count() }).from(pets).where(populationCond),

    db
      .select({ n: countDistinct(pets.id) })
      .from(pets)
      .where(and(populationCond, dewormedExists)),

    db
      .select({
        province: pets.jurisdictionProvince,
        total: count(),
        dewormed: sql<number>`count(*) FILTER (WHERE ${dewormedExists})::int`,
      })
      .from(pets)
      .where(populationCond)
      .groupBy(pets.jurisdictionProvince)
      .orderBy(sql`count(*) desc`),
  ]);

  const total = totalRows[0]?.n ?? 0;
  const dewormed = dewormedRows[0]?.n ?? 0;

  const byProvince: ProvinceDewormingRow[] = provinceRows
    .filter((r): r is typeof r & { province: string } => r.province !== null)
    .map((r) => ({
      province: r.province,
      total: r.total,
      dewormed: Number(r.dewormed),
      ratePct: coverageRate(Number(r.dewormed), r.total),
    }));

  return {
    rate: coverageRate(dewormed, total),
    dewormed,
    total,
    byProvince,
  };
}
