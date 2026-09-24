// lib/metrics/ — Pattern-B projection foundation barrel.
//
// All aggregate dashboard fetchers (govt-home-kpis, govt-dashboards, admin-metrics)
// import their shared primitives from here. Items 2–4 (new metrics) build their
// fetchers natively on these exports.
//
// Pattern B: population-level SQL aggregates, jurisdiction-scoped, period-aware,
// k-anonymity enforced. See docs/architecture/hexagonal-lite.md §Pattern B.

export type {
  DashboardActor,
  DashboardJurisdiction,
  ProjectionContext,
  ProjectionScope,
} from "./context";
export {
  buildProjectionContext,
  censusEligibleProvince,
  ctxKey,
  isSubProvincialScope,
} from "./context";

export type { Cell, MetricResult, SuppressedCells } from "./types";

export type { SuppressOpts } from "./anonymity";
export { complementarySuppress, suppressSmallCells, suppressedMetric } from "./anonymity";

export {
  petsScopeClause,
  petEventsScopeClause,
  jurisdictionPairClause,
  seesSyntheticRows,
  syntheticRowExclusion,
  withoutSyntheticRows,
} from "./scope";

export { activePetsCondition, dogsInScopeCondition, petEventsInScopeCondition } from "./population";

// Shared rabies-vaccination predicate — single definition of the
// rabies_coverage_dogs_12m numerator for EXISTS-shaped queries (C3).
export {
  RABIES_VACCINE_NAME_REGEX,
  rabiesCurrentlyValidCondition,
  rabiesDoseQualifies,
  rabiesSignedByMatriculaCondition,
  rabiesVaccinatedExists,
} from "./rabies";

export { cachedActivePetCount, cachedDogCount } from "./cache";

export { resolveAnalyticsPeriod, windows } from "./period";
export type { AnalyticsPeriod, PeriodSearchParams } from "./period";

// Bucketed time-series (trend) projections — D1. Pure transforms live in
// ./timeseries; the DB-bound scope-aware fetchers live in ./trends.
export type {
  BucketGranularity,
  SeriesBucketRow,
  StackedPoint,
  StackedSeries,
} from "./timeseries";
export {
  bucketGranularityFor,
  dateTruncUnit,
  formatBucketLabel,
  futureBucketLabel,
  isoWeekLabel,
  pivotStackedSeries,
  suppressSmallBuckets,
  suppressSmallStackedCells,
} from "./timeseries";
export type { SingleSeriesTrend, StackedTrend } from "./trends";
export {
  fetchBitesTrend,
  fetchDeathCausesTrend,
  fetchKpiTrend,
  fetchOutbreakSignalsTrend,
  fetchRabiesVaccinationTrend,
} from "./trends";

// Paquete J — pure trend projection (forecast) over flow series.
export type {
  CrossingDirection,
  ForecastMethod,
  ForecastOpts,
  ForecastPoint,
  ForecastResult,
  SeriesPoint,
} from "./forecast";
export { DEFAULT_HORIZON, MIN_POINTS, projectSeries, targetCrossing } from "./forecast";

// FORECAST-A-META — a metric's forecast as a PROPERTY of its (current,
// target) pair, rendered where the number already lives (see
// lib/metrics/kpi-catalog.ts's `forecast` field for which KPIs qualify).
export type {
  ForecastToTargetInput,
  ForecastToTargetResult,
  ForecastTrendPoint,
  ResourceGapInput,
  ResourceGapResult,
} from "./forecast-to-target";
export {
  MAX_HORIZON_MONTHS,
  MIN_TREND_POINTS,
  forecastToTarget,
  resourceGap,
} from "./forecast-to-target";

// PO-interview decision 2, item 1 — gap×población ranking: which
// jurisdiction's below-target gap matters most in real-world units, not just
// an abstract percentage. See lib/metrics/impact-ranking.ts's module header.
export type { ImpactRankable, ImpactRow, ImpactSummary, ImpactTotal } from "./impact-ranking";
export {
  DEFAULT_IMPACT_TOP_N,
  NO_POPULATION_NOTE,
  computeImpact,
  formatImpactUnits,
  formatTopImpactLine,
  isImpactMet,
  rankByImpact,
  summarizeTopImpact,
  totalImpactByJurisdiction,
} from "./impact-ranking";

// Fase 0 additions — targets, tone, delta, freshness.
export {
  TARGETS,
  computeDeltaPct,
  decisionsDeltaPct,
  enoSlaHeadline,
  enoSlaTone,
  rabiesComplianceHeadline,
  rabiesComplianceTone,
  toneForBreachCeiling,
  toneForTarget,
} from "./targets";
export { lastIngestAt } from "./freshness";

