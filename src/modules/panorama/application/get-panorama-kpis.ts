// Panorama application use-case: resolve the console's headline KPIs.
//
// DESIGN INVARIANT — DASHBOARD PARITY: every KPI here is computed by calling the
// SAME tested dashboard fetchers the equivalent /gob detail dashboards use, so
// the Panorama console can NEVER desync from the dashboards. This use-case does
// NOT re-derive a single metric with its own query; it only orchestrates the
// fetchers and shapes the result into a typed, tooltip-carrying payload.
//
// Each KPI carries:
//   - a formatted display `value` + an optional `sub` line,
//   - a `tone` for the OpKpi tile,
//   - an `info` tooltip ({definition, formula, caveat}) — IDENTICAL wording to
//     the /gob home tiles so the numbers AND their definitions match,
//   - the backing fetcher name (for traceability / tests).
//
// SCOPE + PERIOD: the (actor, jurisdictions, period) tuple is resolved at the
// auth boundary (the page / the /api/panorama/kpis route) and threaded down. A
// govt actor can NEVER widen scope — the fetchers intersect with assignments.
//
// VIEWPORT-BBOX NARROWING (spec nice-to-have): DEFERRED. Narrowing the KPI
// denominators to the current map viewport would require duplicating each
// metric's SQL with an extra bbox predicate, which would FORK the metric
// definition and break dashboard parity — the exact thing this use-case exists
// to prevent. Until the dashboard fetchers accept an optional bbox themselves,
// the KPIs are scope+period-aware (correct and demoable). See TODO below.
// TODO(panorama-bbox): thread an optional bbox into the shared fetchers
//   (lib/govt-home-kpis, lib/govt-dashboards) so the console and the dashboards
//   stay single-sourced, then surface it here without a forked query.

import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import {
  type AnalyticsPeriod,
  type DashboardActor,
  type DashboardJurisdiction,
  buildProjectionContext,
} from "@/lib/metrics";
import { lastIngestAt } from "@/lib/metrics/freshness";
import { KPI_CATALOG } from "@/lib/metrics/kpi-catalog";
import { windows } from "@/lib/metrics/period";
import { fetchSterilizationCoverage } from "@/lib/metrics/population-control";
import { applyCensusCoverageGuard } from "@/lib/metrics/presentation-guards";
// D.10 scope-headline verdict (RA-3 finding C1). The wording lives in ONE
// helper so this tile cannot invent a phrasing of its own — the same reason
// /gob/censo, /gob/poblacion and both /programa pages call it.
import { scopeTotalSuppressionNotice } from "@/lib/metrics/province-disclosure";
import { TARGETS, toneForTarget } from "@/lib/metrics/targets";
// v+1 rail — the SAME generic/typed trend fetchers /gob home wires into its
// KPI tiles (app/gob/page.tsx: rabiesVaxTrend/bitesTrend/zoonosisTrend). No
// panorama-only trend query: reusing these three preserves dashboard parity.
import { fetchBitesTrend, fetchKpiTrend, fetchRabiesVaccinationTrend } from "@/lib/metrics/trends";

import { formatCount, formatPercent, formatRate, pluralizeEs } from "@/lib/utils/format";

// v+1 rail — D4 reunification rate + C1 microchip penetration, the SAME
// fetchers /gob/perdidas and /gob/programa already call. Adding them here
// only ORCHESTRATES a call the dashboards already trust; no new SQL.
import {
  fetchDangerousBreedCompliance,
  fetchMicrochipPenetration,
  fetchReunificationRate,
} from "@/lib/analytics/compliance-metrics";
import { fetchAnalyticsMetrics, fetchPerdidasMetrics } from "@/lib/analytics/govt-dashboards";
import {
  type RabiesDenominator,
  fetchActiveZoonosis,
  fetchBitesPer10k,
  fetchOpenWelfareReportsCount,
  fetchRabiesCoverage,
  fetchRabiesDenominator,
} from "@/lib/analytics/govt-home-kpis";
import type { PanoramaKpiId } from "@/src/modules/panorama/domain/types";
import {
  loadMortalityByProvince,
  loadZoonosisSignalScopeTotal,
} from "@/src/modules/panorama/infrastructure/repository";

/** Tone passthrough to the OpKpi tile (kept loose to avoid a UI import here). */
export type KpiTone = "neutral" | "danger" | "warn" | "ok" | "blue";

/** The ⓘ tooltip payload the OpKpi tile renders. */
export type KpiInfo = {
  definition: string;
  formula?: string;
  caveat?: string;
};

/**
 * map-QOL: period-over-period comparison for a KPI. Only attached where the
 * underlying metric is genuinely window-sensitive (cobertura, mordeduras,
 * zoonosis) — state metrics (colas, stocks) get NO delta rather than a
 * misleading 0%.
 */
export type KpiDelta = {
  /**
   * The signed magnitude vs the immediately-prior window of equal length. Its
   * meaning depends on `unit`: for `"pct"` it is the RELATIVE percent change
   * ((cur−prior)/prior); for `"pts"` it is the ABSOLUTE difference in percentage
   * POINTS (cur−prior). A percentage-valued KPI (cobertura) MUST use `"pts"` — a
   * relative % of a percentage reads as an implausible "+76%" (cowork QA H9).
   */
  pct: number;
  /**
   * Unit of `pct`. `"pct"` = relative percent change (counts/rates per-10k);
   * `"pts"` = percentage points (metrics whose display value is itself a %).
   */
  unit: "pct" | "pts";
  /** Direction, so the UI can pair the arrow glyph with the signed text. */
  direction: "up" | "down" | "flat";
  /** es-AR display/aria text, e.g. "+12% vs período anterior" or "+27 pts vs período anterior". */
  label: string;
};

