// lib/metrics/population-control.ts — Paquete G: control poblacional.
//
// Three async fetchers + one trend reuse built on ProjectionContext,
// scoped and period-aware:
//
//   fetchSterilizationCoverage(ctx)       → { rate, sterilized, total, byProvince }
//   fetchActivePregnancies(ctx)           → count of in-progress pregnancies
//   fetchReproductiveOutcomes(ctx)        → grouped counts by outcome + registeredBirths
//   fetchNetGrowth(ctx)                   → { altas, registeredBirths, deaths, net }
//   fetchSterilizationNatalidadRatio(ctx) → sterilizations/births in period (null if den=0)
//   fetchSterilizationTrend(ctx)          → reuses fetchKpiTrend("sterilization_performed", ctx)
//
// NATALIDAD CAVEAT (CRITICAL — MUST NOT BE REMOVED):
// --------------------------------------------------
// `registeredBirths` counts ONLY tracked pregnancies with
// `payload->>'pregnancy_phase' = 'ended'` AND `payload->>'outcome' = 'live_birth'`
// (i.e. pregnancies recorded via `recordPregnancyEndedAction` in the system).
// There is NO total-births event: street/untracked litters and callejero births
// are invisible. Therefore:
//   - netGrowth.net is DIRECTIONAL, NOT exact.
//   - sterilizationNatalidadRatio is DIRECTIONAL, NOT exact.
//   - Both systematically UNDER-COUNT natalidad (under-estimate births → over-
//     estimate containment). Operators must treat them as indicators, not absolutes.
//
// This caveat MUST appear in the UI as an info tooltip + a caveat sub line:
//   "Solo partos en seguimiento — subestima la natalidad real"
//
// PURE HELPERS (unit-tested, DB-free):
// -------------------------------------
// computeNetGrowth, safeRatio, coverageRate

import { and, count, countDistinct, eq, gte, lte, sql } from "drizzle-orm";

// Heavy read-only analytics — routed through the ANALYTICS pool (session
// pooler in production; see db/index.ts, task #74 dual-pool split).
import { analyticsDb as db, petEvents, pets } from "@/db";
import { amendedPayloadText } from "@/lib/infra/amendment-sql";

import type { ProjectionContext } from "./context";
import { activePetsCondition } from "./population";
import { planProvinceDisclosure } from "./province-disclosure";
import { petsScopeClause } from "./scope";
import type { SingleSeriesTrend } from "./trends";
import { fetchKpiTrend } from "./trends";

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable, DB-free)
// ---------------------------------------------------------------------------

/**
 * Compute net population growth over a period.
 *
 * Formula: altas + births − deaths.
 * The result can be negative (population is contracting).
 *
 * @param altas  - New registrations in the period.
 * @param births - Registered live births in the period (tracked pregnancies only).
 * @param deaths - Deaths recorded in the period.
 */
export function computeNetGrowth({
  altas,
  births,
  deaths,
}: {
  altas: number;
  births: number;
  deaths: number;
}): number {
  return altas + births - deaths;
}

/**
 * Safe ratio: numerator / denominator.
 * Returns null when denominator is 0 (no meaningful ratio).
 *
 * @param num - Numerator.
 * @param den - Denominator.
 */
export function safeRatio(num: number, den: number): number | null {
  if (den === 0) return null;
  return num / den;
}

/**
 * Sterilization coverage rate as a percentage (0–100).
 * Returns 0 when total is 0 (empty population → no coverage signal).
 *
 * @param sterilized - Count of sterilized active pets.
 * @param total      - Count of all active pets.
 */
export function coverageRate(sterilized: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((sterilized / total) * 1000) / 10;
}

// ---------------------------------------------------------------------------
// Shared guard
// ---------------------------------------------------------------------------

/** True when a govt actor has no assigned jurisdictions — all queries return zeros/empty. */
function isEmptyScope(ctx: ProjectionContext): boolean {
  return ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0;
}

// ---------------------------------------------------------------------------
// Sterilization coverage
// ---------------------------------------------------------------------------

