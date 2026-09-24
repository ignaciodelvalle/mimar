// Real KPI fetchers for the /gob home dashboard (L-followup sprint).
//
// Each fetcher respects the viewer's jurisdiction scope:
//   admin  → universal (no WHERE clause on jurisdiction)
//   govt   → their assigned jurisdiction pairs only
//
// All fetchers accept a ProjectionContext (actor + scope + period) built via
// buildProjectionContext() from lib/metrics/. Scope and period primitives are
// single-sourced there; k-anonymity suppression is enforced by
// lib/metrics/anonymity.ts where applicable.

import { and, count, countDistinct, gte, inArray, lt, lte, not, sql } from "drizzle-orm";
import { eq } from "drizzle-orm";

// Heavy read-only analytics — routed through the ANALYTICS pool (session
// pooler in production; see db/index.ts, task #74 dual-pool split).
import { cases, analyticsDb as db, petEvents, pets, welfareReports } from "@/db";
import {
  type ProjectionContext,
  TARGETS,
  censusEligibleProvince,
  computeCensusCoverage,
  dogsInScopeCondition,
  getCensusPopulationsCached,
  jurisdictionPairClause,
  petsScopeClause,
  rabiesDoseQualifies,
  rabiesSignedByMatriculaCondition,
  withoutSyntheticRows,
} from "@/lib/metrics";
import { openObservationStatusSql } from "@/lib/metrics/observation-status";
import { TERMINAL_STATUSES as WELFARE_TERMINAL_STATUSES } from "@/src/modules/welfare/domain/welfare-status-rules";

// Re-export types so callers that import from this module don't need to change.
export type { DashboardActor, DashboardJurisdiction, ProjectionContext } from "@/lib/metrics";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Internal scope helpers (table-specific — not in lib/metrics)
// ---------------------------------------------------------------------------

// Scope clause for cases rows (uses cases.jurisdictionProvince/Locality).
function casesScopeClause(ctx: ProjectionContext) {
  // T1-P1: synthetic rows ride out with the scope (lib/metrics/scope.ts).
  return withoutSyntheticRows(ctx.actor.role, "cases", jurisdictionOnlyCasesScopeClause(ctx));
}

function jurisdictionOnlyCasesScopeClause(ctx: ProjectionContext) {
  if (ctx.scope.kind === "global") {
    // Admin province drill-down: narrow to the selected province/locality.
    if (!ctx.adminProvince) return null;
    if (ctx.adminLocality) {
      return and(
        eq(cases.jurisdictionProvince, ctx.adminProvince),
        eq(cases.jurisdictionLocality, ctx.adminLocality),
      );
    }
    return eq(cases.jurisdictionProvince, ctx.adminProvince);
  }
  const { jurisdictions } = ctx.scope;
  if (jurisdictions.length === 0) return sql`false`;
  // Route through the shared clause so a WHOLE-PROVINCE assignment subsumes every
  // locality/barrio in it (critique of PR #762, finding 7) — the inline exact-pair
  // build here was NOT covered by 7a17ec97's subsumption fix.
  return (
    // synthetic: covered — casesScopeClause wraps this with withoutSyntheticRows.
    jurisdictionPairClause(
      jurisdictions,
      sql`${cases.jurisdictionProvince}`,
      sql`${cases.jurisdictionLocality}`,
    ) ?? sql`false`
  );
}

// Pets-table jurisdiction scope for pet_events reads that do NOT join pets.
//
// This is the PRIMARY jurisdiction scope for non-outbreak event fetchers, wrapped
// in an EXISTS subquery so callers stay join-free. It replaces the payload-snapshot
// scope (petEventsScopeClause): the payload pet_jurisdiction_* fields are written by
// ONLY outbreak_signal, so applying the payload scope to vaccination/incident/
// disease events evaluated to `false` for every scoped-govt row and returned ZERO
// results (the "ghost-payload" bug). Scoping by the pet's CURRENT jurisdiction fixes
// that and also closes the payload-drift hole a moved pet used to leave open
// (scope-security review 2026-07-04 A2).
//
// Covers all scope kinds via petsScopeClause: govt → OR of pets.jurisdiction_*
// pairs; admin province drill-down → the selected-province predicate; admin
// universal → null (no restriction).
function petsCurrentJurisdictionGuard(ctx: ProjectionContext) {
  const scope = petsScopeClause(ctx);
  if (!scope) return null;
  return sql`EXISTS (SELECT 1 FROM ${pets} WHERE ${pets.id} = ${petEvents.petId} AND (${scope}))`;
}

// Scope clause for welfare_reports rows.
function welfareReportsScopeClause(ctx: ProjectionContext) {
  // T1-P1: synthetic rows ride out with the scope (lib/metrics/scope.ts).
  return withoutSyntheticRows(
    ctx.actor.role,
    "welfareReports",
    jurisdictionOnlyWelfareReportsScopeClause(ctx),
  );
}

function jurisdictionOnlyWelfareReportsScopeClause(ctx: ProjectionContext) {
  if (ctx.scope.kind === "global") {
    // Admin province drill-down: narrow to the selected province/locality.
    if (!ctx.adminProvince) return null;
    if (ctx.adminLocality) {
      return and(
        eq(welfareReports.jurisdictionProvince, ctx.adminProvince),
        eq(welfareReports.jurisdictionLocality, ctx.adminLocality),
      );
    }
    return eq(welfareReports.jurisdictionProvince, ctx.adminProvince);
  }
  const { jurisdictions } = ctx.scope;
  if (jurisdictions.length === 0) return sql`false`;
  // Whole-province subsumption via the shared clause (critique of PR #762, finding 7).
  return (
    // synthetic: covered — welfareReportsScopeClause wraps this with withoutSyntheticRows.
    jurisdictionPairClause(
      jurisdictions,
      sql`${welfareReports.jurisdictionProvince}`,
      sql`${welfareReports.jurisdictionLocality}`,
    ) ?? sql`false`
  );
}

// ---------------------------------------------------------------------------
// KPI 1 — Rabies vaccination coverage
// ---------------------------------------------------------------------------

/**
 * Canonical es-AR label for this KPI — DOGS ONLY, trailing 12 months.
 *
 * DISAMBIGUATION (critique-govt-2026-07-03.md, "Same metric, different
 * numbers" — 42% here vs 54% under the same old label elsewhere): this KPI is
 * DISTINCT from RABIES_VACCINATION_RATE_LABEL_ES (lib/analytics/govt-dashboards.ts),
 * which counts ALL species with no time window. Full numerator/denominator
 * breakdown of both lives in lib/metrics/kpi-catalog.ts
 * (rabies_coverage_dogs_12m vs rabies_vaccination_rate_all_species).
 *
 * FOLLOW-UP (render-site, out of this module's lane): app/gob/page.tsx and
 * src/modules/panorama/application/get-panorama-kpis.ts currently render this
 * KPI's label as a JSX/object literal, not by importing this constant — a
 * later pass should have them import RABIES_COVERAGE_LABEL_ES instead of
 * repeating the string.
 */
export const RABIES_COVERAGE_LABEL_ES = "Cobertura antirrábica — perros (12 meses)";