// C1 — metric-contract guard engine (dim-interno:docs/reviews/results/
// 2026-07-22-plan-maestro-integridad.md). Pure presentation guards enforcing
// kpi-catalog.ts's guards/semaphore fields at render time.
export {
  UNSTABLE_DELTA_BASE_NOTE,
  ZERO_DENOMINATOR_DASH,
  applyCensusCoverageGuard,
  censusCoverageLowGate,
  censusCoverageWarningNote,
  guardRatioTone,
  resolveSemaphoreTone,
  shouldSuppressDelta,
  smallNGate,
  smallNNote,
  zeroDenominatorGate,
} from "./presentation-guards";
export type { CensusGuardedTone, GuardedRatio, Tone as GuardTone } from "./presentation-guards";

// D4 reunification rate, per administrative unit — feeds the Panorama
// `reunificacion` layer (src/modules/panorama/infrastructure/repository.ts).
export { fetchReunificationByUnit } from "./reunification-rollups";
export type { ReunificationByUnitKpi, ReunificationByUnitRow } from "./reunification-rollups";

// Paquete E — censo poblacional & salud del registro.
export {
  DORMANT_MONTHS_DEFAULT,
  ESTIMATED_DOGS_PER_INHABITANT,
  assertFunnelMonotonic,
  classifyDormant,
  computeCensusCoverage,
  estimateDogPopulation,
  funnelPercents,
  getCensusPopulationsCached,
  identificationFunnel,
  isIncompleteProfile,
  registryCounts,
  registrationTrend,
  registryByProvince,
  resetCensusPopulationsCache,
} from "./census";

// D.10 disclosure rule for per-province aggregates (censo + control poblacional).
// The ONE place the "own jurisdiction real, foreign sub-k withheld" verdict is
// made — screens and CSV exports consume already-decided rows, never raw values.
export {
  SUPPRESSED_CELL_TEXT,
  planProvinceDisclosure,
  provinceSuppressionNotice,
  scopeSummaryRow,
  scopeTotalSuppressionNotice,
} from "./province-disclosure";
export type { ProvinceDenominatorRow, ProvinceDisclosurePlan } from "./province-disclosure";
export type {
  CensusCoverage,
  FunnelStages,
  ProvinceRegistryResult,
  ProvinceRegistryRow,
  RegistryCounts,
} from "./census";

// Paquete F — pipeline de custodia & adopción.
export {
  funnelBarWidths,
  returnRate,
  timeInStateNonNegative,
  fetchAdoptionTrend,
  fetchCustodyFunnel,
  fetchFosterPoolUtilization,
  fetchPrevAdoptionCount,
  fetchReturnRate,
  fetchShelterOccupancyNational,
  fetchTimeInState,
} from "./custody";
export type {
  CustodyFunnel,
  FosterPoolUtilization,
  FunnelCounts,
  ShelterOccupancy,
  TimeInStateRow,
} from "./custody";

// Paquete H — salud operativa del programa.
export {
  completeness,
  countAlertedProvinces,
  fetchCrossJurisdictionOutliers,
  fetchDataQuality,
  fetchPiiOversight,
  isOutlier,
  K_ANON_MIN,
} from "./program-health";
export type { DataQuality, OutlierMetric, OutlierRow, PiiOversightRow } from "./program-health";

// Paquete H — alert subscriptions (threshold alerts on /admin/programa).
export { evaluateAlertSubscriptions, isBreaching } from "./alert-evaluation";
export type { EvaluatedSubscription } from "./alert-evaluation";

// Paquete G — control poblacional.
export {
  computeNetGrowth,
  coverageRate,
  fetchActivePregnancies,
  fetchNetGrowth,
  fetchPrevRegisteredBirths,
  fetchReproductiveOutcomes,
  fetchSterilizationCoverage,
  fetchSterilizationNatalidadRatio,
  fetchSterilizationTrend,
  safeRatio,
} from "./population-control";
export type {
  NetGrowthResult,
  ProvinceSterlizationRow,
  ReproductiveOutcomeKey,
  ReproductiveOutcomes,
  SterilizationCoverageResult,
} from "./population-control";

// 26/48 coverage-gap fill — four high-yield events surfaced on existing /gob
// dashboards (deworming coverage · vet-access gap · movement corridors · adoption
// application funnel). Each reads the append-only pet_events spine, jurisdiction-
// scoped via petsScopeClause.
export { fetchDewormingCoverage } from "./deworming";
export type { DewormingCoverageResult, ProvinceDewormingRow } from "./deworming";
export {
  VET_ACCESS_DESERT_ACTS_PER_PET_YEAR,
  VET_ACCESS_DESERT_MIN_PERIOD_DAYS,
  VET_ACCESS_MIN_ACTIVE_PETS,
  VET_ACTIVITY_EVENT_TYPES,
  classifyVetAccess,
  fetchVetAccessByLocality,
  perThousand,
  vetAccessDesertThresholdPer1k,
} from "./vet-access";
export type { VetAccessBand, VetAccessResult, VetAccessRow } from "./vet-access";
export { fetchMovementCorridors } from "./movement";
export type { MovementCorridorsResult } from "./movement";
export { approvalRate, fetchAdoptionApplicationFunnel } from "./adoption-funnel";
export type { AdoptionFunnelResult } from "./adoption-funnel";