/**
 * One province coverage row. A DISCRIMINATED UNION on `suppressed`, not
 * independent nullable fields: a consumer cannot reach `ratePct`/`total`/
 * `sterilized` without first proving the cell is published, which is what stops
 * a `?? 0` from publishing a confident zero. A withheld cell carries `null` in
 * every numeric field — protected values are ABSENT, never zero.
 *
 * All three numbers travel together on purpose: a rate published beside its base
 * leaks the numerator by multiplication, so withholding one and keeping the
 * others would be no protection at all.
 */
export type ProvinceSterlizationRow =
  | {
      /** Province name as stored in pets.jurisdiction_province. */
      province: string;
      suppressed: false;
      /** Sterilization coverage rate (0–100). */
      ratePct: number;
      /** Count of sterilized active pets in the province. */
      sterilized: number;
      /** Total active pets in the province (denominator). */
      total: number;
    }
  | {
      province: string;
      suppressed: true;
      ratePct: null;
      sterilized: null;
      total: null;
    };

export type SterilizationCoverageResult = {
  /**
   * Sterilization coverage rate as a percentage (0–100).
   * sterilized / total * 100, rounded to one decimal.
   * 0 when total is 0.
   */
  rate: number;
  /** Count of distinct active pets with ≥1 sterilization_performed event. */
  sterilized: number;
  /** Count of active/lost pets in scope (denominator). */
  total: number;
  /**
   * Per-province breakdown, already carrying the D.10 disclosure verdict
   * (`planProvinceDisclosure`): the operator's OWN provinces keep their real
   * numbers, foreign provinces with a sub-k `total` are withheld (all three
   * numeric fields null). Withheld rows are KEPT in the array so absence never
   * becomes the disclosure channel.
   *
   * The premise that used to justify raw rows here — "cell sizes are always
   * large enough to be non-identifying" — is the one task #40 retired: true of a
   * province's POPULATION, false of its DENOMINATOR, and this is a rate, so it
   * reveals its denominator.
   *
   * Deciding in the fetcher is what makes screen/export parity STRUCTURAL:
   * /admin/poblacion's ranked table, /gob/poblacion, /gob/poblacion/export and
   * the Panorama esterilizacion loader all read THESE rows, so none of them can
   * hold a raw value another one hides.
   */
  byProvince: ProvinceSterlizationRow[];
  /** Provinces withheld from `byProvince`. Every surface that renders those rows
   *  MUST announce this number — a hidden cell nobody mentions is worse than a
   *  published one. */
  byProvinceSuppressedCount: number;
  /** Σ `total` over ALL provinces (withheld included), or null when the withheld
   *  mass it exposes is itself under k. Feeds the "sin provincia asignada"
   *  footnote; render nothing when null. */
  byProvinceAssignedTotal: number | null;
  /**
   * FALSE ⇒ this screen/CSV must publish NO scope-wide aggregate: not `rate`,
   * not `sterilized`, not `total`, and not the sibling KPIs counted over the
   * same scope (preñeces, nacimientos, balance, ratio). RA-3 finding C1:
   * `/gob/padron?vista=poblacion&province=AR-V` printed "meta programática 70% ·
   * 1 de 3" beside a province row reading "suprimido por privacidad" — a rate
   * published next to its base gives up the numerator by multiplication, and a
   * single-province scope makes the base the withheld cell.
   *
   * Decided by the SAME `planProvinceDisclosure` call that decided `byProvince`,
   * so the screen and /gob/poblacion/export cannot disagree about the headline
   * any more than they can about a row. Render `scopeTotalSuppressionNotice`.
   */
  scopeTotalPublishable: boolean;
};