export type RabiesCoverageKpi = {
  /**
   * % of dogs in scope with ≥1 rabies vaccination event in the last 12 months.
   * DENOMINATOR: the REGISTRY (registered/active dogs), i.e. `registryDenominator`.
   */
  current: number;
  /** Public-health target — the flat TARGETS.RABIES_COVERAGE_PCT default, or
   *  the jurisdiction-resolved value when the caller injected one (ADR-8). */
  target: number;
  /** Number of distinct localities in scope with ≥1 dog. */
  partidos: number;
  /** True when the scope contains ≥1 dog; false means "no population yet". */
  hasData: boolean;
  /**
   * The FIRST (registry) denominator of `current`: active/lost dogs in scope.
   * Naming it turns "41,3%" into "41,3% de los 12.480 perros del padrón".
   */
  registryDenominator: number;
  /**
   * The SECOND (census) denominator: the ESTIMATED canine population for the
   * scope (human census × ESTIMATED_DOGS_PER_INHABITANT). `null` when no census
   * row covers the scope — callers then show only the registry denominator plus
   * a "sin estimación censal" note. NOT a hard count; always label it "estimada".
   */
  censusDenominator: number | null;
  /**
   * Registry-growth KPI: `registryDenominator / censusDenominator × 100`, one
   * decimal — "el padrón cubre X% de la población canina estimada". `null` when
   * no census estimate is available. This is the pilot's adoption curve, not a
   * vaccination figure.
   */
  censusCoveragePct: number | null;
  /**
   * WHY `censusCoveragePct` is null — `null` when it is not null.
   *
   * The two absences read identically on a tile ("Sin estimación censal") and
   * mean different things (demo review 2026-08-01, and the same
   * distinguish-your-empty-states rule the briefing empty state follows):
   *
   *   - "grain-mismatch": a census row exists, but it describes a WHOLE
   *     province and this view does not (a partial-province mandate, a
   *     locality drill, or the national aggregate). Dividing anyway is how a
   *     5-barrio operator got "0,1%" against all of CABA's estimated canine
   *     population. Nothing is missing from the database; the question just
   *     cannot be answered at this scale.
   *   - "no-census-row": the view IS one whole province and that province has
   *     no `jurisdictions_census` row — genuinely missing reference data.
   *
   * OPTIONAL on purpose: the Panorama fan-out builds RabiesCoverageKpi values
   * in its own tests, and a render site must degrade to the SAFER reading
   * ("not answerable at this scale") when the reason is absent — never to
   * "this province has no census row", which asserts a data gap.
   */
  censusUnavailableReason?: "grain-mismatch" | "no-census-row" | null;
  /**
   * DUAL-LENS disclosure (T1, PO decision 2026-07): of the dogs counted in
   * `current`, how many hold a dose SIGNED by a matriculated vet
   * (rabiesSignedByMatriculaCondition). ALWAYS computed — independent of
   * ctx.verifiedOnly. The declared `current` stays the headline (DIM is a
   * self-declared registry by design); this is disclosure, never a replacement.
   */
  signedCount: number;
  /** signedCount / registryDenominator × 100, 1 decimal (0 when no dogs). */
  signedPct: number;
};

/**
 * KPI: rabies_coverage_dogs_12m (see lib/metrics/kpi-catalog.ts)
 *
 * NUMERATOR:   COUNT DISTINCT dogs with ≥1 vaccination_administered event
 *              whose vaccine_name matches /(antirr[áa]bica|rabies)/i (accent-
 *              aware, amendment-overlay-aware) that is CURRENTLY VALID as of
 *              ctx.period.until: `until <= next_due_at` when the dose sets an
 *              explicit expiry, else the trailing-12m proxy (occurred_at within
 *              12 months ending at ctx.period.until). See rabiesCurrentlyValidCondition
 *              (lib/metrics/rabies.ts) — issue #52.
 * DENOMINATOR: COUNT active/lost dogs (pets.species = 'dog') in scope.
 * SOURCE:      pets, pet_events (vaccination_administered).
 * CADENCE:     FIXED trailing 12 months ending at ctx.period.until — the window
 *              is INTRINSIC to the metric (annual rabies vaccination, Ley 22.953),
 *              NOT the caller's display period. See the since12m note below.
 * SUPPRESSION: none.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
export async function fetchRabiesCoverage(
  ctx: ProjectionContext,
  sharedDenom?: RabiesDenominator,
  // ADR-8 (jurisdiction-compliance WU4b): gob RSC callers may inject the
  // jurisdiction-resolved rabies target (resolveJurisdictionTargets); the flat
  // TARGETS default keeps every legacy/national caller byte-identical (JT5 —
  // admin + Panorama stay national).
  targetPct: number = TARGETS.RABIES_COVERAGE_PCT,
): Promise<RabiesCoverageKpi> {
  if (ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0) {
    return {
      current: 0,
      target: targetPct,
      partidos: 0,
      hasData: false,
      registryDenominator: 0,
      censusDenominator: null,
      censusCoveragePct: null,
      // No jurisdictions at all — no province row can describe this view.
      censusUnavailableReason: "grain-mismatch",
      signedCount: 0,
      signedPct: 0,
    };
  }

  // The numerator window is a FIXED 12 months ending at ctx.period.until, NOT
  // ctx.period.since. Rabies coverage is definitionally "share of dogs with a
  // valid (annual) rabies vaccine" — the 12-month window is intrinsic to the
  // metric (Ley 22.953), not a display choice. Before this, the numerator used
  // ctx.period.since, so a caller with a shorter display window (e.g. the
  // Panorama console's 90-day "cumplimiento" preset) computed coverage over 90
  // days — yielding 11% under the SAME "(perros, 12m)" label the /gob Panel
  // rendered as 42% over a true trailing-12m window (val-2-govt B1). Anchoring
  // to `until` keeps the metric period-aware for the time-scrubber's as-of view
  // and the period-over-period delta (prior window ends at period.since) while
  // guaranteeing every surface computes the SAME 12-month coverage.
  const coverageUntil = ctx.period.until;
  const since12m = new Date(coverageUntil.getTime() - 365 * DAY_MS);

  // vaccination_administered carries no payload jurisdiction snapshot — scope by
  // the pet's HOME jurisdiction (petsScopeClause) against the pets INNER JOIN
  // below. petEventsScopeClause here was the ghost-payload bug (evaluated to
  // `false` for every scoped-govt row). petsScopeClause covers govt AND the admin
  // province drill-down.
  const petsScope = petsScopeClause(ctx);

  // Distinct dogs with a rabies vaccination event in scope, last 12 months.
  // vaccination_administered payload carries `vaccine_name`. Match the SAME
  // accent-aware regex the surveillance module uses
  // (~* '(antirr[áa]bica|rabies)'), NOT ILIKE '%rabi%': ILIKE is
  // accent-SENSITIVE, so it silently MISSED the canonical form name
  // "Antirrábica" (the accented á breaks the 'rabi' substring) and
  // undercounted coverage to ~zero. Keeping the same regex as
  // surveillance-repository.ts keeps "is a rabies vaccine" consistent.
  // Name AND expiry both read through the amendment overlay, in one lateral
  // probe (rabiesDoseQualifies): a corrected vaccine counts with its CURRENT
  // name (projection-cron audit 2026-07-03 A2) and a corrected booster date
  // counts from its CURRENT value (review 2026-08-22, M6 — the date used to be
  // read raw, so a dog could read "vencida" to its owner and covered here).
  // "Currently valid" (issue #52): a dose with an explicit next_due_at counts
  // only while `until <= next_due_at`; a dose without next_due_at falls back to
  // the trailing-12m proxy. Replaces the plain occurred_at BETWEEN since12m/until
  // so an expired-but-recent dose no longer counts and a still-valid old dose does.
  const rabiesVaccConditions = [
    eq(petEvents.eventType, "vaccination_administered"),
    rabiesDoseQualifies(
      {
        id: sql`${petEvents.id}`,
        payload: sql`${petEvents.payload}`,
        occurredAt: sql`${petEvents.occurredAt}`,
      },
      { since: since12m, until: coverageUntil },
    ),
  ];
  // Panorama "solo firmado por matrícula" narrowing (task #78 Part 3): when set,
  // count ONLY vet-signed doses via the SHARED predicate so this national
  // numerator matches the choropleth's signed-only definition exactly. Numerator-
  // only — scope/k-anon/auth are untouched.
  if (ctx.verifiedOnly) {
    rabiesVaccConditions.push(
      rabiesSignedByMatriculaCondition(
        sql`${petEvents.authorRole}`,
        sql`${petEvents.authorVerified}`,
      ),
    );
  }
  // Jurisdiction scope on the pet's home columns (petsScopeClause already emits
  // the whole-province subsumption via jurisdictionPairClause). Covers govt and
  // the admin province drill-down; admin-universal → null.
  if (petsScope) rabiesVaccConditions.push(sql`(${petsScope})`);
  // Scope to dogs only by joining pets.
  rabiesVaccConditions.push(sql`${pets.species} = ${"dog"}`);
  // NUMERATOR ⊆ DENOMINATOR. The denominator (dogsInScopeCondition,
  // lib/metrics/population.ts) is `status IN ('active','lost')` — it excludes
  // deceased dogs. This numerator used to omit the status filter entirely, so a
  // dog vaccinated and later dead kept counting on top while dropping out of
  // the bottom: the flagship rabies-coverage figure ran high, and in a small
  // jurisdiction it could exceed 100% outright (1 live unvaccinated + 1 dead
  // vaccinated → 1/1 = 100%; add a live vaccinated → 2/1 = 200%). There is no
  // LEAST(…,100) clamp downstream, and there should not be one: a rate over 100
  // is the symptom, not the disease. Sibling metrics already filter status
  // (fetchCrossJurisdictionOutliers via activeCond; the census identification
  // funnel documents this exact class at census.ts:594) — this KPI was the
  // inconsistent one.
  rabiesVaccConditions.push(sql`${pets.status} IN ('active', 'lost')`);

  // Numerator: distinct dog petIds with a qualifying rabies vax event (join pets
  // to filter species). The DENOMINATOR (total dogs + partidos + census
  // population) is scope-only — period- AND verifiedOnly-independent — so the
  // panorama fan-out computes it ONCE and shares it across the current / prior /
  // verified calls (qw#4). /gob home passes no sharedDenom, so
  // fetchRabiesDenominator runs concurrently with the numerator here — same
  // parallelism as before, no regression.
  // DUAL-LENS (T1): the signed sub-count rides the SAME query as a FILTER arm —
  // no extra round-trip. Under ctx.verifiedOnly the base conditions already
  // require the signature, so signed === n (the lenses collapse, still honest).
  const [vaccDogRows, denom] = await Promise.all([
    db
      .select({
        n: countDistinct(petEvents.petId),
        signed:
          sql<number>`count(distinct ${petEvents.petId}) filter (where ${rabiesSignedByMatriculaCondition(
            sql`${petEvents.authorRole}`,
            sql`${petEvents.authorVerified}`,
          )})`.mapWith(Number),
      })
      .from(petEvents)
      .innerJoin(pets, eq(pets.id, petEvents.petId))
      .where(and(...rabiesVaccConditions)),
    sharedDenom ? Promise.resolve(sharedDenom) : fetchRabiesDenominator(ctx),
  ]);

  const totalDogs = denom.totalDogs;
  const vaccinatedDogs = vaccDogRows[0]?.n ?? 0;
  const signedDogs = vaccDogRows[0]?.signed ?? 0;
  // One-decimal precision (Math.round(x*1000)/10), NOT a bare integer: a
  // coverage of 41.9% must survive to the display as 41,9% instead of being
  // truncated to 41% at the fetcher (KPI precision audit 2026-07-07). Matches
  // the 1-decimal convention of coverageRate() and fetchBitesPer10k.
  const current = totalDogs === 0 ? 0 : Math.round((vaccinatedDogs / totalDogs) * 1000) / 10;

  // Second (census) denominator: registered dogs / estimated canine population.
  // computeCensusCoverage returns null when no census row covers the scope, so
  // the display degrades to "sin estimación censal" instead of a fabricated %.
  //
  // H-2 (fresh-review 2026-07-18): this census denominator divides a
  // scope-narrowed dog count (dogsCondition honors the locality) by the
  // WHOLE-province human census (fetchCensusPopulation sums province rows —
  // jurisdictions_census is province-grain only), so at sub-province grain
  // censusCoveragePct is understated by the same province/locality ratio as the
  // H1 bites rate (~13× for a CABA comuna). Suppress it there — never a
  // fabricated coverage. The registry coverage (`current`, a dogs/dogs ratio) is
  // grain-independent and stays honest at any grain.
  //
  // C3 (2026-07-22): gated on `censusEligibleProvince`, NOT `isSubProvincialScope`
  // — the eligibility question is "does the RESOLVED VIEW cover one whole
  // province?", not "is any single assignment sub-provincial?". A multi-barrio
  // govt whose view aggregates every one of their CABA barrios now gets the
  // CABA census row; a govt drilled to one specific barrio still does not.
  //
  // 2026-08-01: censusEligibleProvince now requires the view to cover a WHOLE
  // province (5 of 48 barrios is not CABA — see its docblock), and the two
  // ways this can come back null are reported separately so the tile can say
  // which one happened instead of one flat "sin estimación censal".
  const eligibleProvince = censusEligibleProvince(ctx);
  const census =
    eligibleProvince === null ? null : computeCensusCoverage(totalDogs, denom.censusPopulation);
  const censusUnavailableReason = census
    ? null
    : eligibleProvince === null
      ? ("grain-mismatch" as const)
      : ("no-census-row" as const);

  return {
    current,
    target: targetPct,
    partidos: denom.partidos,
    hasData: totalDogs > 0,
    registryDenominator: totalDogs,
    censusDenominator: census?.censusDenominator ?? null,
    censusCoveragePct: census?.censusCoveragePct ?? null,
    censusUnavailableReason,
    signedCount: signedDogs,
    // Same 1-decimal convention as `current` — and the same denominator, so the
    // two lenses are directly comparable on the tile.
    signedPct: totalDogs === 0 ? 0 : Math.round((signedDogs / totalDogs) * 1000) / 10,
  };
}

/**
 * The scope-only rabies-coverage denominator (perf audit 2026-07-19 qw#4): total
 * dogs, distinct partidos, and the census population. NONE depend on the period
 * or the verifiedOnly flag (dogsInScopeCondition is status+species+scope; census
 * is scope-only), so the panorama KPI fan-out — which calls fetchRabiesCoverage
 * 3× over the SAME scope (current, prior-window, matrícula-verified) — computes
 * this ONCE and passes it to all three, instead of recomputing byte-identical
 * denominator queries each time.
 */