/** One headline KPI, ready to feed an OpKpi tile. */
export type PanoramaKpi = {
  /** Stable id (used as a React key + a test handle). */
  id: PanoramaKpiId;
  /** es-AR label. */
  label: string;
  /** Pre-formatted display value (es-AR number formatting applied here). */
  value: string;
  /** Optional secondary line (e.g. "meta 80% · 12 partidos"). */
  sub?: string;
  /**
   * Coherence hybrid (cowork QA H1/H6): TRUE for a STOCK / current-state KPI
   * (cobertura, esterilización, microchip, pérdidas, reunificación) whose value
   * is a point-in-time snapshot that does NOT vary with the temporal scrubber's
   * as-of cutoff. The KPI cards render an honest "estado actual" tag on these so
   * the operator knows the scrubber (which moves the map + the temporal KPIs)
   * legitimately does not move them — instead of reading as a broken control.
   * Absent/false → a period/as-of-sensitive KPI that DOES track the scrub.
   */
  currentState?: boolean;
  /**
   * Coherence hybrid (cowork QA H6): a clearly-labeled SECONDARY figure shown
   * beneath the primary on the KPI card — e.g. denuncias shows the in-period
   * count as the PRIMARY (matching the map + Registros) and the all-time backlog
   * here as "backlog 2.202 activas". Keeps the useful all-time number without
   * letting it masquerade as the in-view count. Absent → no secondary line.
   */
  secondary?: string;
  /**
   * Red-team-admin #12a: a flow KPI whose window is FIXED (not the scrubber's
   * selected period) — e.g. "mordeduras (12 meses)". Without this, the chip
   * renders the generic "período" tag identical to period-following flows like
   * denuncias, implying the picker moves it when it does not. Present → the chip
   * shows THIS label (e.g. "12 meses fijos") instead of "período".
   */
  fixedWindowLabel?: string;
  /** Optional progress-bar fill 0..100 (rabies coverage). */
  bar?: number;
  tone: KpiTone;
  /** ⓘ tooltip — copied verbatim from the equivalent /gob tile (parity). */
  info: KpiInfo;
  /** Link to the detail dashboard this KPI mirrors (drill-through). */
  href: string;
  /** The dashboard fetcher that produced this value (traceability / tests). */
  source: string;
  /** Period-over-period delta — only on window-sensitive KPIs (map-QOL). */
  delta?: KpiDelta;
  /**
   * v+1 rail: inline sparkline series (chronological buckets, no keys/labels) —
   * fed straight into OpKpi's `sparkline` prop. Only set on the window-sensitive
   * KPIs with a matching trend fetcher in lib/metrics/trends (cobertura,
   * mordeduras, zoonosis). Same visual language as /gob home's KPI tiles.
   *
   * SUPPRESSED ≠ ZERO: this used to be `number[]`, built with
   * `trend.points.map((p) => p.y)`, and that projection silently dropped the
   * `suppressed` flag that `suppressSmallBuckets` puts on a k-anon-masked
   * bucket — so a masked 1..k-1 bucket (carried as `y: 0`) drew as a dip to the
   * floor with nothing saying so. The whole point now travels.
   *
   * Declared STRUCTURALLY rather than by importing OpKpi's `SparklinePoint`:
   * this is the application layer and it must not depend on a React component.
   * The shape is the contract; the assignment is checked at the render site.
   */
  sparkline?: Array<{ y: number; suppressed?: true }>;
  /**
   * Overrides the sparkline's a11y description when what it PLOTS differs
   * from the tile's headline metric — e.g. `cobertura`'s headline is a
   * PERCENTAGE (rate) but its sparkline (fetchRabiesVaccinationTrend) plots
   * raw per-bucket vaccination VOLUME (countDistinct dogs vaccinated), not
   * the coverage ratio. Without this, the generic "Tendencia de {label}"
   * aria-label reads as if the trend line tracked the % — a click-through
   * honesty mismatch for screen-reader users. Absent → the caller falls back
   * to the generic "Tendencia de {shortLabel}" phrasing (headline and
   * sparkline agree on what's plotted, e.g. mordeduras/zoonosis counts).
   */
  sparklineLabel?: string;
  /**
   * Per-tile degradation (2026-07): TRUE when THIS tile's backing PRIMARY fetcher
   * rejected while others succeeded. The tile renders an honest, self-contained
   * "no disponible" placeholder (value "—", neutral, no numbers) instead of
   * dragging the WHOLE strip to the empty degraded state. Parity invariant: an
   * unavailable tile is ABSENT of numbers — it never shows a stale/wrong figure.
   * Absent/false → a real tile with parity-true numbers. The strip only collapses
   * to the empty `degraded` payload when EVERY tile is unavailable.
   */
  unavailable?: boolean;
};

/**
 * Context denominator (metric-honesty demotion 2026-07-09): the pet population
 * the coverage rates are computed against. Previously a HEADLINE "Mascotas en
 * cobertura" tile — demoted to a footer caption because it is a DENOMINATOR for
 * the rate KPIs, not a decision KPI in its own right (metric audit: it occupied
 * a headline slot without driving a decision). Rendered once under the strip by
 * PanoramaKpiFooter, so it no longer competes with the decision KPIs for
 * attention or repeats across presets.
 */
export type PanoramaCoverageDenominator = {
  /** COUNT(pets status IN ('active','lost')) in scope — the rate KPIs' denominator. */
  totalPets: number;
  /** Drill-through to the analytics dashboard this denominator mirrors. */
  href: string;
};

export type PanoramaKpis = {
  /** The headline KPIs in display order. */
  kpis: PanoramaKpi[];
  /**
   * Human scope+period cue shown next to the strip — communicates the KPIs are
   * recalculated for the active alcance/período (not a static national figure).
   */
  recalculatedFor: string;
  /**
   * map-QOL freshness: ISO timestamp of the newest scoped ingest event
   * (lib/metrics/freshness.lastIngestAt), or null when the scope has no data.
   * Serialized as a string so the payload survives the /api/panorama/kpis
   * JSON round-trip unchanged.
   */
  dataAsOf: string | null;
  /**
   * The coverage denominator ("N mascotas en cobertura") rendered as a footer
   * caption under the strip — NOT a headline tile (metric-honesty demotion
   * 2026-07-09). Optional so pre-existing PanoramaKpis fixtures/callers stay
   * valid; `null` on the degraded strip. The real fetcher always sets it.
   */
  coverageDenominator?: PanoramaCoverageDenominator | null;
  /**
   * trust/safety invariant (2026-07-10): TRUE only for the honest degraded
   * payload (degradedPanoramaKpis) — the KPI fan-out failed and NO real numbers
   * are on screen. Consumers thread this into every CONCLUSION surface (the
   * one-line reading, the metrics column, the ranking) so a degraded view shows
   * an explicit "no pudimos calcular" state that REPLACES any reassuring
   * conclusion ("sin variación", "sin jurisdicciones bajo meta") — the two must
   * never coexist. Optional/undefined on the real path (data loaded) and on
   * pre-existing fixtures, which read as not-degraded.
   */
  degraded?: boolean;
};

/**
 * Thrown by getPanoramaKpis when one or more backing fetchers rejected — the
 * strip cannot be built with dashboard parity. Callers convert this into a
 * degraded-but-honest state (API → 503 envelope; page → degradedPanoramaKpis).
 * It is thrown only AFTER every fetcher has settled (Promise.allSettled), so it
 * never abandons an in-flight query.
 */
export class PanoramaKpisUnavailableError extends Error {
  constructor(readonly failedCount: number) {
    super(
      `panorama KPI fan-out failed (${failedCount} ${pluralizeEs(failedCount, "fetcher", "fetchers")})`,
    );
    this.name = "PanoramaKpisUnavailableError";
  }
}

/**
 * es-AR degraded KPI payload — an EMPTY strip carrying an honest "no pudimos
 * cargar los indicadores, reintentá" cue in `recalculatedFor` (the field the
 * KpiStrip renders as its caption). Used as the withDbBudget fallback on the
 * page + API paths so a degraded DB renders a truthful empty state instead of
 * hanging the RSC stream forever. No tiles, no fabricated numbers.
 */