/**
 * Sterilization coverage: what fraction of active pets in scope have received
 * at least one sterilization_performed event?
 *
 * Numerator: COUNT(DISTINCT pets) WHERE EXISTS sterilization_performed event.
 * Uses the same EXISTS subquery pattern as fetchMicrochipPenetration in
 * lib/compliance-metrics.ts — guaranteed same denominator, no fan-out.
 *
 * byProvince: per-province coverage with the D.10 disclosure rule already
 * applied (own jurisdiction real, foreign sub-k withheld) — see
 * SterilizationCoverageResult.byProvince and ./province-disclosure.ts.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
/**
 * KPI: sterilization_coverage_population (see lib/metrics/kpi-catalog.ts)
 *
 * NUMERATOR:   COUNT DISTINCT active/lost pets with ≥1 sterilization_performed
 *              event, ever (no time window on the event itself).
 * DENOMINATOR: COUNT active/lost pets in scope.
 * SOURCE:      pets, pet_events (sterilization_performed).
 * CADENCE:     point-in-time snapshot ("ever sterilized", not "in period").
 * SUPPRESSION: k=5 on the per-province breakdown for provinces OUTSIDE the
 *              viewer's jurisdiction (D.10, planProvinceDisclosure), reported
 *              via `byProvinceSuppressedCount` — AND on the headline rate
 *              itself via `scopeTotalPublishable`. The old exemption here read
 *              "none on the headline rate (a whole-scope aggregate the operator
 *              is entitled to)": true nationally, FALSE the moment `?province=`
 *              narrows the scope to one unit, because then the whole-scope
 *              aggregate is that unit's cell (RA-3 finding C1).
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
export async function fetchSterilizationCoverage(
  ctx: ProjectionContext,
  opts?: { species?: string },
): Promise<SterilizationCoverageResult> {
  const empty: SterilizationCoverageResult = {
    rate: 0,
    sterilized: 0,
    total: 0,
    byProvince: [],
    byProvinceSuppressedCount: 0,
    byProvinceAssignedTotal: 0,
    scopeTotalPublishable: true,
  };
  if (isEmptyScope(ctx)) return empty;

  const activeCond = activePetsCondition(ctx);
  // Species narrows total/sterilized/byProvince identically (domain-axes work:
  // poblacion species filter). Undefined → populationCond === activeCond.
  const populationCond = opts?.species
    ? and(activeCond, eq(pets.species, opts.species))
    : activeCond;

  // An active pet is "sterilized" if it has ≥1 sterilization_performed event.
  // EXISTS keeps the numerator/denominator on the SAME pet base (no fan-out).
  // Mirrors fetchMicrochipPenetration EXACTLY (lib/compliance-metrics.ts).
  const sterilizedExists = sql`EXISTS (
    SELECT 1 FROM pet_events pe
    WHERE pe.pet_id = ${pets.id}
      AND pe.event_type = 'sterilization_performed'
  )`;

  const [totalRows, sterilizedRows, provinceRows] = await Promise.all([
    db.select({ n: count() }).from(pets).where(populationCond),

    db
      .select({ n: countDistinct(pets.id) })
      .from(pets)
      .where(and(populationCond, sterilizedExists)),

    // Per-province sterilized/total for choropleth.
    db
      .select({
        province: pets.jurisdictionProvince,
        total: count(),
        sterilized: sql<number>`count(*) FILTER (WHERE ${sterilizedExists})::int`,
      })
      .from(pets)
      .where(populationCond)
      .groupBy(pets.jurisdictionProvince)
      .orderBy(sql`count(*) desc`),
  ]);

  const total = totalRows[0]?.n ?? 0;
  const sterilized = sterilizedRows[0]?.n ?? 0;

  const rawProvinces = provinceRows
    .filter((r): r is typeof r & { province: string } => r.province !== null)
    .map((r) => ({
      province: r.province,
      total: r.total,
      sterilized: Number(r.sterilized),
    }));

  const disclosure = applyCoverageDisclosure(ctx, rawProvinces);

  return {
    rate: coverageRate(sterilized, total),
    sterilized,
    total,
    ...disclosure,
  };
}

/**
 * The pure half of `fetchSterilizationCoverage`'s province breakdown — raw rows
 * in, D.10 verdict out. Exported so the rule is unit-testable without Postgres
 * and so a test pins the SAME function production runs.
 */