export type RabiesDenominator = { totalDogs: number; partidos: number; censusPopulation: number };

export async function fetchRabiesDenominator(ctx: ProjectionContext): Promise<RabiesDenominator> {
  if (ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0) {
    return { totalDogs: 0, partidos: 0, censusPopulation: 0 };
  }
  const dogsCondition = dogsInScopeCondition(ctx);
  const [dogsRows, partidosRows, censusPopulation] = await Promise.all([
    db.select({ n: count() }).from(pets).where(dogsCondition),
    db
      .select({ n: countDistinct(pets.jurisdictionLocality) })
      .from(pets)
      .where(dogsCondition),
    fetchCensusPopulation(ctx),
  ]);
  return {
    totalDogs: dogsRows[0]?.n ?? 0,
    partidos: partidosRows[0]?.n ?? 0,
    censusPopulation,
  };
}

// ---------------------------------------------------------------------------
// KPI 1b — Rabies vaccination coverage, per province
// ---------------------------------------------------------------------------

export type RabiesCoverageByProvinceRow = {
  /** Province name as stored in pets.jurisdiction_province. */
  province: string;
  /** Coverage rate as a percentage (0–100): vaccinated dogs / total dogs * 100, rounded. */
  ratePct: number;
  /** Count of distinct vaccinated dogs in the province (numerator). */
  vaccinated: number;
  /** Total dogs in scope in the province (denominator). */
  total: number;
};

/**
 * Per-province rabies vaccination coverage.
 *
 * Mirrors `fetchRabiesCoverage` EXACTLY — same dogsCondition (species='dog' +
 * scope), same rabiesVaccConditions (regex-based accent-aware match), same 12m
 * window — but groups by `pets.jurisdiction_province` instead of aggregating
 * into a single national figure.
 *
 * Used by the Panorama choropleth to guarantee per-province rates are computed
 * with the same dogs-based denominator as the national KPI that the map links to.
 *
 * ratePct = total > 0 ? round(vaccinated / total * 100) : 0.
 */
/**
 * KPI: per-province breakdown of rabies_coverage_dogs_12m (see kpi-catalog.ts).
 * Same numerator/denominator/source/cadence as fetchRabiesCoverage, grouped by
 * pets.jurisdiction_province instead of aggregated nationally. SUPPRESSION: none.
 */