export function degradedPanoramaKpis(): PanoramaKpis {
  return {
    kpis: [],
    recalculatedFor:
      "No pudimos cargar los indicadores en este momento. Reintentá en unos segundos.",
    dataAsOf: null,
    coverageDenominator: null,
    // Explicit degraded sentinel — see PanoramaKpis.degraded. Lets conclusion
    // surfaces REPLACE their reassuring copy with an honest failure state
    // instead of reading an empty strip as "all good".
    degraded: true,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The window immediately BEFORE the active period, same length. Standard
 * preset lengths ride the named prior-window factories in lib/metrics/period
 * (trailing60d/14d/24m — the doubled window's front half IS the prior window);
 * custom lengths mirror the window backwards generically.
 */
function priorWindowOf(period: AnalyticsPeriod): { since: Date; until: Date } {
  const lengthMs = period.until.getTime() - period.since.getTime();
  const days = Math.round(lengthMs / DAY_MS);
  // The factories anchor at NOW — only equivalent when the active window is a
  // live trailing preset (until ≈ now). Historical/custom windows mirror
  // generically instead.
  const untilIsNow = Math.abs(Date.now() - period.until.getTime()) < DAY_MS;
  const doubled = untilIsNow
    ? days === 30
      ? windows.trailing60d()
      : days === 7
        ? windows.trailing14d()
        : days === 365
          ? windows.trailing24m()
          : null
    : null;
  if (doubled !== null) return { since: doubled.since, until: period.since };
  return { since: new Date(period.since.getTime() - lengthMs), until: period.since };
}

/**
 * Period-over-period delta vs the prior value.
 *
 * `unit: "pct"` (default) — RELATIVE percent change ((cur−prior)/prior). Correct
 * for counts and per-10k rates. Returns undefined when the prior is 0 or
 * non-finite (no meaningful % base — better no delta than a lie).
 *
 * `unit: "pts"` — ABSOLUTE difference in percentage POINTS (cur−prior), for KPIs
 * whose display value is itself a percentage (cobertura). A relative % of a
 * percentage produced the implausible "+76% de cobertura" the cowork QA flagged
 * (H9): coverage rising 36%→64% is "+28 pts", not "+78%". A zero prior is fine
 * here (the point difference is still meaningful), so only non-finite is guarded.
 */
function deltaOf(
  current: number,
  prior: number,
  unit: "pct" | "pts" = "pct",
): KpiDelta | undefined {
  if (!Number.isFinite(current) || !Number.isFinite(prior)) return undefined;
  if (unit === "pts") {
    const pts = Math.round(current - prior);
    const direction = pts > 0 ? "up" : pts < 0 ? "down" : "flat";
    const sign = pts > 0 ? "+" : "";
    return {
      pct: pts,
      unit,
      direction,
      label: `${sign}${pts.toLocaleString("es-AR")} pts vs período anterior`,
    };
  }
  if (prior === 0) return undefined;
  const pct = Math.round(((current - prior) / prior) * 100);
  const direction = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const sign = pct > 0 ? "+" : "";
  return {
    pct,
    unit,
    direction,
    label: `${sign}${pct.toLocaleString("es-AR")}% vs período anterior`,
  };
}

/**
 * Build the cobertura tile's sub-line naming BOTH denominators (task #79):
 *   1. the registry count `current` is a % of ("… perros en el padrón"),
 *   2. how much of the estimated canine population the padrón covers
 *      ("el padrón cubre X% de la población canina estimada"), or an honest
 *      "sin estimación censal" when the scope has no census row.
 * Then the firmado-por-matrícula share (task #78 Part 3) and the meta.
 *
 * PURE — no DB. Takes the total-coverage and signed-only KPI results.
 */
function coberturaSub(
  coverage: {
    target: number;
    registryDenominator: number;
    censusCoveragePct: number | null;
  },
  // Per-tile degradation: the signed-only fetcher is an ENRICHMENT — if it
  // rejected while the primary coverage succeeded, drop the "firmado por
  // matrícula" segment rather than fail the whole tile (null → omit it).
  coverageSigned: { current: number } | null,
): string {
  const registry = `${formatCount(coverage.registryDenominator)} ${
    coverage.registryDenominator === 1 ? "perro" : "perros"
  } en el padrón`;
  const census =
    coverage.censusCoveragePct !== null
      ? `el padrón cubre ${formatPercent(coverage.censusCoveragePct)} de la población canina estimada`
      : "sin estimación censal";
  const signed =
    coverageSigned !== null
      ? `${formatPercent(coverageSigned.current)} firmado por matrícula`
      : null;
  return [registry, census, signed, `meta ${coverage.target}%`].filter(Boolean).join(" · ");
}

/**
 * Resolve the console's headline KPIs for the active (actor, jurisdictions,
 * period). Reuses the tested dashboard fetchers so the numbers are IDENTICAL to
 * the detail dashboards. Never widens scope (the fetchers intersect with the
 * viewer's assignments). All fetchers run concurrently.
 *
 * `adminProvince` / `adminLocality` are ONLY for admin actors drilling into a
 * province via the Panorama JurisdictionSwitcher. Never pass them for govt actors
 * (their scope is enforced by filteredJurisdictions).
 */
export async function getPanoramaKpis(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  period: AnalyticsPeriod,
  adminProvince?: string,
  adminLocality?: string,
  asOf?: Date | null,
): Promise<PanoramaKpis> {
  // One ProjectionContext for the ctx-based fetchers. Thread adminProvince so
  // petsScopeClause / petEventsScopeClause narrow from global to the selected province.
  const ctx = buildProjectionContext(actor, jurisdictions, period, {
    adminProvince,
    adminLocality,
  });

  // Coherence hybrid (cowork QA H1/H6): when the operator scrubs the timeline the
  // map + Registros refetch as-of that cutoff, but the KPIs used NOT to — the big
  // number contradicted the map ("102 zoonosis" over a map showing 19). Thread the
  // as-of cutoff into the TEMPORAL KPIs only (mordeduras, zoonosis, denuncias
  // in-period): they compute against a period whose `until` is clamped to `asOf`,
  // so they move WITH the map. STOCK/current-state KPIs (cobertura, esterilización,
  // microchip, pérdidas, reunificación) keep the LIVE ctx — they are point-in-time
  // snapshots that cannot vary with a corte, and are labeled "estado actual" so the
  // scrubber's honest non-effect on them reads as intentional, not broken. When
  // `asOf` is null (parked at live) every temporal ctx collapses back to `ctx`, so
  // the behavior is byte-identical to before (no regression on the live view).
  const temporalPeriod: AnalyticsPeriod = asOf ? { ...period, until: asOf } : period;
  const temporalCtx = asOf
    ? buildProjectionContext(actor, jurisdictions, temporalPeriod, { adminProvince, adminLocality })
    : ctx;

  // task #78 Part 3 — the ministry-credibility "both numbers" for the cobertura
  // tile: the SAME ctx narrowed to vet-signed doses only (firmado por matrícula).
  // The tile's headline value stays TOTAL coverage; this signed figure rides in
  // the tile `sub` so the operator sees, at a glance, how much of the coverage is
  // backed by a matriculated signature. Numerator-only narrowing (never widens
  // scope) — the signed number is always ≤ the total.
  const verifiedCtx = buildProjectionContext(actor, jurisdictions, period, {
    adminProvince,
    adminLocality,
    verifiedOnly: true,
  });

  // map-QOL period-over-period: the SAME window-sensitive fetchers run once
  // more against the immediately-prior window (identical scope) so the deltas
  // are parity-true by construction. Only the 3 window-sensitive metrics get a
  // prior run — the state metrics (colas/stocks) would return the same value.
  const priorWindow = priorWindowOf(period);
  const priorCtx = buildProjectionContext(
    actor,
    jurisdictions,
    { ...period, since: priorWindow.since, until: priorWindow.until },
    { adminProvince, adminLocality },
  );

  // Prior window for the TEMPORAL KPIs' deltas — anchored to the as-of cutoff so a
  // scrubbed value's delta compares like-for-like against the window immediately
  // before the as-of frame (not the live prior). Collapses to `priorCtx` at live.
  const temporalPriorWindow = asOf ? priorWindowOf(temporalPeriod) : priorWindow;
  const temporalPriorCtx = asOf
    ? buildProjectionContext(
        actor,
        jurisdictions,
        { ...period, since: temporalPriorWindow.since, until: temporalPriorWindow.until },
        { adminProvince, adminLocality },
      )
    : priorCtx;

  // NEVER-CRASH FAN-OUT (task #74): use Promise.allSettled — NOT Promise.all.
  // Promise.all rejects on the FIRST fetcher failure and ABANDONS its siblings;
  // when a sibling later rejects (routine once the transaction pooler degrades
  // and queries error out) that rejection has no consumer and surfaces as an
  // unhandledRejection that crashes the lambda mid-response — the exact prod
  // incident. allSettled awaits EVERY fetcher to completion, so no promise is
  // ever abandoned. If any fetcher rejected we degrade the WHOLE strip (the
  // historical all-or-nothing parity contract) by throwing a typed error the
  // callers convert into a degraded-but-honest state — but only AFTER every
  // sibling has settled, so nothing dangles.
  // qw#4: the rabies-coverage denominator is scope-only, so compute it ONCE and
  // share it across the 3 fetchRabiesCoverage calls below (ctx / priorCtx /
  // verifiedCtx — same scope) instead of recomputing byte-identical denominator
  // queries each time. Fail-safe: on a denominator error we fall back to
  // undefined, so each call recomputes its own and fails honestly INSIDE the
  // allSettled — the never-crash contract is preserved.
  let rabiesDenom: RabiesDenominator | undefined;
  try {
    rabiesDenom = await fetchRabiesDenominator(ctx);
  } catch {
    rabiesDenom = undefined;
  }

  const settled = await Promise.allSettled([
    // 1. Cobertura antirrábica — lib/govt-home-kpis.fetchRabiesCoverage (ctx).
    fetchRabiesCoverage(ctx, rabiesDenom),
    // 2. Mascotas en cobertura (totalPets) — lib/govt-dashboards.fetchAnalyticsMetrics.
    //    Non-ctx fetcher: thread adminProvince via opts so it applies explicit predicates.
    fetchAnalyticsMetrics(actor, jurisdictions, {
      since: period.since,
      adminProvince,
      adminLocality,
    }),
    // 3. Pérdidas activas — lib/govt-dashboards.fetchPerdidasMetrics (population metric).
    //    Non-ctx fetcher: thread adminProvince via opts.
    fetchPerdidasMetrics(actor, jurisdictions, { adminProvince, adminLocality }),
    // 4. Mordeduras / 10k hab. — lib/govt-home-kpis.fetchBitesPer10k.
    //    TEMPORAL: as-of-aware ctx so the rate tracks the scrubber (H1).
    fetchBitesPer10k(temporalCtx),
    // 5. Zoonosis activas — lib/govt-home-kpis.fetchActiveZoonosis.
    //    TEMPORAL: as-of-aware ctx so the signal snapshot tracks the scrubber (H1).
    fetchActiveZoonosis(temporalCtx),
    // 6. Denuncias — lib/govt-home-kpis.fetchOpenWelfareReportsCount.
    //    TEMPORAL: as-of-aware ctx so the in-period primary tracks the scrubber
    //    (the all-time backlog it also returns is period-independent) (H6).
    fetchOpenWelfareReportsCount(temporalCtx),
    // 7. Cobertura de esterilización — lib/metrics/population-control.fetchSterilizationCoverage.
    // Same fetcher as /gob/poblacion → dashboard parity guaranteed. STOCK (estado actual).
    fetchSterilizationCoverage(ctx),
    // Prior-window runs (deltas). Cobertura's prior stays LIVE (it is current-state);
    // the temporal KPIs' priors anchor to the as-of frame (temporalPriorCtx). Zoonosis's
    // prior is a signal-total (added at the end) — its delta now tracks the signal
    // primary, not the old composite.
    fetchRabiesCoverage(priorCtx, rabiesDenom),
    fetchBitesPer10k(temporalPriorCtx),
    // Freshness: newest scoped ingest event (map-QOL freshness chip).
    lastIngestAt(ctx),
    // task #78 Part 3: signed-only (firmado por matrícula) rabies coverage for the
    // cobertura tile's "both numbers" sub-line.
    fetchRabiesCoverage(verifiedCtx, rabiesDenom),
    // v+1 rail — meta-progress meters: D4 reunification rate (perdidas-reunificacion
    // preset) + C1 microchip penetration (cumplimiento preset). Same fetchers
    // /gob/perdidas + /gob/programa already call; current-active-period ctx.
    fetchReunificationRate(ctx),
    fetchMicrochipPenetration(ctx),
    // v+1 rail — KPI sparklines. Same trend fetchers /gob home wires into its
    // tiles, run against the SAME ctx as the headline value (not a fixed 12m
    // window) so the sparkline always spans the operator's active period.
    fetchRabiesVaccinationTrend(ctx), // cobertura (current-state → live ctx)
    fetchBitesTrend(temporalCtx), // mordeduras (temporal → as-of-aware)
    fetchKpiTrend("rabies_observation_started", temporalCtx), // zoonosis (temporal → as-of-aware)
    // Coherence hybrid (round 2, H1) — the zoonosis PRIMARY: scope-wide
    // outbreak_signal total in the SAME [since, asOf] window the map layer draws
    // (loadZoonosisByUnit), so the big number == Σ(map cells). At live asOf is
    // undefined (unbounded up to now — exactly the layer's behavior); a scrub
    // clamps it. [17] current window, [18] prior window (for the delta).
    loadZoonosisSignalScopeTotal(
      actor,
      jurisdictions,
      period.since,
      asOf ?? undefined,
      adminProvince,
      adminLocality,
    ),
    loadZoonosisSignalScopeTotal(
      actor,
      jurisdictions,
      temporalPriorWindow.since,
      temporalPriorWindow.until,
      adminProvince,
      adminLocality,
    ),
    // Orphaned-layer wiring — PPP registry adoption (C7) + mortality. Both are
    // CURRENT-STATE (estado actual): PPP reuses the SAME scope fetcher /gob's C7
    // KPI calls (fetchDangerousBreedCompliance); mortality sums the province
    // choropleth loader the map already draws (loadMortalityByProvince) so the KPI
    // total == Σ(map cells). No new SQL — both respect scope, neither varies with
    // the scrubber (current-state, so no as-of). [18] PPP, [19] mortality.
    fetchDangerousBreedCompliance(ctx),
    loadMortalityByProvince(actor, jurisdictions, adminProvince, adminLocality),
  ]);

  // PER-TILE DEGRADATION (2026-07, replacing the historical all-or-nothing throw):
  // a single fetcher rejection used to degrade the WHOLE strip to empty. Now each
  // tile is built from its PRIMARY fetcher; a tile whose primary rejected becomes
  // an honest "no disponible" placeholder (post-pass below) while its siblings
  // render their parity-true numbers. Log every failure. allSettled already
  // awaited EVERY fetcher (never-crash fan-out, task #74), so nothing dangles.
  const rejections = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  for (const r of rejections) {
    console.error("[panorama-kpis] fetcher failed:", r.reason);
  }

  const fulfilled = <T>(r: PromiseSettledResult<T>): r is PromiseFulfilledResult<T> =>
    r.status === "fulfilled";
  // ENRICHMENT accessor: the settled value or null. Used for the adornments
  // (deltas, sparklines, the signed sub-line, the zoonosis composite) — a
  // rejected enrichment drops just that adornment, never the tile. PRIMARY values
  // fall back to a neutral shape ONLY so the literal below computes without
  // throwing; the post-pass then REPLACES any tile whose primary rejected with the
  // unavailable placeholder, so a fallback value is never shown as a real figure.
  const opt = <T>(r: PromiseSettledResult<T>): T | null => (fulfilled(r) ? r.value : null);

  const coverage = opt(settled[0]) ?? {
    current: 0,
    target: 0,
    registryDenominator: 0,
    censusDenominator: 0,
    censusCoveragePct: null,
    partidos: 0,
    hasData: false,
  };
  const analytics = opt(settled[1]); // footer denominator — nullable, guarded in the return.
  const perdidas = opt(settled[2]) ?? { activeCount: 0, recoveredMonth: 0, avgDaysActive: 0 };
  const bites = opt(settled[3]) ?? { rate: 0, delta: 0, reports: 0, percapitaEligible: true };
  // Zoonosis composite (activas hoy) — an ENRICHMENT for the sub/secondary; the
  // PRIMARY value is the scope-signal total [16]. Null → drop sub/secondary.
  const zoonosis = opt(settled[4]);
  const welfare = opt(settled[5]) ?? { count: 0, inPeriod: 0 };
  // FAIL-CLOSED FALLBACK. `scopeTotalPublishable: false` here is deliberate and
  // is never seen by an operator: index 6 IS this tile's PRIMARY (PRIMARY_INDEX
  // .esterilizacion), so a rejected fetcher is replaced by the `unavailable`
  // placeholder in the post-pass below — which carries no `sub`, no `bar` and no
  // number at all. The `false` only matters if that post-pass ever stops
  // covering this tile, and in that case withholding is the safe direction. A
  // privacy flag that defaults to "publish" is the failure this whole wave is
  // about.
  const sterilization = opt(settled[6]) ?? {
    rate: 0,
    sterilized: 0,
    total: 0,
    byProvince: [],
    byProvinceSuppressedCount: 0,
    byProvinceAssignedTotal: null,
    scopeTotalPublishable: false,
  };
  const priorCoverage = opt(settled[7]); // enrichment (delta)
  const priorBites = opt(settled[8]); // enrichment (delta)
  const ingestAt = opt(settled[9]);
  // task #78 Part 3: signed-only coverage (firmado por matrícula) for the sub-line.
  const coverageSigned = opt(settled[10]); // enrichment (sub segment)
  // v+1 rail: meta-progress meters + sparklines.
  const reunification = opt(settled[11]) ?? {
    ratePct: 0,
    recovered: 0,
    lostEpisodes: 0,
    medianDaysToRecovery: 0,
  };
  const microchip = opt(settled[12]) ?? {
    ratePct: 0,
    chipped: 0,
    active: 0,
    byLocality: { value: [] as never, suppressedCount: 0 },
  };
  const rabiesVaxTrend = opt(settled[13]); // enrichment (sparkline)
  const bitesTrend = opt(settled[14]); // enrichment (sparkline)
  const zoonosisTrend = opt(settled[15]); // enrichment (sparkline)
  // Coherence hybrid (round 2, H1): the scope-wide outbreak_signal totals — the
  // PRIMARY zoonosis number (== Σ map cells) and its prior-window comparison.
  const zoonosisSignals = opt(settled[16]) ?? 0;
  const priorZoonosisSignals = opt(settled[17]); // enrichment (delta)
  // Orphaned-layer wiring: PPP registry adoption + mortality (both current-state).
  const ppp = opt(settled[18]) ?? { ratePct: 0, attested: 0, flaggedCount: 0 };
  const mortalityProv = opt(settled[19]) ?? { cells: [], truncated: false };
  // Mortality KPI value = the scope total, i.e. Σ of the province choropleth cells
  // (each cell value is a raw deceased count — density metric). Guarantees the
  // headline number equals the sum of what the mortality map paints.
  //
  // #40 null-guard: a k-anon-suppressed province carries `value: null` and is
  // SKIPPED, not counted as 0. Two consequences, both deliberate:
  //  · the headline can now sit slightly BELOW the true national total — by at
  //    most (k-1) per suppressed province. It still equals Σ of what the map
  //    paints, which is the invariant this line exists to hold.
  //  · skipping is also what keeps the total safe to publish: a headline that
  //    INCLUDED the hidden cells would let a reader recover them by subtracting
  //    the visible provinces (the differencing attack complementarySuppress
  //    defends against on the open-data side).
  const mortalityTotal = mortalityProv.cells.reduce((sum, c) => sum + (c.value ?? 0), 0);
  // PPP "sin PPP" state: no dangerous-breed-flagged pets in scope → a 0% rate would
  // read as bad registry adoption when the honest reading is "there are no PPP here".
  const pppNoData = ppp.flaggedCount === 0;

  // Guard parity (consistency sweep 2026-07-23): this is the SECOND render site
  // of rabies_coverage_dogs_12m. /gob/page.tsx applies the descriptor's
  // zero-denominator + census-coverage-floor guards; this tile painted raw
  // value/tone, so a 0-dog padrón showed a confident "0%"/warn and a sliver-thin
  // padrón kept its ok/warn verdict. Same descriptor ⇒ same guards.
  // RA-3 finding C1, FOURTH SURFACE. `?province=AR-V` on the Panorama console
  // threads `adminProvince` into the ctx above, and `petsScopeClause` narrows the
  // WHOLE scope to that one province — so `fetchSterilizationCoverage(ctx)`
  // returns a `rate` computed over a single unit. At that point "Cobertura de
  // esterilización" is not a whole-scope aggregate the operator is entitled to:
  // it IS that province's withheld cell wearing a KPI label, published in the
  // same request in which /gob/poblacion hatches the province and
  // /gob/padron?vista=censo prints "suprimido por privacidad" for it.
  //
  // ONE decision point, consumed not re-derived: the verdict arrives from the
  // SAME `planProvinceDisclosure` call that decided `byProvince`, so this tile
  // and the poblacion screen it links to (`href: "/gob/poblacion"`) cannot
  // disagree. Re-deriving `sterilization.total >= 5` here would be the second
  // decision point this class of bug keeps producing.
  //
  // NOT the divergence `province-disclosure.ts` documents. That one is about a
  // govt operator's OWN province being hatched by the #40 Panorama LAYER loaders
  // (`provinceCell`, which decides on the denominator and never asks who is
  // looking) while /gob/censo shows them the real number. This is the opposite
  // direction and cannot touch it: `planProvinceDisclosure` drops own-jurisdiction
  // provinces from the candidate set BEFORE k is applied
  // (`isOwnJurisdictionProvince`), so a withheld sole unit is by construction a
  // FOREIGN one. D.10 survives — a govt operator scoped to their own 3-pet
  // province keeps `scopeTotalPublishable === true` and keeps the real number.
  // Pinned by a named test in __tests__/get-panorama-kpis.test.ts.
  //
  // KNOWN, NOT FIXED HERE (reported, own change): the sibling tiles counted over
  // the same active-pet base (microchip, PPP, reunificación) and the
  // `coverageDenominator` footer still publish at a withheld scope. Their
  // fetchers do not carry this verdict, and the tiles whose base is NOT the pet
  // padrón (mordeduras/10k hab., zoonosis signals, denuncias) must NOT inherit it
  // — withholding a metric whose denominator is the human census under a verdict
  // computed on registered pets is the RA-1 over-correction. That triage is a
  // change of its own, not a rider on this one.
  const sterilizationScopeNotice = scopeTotalSuppressionNotice(sterilization.scopeTotalPublishable);

  const coverageGuard = coverage.hasData
    ? applyCensusCoverageGuard(KPI_CATALOG.rabies_coverage_dogs_12m, {
        censusCoveragePct: coverage.censusCoveragePct,
        computedTone: toneForTarget(coverage.current, coverage.target),
      })
    : null;

  // Display order (legal-analysis intake 2026-07-03, metric reorientation):
  // the two legally-grounded compliance coverages lead — antirrábica
  // (Ley 22.953, near-universal) and esterilización (mandated in 5 provinces)
  // are the flagship public-health KPIs; risk signals follow. The population
  // denominator ("mascotas en cobertura") is NO LONGER a headline tile —
  // metric-honesty demotion 2026-07-09 moved it to `coverageDenominator`, a
  // footer caption (it is a context denominator, not a decision KPI).
  const kpis: PanoramaKpi[] = [
    {
      id: "cobertura",
      label: "Cobertura antirrábica (perros, 12m)",
      // Headline value = TOTAL coverage OF THE REGISTRY. The `sub` names BOTH
      // denominators (task #79 honest double denominators): the registry count
      // that `current` is a % of, AND how much of the estimated canine population
      // the registry itself covers. The firmado-por-matrícula share (task #78
      // Part 3) and the meta close the line.
      value: coverage.hasData ? formatPercent(coverage.current) : "—",
      sub: coverage.hasData
        ? [coberturaSub(coverage, coverageSigned), coverageGuard?.note].filter(Boolean).join(" · ")
        : "Sin datos en el período",
      bar: coverage.hasData ? coverage.current : undefined,
      // STOCK: a point-in-time coverage snapshot — does not vary with the scrub.
      currentState: true,
      tone: coverageGuard?.tone ?? "neutral",
      // F9 (2026-08-01): was /gob/analytics, which renders
      // rabies_vaccination_rate_all_species — a DIFFERENT metric (no species
      // filter, no window). This tile is fetchRabiesCoverage (dogs, 12m); the
      // province-vs-target breakdown of that same definition is the Programa
      // outliers table (fetchCrossJurisdictionOutliers' `rabies` rows reuse
      // the same rabiesVaccinatedExists predicate over ctx.period).
      // `?vista=resumen` is explicit on purpose: the anchor only exists in the
      // Resumen vista, so the link must not depend on which vista is default.
      href: "/gob/programa?vista=resumen#gob-programa-outliers-titulo",
      source: "govt-home-kpis.fetchRabiesCoverage",
      // H9: cobertura is a PERCENTAGE — its period delta is percentage POINTS, not
      // a relative % of a % (which read as the implausible "+76%" the QA flagged).
      // Enrichment guards: a rejected prior-window / trend fetcher drops the delta
      // / sparkline adornment rather than the whole tile (per-tile degradation).
      delta: priorCoverage ? deltaOf(coverage.current, priorCoverage.current, "pts") : undefined,
      sparkline: rabiesVaxTrend ? rabiesVaxTrend.points : undefined,
      // Honesty fix (Panorama audit): the headline is a % coverage RATE, but the
      // sparkline plots per-bucket vaccination VOLUME — say so, not "Cobertura".
      sparklineLabel: "vacunación antirrábica registrada (volumen, no el % de cobertura)",
      info: {
        definition:
          "Porcentaje de perros del padrón (activos/perdidos) en la jurisdicción con al menos una vacunación antirrábica registrada en los últimos 12 meses. El padrón registrado es el primer denominador; el segundo es la población canina estimada. Obligación legal: Ley 22.953 (vacunación antirrábica obligatoria, vigente en casi todas las jurisdicciones). Meta de salud pública: 80%.",
        formula:
          "COUNT DISTINCT perros con vaccination_administered (vaccine_name ~* 'antirr[áa]bica|rabies', últimos 12m) / COUNT DISTINCT perros del padrón. «Cobertura del padrón» = perros del padrón / población canina estimada (censo humano × 0,158 perros/hab.).",
        caveat:
          "Solo se cuentan vacunas registradas en miMAR. La cobertura real puede ser mayor si existen campañas fuera del sistema. La «población canina estimada» deriva del censo humano INDEC con un factor de tenencia (0,158 perros/hab., ancla EAH CABA) — es una estimación, no un censo canino; si la jurisdicción no tiene fila de censo se muestra «sin estimación censal». «Firmado por matrícula» es la porción firmada por un veterinario matriculado (author_role='vet', verificado) — la parte que el registro oficial cuenta como «al día».",
      },
    },
    {
      id: "esterilizacion",
      label: "Cobertura de esterilización",
      // Withheld ⇒ NO number, in any encoding. `value` is the em dash (never
      // "0%": a false zero reads as a measured value AND asserts something
      // untrue), `bar` is dropped because a progress bar's WIDTH is the rate —
      // publishing the figure geometrically instead of typographically is still
      // publishing it — and `tone` goes neutral, because an ok/warn verdict is a
      // claim about a number this tile refuses to state. `sub` carries the
      // shared disclosure line so the operator reads WHY, and reads the same
      // words here as on /gob/poblacion.
      value: sterilizationScopeNotice ? "—" : formatPercent(sterilization.rate),
      sub: sterilizationScopeNotice ?? `meta ${TARGETS.STERILIZATION_COVERAGE_PCT}%`,
      bar: sterilizationScopeNotice ? undefined : sterilization.rate,
      currentState: true,
      tone: sterilizationScopeNotice
        ? "neutral"
        : sterilization.rate >= TARGETS.STERILIZATION_COVERAGE_PCT
          ? "ok"
          : "warn",
      href: "/gob/poblacion",
      source: "metrics.fetchSterilizationCoverage",
      info: {
        definition:
          "Porcentaje de mascotas activas en la jurisdicción con al menos un evento sterilization_performed registrado. Meta programática: 70% (indicador de control poblacional).",
        formula:
          "COUNT DISTINCT mascotas con sterilization_performed / COUNT DISTINCT mascotas activas en alcance",
        caveat:
          "Obligatoria por ley provincial en Santa Fe, Mendoza, La Rioja, Chubut y San Juan; programática en el resto. Solo se cuentan esterilizaciones registradas en miMAR.",
      },
    },
    {
      // v+1 rail — C1 microchip penetration (Ley Prov 14.107), the same fetcher
      // /gob/programa's "Microchip" tile uses. Wording copied verbatim for
      // dashboard parity (definition/formula/href).
      id: "microchip",
      label: "Microchip",
      value: formatPercent(microchip.ratePct),
      sub: `meta ${TARGETS.MICROCHIP_PENETRATION_PCT}%`,
      bar: microchip.ratePct,
      currentState: true,
      tone: toneForTarget(microchip.ratePct, TARGETS.MICROCHIP_PENETRATION_PCT),
      href: "/gob/censo",
      source: "compliance-metrics.fetchMicrochipPenetration",
      info: {
        definition: "% de mascotas activas con microchip ISO activo.",
        formula: "chipped / active * 100",
      },
    },
    {
      // Orphaned-layer wiring — C7 dangerous-breed (PPP) registry adoption, the
      // SAME fetcher /gob's C7 KPI uses (fetchDangerousBreedCompliance) so the
      // number matches the dashboard. Rides with microchip in the compliance
      // family (Ley Prov 14.107). STOCK (estado actual): a point-in-time
      // registry-adoption snapshot, so it does not vary with the scrubber.
      id: "ppp",
      label: "Registro PPP",
      value: pppNoData ? "—" : formatPercent(ppp.ratePct),
      sub: pppNoData
        ? "sin PPP en alcance"
        : `${formatCount(ppp.attested)} de ${formatCount(ppp.flaggedCount)} atestados · benchmark 80%`,
      bar: pppNoData ? undefined : ppp.ratePct,
      currentState: true,
      tone: pppNoData ? "neutral" : toneForTarget(ppp.ratePct, 80),
      href: "/gob/censo",
      source: "compliance-metrics.fetchDangerousBreedCompliance",
      info: {
        definition:
          "Porcentaje de perros potencialmente peligrosos (PPP) del alcance con una atestación que se puede contrastar — la adopción del registro obligatorio (Ley Prov 14.107 / Ley CABA 4078). Cuenta cuando la atestación cita el número de inscripción que dio el registro, o cuando la asentó una institución responsable (organismo, organización verificada o veterinario matriculado). Benchmark programático: 80%.",
        formula:
          "COUNT DISTINCT(PPP con atestación que cita el número de inscripción o asentada por una institución responsable) / COUNT DISTINCT(PPP activos en alcance) × 100",
        caveat:
          "Solo cuenta atestaciones registradas en miMAR. Una atestación sin número de inscripción y sin firma institucional queda asentada pero NO suma acá: es una declaración que nadie puede contrastar contra el registro. Si no hay PPP en el alcance (denominador 0) se muestra «sin PPP» en lugar de 0%. Es un estado actual (no depende del período).",
      },
    },
    {
      id: "perdidas",
      label: "Pérdidas activas",
      value: formatCount(perdidas.activeCount),
      sub:
        perdidas.avgDaysActive > 0
          ? `${perdidas.recoveredMonth} recuperadas (30d) · ${perdidas.avgDaysActive} d prom.`
          : `${perdidas.recoveredMonth} recuperadas (30d)`,
      // STOCK: COUNT(status='lost') now — a state count, not a period metric.
      currentState: true,
      tone: perdidas.activeCount > 0 ? "warn" : "neutral",
      href: "/gob/perdidas",
      source: "govt-dashboards.fetchPerdidasMetrics",
      info: {
        definition:
          "Mascotas actualmente en estado 'lost' en la jurisdicción. Incluye, como contexto, cuántas se recuperaron en los últimos 30 días y los días promedio que llevan perdidas.",
        formula: "COUNT(pets donde status='lost') en alcance",
        caveat:
          "activeCount es un estado actual (no depende del período). 'recuperadas' usa una ventana fija de 30 días.",
      },
    },
    {
      // v+1 rail — D4 reunification rate, the same fetcher /gob/perdidas' "Tasa
      // de reunificación" tile uses. Wording copied verbatim for parity. Headlines
      // the perdidas-reunificacion preset's own question (previously absent).
      id: "reunificacion",
      label: "Tasa de reunificación",
      value: formatPercent(reunification.ratePct),
      sub: `meta ${TARGETS.REUNIFICATION_PCT}% · ${reunification.recovered} de ${reunification.lostEpisodes} episodios`,
      bar: reunification.ratePct,
      // NOT currentState (cowork round 2): the rate is computed over the active
      // period's lost episodes — it IS period/as-of sensitive, so it must NOT wear
      // the "estado actual" tag (that would be the inverse of the zoonosis error).
      tone: toneForTarget(reunification.ratePct, TARGETS.REUNIFICATION_PCT),
      href: "/gob/perdidas",
      source: "compliance-metrics.fetchReunificationRate",
      info: {
        definition: `Porcentaje de episodios de pérdida que terminaron en reunificación con el dueño/a. Benchmark internacional: ${TARGETS.REUNIFICATION_PCT}% (UK RSPCA).`,
        formula:
          "COUNT(episodios_lost → status='active') / COUNT(all lost episodes en período) × 100",
      },
    },
    {
      id: "mordeduras",
      // Per-cápita honesty (H1): jurisdictions_census is province-grain only, so
      // a locality-scoped viewer (percapitaEligible=false) cannot get an honest
      // per-10k rate — the numerator counts the locality but the denominator sums
      // the whole province, understating it. The tile then shows the absolute
      // count under "Mordeduras (12 meses)", mirroring the map's
      // percapitaEligibleFor gate — never a fabricated rate.
      label: bites.percapitaEligible ? "Mordeduras / 10k hab." : "Mordeduras (12 meses)",
      // G2: a rate that rounds to "0,0" at 1 decimal while there ARE reports
      // (n>0) reads as "cero mordeduras" — the headline number contradicts the
      // "N reportes" sub-line. Show "<0,1" so a nonzero numerator never displays
      // as a flat zero. A genuine zero (0 reports) keeps the plain "0,0".
      value: !bites.percapitaEligible
        ? formatCount(bites.reports)
        : bites.reports > 0 && formatRate(bites.rate) === formatRate(0)
          ? "<0,1"
          : formatRate(bites.rate),
      sub: bites.percapitaEligible
        ? `${formatCount(bites.reports)} ${bites.reports === 1 ? "reporte" : "reportes"}`
        : "sin padrón censal local",
      // #12a: this window is a FIXED trailing 12 months, NOT the scrubber's
      // selected period — declare it so the chip tags "12 meses fijos" instead
      // of the generic "período" (which implies the picker moves this number).
      fixedWindowLabel: "12 meses fijos",
      // A genuine zero (0 reports) is a neutral state, not an "Atención": gate the
      // warn semaphore on reports > 0 (mirrors app/gob/page.tsx). Without this the
      // tile flags a warning over "0" — starker now that the sub-province path
      // shows the absolute count.
      tone: bites.reports > 0 ? "warn" : "neutral",
      href: "/gob/vigilancia",
      source: "govt-home-kpis.fetchBitesPer10k",
      delta:
        bites.percapitaEligible && priorBites ? deltaOf(bites.rate, priorBites.rate) : undefined,
      sparkline: bitesTrend ? bitesTrend.points : undefined,
      // Honesty label (dataviz review 2026-07-23): when the headline is the
      // per-10k RATE, the sparkline still plots raw report COUNTS
      // (fetchBitesTrend applies no census denominator) — same class as the
      // cobertura volume-vs-% fix; say so instead of implying a rate trend.
      sparklineLabel: bites.percapitaEligible
        ? "mordeduras registradas (conteo, no la tasa por 10.000)"
        : undefined,
      info: {
        definition: bites.percapitaEligible
          ? "Tasa de incidentes de mordedura por cada 10.000 habitantes del censo provincial en los últimos 12 meses. Se usa como indicador de riesgo zoonótico (A6 proxy)."
          : "Cantidad de incidentes de mordedura en los últimos 12 meses. A nivel localidad no se publica la tasa por 10.000 hab.: el censo (jurisdictions_census) solo tiene padrón provincial, así que una tasa subestimaría la incidencia.",
        formula: bites.percapitaEligible
          ? "COUNT(incident_reported donde incident_type='bite_inflicted', últimos 12m) / (población_censo / 10.000)"
          : "COUNT(incident_reported donde incident_type='bite_inflicted', últimos 12m)",
        caveat:
          "El denominador es población humana del censo (jurisdictions_census). Si la provincia no tiene fila de censo, la tasa se muestra como 0.",
      },
    },
    {
      // Coherence hybrid (cowork round 2, H1): the PRIMARY is the scope-wide
      // outbreak_signal count in the SAME [since, asOf] window the map layer draws
      // (loadZoonosisByUnit) — so the big number == Σ(map cells) and tracks the
      // scrubber. The composite "activas hoy" (live rabies-observation + open bite +
      // 30d lepto/hidat) — which mixes stock arms the scrubber can NOT move, the very
      // source of the KPI≠map contradiction — rides as a clearly-labeled SECONDARY.
      id: "zoonosis",
      label: "Señales de zoonosis (período)",
      value: formatCount(zoonosisSignals),
      // Enrichment guard: the "activas hoy" composite [4] adorns the sub/secondary;
      // if it rejected while the PRIMARY signal total [16] succeeded, drop the
      // breakdown rather than show a fabricated "0 rabia · 0 lepto · 0 hidat".
      sub: zoonosis
        ? `${zoonosis.rabies} rabia · ${zoonosis.lepto} lepto · ${zoonosis.hidat} hidat.`
        : undefined,
      secondary: zoonosis
        ? `activas hoy: ${formatCount(zoonosis.count)} (rabia + mordeduras + 30d)`
        : undefined,
      tone: zoonosisSignals > 0 ? "danger" : "neutral",
      href: "/gob/vigilancia",
      source: "repository.loadZoonosisSignalScopeTotal",
      delta:
        priorZoonosisSignals != null ? deltaOf(zoonosisSignals, priorZoonosisSignals) : undefined,
      sparkline: zoonosisTrend ? zoonosisTrend.points : undefined,
      info: {
        definition:
          "PRIMARIO: señales de zoonosis (eventos outbreak_signal) registradas en el período y alcance seleccionados — la MISMA población que dibuja el mapa y lista Registros; se mueve con la línea de tiempo. SECUNDARIO (activas hoy): total de señales zoonóticas activas de estado actual: mascotas con observación rábica en curso + casos bite_incident abiertos (deduplicados) + leptospirosis/hidatidosis de los últimos 30 días — un stock que no depende del período.",
        formula:
          "primario = COUNT DISTINCT(outbreak_signal en [desde, hasta]) en alcance · activas hoy = COUNT DISTINCT(pets en obs. rábica O caso bite abierto) + COUNT(disease_reported='lepto', 30d) + COUNT(disease_reported='hidatidosis', 30d)",
      },
    },
    {
      // Coherence hybrid (cowork QA H6): the PRIMARY is the in-period count — the
      // SAME population the map bubbles + the Registros list show for the active
      // period (so "195 en el período" == the map), and it tracks the scrubber.
      // The all-time backlog ("2.202 activas") rides as a clearly-labeled SECONDARY
      // so the useful work-queue total stays visible without masquerading as the
      // in-view count (the 965-vs-2.202 mismatch the QA flagged).
      id: "denuncias",
      label: "Denuncias en el período",
      value: formatCount(welfare.inPeriod),
      sub: welfare.inPeriod === 1 ? "denuncia en el período" : "denuncias en el período",
      // T2.2: the backlog arm has NO date bound — it is an all-time stock
      // evaluated at NOW, so beside a scrubbed PRIMARY the old "acumulado: N"
      // read as if it belonged to the same frame. "hoy" names the base
      // explicitly; threading asOf into the backlog query is deferred.
      secondary: `acumulado hoy: ${formatCount(welfare.count)} ${
        welfare.count === 1 ? "activa en total" : "activas en total"
      }`,
      tone: welfare.inPeriod > 0 ? "warn" : "neutral",
      href: "/gob/maltrato",
      source: "govt-home-kpis.fetchOpenWelfareReportsCount",
      info: {
        definition:
          "PRIMARIO: denuncias de bienestar creadas en el período y alcance seleccionados (cualquier estado, visibles según moderación) — la misma población que muestran el mapa y la lista de Registros. SECUNDARIO (backlog): denuncias con estado no terminal (ni 'closed', 'invalid' ni 'duplicate') acumuladas de todo el tiempo — la cola de trabajo de la bandeja de maltrato.",
        formula:
          "primario = COUNT(welfare_reports donde created_at ∈ [desde, hasta], visibles) en alcance · backlog = COUNT(welfare_reports donde status NOT IN ('closed','invalid','duplicate')) en alcance",
        caveat:
          "La ubicación en el mapa es aproximada (centroide de localidad); el conteo refleja el alcance, no el recuadro visible. El backlog es un stock calculado al día de hoy: no depende del período ni de la línea de tiempo; el primario sí se mueve con la línea de tiempo.",
      },
    },
    {
      // Orphaned-layer wiring — mortality (pets.status='deceased'), summed from the
      // SAME province choropleth loader the map draws (loadMortalityByProvince) so
      // the headline equals Σ(map cells). STOCK (estado actual): a current-state
      // count that does NOT vary with the scrubber.
      id: "mortalidad",
      label: "Mortalidad registrada",
      value: formatCount(mortalityTotal),
      sub:
        mortalityTotal === 1
          ? "mascota fallecida (estado actual)"
          : "mascotas fallecidas (estado actual)",
      currentState: true,
      tone: mortalityTotal > 0 ? "warn" : "neutral",
      href: "/gob/mortalidad",
      source: "repository.loadMortalityByProvince",
      info: {
        definition:
          "Mascotas actualmente en estado «fallecida» registradas en miMAR, en el alcance seleccionado. Es un estado actual (no depende del período).",
        formula: "COUNT(mascotas con status='deceased') en alcance",
        caveat:
          "Solo cuenta fallecimientos registrados en miMAR; la mortalidad real puede ser mayor. No depende de la línea de tiempo (estado actual). El detalle (/gob/mortalidad) usa una definición distinta: fallecimientos ocurridos EN el período seleccionado (un flujo), no el stock actual de mascotas fallecidas — los dos números no van a coincidir.",
      },
    },
  ];

  // PER-TILE DEGRADATION post-pass: replace any tile whose PRIMARY fetcher rejected
  // with an honest "no disponible" placeholder — same id/label/href/source/info
  // (so the operator still sees WHICH metric failed and what it would measure), but
  // NO numbers (value "—", neutral, `unavailable`). This runs AFTER the literal
  // build so the metadata is single-sourced from the tile definitions above; a
  // fulfilled primary keeps its real, parity-true numbers untouched.
  const PRIMARY_INDEX: Partial<Record<PanoramaKpiId, number>> = {
    cobertura: 0,
    esterilizacion: 6,
    microchip: 12,
    ppp: 18,
    perdidas: 2,
    reunificacion: 11,
    mordeduras: 3,
    zoonosis: 16,
    denuncias: 5,
    mortalidad: 19,
  };
  const degradedKpis: PanoramaKpi[] = kpis.map((tile) => {
    const idx = PRIMARY_INDEX[tile.id];
    // `settled[idx]` is the heterogeneous tuple's union; only `.status` is common,
    // so check it directly (the generic `fulfilled` guard can't unify the union).
    if (idx === undefined || settled[idx].status === "fulfilled") return tile;
    return {
      id: tile.id,
      label: tile.label,
      href: tile.href,
      source: tile.source,
      info: tile.info,
      currentState: tile.currentState,
      value: "—",
      tone: "neutral",
      unavailable: true,
    };
  });

  // Strip-level empty state ONLY when EVERY tile is unavailable (all primaries
  // rejected): throw the typed error so callers convert it to the empty degraded
  // payload, exactly as the historical all-or-nothing path did. A PARTIAL failure
  // keeps the surviving tiles and their real numbers.
  if (degradedKpis.every((k) => k.unavailable)) {
    throw new PanoramaKpisUnavailableError(rejections.length);
  }

  // Fence honesty (cowork round 2): a NON-admin operator whose scope resolved to
  // ZERO jurisdictions (fenced out of the requested province) has NO data in
  // scope — the fetchers legitimately return 0, but "0%"/"0" reads as a real
  // measured zero (looks like "this province has no coverage"). Blank the values
  // to "—" so the strip matches the map + dock ("sin datos en tu alcance"); the
  // recalc caption already says so. Admin universal ([] = national) is exempt.
  const noScopeData = !hasNationalReadScope(actor.role) && jurisdictions.length === 0;
  const displayKpis = noScopeData
    ? degradedKpis.map((k) => ({
        ...k,
        value: "—",
        sub: undefined,
        bar: undefined,
        delta: undefined,
        sparkline: undefined,
        secondary: undefined,
        currentState: undefined,
        tone: "neutral" as const,
      }))
    : degradedKpis;

  return {
    kpis: displayKpis,
    recalculatedFor: describeRecalc(actor, jurisdictions, adminProvince, adminLocality),
    dataAsOf: ingestAt?.toISOString() ?? null,
    // Context denominator ("N mascotas en cobertura") — a footer caption, not a
    // headline tile (metric-honesty demotion 2026-07-09). Same fetcher
    // (fetchAnalyticsMetrics.totalPets) as before; only its placement changed.
    // Per-tile degradation: null when the analytics fetcher itself rejected — the
    // footer caption is omitted rather than showing a fabricated denominator.
    coverageDenominator: analytics
      ? {
          totalPets: analytics.totalPets,
          // F9 (2026-08-01): registry_total_pets is published in exactly ONE
          // place now — the Programa hub's Resumen vista ("Total registradas").
          // The Analítica vista used to carry a second tile over the same
          // predicate and no longer does, so this caption points at the single
          // publisher instead of at the tab that stopped publishing it.
          href: "/gob/programa?vista=resumen",
        }
      : null,
  };
}

/** es-AR cue describing the alcance the KPIs were recalculated for. */
function describeRecalc(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): string {
  if (hasNationalReadScope(actor.role)) {
    if (adminLocality) {
      return `Recalculado para ${adminLocality}, ${adminProvince} y el período seleccionado.`;
    }
    if (adminProvince) {
      return `Recalculado para ${adminProvince} y el período seleccionado.`;
    }
    return "Recalculado para el alcance nacional y el período seleccionado.";
  }
  if (jurisdictions.length === 0) {
    // NON-admin with zero jurisdictions in scope. This is NOT national reach —
    // "alcance nacional" is reserved for the admin branch above. An empty set
    // here means either the operator selected a province OUTSIDE their scope
    // (narrowGovtScope filtered it to []) or they hold no assignment; in both
    // cases the data is correctly empty. Say so honestly instead of implying a
    // national recompute (QA histórico 2026-07-08 #81: the footer lied).
    return "Sin datos en tu alcance para el período seleccionado.";
  }
  // QA fix (2026-07-11 adversarial cowork, §3): a single-jurisdiction govt
  // operator scoped to ONE LOCALITY (e.g. Palermo in CABA) saw "Recalculado
  // para CABA" — the copy named the PROVINCE and silently dropped the
  // narrower locality scope, reading as if the whole province had been
  // recalculated. Name the actual scope unit: the locality (with its
  // province for disambiguation) when the single jurisdiction pins one,
  // otherwise the province (a whole-province assignment, no locality pinned).
  if (jurisdictions.length === 1) {
    const [only] = jurisdictions;
    return only.locality
      ? `Recalculado para ${only.locality}, ${only.province} y el período seleccionado.`
      : `Recalculado para ${only.province} y el período seleccionado.`;
  }
  const provinces = [...new Set(jurisdictions.map((j) => j.province))];
  const where = provinces.length === 1 ? provinces[0] : `${provinces.length} provincias`;
  return `Recalculado para ${where} y el período seleccionado.`;
}