export function applyCoverageDisclosure(
  ctx: ProjectionContext,
  raw: readonly { province: string; total: number; sterilized: number }[],
): Pick<
  SterilizationCoverageResult,
  "byProvince" | "byProvinceSuppressedCount" | "byProvinceAssignedTotal" | "scopeTotalPublishable"
> {
  // k protects the BASE (active pets), never the rate — the rate is the thing
  // the base makes safe to publish.
  const plan = planProvinceDisclosure(
    ctx,
    raw.map((r) => ({ province: r.province, denominator: r.total })),
  );

  const byProvince: ProvinceSterlizationRow[] = raw.map((r) =>
    plan.withheld.has(r.province)
      ? { province: r.province, suppressed: true, ratePct: null, sterilized: null, total: null }
      : {
          province: r.province,
          suppressed: false,
          total: r.total,
          sterilized: r.sterilized,
          ratePct: coverageRate(r.sterilized, r.total),
        },
  );

  return {
    byProvince,
    byProvinceSuppressedCount: plan.suppressedCount,
    byProvinceAssignedTotal: plan.publishableRowTotal,
    scopeTotalPublishable: plan.scopeTotalPublishable,
  };
}

// ---------------------------------------------------------------------------
// Active pregnancies
// ---------------------------------------------------------------------------

/**
 * Count of pets in scope with pregnancyStatus = 'in_progress'.
 *
 * Uses the denormalized pets.pregnancy_status column (D7 pattern: same as
 * pets.status for active/lost — authoritative at population scale).
 * Scope via petsScopeClause (jurisdiction filter on the pets table).
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
/**
 * KPI: active_pregnancies (see lib/metrics/kpi-catalog.ts)
 *
 * NUMERATOR:   COUNT active/lost pets WHERE pregnancy_status = 'in_progress'.
 * DENOMINATOR: n/a — absolute count.
 * SOURCE:      pets (denormalized pregnancy_status column).
 * CADENCE:     point-in-time snapshot.
 * SUPPRESSION: none.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
export async function fetchActivePregnancies(
  ctx: ProjectionContext,
  opts?: { species?: string },
): Promise<number> {
  if (isEmptyScope(ctx)) return 0;

  const activeCond = activePetsCondition(ctx);
  const conditions = [activeCond, eq(pets.pregnancyStatus, "in_progress")];
  if (opts?.species) conditions.push(eq(pets.species, opts.species));
  const rows = await db
    .select({ n: count() })
    .from(pets)
    .where(and(...conditions));

  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Reproductive outcomes
// ---------------------------------------------------------------------------

export type ReproductiveOutcomeKey =
  | "live_birth"
  | "stillbirth"
  | "miscarriage"
  | "termination"
  | "unknown";

export type ReproductiveOutcomes = {
  /** Counts per outcome from clinical_info_logged pregnancy-ended events in the period. */
  byClinicalOutcome: Record<ReproductiveOutcomeKey, number>;
  /**
   * Count of live-birth events in the period.
   *
   * NATALIDAD CAVEAT: this only counts TRACKED pregnancies recorded in the
   * system. Street/untracked litters are invisible. This number systematically
   * UNDER-COUNTS real natalidad and must be labelled as such in the UI:
   *   "Solo partos en seguimiento — subestima la natalidad real"
   */
  registeredBirths: number;
  /**
   * Optional sum of live_births_count payload field for tracked live-birth events.
   * When > 0 this is a better proxy for animals born than event count.
   * May be 0 if reporters did not fill in the count field.
   */
  liveBirthsCountSum: number;
};