export async function fetchRabiesCoverageByProvince(
  ctx: ProjectionContext,
): Promise<RabiesCoverageByProvinceRow[]> {
  if (ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0) {
    return [];
  }

  // FIXED trailing-12m window ending at ctx.period.until — SAME anchoring as
  // fetchRabiesCoverage (the metric's 12-month window is intrinsic, not the
  // display period), so the choropleth per-province rates never diverge from
  // the national KPI tile under a shorter display window (val-2-govt B1).
  const coverageUntil = ctx.period.until;
  const since12m = new Date(coverageUntil.getTime() - 365 * DAY_MS);

  // Scope by the pet's HOME jurisdiction (petsScopeClause) against the pets INNER
  // JOIN below — vaccination_administered has no payload jurisdiction snapshot, so
  // petEventsScopeClause was the ghost-payload bug. Grouping is already by the pets
  // column (pets.jurisdictionProvince), so no display repoint is needed.
  const petsScope = petsScopeClause(ctx);
  const dogsCondition = dogsInScopeCondition(ctx);

  // Rabies vaccination event conditions — SAME shared predicate as
  // fetchRabiesCoverage (regex, not ILIKE, to match the accented canonical form
  // "Antirrábica"; amendment overlay over BOTH vaccine_name and next_due_at)
  // so the choropleth per-province rates never diverge from the national KPI.
  const rabiesVaccConditions = [
    eq(petEvents.eventType, "vaccination_administered"),
    rabiesDoseQualifies(
      {
        id: sql`${petEvents.id}`,
        payload: sql`${petEvents.payload}`,
        occurredAt: sql`${petEvents.occurredAt}`,
      },
      { since: since12m, until: coverageUntil },
    ),
  ];
  // Panorama "solo firmado por matrícula" narrowing (task #78 Part 3) — SAME
  // vet-signed clause as fetchRabiesCoverage so the per-province signed rates
  // never diverge from the national signed KPI. Numerator-only.
  if (ctx.verifiedOnly) {
    rabiesVaccConditions.push(
      rabiesSignedByMatriculaCondition(
        sql`${petEvents.authorRole}`,
        sql`${petEvents.authorVerified}`,
      ),
    );
  }
  // Jurisdiction scope on the pet's home columns (petsScopeClause already emits
  // the whole-province subsumption). Covers govt and the admin province drill-down.
  if (petsScope) rabiesVaccConditions.push(sql`(${petsScope})`);
  rabiesVaccConditions.push(sql`${pets.species} = ${"dog"}`);
  // Same numerator ⊆ denominator fix as the national KPI above — this is the
  // per-province twin that feeds the Panorama choropleth, so leaving it out
  // would make the map and the alerts table disagree for the same province.
  rabiesVaccConditions.push(sql`${pets.status} IN ('active', 'lost')`);

  // Per-province total dogs (same dogsCondition as the national KPI).
  const totalByProvince = await db
    .select({
      province: pets.jurisdictionProvince,
      n: count(),
    })
    .from(pets)
    .where(and(dogsCondition, sql`${pets.jurisdictionProvince} IS NOT NULL`))
    .groupBy(pets.jurisdictionProvince);

  // Per-province vaccinated dogs: distinct dog petIds with a qualifying rabies
  // vax event, grouped by the pet's province.
  const vaccinatedByProvince = await db
    .select({
      province: pets.jurisdictionProvince,
      n: countDistinct(petEvents.petId),
    })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(and(...rabiesVaccConditions, sql`${pets.jurisdictionProvince} IS NOT NULL`))
    .groupBy(pets.jurisdictionProvince);

  // Merge totals and vaccinated counts into per-province rows.
  const vaccinatedMap = new Map<string, number>(
    vaccinatedByProvince
      .filter((r): r is typeof r & { province: string } => r.province !== null)
      .map((r) => [r.province, r.n]),
  );

  return totalByProvince
    .filter((r): r is typeof r & { province: string } => r.province !== null)
    .map((r) => {
      const vaccinated = vaccinatedMap.get(r.province) ?? 0;
      const total = r.n;
      return {
        province: r.province,
        // 1-decimal precision (audit 2026-07-07) — same as the national KPI.
        ratePct: total > 0 ? Math.round((vaccinated / total) * 1000) / 10 : 0,
        vaccinated,
        total,
      };
    });
}

// ---------------------------------------------------------------------------
// KPI 2 — Sterilization metrics
// ---------------------------------------------------------------------------

export type SterilizationKpi = {
  /** sterilization_performed events in scope in the last 30 days. */
  count: number;
  /**
   * % change vs the prior 30-day window.
   * 0 when there were no sterilizations in the prior window (avoids Infinity).
   */
  deltaPct: number;
  /** Distinct author organizations for the current 30-day window. */
  orgs: number;
  /**
   * The prior 30-day window's raw count — the deltaPct's DENOMINATOR. C1
   * (2026-07-22): render sites need this raw number, not just the already-
   * computed deltaPct, to apply the unstableDeltaBase guard
   * (lib/metrics/presentation-guards.ts shouldSuppressDelta) — a delta
   * computed against a near-zero prior base (e.g. 1 → 0, "−100%") is not a
   * stable trend, and the guard can't tell that from deltaPct alone.
   */
  prevCount: number;
  /**
   * DUAL-LENS disclosure (T1): of the current-30d `count`, how many events were
   * authored by a matriculated vet (author_role='vet' AND author_verified —
   * rabiesSignedByMatriculaCondition, the single "signed" predicate). The
   * declared `count` stays the headline; this is disclosure alongside it.
   */
  signedCount: number;
  /** signedCount / count × 100, 1 decimal (0 when count is 0). */
  signedPct: number;
};

/**
 * KPI: sterilizations_per_month (see lib/metrics/kpi-catalog.ts)
 *
 * NUMERATOR:   COUNT sterilization_performed events in the trailing 30 days.
 * DENOMINATOR: n/a — flow count, not a ratio (prior-30d count is used only to
 *              compute deltaPct, not as a KPI denominator).
 * SOURCE:      pet_events (sterilization_performed).
 * CADENCE:     trailing 30 days vs prior 30 days.
 * SUPPRESSION: none.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
export async function fetchSterilizationMetrics(ctx: ProjectionContext): Promise<SterilizationKpi> {
  if (ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0) {
    return { count: 0, deltaPct: 0, orgs: 0, prevCount: 0, signedCount: 0, signedPct: 0 };
  }

  // "Esterilizaciones / mes" is a FIXED 30-day flow, ending at ctx.period.until —
  // the 30-day window is INTRINSIC to the label, NOT the caller's display period
  // (issue #58, the same label-vs-period divergence class as rabies coverage).
  // Before this the current window started at ctx.period.since, so a caller with a
  // wider display window (e.g. a 12-month ctx) counted MONTHS of sterilizations
  // under the "/ mes" label. Anchoring to `until` keeps it period-aware for an
  // as-of scrub while guaranteeing every surface computes the SAME 30-day count.
  const until = ctx.period.until;
  const since30d = new Date(until.getTime() - 30 * DAY_MS);
  const since60d = new Date(until.getTime() - 60 * DAY_MS);

  const baseConditions = [eq(petEvents.eventType, "sterilization_performed")];
  // Jurisdiction scope by the pet's CURRENT home jurisdiction. sterilization_performed
  // carries no payload jurisdiction snapshot, so the former petEventsScopeClause was
  // the ghost-payload bug (zeroed every scoped-govt count); the pets guard is the
  // correct scope and covers govt + admin drill-down (admin-universal → null).
  const petsGuard = petsCurrentJurisdictionGuard(ctx);
  if (petsGuard) baseConditions.push(petsGuard);

  // PF1 consolidation (2026-07-22, query-fan-out audit): all three arms are
  // the SAME table (petEvents) with the SAME base conditions
  // (eventType='sterilization_performed' + petsGuard) — current/prev only
  // differ by window, and orgs is a distinct-count over the SAME current
  // window. `COUNT(*) FILTER (WHERE …)` and `COUNT(DISTINCT … ) FILTER
  // (WHERE …)` are both valid Postgres aggregate forms, so all three collapse
  // into ONE query instead of three round-trips. Parity pinned in
  // __tests__/pf1-consolidation-parity.test.ts against an independently
  // written reference query over seeded fixtures.
  const until30Iso = until.toISOString();
  const since30dIso = since30d.toISOString();
  const since60dIso = since60d.toISOString();
  const rows = await db
    .select({
      current:
        sql<number>`count(*) filter (where ${petEvents.occurredAt} >= ${since30dIso} and ${petEvents.occurredAt} <= ${until30Iso})`.mapWith(
          Number,
        ),
      prev: sql<number>`count(*) filter (where ${petEvents.occurredAt} >= ${since60dIso} and ${petEvents.occurredAt} < ${since30dIso})`.mapWith(
        Number,
      ),
      orgs: sql<number>`count(distinct ${petEvents.authorOrganizationId}) filter (where ${petEvents.occurredAt} >= ${since30dIso} and ${petEvents.occurredAt} <= ${until30Iso})`.mapWith(
        Number,
      ),
      // DUAL-LENS (T1): vet-signed portion of the current window — one more
      // FILTER arm on the same consolidated query, no extra round-trip. The
      // "signed" predicate is the SHARED matrícula helper (rabies-named, but it
      // is the single definition of "signed by a matriculated vet").
      signed:
        sql<number>`count(*) filter (where ${petEvents.occurredAt} >= ${since30dIso} and ${petEvents.occurredAt} <= ${until30Iso} and ${rabiesSignedByMatriculaCondition(
          sql`${petEvents.authorRole}`,
          sql`${petEvents.authorVerified}`,
        )})`.mapWith(Number),
    })
    .from(petEvents)
    .where(and(...baseConditions));

  const currentCount = rows[0]?.current ?? 0;
  const prevCount = rows[0]?.prev ?? 0;
  // Use the centralized computeDeltaPct which rounds to one decimal and guards /0.
  // Re-imported inline to avoid circular dep — TARGETS is already imported from lib/metrics.
  const deltaPct =
    prevCount === 0 ? 0 : Math.round(((currentCount - prevCount) / prevCount) * 1000) / 10;

  const signedCount = rows[0]?.signed ?? 0;
  return {
    count: currentCount,
    deltaPct,
    orgs: rows[0]?.orgs ?? 0,
    prevCount,
    signedCount,
    signedPct: currentCount === 0 ? 0 : Math.round((signedCount / currentCount) * 1000) / 10,
  };
}

// ---------------------------------------------------------------------------
// KPI 3 — Bites per 10k population
// ---------------------------------------------------------------------------

export type BitesPer10kKpi = {
  /** Bite reports / (estimatedPopulation / 10_000), 1 decimal. */
  rate: number;
  /** rate minus the prior 12-month rate, 1 decimal. */
  delta: number;
  /** Raw count of incident_reported bite events in the last 12 months. */
  reports: number;
  /**
   * False when the viewer's RESOLVED VIEW has no eligible census province
   * (`censusEligibleProvince(ctx) === null` — C3, 2026-07-22): the census
   * denominator is province-grain only, so a per-10k rate would divide by a
   * population that does not honestly cover the view — understating it (~13×
   * for a single-barrio drill within CABA, the H1 finding). In that state the
   * tile shows the absolute `reports` count and hides the rate; `rate`/`delta`
   * are 0. Read this flag FIRST — a 0 rate here means "not publishable at this
   * grain", not "no incidence". Mirrors the map's percapitaEligibleFor at the
   * KPI strip.
   */
  percapitaEligible: boolean;
};