/**
 * Counts of clinical_info_logged events with sub_kind='pregnancy' AND
 * pregnancy_phase='ended', grouped by outcome, in ctx period, scoped.
 *
 * Event payload shape (from app/actions/pregnancy.ts):
 *   { sub_kind: 'pregnancy', pregnancy_phase: 'ended', outcome: <key>, live_births_count: N|null }
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
/**
 * KPI: not yet in lib/metrics/kpi-catalog.ts (feeds sterilization_natalidad_ratio's
 * denominator — documented here directly, no cross-surface label ambiguity).
 *
 * NUMERATOR:   COUNT clinical_info_logged events (sub_kind='pregnancy',
 *              pregnancy_phase='ended'), grouped by payload.outcome.
 *              registeredBirths = the 'live_birth' bucket specifically.
 * DENOMINATOR: n/a — grouped counts, not a ratio.
 * SOURCE:      pet_events (clinical_info_logged).
 * CADENCE:     matches the caller's ProjectionContext period.
 * SUPPRESSION: none.
 *
 * NATALIDAD CAVEAT: only TRACKED pregnancies are counted — see the
 * module-level comment. registeredBirths under-counts real natalidad.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
export async function fetchReproductiveOutcomes(
  ctx: ProjectionContext,
  opts?: { species?: string },
): Promise<ReproductiveOutcomes> {
  const empty: ReproductiveOutcomes = {
    byClinicalOutcome: {
      live_birth: 0,
      stillbirth: 0,
      miscarriage: 0,
      termination: 0,
      unknown: 0,
    },
    registeredBirths: 0,
    liveBirthsCountSum: 0,
  };
  if (isEmptyScope(ctx)) return empty;

  // clinical_info_logged carries no payload jurisdiction snapshot — scope by the
  // pet's HOME jurisdiction (petsScopeClause) against the pets INNER JOIN in the
  // `resolved` derived table below. petEventsScopeClause here would be the
  // ghost-payload bug (evaluates to `false` for every scoped-govt row).
  const scope = petsScopeClause(ctx);

  const conditions = [
    eq(petEvents.eventType, "clinical_info_logged"),
    sql`${petEvents.payload}->>'sub_kind' = ${"pregnancy"}`,
    sql`${petEvents.payload}->>'pregnancy_phase' = ${"ended"}`,
    gte(petEvents.occurredAt, ctx.period.since),
    lte(petEvents.occurredAt, ctx.period.until),
  ];
  if (scope) conditions.push(sql`(${scope})`);
  if (opts?.species) conditions.push(eq(pets.species, opts.species));

  // AMENDMENT OVERLAY (corrections-supersede E3): clinical_info_logged is in
  // AMENDABLE_EVENT_TYPES, so `outcome` and `live_births_count` are mutable —
  // a vet correcting an outcome (e.g. live_birth → stillbirth via event_amended)
  // MUST move the natalidad buckets. Both are read through amendedPayloadText so
  // the latest corrected payload counts, not the original. sub_kind/
  // pregnancy_phase are structural discriminators (existence-defining), raw.
  //
  // The overlay is a correlated subquery on pet_events.id, so it CANNOT sit
  // directly in GROUP BY alongside an aggregate over another such subquery
  // (Postgres: "subquery uses ungrouped column"). Resolve both fields per-row in
  // a derived table first, then group by the resolved plain column.
  const resolved = db
    .select({
      outcome: sql<string>`COALESCE(${amendedPayloadText("outcome")}, 'unknown')`.as("outcome"),
      liveBirths: sql<string | null>`${amendedPayloadText("live_births_count")}`.as("live_births"),
    })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(and(...conditions))
    .as("resolved");

  const rows = await db
    .select({
      outcome: resolved.outcome,
      n: count(),
      liveBirthsSum: sql<number>`COALESCE(SUM((${resolved.liveBirths})::int) FILTER (WHERE ${resolved.liveBirths} IS NOT NULL), 0)::int`,
    })
    .from(resolved)
    .groupBy(resolved.outcome);

  const VALID_OUTCOMES = new Set<ReproductiveOutcomeKey>([
    "live_birth",
    "stillbirth",
    "miscarriage",
    "termination",
    "unknown",
  ]);

  const counts: Record<ReproductiveOutcomeKey, number> = {
    live_birth: 0,
    stillbirth: 0,
    miscarriage: 0,
    termination: 0,
    unknown: 0,
  };
  let liveBirthsCountSum = 0;

  for (const row of rows) {
    const key = VALID_OUTCOMES.has(row.outcome as ReproductiveOutcomeKey)
      ? (row.outcome as ReproductiveOutcomeKey)
      : "unknown";
    counts[key] += row.n;
    if (key === "live_birth") {
      liveBirthsCountSum += Number(row.liveBirthsSum);
    }
  }

  return {
    byClinicalOutcome: counts,
    registeredBirths: counts.live_birth,
    liveBirthsCountSum,
  };
}

/**
 * Prior-period registeredBirths count, for the /gob/poblacion deltaV2 chip on
 * "Nacimientos registrados".
 *
 * Mirrors fetchReproductiveOutcomes' live_birth filter EXACTLY (same
 * sub_kind='pregnancy' + pregnancy_phase='ended' + outcome='live_birth'
 * predicate, read through the SAME amendedPayloadText overlay so a vet
 * correction moves the prior-period bucket too, same petsScopeClause scope)
 * but shifted one full period back — same pattern as campaign-metrics.ts'
 * fetchPrevTotals: prevUntil = ctx.period.since, prevSince = since − duration.
 * Consumed via formatDelta (lib/analytics/campaign-metrics.ts).
 *
 * NATALIDAD CAVEAT applies here too — see module header. The delta compares
 * two under-counted numbers, so it is directional (more/fewer TRACKED births),
 * not a claim about real natalidad trend.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
export async function fetchPrevRegisteredBirths(
  ctx: ProjectionContext,
  opts?: { species?: string },
): Promise<number> {
  if (isEmptyScope(ctx)) return 0;

  const scope = petsScopeClause(ctx);
  const duration = ctx.period.until.getTime() - ctx.period.since.getTime();
  const prevSince = new Date(ctx.period.since.getTime() - duration);
  const prevUntil = ctx.period.since;

  const conditions = [
    eq(petEvents.eventType, "clinical_info_logged"),
    sql`${petEvents.payload}->>'sub_kind' = ${"pregnancy"}`,
    sql`${petEvents.payload}->>'pregnancy_phase' = ${"ended"}`,
    sql`${amendedPayloadText("outcome")} = ${"live_birth"}`,
    gte(petEvents.occurredAt, prevSince),
    lte(petEvents.occurredAt, prevUntil),
  ];
  if (scope) conditions.push(sql`(${scope})`);
  if (opts?.species) conditions.push(eq(pets.species, opts.species));

  const [row] = await db
    .select({ n: count() })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(and(...conditions));

  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Net growth
// ---------------------------------------------------------------------------

export type NetGrowthResult = {
  /** Count of new pet registrations (pets.created_at in period, in scope). */
  altas: number;
  /**
   * Registered live births in the period (tracked pregnancies only).
   *
   * NATALIDAD CAVEAT: systematically under-counts real natalidad.
   * Street/untracked litters are invisible. Display with caveat:
   *   "Solo partos en seguimiento — subestima la natalidad real"
   */
  registeredBirths: number;
  /** Count of death_recorded events in the period, scoped. */
  deaths: number;
  /**
   * Net = altas + registeredBirths − deaths.
   *
   * DIRECTIONAL, NOT EXACT — because registeredBirths under-counts real births.
   * A net < 0 is a strong containment signal; a net > 0 may be partially
   * explained by untracked litters.
   */
  net: number;
};

/**
 * Net population growth in the ctx period:
 *   net = altas + registeredBirths − deaths
 *
 * All three components use the same period (ctx.period.since / until) and
 * the same jurisdiction scope.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
/**
 * KPI: not yet in lib/metrics/kpi-catalog.ts (composite of three event
 * counts — no cross-surface label ambiguity reported).
 *
 * NUMERATOR:   net = altas (pets.created_at in period) + registeredBirths
 *              (live_birth outcomes in period) − deaths (death_recorded
 *              events in period).
 * DENOMINATOR: n/a — a signed count, not a ratio.
 * SOURCE:      pets, pet_events (death_recorded, clinical_info_logged).
 * CADENCE:     matches the caller's ProjectionContext period.
 * SUPPRESSION: none.
 *
 * NATALIDAD CAVEAT: registeredBirths under-counts real natalidad (tracked
 * pregnancies only) — net is DIRECTIONAL, not exact. See module-level comment.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
export async function fetchNetGrowth(
  ctx: ProjectionContext,
  opts?: { species?: string },
): Promise<NetGrowthResult> {
  const empty: NetGrowthResult = { altas: 0, registeredBirths: 0, deaths: 0, net: 0 };
  if (isEmptyScope(ctx)) return empty;

  const scope = petsScopeClause(ctx);

  // altas: pets created in the period (same scope as activePetsCondition)
  const altasConditions = [
    gte(pets.createdAt, ctx.period.since),
    lte(pets.createdAt, ctx.period.until),
    sql`${pets.status} IN ('active', 'lost')`,
  ];
  if (scope) altasConditions.push(sql`(${scope})`);
  if (opts?.species) altasConditions.push(eq(pets.species, opts.species));

  // deaths: death_recorded events in the period, scoped via JOIN to pets by the
  // pet's HOME jurisdiction (petsScopeClause). death_recorded carries no payload
  // jurisdiction snapshot, so the previous petEventsScopeClause term evaluated to
  // `false` for every scoped-govt row (ghost-payload bug) and zeroed the count.
  // The pets-table `scope` is the correct jurisdiction guard here (same clause
  // altas uses); the queries innerJoin pets.
  const deathConditions = [
    eq(petEvents.eventType, "death_recorded"),
    gte(petEvents.occurredAt, ctx.period.since),
    lte(petEvents.occurredAt, ctx.period.until),
  ];
  if (scope) deathConditions.push(sql`(${scope})`);
  if (opts?.species) deathConditions.push(eq(pets.species, opts.species));

  // registeredBirths: clinical_info_logged pregnancy-ended live_birth in the period.
  // AMENDMENT OVERLAY (E3): `outcome` is a mutable field on an amendable event —
  // read it through amendedPayloadText so a correction (live_birth → stillbirth)
  // supersedes here too. sub_kind/pregnancy_phase are structural, kept raw.
  const birthConditions = [
    eq(petEvents.eventType, "clinical_info_logged"),
    sql`${petEvents.payload}->>'sub_kind' = ${"pregnancy"}`,
    sql`${petEvents.payload}->>'pregnancy_phase' = ${"ended"}`,
    sql`${amendedPayloadText("outcome")} = ${"live_birth"}`,
    gte(petEvents.occurredAt, ctx.period.since),
    lte(petEvents.occurredAt, ctx.period.until),
  ];
  if (scope) birthConditions.push(sql`(${scope})`);
  if (opts?.species) birthConditions.push(eq(pets.species, opts.species));

  const [altasRows, deathRows, birthRows] = await Promise.all([
    db
      .select({ n: count() })
      .from(pets)
      .where(and(...altasConditions)),

    db
      .select({ n: count() })
      .from(petEvents)
      .innerJoin(pets, eq(pets.id, petEvents.petId))
      .where(and(...deathConditions)),

    db
      .select({ n: count() })
      .from(petEvents)
      .innerJoin(pets, eq(pets.id, petEvents.petId))
      .where(and(...birthConditions)),
  ]);

  const altas = altasRows[0]?.n ?? 0;
  const deaths = deathRows[0]?.n ?? 0;
  const registeredBirths = birthRows[0]?.n ?? 0;

  return {
    altas,
    registeredBirths,
    deaths,
    net: computeNetGrowth({ altas, births: registeredBirths, deaths }),
  };
}

// ---------------------------------------------------------------------------
// Sterilization/natalidad ratio
// ---------------------------------------------------------------------------

/**
 * Ratio of sterilization events performed in the period to registered births.
 *
 * Formula: COUNT(sterilization_performed) / registeredBirths.
 * Returns null when registeredBirths is 0 (no meaningful ratio, never divide by zero).
 *
 * NATALIDAD CAVEAT: registeredBirths under-counts real natalidad.
 * A ratio > 1 is a favourable containment signal but does NOT mean sterilizations
 * actually outnumber all litters — untracked births are invisible.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
/**
 * KPI: sterilization_natalidad_ratio (see lib/metrics/kpi-catalog.ts)
 *
 * NUMERATOR:   COUNT sterilization_performed events in the ctx period.
 * DENOMINATOR: COUNT registered live births in the SAME period
 *              (clinical_info_logged, sub_kind='pregnancy',
 *              pregnancy_phase='ended', outcome='live_birth') — null when 0.
 * SOURCE:      pet_events (sterilization_performed, clinical_info_logged).
 * CADENCE:     matches the caller's ProjectionContext period.
 * SUPPRESSION: none.
 *
 * NATALIDAD CAVEAT: the denominator under-counts real natalidad — this ratio
 * OVER-estimates containment. Directional signal only. See module-level comment.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
export async function fetchSterilizationNatalidadRatio(
  ctx: ProjectionContext,
  opts?: { species?: string },
): Promise<number | null> {
  if (isEmptyScope(ctx)) return null;

  // Neither sterilization_performed nor clinical_info_logged carries a payload
  // jurisdiction snapshot — scope by the pet's HOME jurisdiction (petsScopeClause)
  // against the pets INNER JOIN present in both queries below. petEventsScopeClause
  // here would be the ghost-payload bug (evaluates to `false` for every scoped-govt
  // row, forcing the ratio to 0/0 → null).
  const scope = petsScopeClause(ctx);

  const sterilConditions = [
    eq(petEvents.eventType, "sterilization_performed"),
    gte(petEvents.occurredAt, ctx.period.since),
    lte(petEvents.occurredAt, ctx.period.until),
  ];
  if (scope) sterilConditions.push(sql`(${scope})`);
  if (opts?.species) sterilConditions.push(eq(pets.species, opts.species));

  // AMENDMENT OVERLAY (E3): `outcome` read through amendedPayloadText so a
  // corrected outcome supersedes the ratio denominator too.
  const birthConditions = [
    eq(petEvents.eventType, "clinical_info_logged"),
    sql`${petEvents.payload}->>'sub_kind' = ${"pregnancy"}`,
    sql`${petEvents.payload}->>'pregnancy_phase' = ${"ended"}`,
    sql`${amendedPayloadText("outcome")} = ${"live_birth"}`,
    gte(petEvents.occurredAt, ctx.period.since),
    lte(petEvents.occurredAt, ctx.period.until),
  ];
  if (scope) birthConditions.push(sql`(${scope})`);
  if (opts?.species) birthConditions.push(eq(pets.species, opts.species));

  const [sterilRows, birthRows] = await Promise.all([
    db
      .select({ n: count() })
      .from(petEvents)
      .innerJoin(pets, eq(pets.id, petEvents.petId))
      .where(and(...sterilConditions)),

    db
      .select({ n: count() })
      .from(petEvents)
      .innerJoin(pets, eq(pets.id, petEvents.petId))
      .where(and(...birthConditions)),
  ]);

  const sterilizations = sterilRows[0]?.n ?? 0;
  const births = birthRows[0]?.n ?? 0;

  return safeRatio(sterilizations, births);
}

// ---------------------------------------------------------------------------
// Sterilization trend (reuse D2 generic KPI trend)
// ---------------------------------------------------------------------------

/**
 * Bucketed count of sterilization_performed events over the ctx period.
 * Reuses fetchKpiTrend — same granularity, same scope, same k-anonymity.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
/**
 * KPI: sterilization_performed events bucketed over time — the trend view of
 * sterilization_coverage_population's numerator (see kpi-catalog.ts). Reuses
 * fetchKpiTrend, so numerator/scope/k-anon (k=5) are identical to that helper.
 */
export async function fetchSterilizationTrend(
  ctx: ProjectionContext,
  opts?: { species?: string },
): Promise<SingleSeriesTrend> {
  return fetchKpiTrend("sterilization_performed", ctx, opts);
}