/**
 * Fetch the census-based population for the given jurisdictions.
 *
 * For admin (universal) scope: sum ALL rows in jurisdictions_census.
 * For scoped govt views: sum only the provinces present in the viewer's
 *   jurisdictions list (deduplicated — multiple localities in the same
 *   province count only once).
 *
 * Falls back to 0 when the table is empty or a province has no census row;
 * callers must guard against division by zero before using the result.
 */
async function fetchCensusPopulation(ctx: ProjectionContext): Promise<number> {
  if (ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0) return 0;

  // qw#5 (perf audit 2026-07-19): jurisdictions_census is a static 24-row INDEC
  // table; read it once per process (getCensusPopulationsCached) and sum in
  // memory instead of a fresh SUM query per call — this ran ~5× per /gob +
  // panorama fan-out over a 2-connection pool. Same EXACT-name match the old
  // eq/inArray used (no normalization), so an unmatched province still adds 0.
  const pops = await getCensusPopulationsCached();

  if (ctx.scope.kind === "global") {
    // Admin province drill-down: the selected province's census population; else
    // the national total for unrestricted admin.
    if (ctx.adminProvince) return pops[ctx.adminProvince] ?? 0;
    return Object.values(pops).reduce((total, p) => total + p, 0);
  }

  // Scoped: deduplicate to unique province names, then sum those populations.
  const uniqueProvinces = [...new Set(ctx.scope.jurisdictions.map((j) => j.province))];
  return uniqueProvinces.reduce((total, p) => total + (pops[p] ?? 0), 0);
}

/**
 * KPI: bites_per_10k (see lib/metrics/kpi-catalog.ts)
 *
 * NUMERATOR:   COUNT incident_reported events where payload.incident_type =
 *              'bite_inflicted', occurred_at in the trailing 12 months.
 * DENOMINATOR: jurisdictions_census.population (summed over scope) / 10,000.
 * SOURCE:      pet_events (incident_reported), jurisdictions_census.
 * CADENCE:     trailing 12 months vs prior 12 months.
 * SUPPRESSION: none.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
export async function fetchBitesPer10k(ctx: ProjectionContext): Promise<BitesPer10kKpi> {
  if (ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0) {
    return { rate: 0, delta: 0, reports: 0, percapitaEligible: true };
  }

  // "Mordeduras / 10k hab." is a FIXED trailing-12-month rate, ending at
  // ctx.period.until — the 12-month window is INTRINSIC to the metric (and to the
  // "últimos 12 meses" tooltip), NOT the caller's display period (issue #58, the
  // same divergence class as rabies coverage). Before this the current window
  // started at ctx.period.since, so the Panorama console — whose "cumplimiento"
  // preset commits ?period=90d — computed a 90-day bite rate under a tile that
  // reads "12 meses", while the /gob Panel (12m ctx) showed the true 12m rate.
  // Anchoring to `until` keeps it period-aware for an as-of scrub while every
  // surface computes the SAME 12-month rate.
  const until = ctx.period.until;
  const since12m = new Date(until.getTime() - 365 * DAY_MS);
  // Prior 12m window: the 12 months immediately before the current window.
  const since24m = new Date(until.getTime() - 730 * DAY_MS);

  const baseConditions = [
    eq(petEvents.eventType, "incident_reported"),
    sql`(${petEvents.payload}->>'incident_type') = ${"bite_inflicted"}`,
  ];
  // Jurisdiction scope by the pet's CURRENT home jurisdiction. incident_reported
  // carries no payload jurisdiction snapshot, so the former petEventsScopeClause was
  // the ghost-payload bug (zeroed every scoped-govt count); the pets guard is the
  // correct scope and covers govt + admin drill-down (admin-universal → null).
  const petsGuard = petsCurrentJurisdictionGuard(ctx);
  if (petsGuard) baseConditions.push(petsGuard);

  // PF1 consolidation (2026-07-22, query-fan-out audit): current/prev are the
  // SAME table + SAME base conditions (eventType + incident_type + petsGuard),
  // differing only by window — merged into ONE query with two `count(*)
  // FILTER` arms instead of two round-trips. Parity pinned in
  // __tests__/pf1-consolidation-parity.test.ts against an independently
  // written reference query over seeded fixtures.
  const untilIso = until.toISOString();
  const since12mIso = since12m.toISOString();
  const since24mIso = since24m.toISOString();
  const [rows, population] = await Promise.all([
    db
      .select({
        current:
          sql<number>`count(*) filter (where ${petEvents.occurredAt} >= ${since12mIso} and ${petEvents.occurredAt} <= ${untilIso})`.mapWith(
            Number,
          ),
        prev: sql<number>`count(*) filter (where ${petEvents.occurredAt} >= ${since24mIso} and ${petEvents.occurredAt} < ${since12mIso})`.mapWith(
          Number,
        ),
      })
      .from(petEvents)
      .where(and(...baseConditions)),
    fetchCensusPopulation(ctx),
  ]);

  const reports = rows[0]?.current ?? 0;
  const prevReports = rows[0]?.prev ?? 0;

  // Per-cápita honesty (H1): at sub-province grain the numerator is
  // locality-scoped (petsCurrentJurisdictionGuard) but fetchCensusPopulation can
  // only sum WHOLE-province census rows, so a rate would understate incidence by
  // the province/locality population ratio. Suppress the rate and expose only the
  // absolute count — the tile renders "N reportes" with no fabricated per-10k
  // value, mirroring the map's percapitaEligibleFor gate.
  //
  // C3 (2026-07-22): gated on `censusEligibleProvince` — "may this VIEW divide
  // by the census?" — not `isSubProvincialScope`'s "is any assignment
  // sub-provincial?". A multi-barrio govt whose EFFECTIVE view aggregates one
  // whole province is eligible; a single-locality drill (or a scope spanning
  // multiple provinces) is not. The numerator itself is unchanged either way —
  // this only decides whether the province census row may serve as ITS
  // denominator.
  if (censusEligibleProvince(ctx) === null) {
    return { rate: 0, delta: 0, reports, percapitaEligible: false };
  }

  // Guard: if no census row exists for this jurisdiction, rate is 0 rather than
  // throwing a division-by-zero. This keeps the KPI card functional even before
  // the census table is fully seeded in a new environment.
  const rate = population === 0 ? 0 : Math.round((reports / (population / 10_000)) * 10) / 10;
  const prevRate =
    population === 0 ? 0 : Math.round((prevReports / (population / 10_000)) * 10) / 10;
  const delta = Math.round((rate - prevRate) * 10) / 10;

  return { rate, delta, reports, percapitaEligible: true };
}

// ---------------------------------------------------------------------------
// KPI 4 — Active zoonosis
// ---------------------------------------------------------------------------

export type ActiveZoonosisKpi = {
  /** Total active zoonosis signals: open bite_incident cases + active rabies observations. */
  count: number;
  /** Pets with an OPEN rabies observation (rabies_observation_status IN
   *  'in_progress','window_expired_unclosed' — see lib/metrics/observation-status.ts). */
  rabies: number;
  /**
   * Leptospirosis cases — disease_reported events with disease='lepto'
   * in the last 30 days, scoped to the actor's jurisdiction(s).
   * Handoff P4-3.
   */
  lepto: number;
  /**
   * Hidatidosis cases — disease_reported events with disease='hidatidosis'
   * in the last 30 days, scoped to the actor's jurisdiction(s).
   * Handoff P4-3.
   */
  hidat: number;
  /**
   * Net change in opens vs the prior 7-day window (this week opens minus last
   * week opens for rabies_observation_started + open bite_incident cases).
   */
  deltaWeek: number;
};

/**
 * KPI: active_zoonosis_signals (see lib/metrics/kpi-catalog.ts)
 *
 * NUMERATOR:   COUNT DISTINCT pets with an active rabies observation
 *              (rabies_observation_status IN 'in_progress',
 *              'window_expired_unclosed') OR an open
 *              bite_incident case — deduplicated via UNION, not summed — PLUS
 *              COUNT disease_reported events (payload.disease='lepto', 30d)
 *              PLUS COUNT disease_reported events (payload.disease='hidatidosis', 30d).
 * DENOMINATOR: n/a — absolute count.
 * SOURCE:      pets, cases, pet_events (disease_reported, rabies_observation_started).
 * CADENCE:     rabies/bite components are a "now" snapshot; lepto/hidat are
 *              trailing 30 days.
 * SUPPRESSION: none.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
export async function fetchActiveZoonosis(ctx: ProjectionContext): Promise<ActiveZoonosisKpi> {
  if (ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0) {
    return { count: 0, rabies: 0, lepto: 0, hidat: 0, deltaWeek: 0 };
  }

  const now = ctx.period.until.getTime();
  const since7d = new Date(now - 7 * DAY_MS);
  const since14d = new Date(now - 14 * DAY_MS);
  const since30d = new Date(now - 30 * DAY_MS);

  const petsScope = petsScopeClause(ctx);
  const casesScope = casesScopeClause(ctx);

  // Event-based arms (disease_reported, rabies_observation_started) carry NO
  // payload jurisdiction snapshot — only outbreak_signal does. Scope them by the
  // pet's CURRENT home jurisdiction via the pets guard (EXISTS, no join needed);
  // the former payload scope was the ghost-payload bug that zeroed these counts
  // for scoped-govt viewers. The guard covers govt + admin drill-down (admin-
  // universal → null). The rabies-observation and open-bite arms below scope on
  // pets/cases columns directly, unchanged.
  const petsGuard = petsCurrentJurisdictionGuard(ctx);

  const leptoConditions = [
    eq(petEvents.eventType, "disease_reported"),
    sql`(${petEvents.payload}->>'disease') = ${"lepto"}`,
    gte(petEvents.occurredAt, since30d),
  ];
  if (petsGuard) leptoConditions.push(petsGuard);

  const hidatConditions = [
    eq(petEvents.eventType, "disease_reported"),
    sql`(${petEvents.payload}->>'disease') = ${"hidatidosis"}`,
    gte(petEvents.occurredAt, since30d),
  ];
  if (petsGuard) hidatConditions.push(petsGuard);

  // 1. Pets with active rabies observation (status column on pets table).
  //    Returned separately for the sub-label in the KPI tile ("X rabia").
  const rabiesConditions = [openObservationStatusSql()];
  if (petsScope) rabiesConditions.push(sql`(${petsScope})`);

  // 2. Deduplicated rabies+bite count: distinct pets that have EITHER an active
  //    rabies observation OR an open bite_incident case.
  //
  //    Math.max(rabies, biteCases) was incorrect: it assumed the two sets were
  //    fully nested, but a pet can appear in only one of them (e.g. a bite case
  //    opened before the vet triggers a rabies observation, or an obs still
  //    in_progress after the case closed). The correct dedup is a UNION of pet IDs
  //    from both sources followed by COUNT DISTINCT.
  //
  //    casesScope and petsScope are built with different column references
  //    (cases.jurisdiction* vs pets.jurisdiction*) — we build each WHERE arm
  //    separately and UNION the pet IDs before counting.
  const rabiesWhereFragments: ReturnType<typeof sql>[] = [sql`(${openObservationStatusSql()})`];
  if (petsScope) rabiesWhereFragments.push(sql`(${petsScope})`);
  const rabiesWhere = sql.join(rabiesWhereFragments, sql` AND `);

  // Build the bite-case WHERE fragment manually so we can embed it in raw SQL.
  const biteWhereFragments: ReturnType<typeof sql>[] = [
    sql`${cases.caseKind} = ${"bite_incident"}`,
    sql`${cases.status} = ${"open"}`,
  ];
  if (casesScope) biteWhereFragments.push(sql`(${casesScope})`);
  const biteWhere = sql.join(biteWhereFragments, sql` AND `);

  // 3. This week: rabies_observation_started events in scope.
  const startedThisWeekConditions = [
    eq(petEvents.eventType, "rabies_observation_started"),
    gte(petEvents.occurredAt, since7d),
  ];
  if (petsGuard) startedThisWeekConditions.push(petsGuard);

  // 4. Last week: rabies_observation_started events in the 7d window before that.
  const startedLastWeekConditions = [
    eq(petEvents.eventType, "rabies_observation_started"),
    gte(petEvents.occurredAt, since14d),
    lt(petEvents.occurredAt, since7d),
  ];
  if (petsGuard) startedLastWeekConditions.push(petsGuard);

  const [rabiesRows, deduplicatedBiteRabiesRows, thisWeekRows, lastWeekRows, leptoRows, hidatRows] =
    await Promise.all([
      db
        .select({ n: count() })
        .from(pets)
        .where(and(...rabiesConditions)),
      // Distinct pets in EITHER active-obs OR open-bite-case state.
      db.execute<{ n: string }>(sql`
        SELECT COUNT(DISTINCT pet_id)::text AS n FROM (
          SELECT id AS pet_id FROM pets WHERE ${rabiesWhere}
          UNION
          SELECT primary_pet_id AS pet_id FROM cases WHERE ${biteWhere} AND primary_pet_id IS NOT NULL
        ) combined
      `),
      db
        .select({ n: count() })
        .from(petEvents)
        .where(and(...startedThisWeekConditions)),
      db
        .select({ n: count() })
        .from(petEvents)
        .where(and(...startedLastWeekConditions)),
      db
        .select({ n: count() })
        .from(petEvents)
        .where(and(...leptoConditions)),
      db
        .select({ n: count() })
        .from(petEvents)
        .where(and(...hidatConditions)),
    ]);

  const rabies = rabiesRows[0]?.n ?? 0;
  const deduplicatedBiteRabies = Number(deduplicatedBiteRabiesRows[0]?.n ?? 0);
  const lepto = leptoRows[0]?.n ?? 0;
  const hidat = hidatRows[0]?.n ?? 0;
  // Total = deduplicated active-rabies-or-bite-case pets + disease report counts.
  const total = deduplicatedBiteRabies + lepto + hidat;

  const thisWeek = thisWeekRows[0]?.n ?? 0;
  const lastWeek = lastWeekRows[0]?.n ?? 0;
  const deltaWeek = thisWeek - lastWeek;

  return {
    count: total,
    rabies,
    lepto,
    hidat,
    deltaWeek,
  };
}

// ---------------------------------------------------------------------------
// KPI 4a/4b/4c — Decomposed zoonosis signals
// ---------------------------------------------------------------------------
//
// PO-ratified decomposition of the opaque "Zoonosis activas" composite
// (fetchActiveZoonosis above) into THREE legible, independently-counted signals.
// The composite summed dedup(active-rabies-obs ∪ open-bite-cases) + lepto + hidat
// into one number; the three fetchers below split it along its truest axes so an
// operator sees WHICH signal is moving, not one blended figure. Scope and window
// primitives are reused VERBATIM from fetchActiveZoonosis so each part scopes and
// windows identically to the composite it replaces.
//
// MAPPING vs the old composite:
//   - fetchOpenRabiesObservations → the composite's `rabies` arm (pets with
//     an open rabies_observation_status) plus its `deltaWeek` (net change in
//     rabies_observation_started opens vs the prior 7-day window).
//   - fetchOpenBiteCases          → the open-bite-case side of the composite's
//     dedup UNION (cases.case_kind='bite_incident' AND status='open'), now counted
//     on its own instead of merged with the rabies-obs pets.
//   - fetchNotifiedDiseases       → generalises the composite's lepto+hidat arms to
//     ALL disease_reported events in the trailing 30 days (the truest "enfermedades
//     notificadas" axis), keeping lepto/hidat as a sub-breakdown for continuity.

export type OpenRabiesObservationsKpi = {
  /** Pets with an OPEN rabies observation (status IN 'in_progress',
   *  'window_expired_unclosed') in scope. */
  count: number;
  /**
   * Net change in rabies_observation_started opens vs the prior 7-day window
   * (this week minus last week) — same delta the composite exposed as deltaWeek.
   */
  deltaWeek: number;
};

/**
 * KPI: open_rabies_observations (decomposed from active_zoonosis_signals).
 *
 * NUMERATOR:   COUNT pets whose rabies observation is still OPEN in scope —
 *              status IN ('in_progress','window_expired_unclosed'). The second
 *              value landed 2026-08-17: an observation whose window elapsed with
 *              no professional closure is unfinished, not finished.
 * DENOMINATOR: n/a — absolute count.
 * SOURCE:      pets (status), pet_events (rabies_observation_started, for the delta).
 * CADENCE:     "now" snapshot; deltaWeek compares this 7d vs the prior 7d of opens.
 * SUPPRESSION: none.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
export async function fetchOpenRabiesObservations(
  ctx: ProjectionContext,
): Promise<OpenRabiesObservationsKpi> {
  if (ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0) {
    return { count: 0, deltaWeek: 0 };
  }

  const now = ctx.period.until.getTime();
  const since7d = new Date(now - 7 * DAY_MS);
  const since14d = new Date(now - 14 * DAY_MS);

  // Snapshot count scopes on the pets column (petsScopeClause); the started-event
  // delta scopes by the pet's CURRENT home jurisdiction (petsGuard, EXISTS) — SAME
  // scope split fetchActiveZoonosis uses for these two arms.
  const petsScope = petsScopeClause(ctx);
  const petsGuard = petsCurrentJurisdictionGuard(ctx);

  const rabiesConditions = [openObservationStatusSql()];
  if (petsScope) rabiesConditions.push(sql`(${petsScope})`);

  const startedBaseConditions = [eq(petEvents.eventType, "rabies_observation_started")];
  if (petsGuard) startedBaseConditions.push(petsGuard);

  // PF1 consolidation (2026-07-22, query-fan-out audit): thisWeek/lastWeek are
  // the SAME table + SAME base conditions (eventType + petsGuard), differing
  // only by window — merged into ONE query with two `count(*) FILTER` arms.
  // rabiesRows stays a SEPARATE query — it reads a different table (pets, a
  // "now" snapshot column) with a different scope clause (petsScope, not
  // petsGuard), so it does not share this query's shape. Parity pinned in
  // __tests__/pf1-consolidation-parity.test.ts against an independently
  // written reference query over seeded fixtures.
  const since7dIso = since7d.toISOString();
  const since14dIso = since14d.toISOString();
  const [rabiesRows, eventRows] = await Promise.all([
    db
      .select({ n: count() })
      .from(pets)
      .where(and(...rabiesConditions)),
    db
      .select({
        thisWeek:
          sql<number>`count(*) filter (where ${petEvents.occurredAt} >= ${since7dIso})`.mapWith(
            Number,
          ),
        lastWeek:
          sql<number>`count(*) filter (where ${petEvents.occurredAt} >= ${since14dIso} and ${petEvents.occurredAt} < ${since7dIso})`.mapWith(
            Number,
          ),
      })
      .from(petEvents)
      .where(and(...startedBaseConditions)),
  ]);

  const thisWeek = eventRows[0]?.thisWeek ?? 0;
  const lastWeek = eventRows[0]?.lastWeek ?? 0;

  return {
    count: rabiesRows[0]?.n ?? 0,
    deltaWeek: thisWeek - lastWeek,
  };
}

export type OpenBiteCasesKpi = {
  /** Open bite-incident cases (cases.case_kind='bite_incident' AND status='open') in scope. */
  count: number;
};

/**
 * KPI: open_bite_cases (decomposed from active_zoonosis_signals).
 *
 * NUMERATOR:   COUNT cases where case_kind='bite_incident' AND status='open' in scope.
 * DENOMINATOR: n/a — absolute count.
 * SOURCE:      cases.
 * CADENCE:     "now" snapshot.
 * SUPPRESSION: none.
 *
 * Reuses casesScopeClause (whole-province subsumption) — the SAME clause the
 * composite built for the open-bite side of its dedup UNION.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
export async function fetchOpenBiteCases(ctx: ProjectionContext): Promise<OpenBiteCasesKpi> {
  if (ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0) {
    return { count: 0 };
  }

  const casesScope = casesScopeClause(ctx);
  const conditions = [eq(cases.caseKind, "bite_incident"), eq(cases.status, "open")];
  if (casesScope) conditions.push(sql`(${casesScope})`);

  const rows = await db
    .select({ n: count() })
    .from(cases)
    .where(and(...conditions));

  return { count: rows[0]?.n ?? 0 };
}

export type NotifiedDiseasesKpi = {
  /** All disease_reported events in the trailing 30 days in scope. */
  count: number;
  /** Sub-breakdown: leptospirosis reports within the same window. */
  lepto: number;
  /** Sub-breakdown: hidatidosis reports within the same window. */
  hidat: number;
  /**
   * Sub-breakdown: reports with `payload.disease = 'other'` within the same
   * window — the schema's third (and only other) enum value (see
   * `diseaseReported` in lib/events/event-schemas.ts: `disease` is
   * `enum(['lepto', 'hidatidosis', 'other'])`, so lepto + hidat + other is
   * ALWAYS exactly `count`, never less). Bug fix (qa-triage-2026-07-23,
   * finding #2): the /gob panel tile used to render only
   * "{lepto} lepto · {hidat} hidat." — dropping this arm silently made the
   * sub-line's total disagree with the headline `count` (e.g. count=2 shown
   * next to "0 lepto · 1 hidat.", the 1 'other' report invisible). Returning
   * `other` here lets the tile always reconcile numerator === sub-breakdown sum.
   */
  other: number;
};

/**
 * KPI: notified_diseases (decomposed from active_zoonosis_signals).
 *
 * NUMERATOR:   COUNT disease_reported events in the trailing 30 days in scope
 *              (ALL diseases: lepto + hidatidosis + other — the truest "enfermedades
 *              notificadas" axis). lepto/hidat/other are returned as a full
 *              sub-breakdown (never a partial one) so the tile's "X lepto · Y
 *              hidat. · Z otras" legend always sums back to `count`.
 * DENOMINATOR: n/a — absolute count.
 * SOURCE:      pet_events (disease_reported).
 * CADENCE:     trailing 30 days ending at ctx.period.until.
 * SUPPRESSION: none.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
export async function fetchNotifiedDiseases(ctx: ProjectionContext): Promise<NotifiedDiseasesKpi> {
  if (ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0) {
    return { count: 0, lepto: 0, hidat: 0, other: 0 };
  }

  const since30d = new Date(ctx.period.until.getTime() - 30 * DAY_MS);

  // disease_reported carries no payload jurisdiction snapshot — scope by the pet's
  // CURRENT home jurisdiction (petsGuard, EXISTS), SAME as the composite's lepto/hidat arms.
  const petsGuard = petsCurrentJurisdictionGuard(ctx);

  const conditions = [
    eq(petEvents.eventType, "disease_reported"),
    gte(petEvents.occurredAt, since30d),
  ];
  if (petsGuard) conditions.push(petsGuard);

  // Single pass: total + lepto/hidat/other sub-counts via conditional
  // aggregation. The three filters are mutually exclusive and exhaustive
  // (schema enum has exactly these 3 values), so lepto+hidat+other === total.
  const rows = await db
    .select({
      total: count(),
      lepto:
        sql<number>`count(*) filter (where (${petEvents.payload}->>'disease') = 'lepto')`.mapWith(
          Number,
        ),
      hidat:
        sql<number>`count(*) filter (where (${petEvents.payload}->>'disease') = 'hidatidosis')`.mapWith(
          Number,
        ),
      other:
        sql<number>`count(*) filter (where (${petEvents.payload}->>'disease') = 'other')`.mapWith(
          Number,
        ),
    })
    .from(petEvents)
    .where(and(...conditions));

  const row = rows[0];
  return {
    count: row?.total ?? 0,
    lepto: row?.lepto ?? 0,
    hidat: row?.hidat ?? 0,
    other: row?.other ?? 0,
  };
}

// ---------------------------------------------------------------------------
// KPI 5 — Open welfare reports (Denuncias ciudadanas)
// ---------------------------------------------------------------------------

// Statuses considered "terminal" — excluded from the active count. Sourced from
// the welfare domain's single TERMINAL_STATUSES (closed | invalid | duplicate) so
// spam/invalid denuncias do NOT inflate the "open denuncias" KPI. Before C4 this
// local copy omitted 'invalid', over-counting invalid reports as active.

export type OpenWelfareReportsKpi = {
  /** Count of welfare reports with a non-terminal status in scope (all-time backlog). */
  count: number;
  /**
   * Coherence primary (cowork QA H6/H1): reports CREATED within ctx.period
   * [since, until], moderation-visible, ANY status — the SAME population the
   * Panorama map bubbles and the Registros list show for the active period
   * (repository.loadDenunciasByUnit uses the identical createdAt-in-window +
   * moderation filter). Because it keys on ctx.period.until, an as-of scrub that
   * clamps `until` shrinks this count in lock-step with the map — unlike the
   * all-time `count` backlog, which is period-independent (shown as a labeled
   * secondary). This is the number that must EQUAL the map + list.
   */
  inPeriod: number;
};

/**
 * Returns the count of active (non-terminal) welfare reports for the viewer's
 * jurisdiction. Mirrors the scope pattern used by fetchWelfareMetrics in
 * lib/govt-dashboards.ts.
 */
/**
 * KPI: open_welfare_reports (see lib/metrics/kpi-catalog.ts)
 *
 * NUMERATOR:   COUNT welfare_reports rows where status NOT IN ('closed', 'invalid', 'duplicate').
 * DENOMINATOR: n/a — absolute count.
 * SOURCE:      welfare_reports.
 * CADENCE:     point-in-time snapshot.
 * SUPPRESSION: none.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
export async function fetchOpenWelfareReportsCount(
  ctx: ProjectionContext,
): Promise<OpenWelfareReportsKpi> {
  if (ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0) {
    return { count: 0, inPeriod: 0 };
  }

  const scope = welfareReportsScopeClause(ctx);

  // Backlog (secondary): all-time non-terminal work queue, period-independent.
  //
  // Moderation-visible, like every OTHER surface that shows this work. Flagged
  // rows awaiting admin review are hidden from /gob/maltrato and from
  // /gob/acciones (buildMaltratoListConditions, "2. Moderation exclusion"), so
  // counting them here inflated a funcionario's backlog with denuncias they
  // could neither see nor act on: the briefing read 31 while their own worklist
  // read 26, with nothing explaining the five (master test CIU, L-4).
  //
  // Note the `periodCondition` arm below ALREADY carries this predicate — the
  // two arms of this same fetcher disagreed about whether a flagged report
  // counts. This is the arm that was out of step, not the screens.
  const backlogCondition = and(
    not(inArray(welfareReports.status, [...WELFARE_TERMINAL_STATUSES])),
    sql`(${welfareReports.flaggedAt} IS NULL OR ${welfareReports.moderationResolvedAt} IS NOT NULL)`,
  );

  // In-period (primary): reports created within [since, until], moderation-visible,
  // ANY status — MIRRORS repository.loadDenunciasByUnit (the map + Registros
  // population) so the KPI, the bubbles and the list agree for the active period.
  const periodCondition = and(
    gte(welfareReports.createdAt, ctx.period.since),
    lte(welfareReports.createdAt, ctx.period.until),
    sql`(${welfareReports.flaggedAt} IS NULL OR ${welfareReports.moderationResolvedAt} IS NOT NULL)`,
  );

  // PF1 consolidation (2026-07-22, query-fan-out audit): backlog and in-period
  // are the SAME table (welfare_reports) scoped by the IDENTICAL `scope`
  // predicate — they differ only in the counted condition (status backlog vs.
  // created-at window + moderation visibility), so the shared scope moves to
  // the query's WHERE and each arm becomes a `count(*) FILTER` column instead
  // of a separate round-trip. Parity pinned in
  // __tests__/pf1-consolidation-parity.test.ts against an independently
  // written reference query over seeded fixtures.
  const rows = await db
    .select({
      backlog: sql<number>`count(*) filter (where ${backlogCondition})`.mapWith(Number),
      period: sql<number>`count(*) filter (where ${periodCondition})`.mapWith(Number),
    })
    .from(welfareReports)
    .where(scope ?? sql`true`);

  return { count: rows[0]?.backlog ?? 0, inPeriod: rows[0]?.period ?? 0 };
}

// ---------------------------------------------------------------------------
// KPI 6 — Bite escalation gap (C1 first consumer, red-team #6)
// ---------------------------------------------------------------------------
// A jurisdiction can show ZERO open rabies observations while carrying
// hundreds of unescalated bite reports — an empty observations queue reads
// as "controlado" when it may mean "sin escalar", not "sin riesgo" (S4: la
// ausencia de señal se confunde con ausencia de riesgo). This composes the
// TWO already-catalogued fetchers below (bites_per_10k, open_rabies_
// observations, see lib/metrics/kpi-catalog.ts) rather than a new query or
// a new definition — it just pairs their existing outputs for /gob/vigilancia.

export type BiteEscalationGapKpi = {
  /** Reused from fetchBitesPer10k.reports — bite reports, trailing 12 months. */
  bites12m: number;
  /** Reused from fetchOpenRabiesObservations.count — 'now' snapshot. */
  openObservations: number;
};

/**
 * KPI: bite_escalation_gap (see lib/metrics/kpi-catalog.ts). NOT a ratio —
 * the two counts are independent populations shown as a pair, never divided.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
export async function fetchBiteEscalationGap(
  ctx: ProjectionContext,
): Promise<BiteEscalationGapKpi> {
  const [bites, observations] = await Promise.all([
    fetchBitesPer10k(ctx),
    fetchOpenRabiesObservations(ctx),
  ]);
  return { bites12m: bites.reports, openObservations: observations.count };
}
