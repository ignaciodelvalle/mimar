// lib/metrics/kpi-catalog.ts — KPI-definition-as-code catalog (Wave B systemic fix).
//
// C1 — METRIC CONTRACT (dim-interno:docs/reviews/results/2026-07-22-plan-maestro-integridad.md,
// §2 "C1 · Contrato de Métrica"): this module graduates from KPI documentation
// to an EXECUTABLE contract. The systemic failure C1 targets: "a KPI today is a
// fetcher + a label + a color decided ad-hoc per screen" — nothing forces a
// render site to declare the decision question, a target + its legal/programmatic
// source, when a color is legitimate, or the presentation guards that keep a
// small-N rate or a 0/0 ratio from reading as a confident verdict. The fields
// added below (question/target/semaphore/guards/confidence/exclusions) are that
// contract; lib/metrics/presentation-guards.ts is the renderer-side engine that
// enforces `guards`/`semaphore` ONCE instead of per-screen ad-hoc logic.
//
// WHY THIS EXISTS
// ----------------
// The four-actor critique + gob audit (dim-interno:docs/design/handoffs/critiques-smoke-2026-07-03/
// critique-govt-2026-07-03.md) found that "Cobertura antirrábica" showed 42% on the
// Panel/Panorama surfaces and 54% on Analítica/Vigilancia — SAME label, TWO different
// computations (dogs-only/12m/anchored-regex vs all-species/all-time/substring-match).
// An operator has no way to tell these apart from the label alone.
//
// This module is the single source of truth for "what does this KPI actually MEAN":
// numerator, denominator, source tables/events, cadence (time window), and unit —
// for every program KPI surfaced on the /gob dashboards. It is DOCUMENTATION-AS-CODE,
// not a new computation: no KPI's math changes here. Fetchers keep living where they
// already do (lib/metrics/**, lib/analytics/govt-*.ts, lib/analytics/compliance-metrics.ts,
// lib/analytics/mortality-metrics.ts) — this catalog just names and cross-references them.
//
// DISAMBIGUATION (the fix for the 42%/54% drift):
//   RABIES_COVERAGE_DOGS_12M            — dogs only, trailing 12 months, anchored regex.
//   RABIES_VACCINATION_RATE_ALL_SPECIES — all species, all-time, substring match.
//   These get DISTINCT es-AR labels below. Neither is "wrong" — they answer different
//   questions ("are the dogs we're legally required to vaccinate covered in the last
//   year?" vs "what fraction of the whole registry has ever had a rabies shot logged?").
//   The bug was sharing one label across two answers, not the math itself.
//
// SCOPE / NON-GOALS
//   - This catalog does NOT invent new metrics or composite/derived scores (PO decision).
//   - It does NOT change any fetcher's numerator or denominator.
//   - The rabies-coverage render-site label swap is DONE — every render site imports
//     the lib-level label constant (RABIES_COVERAGE_LABEL_ES in govt-home-kpis.ts,
//     RABIES_VACCINATION_RATE_LABEL_ES in govt-dashboards.ts; client-safe ones in
//     kpi-label-constants.ts). scripts/check-metric-labels.ts guards against a render
//     site drifting back to a retyped string for a catalogued KPI's label.
//
// MAINTENANCE
//   Adding a KPI to a /gob page? Add its entry here in the same PR. The test in
//   kpi-catalog.test.ts asserts every KPI fetcher imported by app/gob/page.tsx from
//   lib/analytics/{govt-home-kpis,compliance-metrics,mortality-metrics} has a matching
//   `fetcherName` in this catalog — CI fails if a new home-page KPI ships undocumented.

import { COMPLIANCE_KPI_CATALOG, type ComplianceKpiId } from "./kpi-catalog-compliance";
import { QUEUE_KPI_CATALOG, type QueueKpiId } from "./kpi-catalog-queues";
import { REUNIFICATION_RATE_LABEL_ES } from "./kpi-label-constants";
import { TARGETS } from "./targets";

/** Stable identifier for a catalogued KPI. Snake_case, never reused once shipped. */
export type KpiId =
  // Operational-queue + mandated-compliance descriptors live in sibling
  // modules (this file is against its file-size ratchet) — same contract,
  // same KPI_CATALOG.
  | QueueKpiId
  | ComplianceKpiId
  | "rabies_coverage_dogs_12m"
  | "rabies_vaccination_rate_all_species"
  | "sterilization_coverage_population"
  | "sterilizations_per_month"
  | "bites_per_10k"
  | "active_zoonosis_signals"
  | "open_rabies_observations"
  | "open_bite_cases"
  | "notified_diseases"
  | "microchip_penetration"
  | "ppp_registry_compliance"
  | "open_welfare_reports"
  | "my_assigned_welfare_reports"
  | "mortality_disposal_traceability"
  | "mortality_deaths_12m"
  | "active_pregnancies"
  | "sterilization_natalidad_ratio"
  | "data_quality_completeness"
  | "custody_return_rate"
  | "shelter_occupancy_national"
  | "deworming_coverage_population"
  | "vet_access_per_1k_locality"
  | "movement_volume"
  | "adoption_application_conversion"
  | "eno_sla_compliance"
  | "reunification_rate"
  | "bite_escalation_gap"
  | "outbreak_active_signals"
  | "rabies_observation_cases_open"
  | "pets_registered_today"
  | "vaccinations_weekly"
  | "outbreak_investigations_active"
  | "outbreak_signals_untriaged"
  | "rabies_observation_compliance_10d"
  | "amr_density"
  | "registry_total_pets"
  | "alerted_provinces_below_target"
  | "registry_active_pets"
  | "registry_dormant_pets"
  | "registry_incomplete_profiles"
  | "registered_births"
  | "net_registry_inflow"
  | "shelter_custody_occupied"
  | "foster_active_placements"
  | "adoptions_finalized"
  | "campaign_enrollment"
  | "campaign_completion_rate"
  | "campaign_attendance"
  | "campaign_no_show"
  | "campaign_sanitary_outcome"
  | "outreach_overdue_rabies_count"
  | "outreach_stray_scan_areas"
  | "outreach_sterilization_vets_ranked"
  | "mortality_deaths_period"
  | "mortality_unknown_disposal_rate"
  | "mortality_reportable_share"
  | "lost_pets_active_stock"
  | "lost_pets_recovered_30d"
  | "lost_pets_avg_days_active"
  | "reunification_median_recovery_days"
  | "acquisition_adoption_rate"
  | "custody_disputes_open"
  | "seizures_period_count"
  | "maltrato_unassigned_count"
  | "maltrato_assigned_to_me_count"
  | "maltrato_in_progress_count"
  | "maltrato_closed_30d_count"
  | "territorial_index_provinces_evaluated"
  | "territorial_index_average_score"
  | "policy_outcome_rule_changes_analyzed"
  | "ghost_records_count";

/** Unit of the KPI's `value` field, for consistent formatting across surfaces. */
export type KpiUnit = "percent" | "count" | "rate_per_10k" | "ratio" | "days";

/**
 * Machine-readable time window — the SAME axis that split "Cobertura
 * antirrábica" into two truths (42% trailing-12m vs 54% all-time). `cadence`
 * carries the full prose; `window` is the short categorical tag a render site
 * or the check-metric-labels guard can compare without parsing prose.
 * "mixed" is for composites whose sub-parts use different windows (e.g.
 * active_zoonosis_signals: a 'now' snapshot unioned with a 30d flow count).
 */
export type KpiWindow = "now" | "7d" | "30d" | "12m" | "all_time" | "period" | "mixed";

/**
 * Which pets the numerator/denominator population is drawn from — the OTHER
 * axis of the "Cobertura antirrábica" split (dogs-only vs any species).
 * "n/a" is for KPIs whose scope isn't pet-species-shaped (case/report counts,
 * human-population-denominated rates).
 */
export type KpiSpecies = "dogs" | "all_species" | "n/a";

/**
 * Counting basis, independent of `unit`: "stock" is a point-in-time count of
 * entities currently in a state (open cases, active pregnancies); "flow" is a
 * count of events that occurred within `window`; "ratio" is a
 * numerator/denominator computation (percent, rate, or dimensionless ratio),
 * regardless of whether `unit` renders it as "percent" or "rate_per_10k".
 */
export type KpiBasis = "stock" | "flow" | "ratio";

/**
 * es-AR user-facing copy for the OpKpi ⓘ "acerca de métricas" tooltip
 * (components/ui/dashboard/OpKpi.tsx's `InfoTooltip` prop shape — kept as a
 * STRUCTURALLY compatible, independently-declared type rather than an import,
 * so this lib module stays component-free/DB-free/pure; see kpi-catalog.test.ts).
 *
 * WHY THIS EXISTS (task #15a — staging-readiness triage):
 * numerator/denominator/cadence above are ENGLISH developer documentation.
 * The ⓘ tooltip an operator sees must be es-AR product copy — a different
 * register, not a translation. `ui` is the ONE place that copy lives; render
 * sites call `getKpiInfo(id)` instead of repeating an inline `info={{ ... }}`
 * object, so the same KPI can no longer show worded-differently text on two
 * screens (the same failure mode the label-uniqueness fix above addresses,
 * just for the tooltip body instead of the headline label).
 */
export type KpiInfoTooltip = {
  /** Plain-language es-AR definition of what the KPI measures. */
  definition: string;
  /** Optional short formula/predicate string, es-AR labels + SQL-ish shorthand. */
  formula?: string;
  /** Optional caveat — legal basis, under/over-counting risk, suppression note. */
  caveat?: string;
};

// ---------------------------------------------------------------------------
// C1 contract fields — question / target / semaphore / guards / confidence
// ---------------------------------------------------------------------------

/**
 * The benchmark value a KPI is judged against, plus WHO set it. `source`
 * names the law/programme/benchmark (e.g. "Ley 22.953", "meta programática",
 * "benchmark RSPCA") — the S1 fix for "semáforo como veredicto legal": a
 * render site can now tell a legal mandate apart from an aspirational
 * internal goal instead of painting both the same red/green.
 *
 * `value` must be POPULATED BY REFERENCING lib/metrics/targets.ts's `TARGETS`
 * constant (e.g. `TARGETS.RABIES_COVERAGE_PCT`), never by retyping the
 * number — the whole point of centralising targets.ts was to kill duplicate
 * magic numbers; a catalog entry that re-types "80" instead of importing
 * `TARGETS.RABIES_COVERAGE_PCT` reintroduces exactly that drift risk.
 */
/**
 * Cursor red-team 2026-07-23 (claim #6) — "law next to meta" conflation
 * class: a render site that interpolates `target.value` next to
 * `target.source` verbatim reads "meta 80% (Ley 22.953)" as if the STATUTE
 * set the number, when the law only creates the underlying OBLIGATION
 * (vaccinate/chip/dispose traceably) and the specific % is a programmatic
 * choice never written into the text of the law. `sourceKind` lets a
 * renderer tell these apart:
 *
 *  - "statutory-obligation": the NUMBER is itself what the law/ordinance
 *    requires (e.g. 100% PPP attestation is compulsory by definition; 100%
 *    10-day-window compliance is what "no missed legal deadlines" means).
 *    Law and number are the same fact — safe to render together unchanged.
 *  - "programmatic-target": a real law/ordinance underlies the metric, but
 *    the specific threshold is an internal/programmatic choice the law does
 *    NOT itself set — the renderer must separate "obligación" (the law) from
 *    "meta programática" (the number) so neither reads as authored by the
 *    other.
 *  - "benchmark": no legal obligation at all — an internal program KPI or an
 *    external reference figure (RSPCA, ANMAT/SENASA operational benchmark).
 */
export type KpiTargetSourceKind = "statutory-obligation" | "programmatic-target" | "benchmark";

export type KpiTarget = {
  value: number;
  source: string;
  /** See KpiTargetSourceKind — required so every target-bearing entry makes
   *  this classification explicit (the sweep the C1 red-team fix demands). */
  sourceKind: KpiTargetSourceKind;
};

/**
 * What the tile's tone is legitimately painted against.
 *
 *  - "target": tone derives from comparing the current value to `target`
 *    (typically via `toneForTarget`) — only meaningful when `target` is set.
 *  - "none": there is no target whose miss constitutes a legal/programmatic
 *    failure (or the KPI is a pure uptake/adoption/historical number). The
 *    renderer must NEVER paint an ok/warn/danger "legal verdict" tone from
 *    this KPI — it degrades to "blue" (informational/progress) or "neutral".
 *    This is the fix for red-team #7 (PPP self-serve adoption painted
 *    "Peligro") and the historic all-species rabies tile (S1: "doble
 *    antirrábica").
 */
export type KpiSemaphorePolicy = {
  paintAgainst: "target" | "none";
};

/**
 * What feeds the confidence note shown alongside the value — padrón
 * coverage, k-anonymity suppression, data freshness, sample size, etc.
 * Prose inputs, not a computed score (a numeric confidence SCORE is Ola
 * 2/C4 territory, not this contract).
 */
// Presentation guards live in their own module (file-size fence, 2026-08-01).
import { DELTA_IMPLAUSIBLE_GUARD, type KpiGuards } from "./kpi-guards";
export { formatKpiTarget } from "./kpi-target-copy";
export * from "./kpi-guards";

export type KpiConfidence = {
  inputs: string[];
};

/**
 * FORECAST-A-META (dim-interno:docs/reviews — 2026-07-22): the forecast a KPI can carry
 * is a PROPERTY of the metric, declared here, not a new screen or chart.
 * `trendSource` documents WHICH already-fetched trend feeds it — the honesty
 * rule mirrors `target.source`: a render site must be able to point at a
 * real fetcher already in its own bounded Promise.all, never a new query.
 *
 * Only set this when the render surface can derive a genuine PER-BUCKET
 * ratio/rate from that trend (numerator AND denominator both resolvable
 * within the same bucket) — a trend of the metric's NUMERATOR alone (a flow
 * count) is not the same thing and must not be wired here. This is why most
 * target-bearing ratio KPIs do NOT set `forecast`: their only fetched trend
 * is a numerator flow (e.g. rabies_coverage_dogs_12m's fetchRabiesVaccination-
 * Trend is vaccinations/bucket, not a recomputed coverage-% per bucket), or no
 * trend is fetched at all. See lib/metrics/forecast-to-target.ts for the engine.
 */
export type KpiForecast = {
  /** Fetcher (+ file) whose ALREADY-FETCHED series this forecast reuses —
   *  e.g. "fetchAcquisitionTrend (lib/analytics/dashboards/analytics.ts)". */
  trendSource: string;
};

export type KpiDefinition = {
  /** Stable id — see KpiId. */
  id: KpiId;
  /**
   * The decision question this KPI answers, es-AR, plain language — e.g.
   * "¿Están los perros de la jurisdicción vacunados contra la rabia según lo
   * exige la ley?". Forces every catalogued KPI to justify WHY it is on a
   * screen, not just WHAT it counts (S1: "un KPI es un fetcher + un label +
   * un color decididos ad-hoc"). Optional while the barrido (follow-up) has
   * not yet reached every entry — new entries in this task's 8 first
   * consumers all set it.
   */
  question?: string;
  /** Benchmark + its legal/programmatic source — see KpiTarget. Omit when no
   *  target is legitimate for this KPI (e.g. a pure historical/uptake count). */
  target?: KpiTarget;
  /** Tone-painting policy — see KpiSemaphorePolicy. Omit only for KPIs that
   *  don't render a tone at all (pure counts with no color). */
  semaphore?: KpiSemaphorePolicy;
  /** Presentation guards — see KpiGuards. Omit fields that don't apply. */
  guards?: KpiGuards;
  /** What feeds the confidence note next to the value — see KpiConfidence. */
  confidence?: KpiConfidence;
  /** FORECAST-A-META: which already-fetched trend backs a forecast-to-target
   *  line for this KPI — see KpiForecast. Omit unless a real per-bucket
   *  ratio trend is at hand (the honesty rule, not a target/gap rule). */
  forecast?: KpiForecast;
  /**
   * PO-interview decision 2, item 2 ("forecasts que informen qué falta, no
   * solo cuándo"): the real-world noun for lib/metrics/forecast-to-target.ts's
   * `resourceGap()` — "faltan ~N {resourceUnit}". Only set for a ratio KPI
   * whose gap maps to a genuinely countable resource (a dose, a surgery, a
   * chip) — omit for KPIs with no such 1:1 resource (e.g. a traceability %
   * doesn't "need N disposals" the same honest way a coverage % needs N
   * doses). Always a plural noun, lowercase, es-AR.
   */
  resourceUnit?: string;
  /** Free-form prose naming what this KPI's population EXCLUDES, when that
   *  exclusion could otherwise be mistaken for under-counting (e.g. "no
   *  incluye reportes sin escalar"). Omit when `caveat` already covers it. */
  exclusions?: string;
  /** es-AR display label. MUST be distinct from any other catalog entry's label —
   *  this is the field that fixes the "same label, two truths" bug. */
  label: string;
  /** What is counted in the numerator, in plain language + the matching predicate. */
  numerator: string;
  /** What is counted in the denominator (or "n/a" for absolute counts). */
  denominator: string;
  /** Tables / event types this KPI reads from. */
  source: string;
  /** Exported fetcher function name — cross-referenced by the /gob coverage test. */
  fetcherName: string;
  /** File where the fetcher lives (relative to repo root). */
  fetcherPath: string;
  /** Time window / recomputation cadence (e.g. "trailing 12 months", "all-time", "now"). */
  cadence: string;
  /** Display unit. */
  unit: KpiUnit;
  /** k-anonymity or other suppression applied, if any. "none" when not applicable. */
  suppression: string;
  /** Free-form caveat — under/over-counting risks, legal basis, etc. Omit if none. */
  caveat?: string;
  /** Machine-readable time window — short tag version of `cadence`. */
  window: KpiWindow;
  /** Machine-readable species scope — short tag version of the numerator/denominator prose. */
  species: KpiSpecies;
  /** Machine-readable counting basis — stock / flow / ratio. */
  basis: KpiBasis;
  /** es-AR OpKpi ⓘ tooltip copy — omit while a KPI hasn't been wired through
   *  getKpiInfo() yet (inline `info={{ }}` prop at the render site until then).
   *  Task #15a wired the first batch — see dim-interno:docs/reviews/2026-07-12-staging-readiness-triage.md. */
  ui?: KpiInfoTooltip;
  /** K8: methodology-version stamp — 2 ONLY on descriptors whose numerator/
   *  label/target changed 2026-07-22/23 (see each entry's own comment); omitted = v1. Rendered in OpKpi's ⓘ footer. Do NOT set broadly. */
  methodologyVersion?: number;
};

export const KPI_CATALOG: Record<KpiId, KpiDefinition> = {
  // Operational-queue + mandated-compliance descriptors — declared in their
  // sibling modules, spread in here so `KPI_CATALOG.<id>` stays the ONE
  // lookup every render site uses.
  ...QUEUE_KPI_CATALOG,
  ...COMPLIANCE_KPI_CATALOG,
  rabies_coverage_dogs_12m: {
    id: "rabies_coverage_dogs_12m",
    label: "Cobertura antirrábica — perros (12 meses)",
    numerator:
      "COUNT DISTINCT dogs with ≥1 vaccination_administered event where vaccine_name matches the anchored regex /(antirr[áa]bica|rabies)/i (via the amendment overlay — corrected names count under their current value), occurred_at within the trailing 12 months",
    denominator: "COUNT active/lost dogs (pets.species = 'dog') in scope",
    source: "pets, pet_events (vaccination_administered)",
    fetcherName: "fetchRabiesCoverage",
    fetcherPath: "lib/analytics/govt-home-kpis.ts",
    cadence: "trailing 12 months, recomputed on every render",
    unit: "percent",
    suppression: "none (province rows are never small enough to require k-anon)",
    caveat:
      "Legal basis: Ley 22.953 (vacunación antirrábica obligatoria). Only counts vaccines logged in miMAR — real-world coverage may be higher. DISTINCT FROM rabies_vaccination_rate_all_species: different denominator population (dogs only) and time window (12m, not all-time). Rendered on /gob (Panel de jurisdicción) and Panorama — see app/gob/page.tsx and src/modules/panorama/application/get-panorama-kpis.ts (render-site label already reads 'Cobertura antirrábica (perros, 12m)', consistent with this entry).",
    window: "12m",
    species: "dogs",
    basis: "ratio",
    question:
      "¿Están los perros del padrón de la jurisdicción vacunados contra la rabia según lo exige la ley, en los últimos 12 meses?",
    target: {
      value: TARGETS.RABIES_COVERAGE_PCT,
      source: "Ley 22.953 (vacunación antirrábica obligatoria)",
      // The law mandates the VACCINATION obligation, not an 80% threshold —
      // that figure is a public-health programmatic target (see the `ui.caveat`
      // below), so law and number must render as separate facts (claim #6).
      sourceKind: "programmatic-target",
    },
    semaphore: { paintAgainst: "target" },
    guards: {
      zeroDenominator: "dash",
      // Claim #1 — dual-denominator hero: below 20% padrón-of-census
      // coverage, the registry % cannot honestly imply population-level
      // protection (see censusCoverageLowGate's doc comment).
      censusCoverageFloor: 20,
      // Via hasData + direct applyCensusCoverageGuard (gob home, panorama).
      manualEnforcement: true,
    },
    // PO decision 2 item 2 — "faltan ~N dosis" (one dose per unvaccinated dog
    // in the padrón the % is computed over).
    resourceUnit: "dosis",
    confidence: {
      inputs: [
        "cobertura del padrón (registryDenominator) — perros SIN dueño/no registrados no cuentan",
        "estimación censal (censusCoveragePct) — null cuando no hay fila de censo para el scope",
        "frescura: ventana fija de 12 meses, recalculada en cada render",
      ],
    },
    ui: {
      definition:
        "Porcentaje de perros del padrón (activos/perdidos) en la jurisdicción con al menos una vacunación antirrábica registrada en los últimos 12 meses. El padrón es el primer denominador; el segundo es la población canina estimada. Meta de salud pública: 80%.",
      formula:
        "COUNT DISTINCT perros con vaccination_administered (vaccine_name ~* 'antirr[áa]bica|rabies', últimos 12m) / COUNT DISTINCT perros del padrón. «Cobertura del padrón» = perros del padrón / población canina estimada (censo humano × 0,158 perros/hab.).",
      caveat:
        "Solo se cuentan vacunas registradas en miMAR. La cobertura real puede ser mayor si existen campañas fuera del sistema. La «población canina estimada» deriva del censo humano INDEC con un factor de tenencia (0,158 perros/hab., GCBA — Encuesta Anual de Hogares 2022, módulo Tenencia responsable) — es una estimación piso (CABA subestima la tenencia nacional), no un censo canino; sin fila de censo se muestra «sin estimación censal». No existe cifra oficial nacional de población canina (ni INDEC, ni SENASA, ni Ministerio de Salud) — este factor NO se atribuye a OMS/OPS. Lente dual: el titular cuenta dosis declaradas (mayormente por dueños); el sub-renglón «firmado por matrícula» muestra la porción con firma de veterinario matriculado — es divulgación junto al declarado, nunca su reemplazo.",
    },
  },

  rabies_vaccination_rate_all_species: {
    id: "rabies_vaccination_rate_all_species",
    // C1 rename (2026-07-22, plan-maestro §3c / red-team "doble antirrábica"):
    // "Cobertura antirrábica — todas las mascotas (histórico)" still LOOKED
    // like a compliance figure at a glance (same "Cobertura antirrábica" stem
    // as rabies_coverage_dogs_12m). Renamed to something unmistakable — this
    // is NOT a coverage/compliance number, it's an all-time, all-species,
    // no-window historical count with no legal target.
    label: "Vacunación histórica (todas las especies, sin ventana)",
    numerator:
      "COUNT DISTINCT active/lost pets of ANY species with ≥1 vaccination_administered event where unaccent(vaccine_name) ILIKE unaccent('%rabi%') (via the amendment overlay), NO occurred_at filter — all-time",
    denominator: "COUNT active/lost pets (any species) in scope",
    source: "pets, pet_events (vaccination_administered)",
    fetcherName: "fetchAnalyticsMetrics",
    fetcherPath: "lib/analytics/govt-dashboards.ts",
    cadence: "all-time (no trailing window) — recomputed on every render",
    unit: "percent",
    suppression: "none",
    caveat:
      "This is the KPI the four-actor critique flagged as showing 54% under the SAME label as rabies_coverage_dogs_12m's 42% (critique-govt-2026-07-03.md, 'Same metric, different numbers'). Three real differences drive the gap: (1) denominator includes non-dog species, (2) no 12-month window — a vaccine logged years ago still counts, (3) looser match ('%rabi%' substring vs the anchored regex). Neither number is wrong; they answer different questions. Render sites: app/gob/analytics/AnalyticsScreen.tsx (imports RABIES_VACCINATION_RATE_LABEL_ES = 'Vacunación histórica (todas las especies, sin ventana)', matching this entry verbatim — the old ambiguous 'Cobertura antirrábica (mascotas)' copy is gone and guarded against by RegionRankingTable.test.tsx) and the per-province ranking in lib/analytics/analytics-ranking.ts (fetchRegionRanking reuses this SAME all-species/all-time definition, so Analítica's national figure and its ranking table are internally consistent).",
    window: "all_time",
    species: "all_species",
    basis: "ratio",
    methodologyVersion: 2, // K8: label renamed 2026-07-22 (see above)
    question:
      "¿Qué fracción del registro histórico de miMAR tiene alguna vez una dosis antirrábica cargada, de cualquier especie, sin ventana temporal? (NO es la pregunta de cumplimiento legal — esa es rabies_coverage_dogs_12m).",
    // No `target`: there is no legal/programmatic benchmark for an all-time,
    // all-species, no-window count — inventing one would legitimize painting
    // a semaphore over a number that isn't a compliance measurement.
    semaphore: { paintAgainst: "none" },
    confidence: {
      inputs: [
        "sin ventana temporal — una dosis de hace años sigue contando hoy",
        "match por substring ('%rabi%'), no el regex anclado que usa la métrica de cumplimiento",
      ],
    },
    ui: {
      definition:
        "Vista histórica: porcentaje de mascotas activas de CUALQUIER especie con al menos una vacunación antirrábica registrada alguna vez. NO es la métrica de cumplimiento — esa es la cobertura antirrábica del Panel/Panorama (perros con dosis en los últimos 12 meses, Ley 22.953). Por eso este número es más alto.",
      formula:
        "COUNT(pets activos, toda especie, con ≥1 vaccination_administered ~ 'rabi' alguna vez) / COUNT(pets activos) × 100",
      caveat:
        "Sin ventana temporal ni scope de perros: cuenta cualquier dosis histórica. Para el cumplimiento legal usá la tile del Panel.",
    },
  },

  sterilization_coverage_population: {
    id: "sterilization_coverage_population",
    label: "Cobertura de esterilización (stock)",
    numerator: "COUNT DISTINCT active/lost pets with ≥1 sterilization_performed event, ever",
    denominator: "COUNT active/lost pets in scope",
    source: "pets, pet_events (sterilization_performed)",
    fetcherName: "fetchSterilizationCoverage",
    fetcherPath: "lib/metrics/population-control.ts",
    cadence: "point-in-time snapshot (not period-bound — 'ever sterilized', not 'in period')",
    unit: "percent",
    suppression: "none",
    caveat:
      "Programmatic benchmark (70%), not a universal legal mandate — obligatory by provincial law only in Santa Fe, Mendoza, La Rioja, Chubut, San Juan. Shared by /gob/padron (vista Población, F8 fusion) and Panorama (same fetcher — dashboard parity guaranteed by construction).",
    window: "all_time",
    species: "all_species",
    basis: "ratio",
    // PO decision 2 item 2 — "faltan ~N cirugías" (one sterilization surgery
    // per un-sterilized pet in the padrón the % is computed over).
    resourceUnit: "cirugías",
    ui: {
      definition:
        "Fracción de mascotas activas/extraviadas en el scope con al menos un evento sterilization_performed registrado, alguna vez.",
      formula:
        "COUNT(DISTINCT pets WHERE EXISTS sterilization_performed) / COUNT(pets activos/extraviados en scope) × 100",
      caveat:
        "Meta programática 70% (referencia interna — no es mandato legal universal como la cobertura antirrábica; es obligatoria por ley provincial solo en Santa Fe, Mendoza, La Rioja, Chubut y San Juan).",
    },
  },

  sterilizations_per_month: {
    id: "sterilizations_per_month",
    label: "Esterilizaciones / mes",
    numerator: "COUNT sterilization_performed events in the trailing 30 days",
    denominator:
      "n/a — flow count, not a ratio (compared against the prior 30d window for deltaPct)",
    source: "pet_events (sterilization_performed)",
    fetcherName: "fetchSterilizationMetrics",
    fetcherPath: "lib/analytics/govt-home-kpis.ts",
    cadence: "trailing 30 days vs prior 30 days",
    unit: "count",
    suppression: "none",
    window: "30d",
    species: "all_species",
    basis: "flow",
    question: "¿Cuántas esterilizaciones se registraron este mes y cómo viene la tendencia?",
    // No `target`: a flow count has no legal/programmatic benchmark of its
    // own (sterilization_coverage_population's 70% stock target is a
    // DIFFERENT KPI). semaphore stays "none" — this tile has never painted a
    // tone; the guard that matters here is the delta suppression below.
    semaphore: { paintAgainst: "none" },
    guards: {
      // Red-team's "−95% MoM" class: a delta computed against a near-zero
      // prior-30d base swings wildly on one or two events. Floor chosen to
      // match the smallN convention used elsewhere in this task (5) — below
      // it, the % change is not a stable trend, just noise amplified by a
      // tiny denominator.
      unstableDeltaBase: { minPriorBase: 5 },
      // H16 (external red-team 2026-07-30): unstableDeltaBase above only
      // distrusts a TINY prior base. An order-of-magnitude swing over a
      // HEALTHY base ("1 ↓ −99,6% desde 274") is the other half of the same
      // class and reads as an incomplete load, not a programme.
      deltaImplausible: DELTA_IMPLAUSIBLE_GUARD,
    },
    ui: {
      definition:
        "Cantidad de eventos sterilization_performed registrados en los últimos 30 días en la jurisdicción. Incluye la variación porcentual respecto a los 30 días anteriores. Lente dual: el titular cuenta eventos declarados; el sub-renglón «firmado por matrícula» muestra la porción registrada por veterinarios matriculados — divulgación junto al declarado, nunca su reemplazo.",
      formula:
        "COUNT(sterilization_performed en últimos 30d) vs COUNT(sterilization_performed en 30d previos)",
    },
  },

  bites_per_10k: {
    id: "bites_per_10k",
    label: "Mordeduras / 10.000 habitantes",
    numerator:
      "COUNT incident_reported events where payload.incident_type = 'bite_inflicted', occurred_at within the trailing 12 months",
    denominator: "jurisdictions_census.population (summed over scope) / 10,000",
    source: "pet_events (incident_reported), jurisdictions_census",
    fetcherName: "fetchBitesPer10k",
    fetcherPath: "lib/analytics/govt-home-kpis.ts",
    cadence: "trailing 12 months vs prior 12 months",
    unit: "rate_per_10k",
    suppression: "none",
    caveat:
      "Denominator is HUMAN census population, not pet population — used as a zoonotic-risk proxy (A6). Renders as 0 when a jurisdiction has no census row rather than throwing on division by zero.",
    window: "12m",
    species: "n/a",
    basis: "ratio",
    ui: {
      definition:
        "Tasa de incidentes de mordedura por cada 10.000 habitantes del censo provincial en los últimos 12 meses. Se usa como indicador de riesgo zoonótico (A6 proxy).",
      formula:
        "COUNT(incident_reported donde incident_type='bite_inflicted', últimos 12m) / (población_censo / 10.000)",
      caveat:
        "Denominador es población HUMANA del censo, no población de mascotas. Muestra 0 cuando la jurisdicción no tiene fila de censo, en lugar de dividir por cero.",
    },
  },

  active_zoonosis_signals: {
    id: "active_zoonosis_signals",
    label: "Casos de zoonosis activos",
    numerator:
      "COUNT DISTINCT pets with an OPEN rabies observation (rabies_observation_status IN 'in_progress','window_expired_unclosed') OR an open bite_incident case (deduplicated via UNION, not summed) + COUNT disease_reported events where payload.disease = 'lepto' (trailing 30d) + COUNT disease_reported events where payload.disease = 'hidatidosis' (trailing 30d)",
    denominator: "n/a — absolute count",
    source: "pets, cases, pet_events (disease_reported, rabies_observation_started)",
    fetcherName: "fetchActiveZoonosis",
    fetcherPath: "lib/analytics/govt-home-kpis.ts",
    cadence: "rabies/bite components are a 'now' snapshot; lepto/hidat are trailing 30 days",
    unit: "count",
    suppression: "none",
    caveat:
      "The rabies+bite union is deduplicated at the pet level — a pet in both an active observation AND an open bite case counts once, not twice (fixed from an earlier Math.max approximation that assumed full nesting). STILL SURFACED on Panorama's metrics column (src/modules/panorama/application/get-panorama-kpis.ts) even though /gob home replaced it with its three decomposed parts below (open_rabies_observations, open_bite_cases, notified_diseases) — kept here because it is a genuinely different, still-rendered composite, not dead code.",
    window: "mixed",
    species: "all_species",
    basis: "stock",
  },

  open_rabies_observations: {
    id: "open_rabies_observations",
    label: "Mascotas en observación rábica",
    numerator:
      "COUNT active/lost pets whose rabies observation is still open — rabies_observation_status IN ('in_progress','window_expired_unclosed')",
    denominator: "n/a — absolute count",
    source: "pets, pet_events (rabies_observation_started, for the weekly delta)",
    fetcherName: "fetchOpenRabiesObservations",
    fetcherPath: "lib/analytics/govt-home-kpis.ts",
    cadence: "'now' snapshot; deltaWeek compares the trailing 7 days of opens vs the prior 7 days",
    unit: "count",
    suppression: "none",
    caveat:
      "Decomposed from active_zoonosis_signals's rabies arm (PO-ratified split of the opaque composite into legible signals) — same predicate and same deltaWeek computation, just no longer merged with the open-bite-case count. WIDENED 2026-08-17: 'open' now covers window_expired_unclosed too. Before that date the daily sweep closed an elapsed observation as completed_negative with no clinical author; now it leaves it unclosed, and a counter still keyed on in_progress alone would have drained to zero exactly as the unfinished backlog grew — taking rabies_observation_compliance_10d's openBreaches, which is fenced to be a subset of this KPI, down with it.",
    window: "now",
    species: "all_species",
    basis: "stock",
    ui: {
      definition:
        "Mascotas con una observación antirrábica todavía abierta en la jurisdicción: en curso, o con el período vencido y sin cierre profesional registrado. Deriva de la observación tras mordedura (Ley 22.953).",
      formula:
        "COUNT(pets donde rabies_observation_status IN ('in_progress','window_expired_unclosed')) en alcance",
    },
  },

  open_bite_cases: {
    id: "open_bite_cases",
    label: "Mordeduras abiertas",
    numerator: "COUNT cases where case_kind = 'bite_incident' AND status = 'open'",
    denominator: "n/a — absolute count",
    source: "cases",
    fetcherName: "fetchOpenBiteCases",
    fetcherPath: "lib/analytics/govt-home-kpis.ts",
    cadence: "'now' snapshot",
    unit: "count",
    suppression: "none",
    caveat:
      "Decomposed from active_zoonosis_signals's open-bite-case arm (PO-ratified split) — same casesScopeClause and predicate the composite used for its dedup UNION, now counted on its own instead of merged with rabies-observation pets.",
    window: "now",
    species: "n/a",
    basis: "stock",
    ui: {
      definition:
        "Casos de mordedura (case_kind='bite_incident') que siguen abiertos (status='open') en la jurisdicción.",
      formula: "COUNT(cases donde case_kind='bite_incident' AND status='open') en alcance",
    },
  },

  notified_diseases: {
    id: "notified_diseases",
    label: "Enfermedades notificadas",
    numerator:
      "COUNT disease_reported events in the trailing 30 days in scope (ALL diseases, not only lepto/hidatidosis)",
    denominator: "n/a — absolute count",
    source: "pet_events (disease_reported)",
    fetcherName: "fetchNotifiedDiseases",
    fetcherPath: "lib/analytics/govt-home-kpis.ts",
    cadence: "trailing 30 days ending at ctx.period.until",
    unit: "count",
    suppression: "none",
    caveat:
      "Generalises active_zoonosis_signals's lepto+hidat arms (PO-ratified split) to every disease_reported event in the window — the truest 'enfermedades notificadas' axis. Returns lepto/hidat as a sub-breakdown for continuity with the composite's legend, but the catalogued count is the ALL-diseases total, not just those two.",
    window: "30d",
    species: "n/a",
    basis: "flow",
    ui: {
      definition:
        "Nuevos eventos de enfermedad notificada (disease_reported) registrados en los últimos 30 días en la jurisdicción. El subtítulo desglosa leptospirosis e hidatidosis.",
      formula: "COUNT(disease_reported, últimos 30 días) en alcance",
    },
  },

  microchip_penetration: {
    id: "microchip_penetration",
    label: "Penetración de microchip",
    numerator: "COUNT active/lost pets with ≥1 active microchip_iso identification",
    denominator: "COUNT active/lost pets in scope",
    source: "pets, pet_identifications",
    fetcherName: "fetchMicrochipPenetration",
    fetcherPath: "lib/analytics/compliance-metrics.ts",
    cadence: "point-in-time snapshot",
    unit: "percent",
    suppression:
      "k-anon (k=5) on the per-locality breakdown; the national/province figure is unsuppressed",
    caveat:
      "No legal basis: no Argentine norm mandates microchipping (see target.sourceKind). Only counts microchips registered in miMAR.",
    window: "all_time",
    species: "all_species",
    basis: "ratio",
    question:
      "¿Qué porcentaje de mascotas del padrón (activas/perdidas) tiene un microchip ISO activo registrado?",
    target: {
      value: TARGETS.MICROCHIP_PENETRATION_PCT,
      // NOT a legal citation, deliberately (legal research 2026-08-17, engram
      // legal/claims-refutadas-2026-08-17). This read "Ley Prov. 14.107 (PBA)"
      // and, with sourceKind "programmatic-target", rendered as "Obligación:
      // Ley Prov. 14.107 (PBA) · Meta programática: 80%" — asserting a chip
      // mandate that statute does not contain (art. 8 inc. b admits "un chip O
      // DE UN TATUAJE", and only for PPP; Ley CABA 4.078 never mentions a chip;
      // SENASA confirms no national electronic-ID rule exists). There is no
      // Argentine jurisdiction to substitute, so the honest classification is
      // "benchmark": an internal program goal carrying no legal weight, which
      // formatKpiTarget renders WITHOUT the word "Obligación".
      source: "meta programática de identificación (sin mandato legal argentino)",
      sourceKind: "benchmark",
    },
    semaphore: { paintAgainst: "target" },
    // Red-team 2026-07 #3: 0/0 padrón (out-of-mandate locality) dashes, never a "0%" n=0 alert.
    guards: { zeroDenominator: "dash" },
    // PO decision 2 item 2 — "faltan ~N chips" (one per unchipped pet in the % padrón).
    resourceUnit: "chips",
    confidence: {
      inputs: [
        "k-anonimato (k=5) en el desglose por localidad — celdas chicas ocultas",
        "solo microchips registrados en miMAR — la penetración real puede ser mayor",
      ],
    },
    ui: {
      definition:
        "Porcentaje de mascotas activas/extraviadas en la jurisdicción con al menos una identificación microchip ISO activa registrada (C1). Ninguna norma argentina exige el microchip: la meta es programática, no una obligación legal.",
      formula:
        "COUNT(pets activos/extraviados con pet_identifications.kind='microchip_iso' y status='active') / COUNT(pets activos/extraviados en scope)",
      caveat: "Solo cuenta microchips registrados en miMAR.",
    },
  },

  ppp_registry_compliance: {
    id: "ppp_registry_compliance",
    // C1 rename (2026-07-22, red-team #7): the old label + toneForTarget(…,
    // 100) painted a 0% self-serve-attestation uptake number "Peligro" (red) —
    // a LEGAL-VERDICT color on what is, until the enforcement flow ships,
    // purely a miMAR adoption/uptake number. Renamed + semaphore: none below
    // distinguish "atestación en miMAR" (what this tile measures) from
    // "cumplimiento registral externo" (a claim this tile does NOT make).
    // Shortened (qa-triage-2026-07-23, finding #7): the parenthetical fully
    // spelling out "PPP" made this the longest label in the catalog (58
    // chars), wrapping across 3-4 lines in a narrow OpKpi tile — read as
    // "truncated" in a browse-only review even though no CSS actually clips
    // it (verified: overflow:visible, white-space:normal, no ellipsis). The
    // load-bearing part of the C1 rename above — "en miMAR" (disambiguating
    // from external registry compliance) — is kept; only the redundant
    // acronym-expansion is dropped (PPP is glossed in the ⓘ tooltip's
    // `definition` below, not lost).
    label: "Atestación PPP en miMAR",
    numerator:
      "COUNT DISTINCT PPP-flagged active pets with ≥1 dangerous_breed_attested event that cites registry_id or was authored by an accountable institution (lib/domain/ppp-attestation.ts)",
    denominator: "COUNT active/lost pets where potentially_dangerous_breed = true",
    source: "pets, pet_events (dangerous_breed_attested)",
    fetcherName: "fetchDangerousBreedCompliance",
    fetcherPath: "lib/analytics/compliance-metrics.ts",
    cadence: "point-in-time snapshot",
    unit: "percent",
    suppression: "none",
    caveat:
      "Legal basis: Ley CABA 4078 / Ley Prov. 14.107 (PBA). Reads 0% until the attestation form ships — that is a true value (no adoption yet), not a bug. NOT painted as a legal-verdict tone (semaphore: none) — a self-serve-attestation uptake number reading 'Peligro' misrepresents a feature-adoption gap as a legal breach (red-team #7).",
    window: "all_time",
    species: "dogs",
    basis: "ratio",
    methodologyVersion: 2, // K8: label + semaphore renamed 2026-07-22/23 (see above)
    question:
      "¿Qué porcentaje de mascotas PPP en la jurisdicción tiene su atestación cargada en miMAR? (NO mide cumplimiento registral externo a la ley — solo adopción del flujo de atestación en la plataforma).",
    target: {
      value: TARGETS.PPP_ATTESTATION_PCT,
      source: "Ley CABA 4078 / Ley Prov. 14.107 (PBA)",
      // 100% IS what "atestación obligatoria" legally means — number and law
      // are the same fact here, unlike the programmatic-target entries above.
      sourceKind: "statutory-obligation",
    },
    // Uptake metrics never paint a legal-verdict color (S1 principle) — the
    // target is kept (for the info popover's "meta" line, honestly sourced to
    // the law) but the RENDERED tone never derives from it.
    semaphore: { paintAgainst: "none" },
    exclusions:
      "No mide cumplimiento registral externo (habilitación municipal/provincial fuera de miMAR) — solo la atestación cargada dentro de la plataforma.",
    ui: {
      definition:
        "Porcentaje de mascotas de razas potencialmente peligrosas (PPP) en la jurisdicción con una atestación que se puede contrastar: cita el número de inscripción que dio el registro, o la asentó una institución responsable (C7). Ley CABA 4078 / Ley Prov. 14.107 (PBA) exige la atestación; este número mide SOLO la adopción del flujo dentro de la plataforma, no el cumplimiento registral externo.",
      formula:
        "COUNT(pets PPP activos con atestación que cita el número de inscripción o asentada por una institución responsable) / COUNT(pets PPP activos)",
      caveat:
        "Una atestación sin número de inscripción y sin firma institucional queda asentada en la libreta pero NO suma acá — es una declaración que nadie puede contrastar contra el registro, y la ficha del titular la muestra como «Declarada».",
    },
  },

  open_welfare_reports: {
    id: "open_welfare_reports",
    label: "Denuncias ciudadanas activas",
    numerator: "COUNT welfare_reports rows where status NOT IN ('closed', 'duplicate')",
    denominator: "n/a — absolute count",
    source: "welfare_reports",
    fetcherName: "fetchOpenWelfareReportsCount",
    fetcherPath: "lib/analytics/govt-home-kpis.ts",
    cadence: "point-in-time snapshot",
    unit: "count",
    suppression: "none",
    window: "now",
    species: "n/a",
    basis: "stock",
  },

  // PO visual-validation batch B (2026-07-23) — /gob home's "Mi trabajo
  // asignado" tile. DISTINCT from open_welfare_reports above: that's every
  // non-terminal welfare report in the operator's scope; this is the subset
  // assigned TO THE VIEWER specifically (currentUserId), same moderation
  // exclusion.
  my_assigned_welfare_reports: {
    id: "my_assigned_welfare_reports",
    label: "Denuncias de maltrato asignadas a vos",
    numerator:
      "COUNT welfare_reports rows where assignedToUserId = viewer AND status NOT IN terminal states AND (not flagged OR moderation resolved)",
    denominator: "n/a — absolute count",
    source: "welfare_reports",
    fetcherName: "fetchMyAssignedWelfareCount",
    fetcherPath: "lib/analytics/dashboards/welfare.ts",
    cadence: "point-in-time snapshot",
    unit: "count",
    suppression: "none",
    window: "now",
    species: "n/a",
    basis: "stock",
  },

  mortality_disposal_traceability: {
    id: "mortality_disposal_traceability",
    label: "Disposición trazable de fallecimientos",
    numerator:
      "COUNT death_recorded events where disposal method is known (NOT NULL and <> 'unknown') AND a disposal facility is present",
    denominator: "COUNT death_recorded events in the trailing 12 months",
    source: "pet_events (death_recorded)",
    fetcherName: "fetchMortalityDisposition",
    fetcherPath: "lib/analytics/mortality-metrics.ts",
    // C1 correction (2026-07-22): this descriptor's only real render site is
    // /gob/mortalidad (via getKpiInfo, wired here in the same sweep), which
    // has an ADJUSTABLE period picker (defaultPreset trailing12m, but the
    // operator can change it) — "trailing 12 months" as a FIXED cadence was
    // inaccurate documentation (it described mortality_deaths_12m's fixed-12m
    // home-page sibling, not this tile's actual ctx.period behavior).
    cadence:
      "matches the caller's ProjectionContext period (adjustable via /gob/mortalidad's period picker; default trailing 12 months)",
    unit: "percent",
    suppression: "none",
    caveat:
      "Target: 75% traceable; ≥25% unknown disposition is treated as a breach (DISPOSAL_UNKNOWN_BREACH_PCT).",
    window: "period",
    species: "all_species",
    basis: "ratio",
    question:
      "De los fallecimientos registrados, ¿qué porcentaje tiene una disposición final trazable (método + instalación conocidos)?",
    target: {
      value: TARGETS.DISPOSAL_TRACEABILITY_PCT,
      source: "Ley CABA 5470",
      // The law mandates traceable disposal, not a 75% threshold — the
      // figure is a programmatic benchmark (claim #6).
      sourceKind: "programmatic-target",
    },
    semaphore: { paintAgainst: "target" },
    guards: {
      // 0 deaths → 0/0 traceableRate would read "0%" (a FAILED-traceability
      // signal) when there simply were no deaths to trace — the exact "0/0
      // → 0%" class this task fences. Mirrors mortality_deaths_12m's guard.
      zeroDenominator: "dash",
      // C1 addition: a handful of total deaths can make this rate read as a
      // confident "100% trazable" or "0% trazable" on 1-2 cases.
      smallN: { min: 5 },
    },
    ui: {
      definition:
        "Porcentaje de fallecimientos con método de disposición conocido E instalación registrada. Mide el cumplimiento de trazabilidad exigido por la Ley CABA 5470.",
      formula: "deaths con (disposition_method ≠ null/unknown) AND (facility ≠ '') / total",
      caveat:
        "Umbral de alerta: por debajo de la meta programática (ver TARGETS.DISPOSAL_TRACEABILITY_PCT). Un valor menor al 50% se considera incumplimiento grave (B3).",
    },
  },

  mortality_deaths_12m: {
    id: "mortality_deaths_12m",
    label: "Fallecimientos registrados (12 meses)",
    numerator:
      "COUNT death_recorded events where occurred_at falls within the trailing 12 months, in scope",
    denominator:
      "n/a — absolute count (flow, not a ratio). The SAME query's traceableRate field (shown alongside on /gob home) is a ratio: COUNT death_recorded events with a known disposal method (NOT NULL and <> 'unknown') AND a disposal facility present, divided by this same 12-month total",
    source: "pets, pet_events (death_recorded)",
    fetcherName: "fetchMortalityHeadline",
    fetcherPath: "lib/analytics/mortality-metrics.ts",
    cadence:
      "FIXED trailing 12 months (ctx12m — /gob home has no period picker), recomputed on every render",
    unit: "count",
    suppression: "none",
    caveat:
      "Perf-motivated split (2026-07-19 qw#2) of mortality_disposal_traceability's first query: /gob home only ever rendered `total` + `traceableRate`, not the other four sequential queries (method/cause-week/code/locality breakdowns) fetchMortalityDisposition also runs for /gob/mortalidad — so this fetcher runs ONLY that first aggregation, cutting four serial round-trips per home render. traceableRate here uses the IDENTICAL predicate as mortality_disposal_traceability's ratio (same TRACEABLE condition) — it is not a new or different definition, just the same math computed over a fixed 12m window via a cheaper single-query path instead of the full five-query fetcher.",
    window: "12m",
    species: "all_species",
    basis: "flow",
    question:
      "¿Cuántos fallecimientos se registraron en los últimos 12 meses, y qué tan trazable fue su disposición final?",
    // The headline count itself has no target (a count of deaths isn't
    // "compliant" or not) — semaphore stays "none" for the COUNT; the
    // embedded traceableRate ratio inherits mortality_disposal_traceability's
    // target/semaphore (same predicate, see the caveat above), not a
    // separate one here.
    semaphore: { paintAgainst: "none" },
    guards: {
      // Same "0/0 → 0%" class as mortality_disposal_traceability, on the
      // SAME traceableRate field this fetcher computes over its fixed 12m
      // total. Home renders both `total` and `traceableRate` from one
      // fetcher call, so one guard entry covers both display fields.
      zeroDenominator: "dash",
    },
  },

  active_pregnancies: {
    id: "active_pregnancies",
    label: "Preñeces en seguimiento",
    numerator: "COUNT active/lost pets where pregnancy_status = 'in_progress'",
    denominator: "n/a — absolute count",
    source: "pets (denormalized pregnancy_status column)",
    fetcherName: "fetchActivePregnancies",
    fetcherPath: "lib/metrics/population-control.ts",
    cadence: "point-in-time snapshot",
    unit: "count",
    suppression: "none",
    window: "now",
    species: "all_species",
    basis: "stock",
    ui: {
      definition:
        "Mascotas en el scope con pregnancyStatus='in_progress' (preñez iniciada y aún no cerrada). Requiere que la preñez haya sido registrada por un veterinario.",
      formula: "COUNT(pets) WHERE pregnancy_status = 'in_progress' AND scope",
    },
  },

  sterilization_natalidad_ratio: {
    id: "sterilization_natalidad_ratio",
    label: "Ratio esterilización / natalidad registrada",
    numerator: "COUNT sterilization_performed events in the ctx period",
    denominator:
      "COUNT registered live births in the SAME period (clinical_info_logged events with sub_kind='pregnancy', pregnancy_phase='ended', outcome='live_birth') — null when 0",
    source: "pet_events (sterilization_performed, clinical_info_logged)",
    fetcherName: "fetchSterilizationNatalidadRatio",
    fetcherPath: "lib/metrics/population-control.ts",
    cadence: "matches the caller's ProjectionContext period",
    unit: "ratio",
    suppression: "none",
    caveat:
      "NATALIDAD CAVEAT: the denominator only counts TRACKED pregnancies recorded in miMAR — street/untracked litters are invisible, so this ratio systematically OVER-estimates containment (under-counts births). Directional signal, not exact. Must ship with the UI caveat 'Solo partos en seguimiento — subestima la natalidad real'.",
    window: "period",
    species: "all_species",
    basis: "ratio",
    ui: {
      definition:
        "Eventos clinical_info_logged con sub_kind='pregnancy', pregnancy_phase='ended' y outcome='live_birth' en el período seleccionado, en el scope.",
      formula:
        "COUNT(clinical_info_logged WHERE sub_kind='pregnancy' AND pregnancy_phase='ended' AND outcome='live_birth' AND period AND scope)",
      caveat:
        "Solo cuenta partos de preñeces registradas en el sistema — partos callejeros y camadas sin seguimiento son invisibles. Subestima la natalidad real: es un indicador direccional, no un dato exacto.",
    },
  },

  data_quality_completeness: {
    id: "data_quality_completeness",
    label: "Completitud de datos del registro",
    numerator:
      "COUNT active/lost pets with NONE of: jurisdiction_locality IS NULL, sex = 'unknown', missing active microchip_iso",
    denominator: "COUNT active/lost pets in scope",
    source: "pets, pet_identifications",
    fetcherName: "fetchDataQuality",
    fetcherPath: "lib/metrics/program-health.ts",
    cadence: "point-in-time snapshot",
    unit: "percent",
    suppression: "none",
    window: "now",
    species: "all_species",
    basis: "ratio",
  },

  custody_return_rate: {
    id: "custody_return_rate",
    label: "Tasa de devolución de adopciones",
    numerator: "COUNT adoption_reversed events in the ctx period",
    denominator: "COUNT adoption_finalized events in the SAME period — null when 0",
    source: "pet_events (adoption_finalized, adoption_reversed)",
    fetcherName: "fetchReturnRate",
    fetcherPath: "lib/metrics/custody.ts",
    cadence: "matches the caller's ProjectionContext period",
    unit: "ratio",
    suppression: "none",
    caveat:
      "Numerator and denominator are independent 'events in window' counts, not a followed cohort — a reversal in-period may reference an adoption finalized before the period started.",
    window: "period",
    species: "all_species",
    basis: "ratio",
    methodologyVersion: 2, // K8: target populated 2026-07-22 (see below)
    // C1 (2026-07-22): target/semaphore/guards were previously omitted even
    // though TARGETS.ADOPTION_RETURN_RATE_PCT is a real internal benchmark —
    // populated per the honesty rule (a real target with a source exists).
    // Lower-is-better: toneForTarget is called with higherIsBetter:false at
    // every render site (both /gob and /admin/adopciones).
    question:
      "¿Qué porcentaje de adopciones finalizadas en el período fueron revertidas (devueltas)?",
    target: {
      value: TARGETS.ADOPTION_RETURN_RATE_PCT,
      source: "meta programática interna (retención/calidad de colocación)",
      // No underlying law at all — a pure internal benchmark.
      sourceKind: "benchmark",
    },
    semaphore: { paintAgainst: "target" },
    guards: {
      // A handful of adoptions in a small jurisdiction/period can make one
      // reversal read as a dramatic double-digit return rate — same "100%
      // con N chico" class fenced elsewhere.
      smallN: { min: 5 },
      zeroDenominator: "dash",
    },
    ui: {
      definition:
        "Fracción de adopciones finalizadas que fueron revertidas en el período. Menor es mejor.",
      formula: "COUNT(adoption_reversed) / COUNT(adoption_finalized) — null si den=0",
      caveat:
        "Numerador y denominador son conteos independientes de eventos en el período — un reverso de este período puede corresponder a una adopción de un período anterior, por lo que el valor puede superar el 100%.",
    },
  },

  shelter_occupancy_national: {
    id: "shelter_occupancy_national",
    label: "Ocupación de refugios (nacional)",
    numerator: "SUM active ownerships where role = 'shelter_custody' AND ended_at IS NULL",
    denominator:
      "SUM organizations.capacity_total for organizations where org_type = 'shelter' — null when no capacity declared",
    source: "ownerships, organizations",
    fetcherName: "fetchShelterOccupancyNational",
    fetcherPath: "lib/metrics/custody.ts",
    cadence: "point-in-time snapshot",
    unit: "percent",
    suppression: "none",
    caveat: "Admin-only aggregate (national); capacity is org self-reported config, not verified.",
    window: "now",
    species: "all_species",
    basis: "ratio",
  },

  deworming_coverage_population: {
    id: "deworming_coverage_population",
    label: "Cobertura antiparasitaria (12 meses)",
    numerator:
      "COUNT DISTINCT active/lost pets (any species) with ≥1 deworming_administered event in the trailing 12 months ending at ctx.period.until",
    denominator: "COUNT active/lost pets in scope",
    source: "pets, pet_events (deworming_administered)",
    fetcherName: "fetchDewormingCoverage",
    fetcherPath: "lib/metrics/deworming.ts",
    cadence: "FIXED trailing 12 months ending at ctx.period.until — recomputed on every render",
    unit: "percent",
    suppression: "none (province rows are never small enough to require k-anon)",
    caveat:
      "Sanitary-coverage sibling of rabies_coverage_dogs_12m and sterilization_coverage_population, surfaced on /gob/padron (vista Población, F8 fusion). Unlike sterilization (once-ever), deworming is periodic — the 12-month window is a 'currently protected' proxy. Only counts dewormings logged in miMAR; real-world coverage may be higher. SEED-DENSITY CAVEAT: deworming_administered has low seed density, so this reads a low but HONEST value until owners/vets log antiparasitic doses.",
    window: "12m",
    species: "all_species",
    basis: "ratio",
    ui: {
      definition:
        "Fracción de mascotas activas/extraviadas en el scope con al menos un evento deworming_administered en los últimos 12 meses.",
      formula:
        "COUNT(DISTINCT pets WHERE EXISTS deworming_administered en 12m) / COUNT(pets activos/extraviados en scope) × 100",
      caveat:
        "A diferencia de la esterilización (una vez), la desparasitación es periódica: la ventana de 12 meses es un proxy de 'protección vigente'. Solo cuenta dosis registradas en miMAR — la cobertura real puede ser mayor.",
    },
  },

  vet_access_per_1k_locality: {
    id: "vet_access_per_1k_locality",
    label: "Acceso veterinario (actos / 1.000 activos)",
    numerator: "COUNT VET_ACTIVITY_EVENT_TYPES events in ctx.period, by the pet's home locality",
    denominator: "COUNT active/lost pets homed in the locality, divided by 1,000",
    source: "pets, pet_events (VET_ACTIVITY_EVENT_TYPES)",
    fetcherName: "fetchVetAccessByLocality",
    fetcherPath: "lib/metrics/vet-access.ts",
    cadence: "matches the caller's ProjectionContext period",
    unit: "rate_per_10k",
    suppression:
      "k-anon (k=5) on the per-locality active-pet population — a locality with <5 active pets is suppressed",
    caveat:
      "Access-to-care equity signal surfaced on the Programa hub's Analítica vista (/gob/programa?vista=analitica — F9 2026-08-01; the former standalone /gob/analytics is a redirect now) and on the panorama 'acceso-veterinario' choropleth; localities are sorted ascending by per-1k so care deserts surface first (the CABA vs periphery inequity). Denominator is PET population per locality, not human census. Scoped and grouped by the pet's HOME jurisdiction. Unit is 'per 1,000' (reusing the rate_per_10k unit slot — closest available). VET_ACTIVITY_EVENT_TYPES (lib/metrics/vet-access.ts) = vet_visit_logged, vaccination_administered, sterilization_performed, microchip_implanted, clinical_info_logged — every act that requires a veterinary professional, NOT only logged consults: restricted to vet_visit_logged the numerator was 85 rows nationally and returned 0,0 in 23 of 24 provinces. Deworming is excluded on purpose (over-the-counter, owner-applied). It does NOT filter on author_role — that names the reporter, not the performer. CAVEAT: only acts registered in miMAR are visible, so this is a floor on real access, not a census of it.",
    window: "period",
    species: "all_species",
    basis: "ratio",
    question:
      "¿En qué localidades del alcance el acceso a atención veterinaria registrada es más bajo, y cuáles caen por debajo del piso de un acto por mascota al año?",
    guards: {
      // H6 (external red-team 2026-07-30). k-anon already drops localities
      // under 5 active pets, but 5–49 actives still make the RATIO
      // meaningless: with 12 actives one single act moves the figure by 83
      // per 1.000. Below this floor the row keeps its real numbers and is
      // EXCLUDED from any "desierto" classification — the same posture
      // smallNGate takes for a tile (the value is a fact, the verdict is not).
      smallN: { min: 50 },
      // Enforced by lib/metrics/vet-access.ts's classifyVetAccess (a TABLE,
      // not an OpKpi tile — there is no guardInput.n to feed).
      manualEnforcement: true,
    },
  },

  movement_volume: {
    id: "movement_volume",
    label: "Movilidad registrada (movement_recorded)",
    numerator:
      "COUNT movement_recorded events in the ctx period, scoped, decomposed by payload.sub_kind (jurisdiction_changed / cvi_issued / transport_recorded)",
    denominator: "n/a — absolute counts (a flow volume, not a ratio)",
    source: "pets, pet_events (movement_recorded)",
    fetcherName: "fetchMovementCorridors",
    fetcherPath: "lib/metrics/movement.ts",
    cadence: "matches the caller's ProjectionContext period",
    unit: "count",
    suppression: "none — jurisdiction-level totals, not locality-grouped",
    caveat:
      "Epidemiological mobility signal surfaced on /gob/vigilancia — a moved animal carries its exposure into a new jurisdiction. Scoped by the pet's HOME jurisdiction; a jurisdiction_changed move denormalizes the pet's home to the DESTINATION, so a scoped operator sees inbound relocations once the pet has landed. SEED-DENSITY CAVEAT: movement_recorded (esp. cvi_issued / transport_recorded cross-border) is sparse in seed data — reads honest low/zero totals.",
    window: "period",
    species: "all_species",
    basis: "flow",
  },

  adoption_application_conversion: {
    id: "adoption_application_conversion",
    label: "Conversión de postulaciones de adopción",
    numerator:
      "COUNT adoption_application_submitted events in the ctx period; resolved breakdown counts adoption_application_resolved by payload.outcome (approved/rejected/withdrawn)",
    denominator: "conversionRate = approved / submitted — null when submitted=0",
    source: "pets, pet_events (adoption_application_submitted, adoption_application_resolved)",
    fetcherName: "fetchAdoptionApplicationFunnel",
    fetcherPath: "lib/metrics/adoption-funnel.ts",
    cadence: "matches the caller's ProjectionContext period",
    unit: "percent",
    suppression: "none — jurisdiction-level totals, not locality-grouped",
    caveat:
      "DEMAND side of the pipeline (online postulaciones), distinct from custody_return_rate / fetchCustodyFunnel's SUPPLY side (intake→adoption_finalized). Surfaced on /gob/adopciones. Submitted and resolved are INDEPENDENT windowed counts, not a followed cohort — a resolution in-period may reference an application submitted before the period started. SEED-DENSITY CAVEAT: adoption_application_* density is low in seed data.",
    window: "period",
    species: "all_species",
    basis: "ratio",
  },

  eno_sla_compliance: {
    id: "eno_sla_compliance",
    label: "Cumplimiento SLA de notificaciones ENO",
    numerator:
      "COUNT event_notification_outbox rows where target_kind = 'eno_authority', delivered AND delivered_at <= sla_due_at, created within the ctx period",
    denominator:
      "COUNT event_notification_outbox rows where target_kind = 'eno_authority', delivered, created within the SAME period",
    source: "event_notification_outbox",
    fetcherName: "fetchEnoSla",
    fetcherPath: "lib/analytics/surveillance-metrics.ts",
    cadence: "matches the caller's ProjectionContext period; breachedOpen is a live 'now' snapshot",
    unit: "percent",
    suppression: "none",
    caveat:
      "Added to the catalog by task #15a (staging-readiness triage) after finding the SAME onTime/delivered ratio worded five different ways across /gob/vigilancia, /gob/sistema, /gob/programa, /admin/programa, and AdminKpiStrip (admin home) — none numerically wrong, just textually inconsistent. Measures the INTERNAL outbox queue's SLA, not confirmed external delivery to the health authority. breachedOpen (pending rows already past sla_due_at) is a live snapshot independent of the selected period.",
    window: "period",
    species: "n/a",
    basis: "ratio",
    question:
      "¿Qué porcentaje de notificaciones ENO se entregaron dentro del plazo SLA en el período y scope seleccionados?",
    // C1 (2026-07-22): TARGETS.ENO_SLA_PCT is a real, sourced benchmark — the
    // honesty rule requires populating target whenever one exists.
    target: {
      value: TARGETS.ENO_SLA_PCT,
      source: "benchmark operativo ANMAT/SENASA",
      sourceKind: "benchmark",
    },
    semaphore: { paintAgainst: "target" },
    // Via enoSlaHeadline/enoSlaTone (targets.ts) at all 4 sites. Use those.
    guards: { zeroDenominator: "dash", manualEnforcement: true },
    ui: {
      definition:
        "Porcentaje de notificaciones ENO (Enfermedades de Notificación Obligatoria, target_kind='eno_authority') entregadas dentro del plazo SLA en el período y scope seleccionados (A7). Mide la cola interna de la bandeja de salida, no la entrega externa a la autoridad.",
      formula:
        "COUNT(outbox rows entregadas con delivered_at ≤ sla_due_at) / COUNT(outbox rows entregadas en período) × 100",
      caveat:
        "breachedOpen cuenta notificaciones pendientes con sla_due_at ya vencido en este momento (incumplimiento activo), independiente del período seleccionado.",
    },
  },

  // ---------------------------------------------------------------------------
  // C1 first consumers (2026-07-22, plan-maestro §3) — new catalog entries
  // ---------------------------------------------------------------------------

  reunification_rate: {
    id: "reunification_rate",
    label: REUNIFICATION_RATE_LABEL_ES,
    numerator: "COUNT lost episodes (status_changed → to_status='lost') that returned to 'active'",
    denominator:
      "COUNT all lost episodes in scope, trailing 30 days (fixed window, no period picker)",
    source: "pets, pet_events (status_changed)",
    fetcherName: "fetchReunificationRate",
    fetcherPath: "lib/analytics/compliance-metrics.ts",
    cadence:
      "FIXED trailing 30 days — /gob/perdidas has no period control (PO decision 2026-07-19)",
    unit: "percent",
    suppression: "none",
    caveat:
      "Benchmark: UK RSPCA ~39% (TARGETS.REUNIFICATION_PCT). Does not filter by species — the benchmark is measured over all lost episodes. Same fetcher also returns medianDaysToRecovery, gated by the SAME smallN guard on `recovered` (not `lostEpisodes` — red-team's '100% con N=2' class specifically concerns the recovered-episode count, since the median is computed only over recovered episodes).",
    window: "30d",
    species: "all_species",
    basis: "ratio",
    question:
      "De las mascotas que se perdieron en los últimos 30 días, ¿qué porcentaje volvió con su dueño/a? (a leer SIEMPRE junto al stock de perdidas activas — una tasa alta con pocos episodios no es una victoria poblacional).",
    target: {
      value: TARGETS.REUNIFICATION_PCT,
      source: "benchmark RSPCA (Reino Unido)",
      sourceKind: "benchmark",
    },
    semaphore: { paintAgainst: "target" },
    guards: {
      // Red-team's headline case: "100% reunificación" next to "68 perdidas
      // activas" reads as total success when N=2. Below 5 episodes, the tone
      // is forced neutral and a small-sample note accompanies the (still
      // honestly shown) percentage. Also gates the sibling median-days tile
      // via `recovered` (see the caveat above).
      smallN: { min: 5 },
      zeroDenominator: "dash",
    },
    confidence: {
      inputs: [
        "n = episodios de pérdida en el período (30d) — advertencia de muestra chica bajo 5",
        "stock co-primario: 'Perdidas activas' en la misma pantalla da el contexto poblacional",
      ],
    },
    ui: {
      definition: `Porcentaje de episodios de pérdida abiertos en los últimos 30 días que terminaron en reunificación con el dueño/a. Benchmark internacional: ${TARGETS.REUNIFICATION_PCT}% (UK RSPCA). Con menos de 5 episodios, la tasa se muestra sin semáforo — un porcentaje sobre una muestra chica no es una tendencia.`,
      formula: "COUNT(episodios_lost → status='active') / COUNT(all lost episodes en 30d) × 100",
      caveat:
        "No filtra por especie: la meta de reunificación se mide sobre todos los episodios de pérdida, no por especie — filtrar fragmentaría el benchmark poblacional. Leer siempre junto al stock de 'Perdidas activas'.",
    },
  },

  bite_escalation_gap: {
    id: "bite_escalation_gap",
    label: "Brecha de escalamiento (mordeduras vs. observaciones)",
    numerator:
      "COUNT incident_reported bite events, trailing 12 months — REUSES bites_per_10k's `reports` field (no new query/definition)",
    denominator:
      "n/a — paired with COUNT open rabies observations ('now' snapshot) — REUSES open_rabies_observations' `count` field (no new query/definition). Not a ratio: the two counts measure different populations (reports vs currently-open observations) and are shown side by side, not divided.",
    source: "pet_events (incident_reported), pets (rabies_observation_status)",
    fetcherName: "fetchBiteEscalationGap",
    fetcherPath: "lib/analytics/govt-home-kpis.ts",
    cadence: "bites: trailing 12 months ending at ctx.period.until; observations: 'now' snapshot",
    unit: "count",
    suppression: "none",
    caveat:
      "Red-team #6: a jurisdiction can show 0 open rabies observations while carrying hundreds of unescalated bite reports — an empty observations queue reads as 'controlado' when it may mean 'sin escalar', not 'sin riesgo'. This KPI exists to keep that gap visible as a PAIR, never collapsed into a single ratio that would imply one count is the other's denominator.",
    window: "mixed",
    species: "n/a",
    basis: "flow",
    question:
      "¿Cuántas mordeduras se reportaron en los últimos 12 meses frente a cuántas observaciones rábicas siguen abiertas ahora mismo? Los reportes sin escalamiento no implican ausencia de riesgo.",
    // No target: this is a transparency pairing, not a compliance ratio —
    // there is no legal/programmatic benchmark for "how many bites SHOULD
    // have an open observation". Painting a tone here would fabricate a
    // judgment neither number supports on its own.
    semaphore: { paintAgainst: "none" },
    exclusions:
      "No mide qué fracción de mordeduras derivó en una observación — los dos números son poblaciones independientes (bites_per_10k / open_rabies_observations), no numerador/denominador de un mismo evento.",
    confidence: {
      inputs: [
        "bites: reutiliza bites_per_10k — ventana fija de 12 meses",
        "observaciones abiertas: reutiliza open_rabies_observations — snapshot 'ahora'",
      ],
    },
    ui: {
      definition:
        "Mordeduras reportadas en los últimos 12 meses junto a las observaciones antirrábicas actualmente abiertas en la jurisdicción — dos conteos independientes, mostrados en par para que la brecha entre 'reportado' y 'escalado' quede visible.",
      formula:
        "COUNT(incident_reported, 12m) mostrado junto a COUNT(rabies_observation_status='in_progress')",
      caveat:
        "Los reportes de mordedura sin una observación abierta correspondiente NO implican ausencia de riesgo — pueden reflejar sub-escalamiento, no sub-incidencia.",
    },
  },

  // ---------------------------------------------------------------------------
  // C1 sweep (2026-07-22, plan-maestro §3) — /gob/vigilancia's remaining tiles.
  // fetchVigilanciaMetrics is ONE composite query returning five independent
  // fields; each field gets its own catalog entry (own question/window/basis)
  // rather than sharing one entry, matching the active_zoonosis_signals →
  // open_rabies_observations/open_bite_cases/notified_diseases decomposition
  // precedent above. fetcherName disambiguates the shared function with a
  // parenthetical field suffix (kpi-catalog.test.ts enforces fetcherName
  // uniqueness across entries).
  // ---------------------------------------------------------------------------

  outbreak_active_signals: {
    id: "outbreak_active_signals",
    label: "Señales de brote (30 días)",
    numerator: "COUNT outbreak_signal events occurred within the trailing 30 days",
    denominator: "n/a — absolute count",
    source: "pet_events (outbreak_signal)",
    fetcherName: "fetchVigilanciaMetrics (outbreakActiveCount)",
    fetcherPath: "lib/analytics/dashboards/surveillance.ts",
    cadence: "trailing 30 days ending now — a flow of signals registered within the window",
    unit: "count",
    suppression: "none",
    caveat:
      "No distingue señales ya resueltas: outbreak_signal no tiene estado de cierre, así que el conteo incluye toda señal registrada en la ventana, esté o no atendida. Es actividad registrada, no brotes vivos.",
    window: "30d",
    species: "n/a",
    basis: "flow",
    question: "¿Cuántas señales de brote se registraron en los últimos 30 días?",
    // No target: there is no legal/programmatic benchmark for "how many
    // active outbreaks are acceptable" — the render site's warn tone on >0
    // is an operational-attention signal, not a target-derived verdict.
    semaphore: { paintAgainst: "none" },
  },

  rabies_observation_cases_open: {
    id: "rabies_observation_cases_open",
    label: "Casos de observación rábica abiertos",
    numerator: "COUNT cases where case_kind='bite_incident' AND status IN ('open','escalated')",
    denominator: "n/a — absolute count",
    source: "cases",
    fetcherName: "fetchVigilanciaMetrics (rabiesActiveCount)",
    fetcherPath: "lib/analytics/dashboards/surveillance.ts",
    cadence: "'now' snapshot — no window filter",
    unit: "count",
    suppression: "none",
    caveat:
      "Sin meta formal — el tono de atención (rojo cuando >0) refleja urgencia operativa, no un veredicto de incumplimiento legal (ese vive en rabies_observation_compliance_10d, el cumplimiento del plazo de 10 días).",
    window: "now",
    species: "n/a",
    basis: "stock",
    question:
      "¿Cuántos casos de observación rábica siguen abiertos en la jurisdicción, ahora mismo?",
    exclusions:
      "Distinto de open_rabies_observations (catálogo): ese cuenta MASCOTAS con rabies_observation_status='in_progress' (tabla pets); este cuenta EXPEDIENTES (tabla cases) con case_kind='bite_incident' y status abierto o escalado — poblaciones y tablas distintas, no deben sumarse ni leerse como la misma cifra. El expediente de una observación rábica ES el caso de mordedura: reportBite abre el caso y emite rabies_observation_started en la misma transacción. Los dos números pueden diferir legítimamente: un expediente sigue abierto si queda trabajo pendiente aunque la observación ya haya cerrado, y una mascota puede estar en observación sin expediente propio.",
    semaphore: { paintAgainst: "none" },
  },

  pets_registered_today: {
    id: "pets_registered_today",
    label: "Altas registradas hoy",
    numerator:
      "COUNT pets created since 00:00 ART today (Argentine calendar day, partial day in progress)",
    denominator: "n/a — absolute count",
    source: "pets",
    fetcherName: "fetchVigilanciaMetrics (petsRegisteredToday)",
    fetcherPath: "lib/analytics/dashboards/surveillance.ts",
    cadence:
      "since 00:00 ART today (Argentina is UTC-3 year-round, no DST) — a partial, still-accumulating day, not a completed 24h window",
    unit: "count",
    suppression: "none",
    caveat:
      "Ventana parcial (día en curso) — compararla contra un día completo anterior (o la misma hora de ayer) produciría una variación falsa temprano en el día; por eso este tile no muestra delta.",
    window: "now",
    species: "all_species",
    basis: "flow",
    question:
      "¿Cuántas mascotas se registraron en el sistema desde la medianoche argentina (00:00 ART de hoy)?",
    semaphore: { paintAgainst: "none" },
  },

  vaccinations_weekly: {
    id: "vaccinations_weekly",
    label: "Vacunaciones (7 días)",
    numerator:
      "COUNT vaccination_administered events in the trailing 7 days, scoped by the pet's home jurisdiction",
    denominator: "n/a — flow count, compared against the PRIOR 7-day window for the deltaV2 chip",
    source: "pet_events (vaccination_administered)",
    fetcherName: "fetchVigilanciaMetrics (vaccinationsThisWeek)",
    fetcherPath: "lib/analytics/dashboards/surveillance.ts",
    cadence: "trailing 7 days vs the prior 7 days (fetchPrevVaccinationsWeek)",
    unit: "count",
    suppression: "none",
    caveat:
      "Sin meta propia — la cobertura antirrábica de 80% (rabies_coverage_dogs_12m) es una métrica DISTINTA, de stock sobre 12 meses, no comparable con este conteo semanal de eventos.",
    window: "7d",
    species: "all_species",
    basis: "flow",
    question: "¿Cuántas vacunaciones se registraron esta semana y cómo viene la tendencia?",
    semaphore: { paintAgainst: "none" },
    guards: {
      // Same "−95% MoM sobre base inestable" class as sterilizations_per_month
      // — a delta computed against a near-zero prior-7d base is noise, not a
      // trend. Same floor convention (5) used elsewhere in this task.
      unstableDeltaBase: { minPriorBase: 5 },
      // H16 (external red-team 2026-07-30): unstableDeltaBase above only
      // distrusts a TINY prior base. An order-of-magnitude swing over a
      // HEALTHY base ("1 ↓ −99,6% desde 274") is the other half of the same
      // class and reads as an incomplete load, not a programme.
      deltaImplausible: DELTA_IMPLAUSIBLE_GUARD,
    },
  },

  outbreak_signals_untriaged: {
    id: "outbreak_signals_untriaged",
    label: "Se\u00f1ales sin investigaci\u00f3n (30 d\u00edas)",
    numerator:
      "COUNT(pet_events outbreak_signal, \u00faltimos 30d) sin una fila case_events entry_type='signal_link' que las vincule a un expediente",
    denominator: "n/a \u2014 conteo absoluto",
    source: "pet_events",
    fetcherName: "fetchVigilanciaMetrics (untriagedSignalCount)",
    fetcherPath: "lib/analytics/dashboards/surveillance.ts",
    cadence:
      "misma ventana de 30 d\u00edas y mismo alcance que 'Se\u00f1ales de brote' \u2014 derivado de sus mismas condiciones, no reconstruido, porque los dos n\u00fameros est\u00e1n para leerse uno contra otro",
    unit: "count",
    suppression: "none",
    caveat:
      "EXISTE PARA QUE UN CERO SE PUEDA LEER. 'Casos bajo investigaci\u00f3n activa' es un stock honesto, pero un cero ah\u00ed significa dos cosas distintas: que no pasa nada, o que nadie mir\u00f3. Este n\u00famero separa las dos. No mide riesgo: mide atenci\u00f3n. Una se\u00f1al sin investigaci\u00f3n puede ser un caso aislado que no la amerita.",
    window: "30d",
    species: "n/a",
    basis: "flow",
    question:
      "\u00bfCu\u00e1ntas se\u00f1ales de brote de los \u00faltimos 30 d\u00edas no tienen ning\u00fan expediente abierto?",
    semaphore: { paintAgainst: "none" },
  },
  outbreak_investigations_active: {
    id: "outbreak_investigations_active",
    label: "Casos bajo investigación activa",
    numerator:
      "COUNT cases where case_kind='outbreak_investigation' AND status IN ('open','escalated')",
    denominator: "n/a — absolute count",
    source: "cases",
    fetcherName: "fetchVigilanciaMetrics (investigationActiveCount)",
    fetcherPath: "lib/analytics/dashboards/surveillance.ts",
    cadence:
      "'now' live stock — mirrors the active-status filter the admin investigations queue uses, minus its 90-day recently-closed extension",
    unit: "count",
    suppression: "none",
    caveat:
      "Sin meta formal — el tono de atención (ámbar cuando >0) es una señal operativa de carga de trabajo, no un veredicto de cumplimiento.",
    window: "now",
    species: "n/a",
    basis: "stock",
    question:
      "¿Cuántas investigaciones de brote siguen activas (abiertas o escaladas) en la jurisdicción?",
    semaphore: { paintAgainst: "none" },
  },

  rabies_observation_compliance_10d: {
    id: "rabies_observation_compliance_10d",
    label: "Cumplimiento del plazo de observación",
    numerator:
      "COUNT rabies observations (started/ended event pair) that closed within the legal window (10 calendar days by default; jurisdiction-specific via resolveBusinessRule), closed within the ctx period",
    denominator: "COUNT rabies observations closed within the SAME ctx period — null when 0 closed",
    source: "pets, pet_events (rabies_observation_started, rabies_observation_ended)",
    fetcherName: "fetchRabiesObservationCompliance",
    fetcherPath: "lib/analytics/surveillance-metrics.ts",
    cadence:
      "matches the caller's ProjectionContext period; openBreaches (A9) is a live 'now' snapshot of observations already open past the legal window, independent of the selected period",
    unit: "percent",
    suppression: "none",
    caveat:
      "Un incumplimiento vivo (observación abierta hace más de 10 días, A9) puede coexistir con compliancePct=100% del período, porque miden poblaciones distintas: compliancePct solo cuenta observaciones YA CERRADAS en el período; openBreaches cuenta observaciones AÚN ABIERTAS ahora.",
    window: "period",
    species: "all_species",
    basis: "ratio",
    question:
      "De las observaciones rábicas cerradas en el período, ¿qué porcentaje cerró dentro del plazo legal de 10 días?",
    target: {
      value: 100,
      source: "Ord. CABA 41.831 art. 9 / Decreto 4669/1973 PBA — plazo legal según jurisdicción",
      // 100% IS "never missed the legal deadline" — the ordinance/decree sets
      // the 10-day window itself (resolved per-jurisdiction via
      // resolveBusinessRule — an implementation detail, never operator copy).
      sourceKind: "statutory-obligation",
    },
    semaphore: { paintAgainst: "target" },
    guards: {
      // A "100% cumplimiento" over 1-2 closed observations reads as a
      // confident legal-compliance win on a tiny sample — same "100% con
      // N=2" class the reunification guard fences.
      smallN: { min: 5 },
      zeroDenominator: "dash",
    },
    confidence: {
      inputs: [
        "openBreaches (A9) es un conteo vivo, independiente del período seleccionado — una tasa 100% del período no implica cero incumplimientos activos ahora",
      ],
    },
  },

  amr_density: {
    id: "amr_density",
    label: "Densidad de antimicrobianos (ATM/AMR)",
    numerator:
      "COUNT medication_started events whose drug_code classifies as antimicrobial (curated DRUG_CATALOG), in the ctx period",
    denominator: "COUNT active pets in scope, divided by 1,000 — null when 0 active pets",
    source: "pet_events (medication_started), pets, drug catalog (lib/drugs.ts)",
    fetcherName: "fetchAmrDensity",
    fetcherPath: "lib/analytics/surveillance-metrics.ts",
    cadence: "matches the caller's ProjectionContext period",
    unit: "rate_per_10k",
    suppression: "none",
    caveat:
      "Sin meta programática ni legal — es una señal de monitoreo (presión selectiva de resistencia antimicrobiana), no una medida de cumplimiento. Reutiliza el slot de unidad 'rate_per_10k' pero el valor está expresado por 1.000 (mismo patrón que vet_access_per_1k_locality).",
    window: "period",
    species: "all_species",
    basis: "ratio",
    question:
      "¿Cuántos inicios de tratamiento antimicrobiano se registraron por cada 1.000 mascotas activas en el período?",
    exclusions:
      "Fármacos sin drug_code clasificado en el catálogo se reportan aparte (provisionalUnclassified) y NO se incluyen en la tasa.",
    // No semaphore declared: this tile renders no conditional tone at all
    // (always neutral) — the "omit only for KPIs with no color" carve-out.
  },

  // ---------------------------------------------------------------------------
  // C1 sweep (2026-07-22) — /gob/programa + /admin/programa's North-Star strip.
  // ---------------------------------------------------------------------------

  registry_total_pets: {
    id: "registry_total_pets",
    label: "Total de mascotas registradas",
    numerator: "COUNT pets where status IN ('active','lost')",
    denominator: "n/a — absolute count",
    source: "pets",
    fetcherName: "registryCounts (total) / fetchAnalyticsMetrics (totalPets)",
    fetcherPath: "lib/metrics/census.ts",
    cadence: "point-in-time snapshot",
    unit: "count",
    suppression: "none",
    caveat:
      "Sin meta — es un conteo de tamaño del padrón, no una tasa de cumplimiento. Compartido por /gob/programa (vista Resumen), /admin/programa, /gob/padron (vista Censo), /admin/padron (vista Censo) (vía registryCounts, F8 fusion) — DOS fetchers distintos, mismo predicado exacto (status IN ('active','lost')) verificado — no un cómputo duplicado por accidente. F9 (2026-08-01): la vista Analítica del hub Programa TENÍA un tile propio sobre el segundo fetcher (fetchAnalyticsMetrics.totalPets, lib/analytics/dashboards/analytics.ts); se retiró. Que el predicado coincida hacía inofensiva la duplicación mientras eran dos pantallas separadas — al volverse dos pestañas de UNA pantalla pasó a ser el mismo número con dos etiquetas a un clic de distancia, que es exactamente lo que la fusión vino a eliminar. El fetcher sigue vivo detrás del pie 'N mascotas en cobertura' de Panorama (coverageDenominator), que ahora enlaza a la vista Resumen.",
    window: "now",
    species: "all_species",
    basis: "stock",
    question:
      "¿Cuántas mascotas activas o extraviadas hay registradas en el padrón, en este scope?",
    semaphore: { paintAgainst: "none" },
  },

  alerted_provinces_below_target: {
    id: "alerted_provinces_below_target",
    label: "Provincias bajo meta",
    numerator:
      "COUNT DISTINCT provinces with ≥1 metric (rabies/sterilization/microchip) below its programmatic target",
    denominator: "n/a — absolute count (bounded by the ~24 AR provinces)",
    source: "derivado de fetchCrossJurisdictionOutliers vía countAlertedProvinces",
    fetcherName: "countAlertedProvinces",
    fetcherPath: "lib/metrics/program-health.ts",
    cadence: "matches the caller's ProjectionContext period",
    unit: "count",
    suppression: "none",
    caveat:
      "Composite ops tile: agrega el estado de VARIAS métricas con metas distintas (antirrábica/esterilización/microchip) — no tiene una meta propia; el tono (ok/warn/danger por umbral de cantidad de provincias) es una heurística de atención, no un veredicto único.",
    window: "period",
    species: "all_species",
    basis: "stock",
    question: "¿Cuántas provincias tienen al menos una métrica programática por debajo de su meta?",
    exclusions:
      "No cuenta combinaciones (provincia×métrica, ese es outlierCount y puede superar 24) — cuenta provincias ÚNICAS, por eso nunca puede exceder el total de provincias (~24).",
    semaphore: { paintAgainst: "none" },
  },

  // ---------------------------------------------------------------------------
  // C1 sweep (2026-07-22) — /gob/padron (vista Censo) + /admin/padron (vista
  // Censo)'s KPI row (F8 fusion, formerly /gob/censo + /admin/censo).
  // ---------------------------------------------------------------------------

  registry_active_pets: {
    id: "registry_active_pets",
    label: "Mascotas activas",
    numerator: "COUNT pets where status = 'active'",
    denominator: "n/a — absolute count (excludes 'lost')",
    source: "pets",
    fetcherName: "registryCounts (active)",
    fetcherPath: "lib/metrics/census.ts",
    cadence: "point-in-time snapshot",
    unit: "count",
    suppression: "none",
    caveat:
      "Excluye 'lost' — es el subconjunto activo de registry_total_pets, no un porcentaje sobre ese total.",
    window: "now",
    species: "all_species",
    basis: "stock",
    question: "¿Cuántas mascotas tienen status='active' (excluyendo extraviadas) en este scope?",
    semaphore: { paintAgainst: "none" },
  },

  registry_dormant_pets: {
    id: "registry_dormant_pets",
    label: "Mascotas inactivas",
    numerator: `COUNT active/lost pets with NO pet_events (event_type <> 'credential_scanned') in the trailing ${TARGETS.DORMANT_MONTHS} months — pets with zero logged events also count as dormant`,
    denominator: "COUNT active/lost pets in scope",
    source: "pets, pet_events",
    fetcherName: "registryCounts (dormant)",
    fetcherPath: "lib/metrics/census.ts",
    cadence: `trailing ${TARGETS.DORMANT_MONTHS} months, recomputed on every render`,
    unit: "percent",
    suppression: "none",
    caveat:
      "Los umbrales de color (>20% ámbar, >40% rojo) son heurísticas operativas internas, no una meta legal o programática con fuente citable — por eso semaphore: none pese a que el tile sigue pintando ámbar/rojo. credential_scanned se excluye porque se purga automáticamente a los 90 días y no representa actividad del propietario.",
    window: "12m",
    species: "all_species",
    basis: "ratio",
    question:
      "¿Qué porcentaje del padrón no tiene ninguna actividad de propietario registrada en los últimos 12 meses?",
    semaphore: { paintAgainst: "none" },
    guards: { zeroDenominator: "dash" },
  },

  registry_incomplete_profiles: {
    id: "registry_incomplete_profiles",
    label: "Perfiles incompletos",
    numerator:
      "COUNT active/lost pets missing at least one of: active microchip_iso identification, known sex (≠ 'unknown'), jurisdiction_locality",
    denominator: "COUNT active/lost pets in scope",
    source: "pets, pet_identifications",
    fetcherName: "registryCounts (incomplete)",
    fetcherPath: "lib/metrics/census.ts",
    cadence: "point-in-time snapshot",
    unit: "percent",
    suppression: "none",
    caveat:
      "Los umbrales de color (>15% ámbar, >30% rojo) son heurísticas operativas internas, no una meta legal o programática con fuente citable.",
    window: "now",
    species: "all_species",
    basis: "ratio",
    question:
      "¿Qué porcentaje del padrón no tiene al menos uno de: chip activo, sexo conocido, o localidad?",
    semaphore: { paintAgainst: "none" },
    guards: { zeroDenominator: "dash" },
  },

  // ---------------------------------------------------------------------------
  // C1 sweep (2026-07-22) — /gob/padron (vista Población) + /admin/padron
  // (vista Población)'s KPI row (F8 fusion, formerly /gob/poblacion +
  // /admin/poblacion).
  // ---------------------------------------------------------------------------

  registered_births: {
    id: "registered_births",
    label: "Nacimientos registrados",
    numerator:
      "COUNT clinical_info_logged events where sub_kind='pregnancy', pregnancy_phase='ended', outcome='live_birth', in the ctx period",
    denominator: "n/a — flow count, compared against the PRIOR period for the deltaV2 chip",
    source: "pet_events (clinical_info_logged)",
    fetcherName: "fetchReproductiveOutcomes",
    fetcherPath: "lib/metrics/population-control.ts",
    cadence: "matches the caller's ProjectionContext period",
    unit: "count",
    suppression: "none",
    caveat:
      "Solo cuenta partos de preñeces registradas EN SEGUIMIENTO en el sistema — partos callejeros y camadas sin seguimiento son invisibles. Subestima la natalidad real: indicador direccional, no exacto. Por eso nunca pinta tono (siempre neutral) pese a tener delta.",
    window: "period",
    species: "all_species",
    basis: "flow",
    question:
      "¿Cuántos nacimientos de preñeces EN SEGUIMIENTO se registraron en el período, y cómo viene la tendencia?",
    semaphore: { paintAgainst: "none" },
    guards: {
      // Same "−95% MoM sobre base inestable" class fenced elsewhere — a
      // handful of tracked births swings wildly period over period.
      unstableDeltaBase: { minPriorBase: 5 },
      // H16 (external red-team 2026-07-30): unstableDeltaBase above only
      // distrusts a TINY prior base. An order-of-magnitude swing over a
      // HEALTHY base ("1 ↓ −99,6% desde 274") is the other half of the same
      // class and reads as an incomplete load, not a programme.
      deltaImplausible: DELTA_IMPLAUSIBLE_GUARD,
    },
  },

  net_registry_inflow: {
    id: "net_registry_inflow",
    label: "Altas netas registradas",
    numerator:
      "altas (COUNT pets.created_at in the ctx period) + registeredBirths (live_birth events in the same period)",
    denominator: "menos deaths (COUNT death_recorded events in the same period) — net, not a ratio",
    source: "pets, pet_events (clinical_info_logged, death_recorded)",
    fetcherName: "fetchNetGrowth",
    fetcherPath: "lib/metrics/population-control.ts",
    cadence: "matches the caller's ProjectionContext period",
    unit: "count",
    suppression: "none",
    caveat:
      "INDICADOR DIRECCIONAL, NO EXACTO — no es crecimiento poblacional real. 'Altas nuevas' son mascotas RECIÉN REGISTRADAS en miMAR (pets.created_at), que en su mayoría ya existían y no representan nacimientos. Los nacimientos registrados solo cubren partos en seguimiento. Un valor positivo refleja sobre todo ritmo de adopción del sistema, no necesariamente más mascotas vivas. Por eso el tono es SIEMPRE neutral — nunca pinta ok/danger.",
    window: "period",
    species: "all_species",
    basis: "flow",
    question:
      "¿Cuál es el balance de altas − nacimientos registrados − muertes en el período? (indicador direccional, no un conteo de crecimiento poblacional real)",
    semaphore: { paintAgainst: "none" },
  },

  // ---------------------------------------------------------------------------
  // C1 sweep (2026-07-22) — /gob/adopciones + /admin/adopciones' KPI row.
  // ---------------------------------------------------------------------------

  shelter_custody_occupied: {
    id: "shelter_custody_occupied",
    label: "En custodia (refugio)",
    numerator: "SUM active ownerships where role='shelter_custody' AND ended_at IS NULL",
    denominator: "n/a — absolute count (this tile shows the numerator alone, not the % ratio)",
    source: "ownerships",
    fetcherName: "fetchShelterOccupancyNational (occupied)",
    fetcherPath: "lib/metrics/custody.ts",
    cadence: "point-in-time snapshot",
    unit: "count",
    suppression: "none",
    caveat:
      "Reutiliza el mismo fetcher que shelter_occupancy_national (catálogo) pero muestra solo el numerador 'occupied' — no el % ocupación/cupo. En /gob/adopciones el valor está scoped a la jurisdicción vía ownerships; el cupo (capacity) sigue siendo NACIONAL (config de organizaciones, no divisible por jurisdicción) — por eso esta tile nunca muestra un %, solo el conteo.",
    window: "now",
    species: "all_species",
    basis: "stock",
    question: "¿Cuántos animales están actualmente en custodia activa de refugio, en este scope?",
    semaphore: { paintAgainst: "none" },
  },

  foster_active_placements: {
    id: "foster_active_placements",
    label: "En tránsito",
    numerator: "COUNT ownerships where role='foster' AND ended_at IS NULL",
    denominator: "n/a — absolute count",
    source: "ownerships",
    fetcherName: "fetchFosterPoolUtilization (activeFosterPlacements)",
    fetcherPath: "lib/metrics/custody.ts",
    cadence: "point-in-time snapshot",
    unit: "count",
    suppression: "none",
    window: "now",
    species: "all_species",
    basis: "stock",
    question: "¿Cuántas colocaciones de tránsito están activas ahora mismo, en este scope?",
    semaphore: { paintAgainst: "none" },
  },

  adoptions_finalized: {
    id: "adoptions_finalized",
    // C1 label precision (2026-07-22): renamed from bare "Adopciones" — that
    // string collided (registry-import fence, lint:metric-labels) with
    // unrelated UI copy elsewhere (org daily-loop task labels, the
    // notificaciones category map) that has nothing to do with this KPI.
    // "Adopciones finalizadas" is also more precise on its own merits — it
    // names the exact adoption_finalized event, not the broader adoption
    // *process* (postulaciones, embudo, etc.) other surfaces also discuss.
    label: "Adopciones finalizadas",
    numerator: "COUNT adoption_finalized events in the ctx period",
    denominator: "n/a — flow count, compared against the PRIOR period for the deltaV2 chip",
    source: "pet_events (adoption_finalized)",
    fetcherName: "fetchCustodyFunnel (adoption)",
    fetcherPath: "lib/metrics/custody.ts",
    cadence:
      "matches the caller's ProjectionContext period vs the prior period (fetchPrevAdoptionCount)",
    unit: "count",
    suppression: "none",
    window: "period",
    species: "all_species",
    basis: "flow",
    methodologyVersion: 2, // K8: label renamed 2026-07-22 (see above)
    question: "¿Cuántas adopciones se finalizaron en el período, y cómo viene la tendencia?",
    semaphore: { paintAgainst: "none" },
    guards: {
      // Same "−95% MoM sobre base inestable" class fenced elsewhere.
      unstableDeltaBase: { minPriorBase: 5 },
      // H16 (external red-team 2026-07-30): unstableDeltaBase above only
      // distrusts a TINY prior base. An order-of-magnitude swing over a
      // HEALTHY base ("1 ↓ −99,6% desde 274") is the other half of the same
      // class and reads as an incomplete load, not a programme.
      deltaImplausible: DELTA_IMPLAUSIBLE_GUARD,
    },
  },

  // ---------------------------------------------------------------------------
  // C1 sweep (2026-07-22) — /gob/campanas' KPI row.
  // ---------------------------------------------------------------------------

  campaign_enrollment: {
    id: "campaign_enrollment",
    label: "Inscripciones (campañas)",
    numerator:
      "COUNT appointment turnos reservados (status IN confirmed/attended/no_show) in the ctx period, for offerings matching the optional serviceKind filter",
    denominator: "n/a — flow count, compared against the PRIOR period for the deltaV2 chip",
    source: "appointments, service_offerings",
    fetcherName: "fetchCampaignDashboard (totals.enrollment)",
    fetcherPath: "lib/analytics/campaign-metrics.ts",
    cadence: "matches the caller's ProjectionContext period vs the prior period",
    unit: "count",
    suppression: "none",
    caveat:
      "Turnos cancelados no se cuentan. Tono siempre 'blue' (informativo) — no es una tasa de cumplimiento.",
    window: "period",
    species: "all_species",
    basis: "flow",
    question: "¿Cuántos turnos se reservaron en campañas sanitarias en el período?",
    semaphore: { paintAgainst: "none" },
    guards: {
      unstableDeltaBase: { minPriorBase: 5 },
      // H16 (external red-team 2026-07-30): unstableDeltaBase above only
      // distrusts a TINY prior base. An order-of-magnitude swing over a
      // HEALTHY base ("1 ↓ −99,6% desde 274") is the other half of the same
      // class and reads as an incomplete load, not a programme.
      deltaImplausible: DELTA_IMPLAUSIBLE_GUARD,
    },
  },

  campaign_completion_rate: {
    id: "campaign_completion_rate",
    label: "Completitud de campañas",
    numerator: "COUNT appointments with status='attended' in the ctx period",
    denominator: "COUNT enrollment (turnos reservados) in the SAME period — null when 0",
    source: "appointments",
    fetcherName: "fetchCampaignDashboard (totals.completionRate)",
    fetcherPath: "lib/analytics/campaign-metrics.ts",
    cadence: "matches the caller's ProjectionContext period",
    unit: "percent",
    suppression: "none",
    caveat:
      "No muestra delta: el único dato de período anterior disponible es un delta de VOLUMEN (conteo), no de tasa — mostrar '+100%' junto a una tasa estable del 72% implicaría un salto que no ocurrió.",
    window: "period",
    species: "all_species",
    basis: "ratio",
    question: "¿Qué porcentaje de turnos reservados en campañas resultó en asistencia efectiva?",
    target: {
      value: TARGETS.CAMPAIGN_COMPLETION_PCT,
      source: "meta programática de campañas",
      sourceKind: "benchmark",
    },
    semaphore: { paintAgainst: "target" },
    guards: {
      // A handful of turnos in a small campaign can read as a deceptively
      // confident completion rate (e.g. 1 de 1 = 100%).
      smallN: { min: 5 },
      zeroDenominator: "dash",
    },
  },

  campaign_attendance: {
    id: "campaign_attendance",
    label: "Asistencias (campañas)",
    numerator: "COUNT appointments with status='attended' in the ctx period",
    denominator: "n/a — flow count, compared against the PRIOR period for the deltaV2 chip",
    source: "appointments",
    fetcherName: "fetchCampaignDashboard (totals.completion)",
    fetcherPath: "lib/analytics/campaign-metrics.ts",
    cadence: "matches the caller's ProjectionContext period vs the prior period",
    unit: "count",
    suppression: "none",
    caveat:
      "Mismo numerador que campaign_completion_rate, mostrado como conteo absoluto en vez de tasa. Tono siempre 'ok' (no deriva de una meta) — es un conteo de actividad, no un veredicto.",
    window: "period",
    species: "all_species",
    basis: "flow",
    question: "¿Cuántas asistencias efectivas hubo en campañas en el período?",
    semaphore: { paintAgainst: "none" },
    guards: {
      unstableDeltaBase: { minPriorBase: 5 },
      // H16 (external red-team 2026-07-30): unstableDeltaBase above only
      // distrusts a TINY prior base. An order-of-magnitude swing over a
      // HEALTHY base ("1 ↓ −99,6% desde 274") is the other half of the same
      // class and reads as an incomplete load, not a programme.
      deltaImplausible: DELTA_IMPLAUSIBLE_GUARD,
    },
  },

  campaign_no_show: {
    id: "campaign_no_show",
    label: "Ausencias (campañas)",
    numerator: "COUNT appointments with status='no_show' in the ctx period",
    denominator: "n/a — flow count, compared against the PRIOR period for the deltaV2 chip",
    source: "appointments",
    fetcherName: "fetchCampaignDashboard (totals.noShow)",
    fetcherPath: "lib/analytics/campaign-metrics.ts",
    cadence: "matches the caller's ProjectionContext period vs the prior period",
    unit: "count",
    suppression: "none",
    caveat:
      "Sin meta formal — el tono de atención (ámbar cuando >0) es una señal operativa (posibles barreras de acceso), no un veredicto de cumplimiento.",
    window: "period",
    species: "all_species",
    basis: "flow",
    question: "¿Cuántas ausencias (no-show) hubo en campañas en el período?",
    semaphore: { paintAgainst: "none" },
    guards: {
      unstableDeltaBase: { minPriorBase: 5 },
      // H16 (external red-team 2026-07-30): unstableDeltaBase above only
      // distrusts a TINY prior base. An order-of-magnitude swing over a
      // HEALTHY base ("1 ↓ −99,6% desde 274") is the other half of the same
      // class and reads as an incomplete load, not a programme.
      deltaImplausible: DELTA_IMPLAUSIBLE_GUARD,
    },
  },

  campaign_sanitary_outcome: {
    id: "campaign_sanitary_outcome",
    label: "Impacto sanitario (campañas)",
    numerator:
      "COUNT sanitary pet_events (vaccination_administered / sterilization_performed / deworming_administered) linked to an ATTENDED campaign appointment via appointments.outcome_event_id, in the ctx period",
    denominator:
      "n/a — absolute count; outcomeConversionRate (attended → prestación) is shown in the info caveat, not as a separate tile",
    source: "appointments, pet_events",
    fetcherName: "fetchCampaignDashboard (totals.sanitaryOutcome)",
    fetcherPath: "lib/analytics/campaign-metrics.ts",
    cadence: "matches the caller's ProjectionContext period",
    unit: "count",
    suppression: "none",
    caveat:
      "Es el RESULTADO sanitario, no la logística — atribución exacta por turno vía outcome_event_id, no un proxy por ventana temporal. Tono siempre 'ok' (no deriva de una meta).",
    window: "period",
    species: "all_species",
    basis: "flow",
    question:
      "¿Cuántas prestaciones sanitarias efectivamente registradas (evento inmutable) resultaron de turnos asistidos en campañas, en el período?",
    semaphore: { paintAgainst: "none" },
  },

  // ---------------------------------------------------------------------------
  // C1 sweep (2026-07-22) — /gob/outreach's pipeline summary KPI row.
  // ---------------------------------------------------------------------------

  outreach_overdue_rabies_count: {
    id: "outreach_overdue_rabies_count",
    label: "Antirrábica vencida (pipeline)",
    numerator:
      "COUNT active pets whose latest vaccination_administered event (vaccine_name ILIKE '%antirr%') is older than the overdue cutoff (~365 days), OR that have no such event ever",
    denominator: "n/a — absolute count, CAPPED at 500 rows (LIMIT in the underlying query)",
    source: "pets, pet_events (vaccination_administered)",
    fetcherName: "fetchOverdueRabiesVaccine",
    fetcherPath: "lib/infra/outreach-pipelines.ts",
    cadence: "'now' snapshot vs a rolling ~365-day cutoff",
    unit: "count",
    suppression: "none",
    caveat:
      "El pipeline trae como máximo 500 filas (LIMIT 500) — si la jurisdicción tiene más de 500 mascotas vencidas, este número SUBESTIMA el total real. El tile no distingue ese caso; leer junto con el CSV completo antes de asumir que es el total exacto.",
    window: "now",
    species: "all_species",
    basis: "stock",
    question:
      "¿Cuántas mascotas activas en la cobertura tienen la antirrábica vencida o nunca vacunada?",
    exclusions:
      "Es el reverso operativo de rabies_coverage_dogs_12m, pero con scope de TODAS las especies (no solo perros) y un corte de vencimiento (~365 días) en vez de la ventana de 12 meses — no son el mismo conteo ni deben sumarse.",
    semaphore: { paintAgainst: "none" },
  },

  outreach_stray_scan_areas: {
    id: "outreach_stray_scan_areas",
    label: "Áreas con escaneos (pipeline)",
    numerator:
      "COUNT DISTINCT localities with ≥1 credential_scanned event where payload.is_self_scan = false, in the ctx period",
    denominator: "n/a — absolute count",
    source: "pet_events (credential_scanned)",
    fetcherName: "fetchStrayDensityAreas",
    fetcherPath: "lib/infra/outreach-pipelines.ts",
    cadence: "matches the caller's ProjectionContext period (trailing 30 days on this page)",
    unit: "count",
    suppression: "none",
    caveat:
      "'Callejero' es un PROXY (escaneo no-propio de credencial), no una clasificación veterinaria confirmada — sin meta formal; el tono de atención (ámbar cuando >0) es operativo.",
    window: "30d",
    species: "all_species",
    basis: "stock",
    question:
      "¿En cuántas localidades hubo al menos un escaneo de credencial no-propio (proxy de animal callejero) en el período?",
    semaphore: { paintAgainst: "none" },
  },

  outreach_sterilization_vets_ranked: {
    id: "outreach_sterilization_vets_ranked",
    label: "Vets en ranking (pipeline)",
    numerator:
      "COUNT DISTINCT veterinarians with ≥1 sterilization_performed event in the ctx period",
    denominator: "n/a — absolute count",
    source: "pet_events (sterilization_performed)",
    fetcherName: "fetchSterilizationVetRanking",
    fetcherPath: "lib/infra/outreach-pipelines.ts",
    cadence: "matches the caller's ProjectionContext period (trailing 30 days on this page)",
    unit: "count",
    suppression: "none",
    caveat:
      "Es un conteo de participación (cuántos vets aparecen en la tabla de reconocimiento de abajo), no una tasa de cumplimiento — tono siempre 'blue' (informativo).",
    window: "30d",
    species: "all_species",
    basis: "stock",
    question:
      "¿Cuántos veterinarios/as tienen al menos una esterilización registrada en el período, en la cobertura?",
    semaphore: { paintAgainst: "none" },
  },

  // ---------------------------------------------------------------------------
  // C1 sweep (2026-07-22) — /gob/mortalidad's KPI row (period-variable siblings
  // of mortality_deaths_12m/mortality_disposal_traceability, which are FIXED
  // 12m — this page has a period picker, so these are genuinely distinct
  // window semantics, not the same KPI re-rendered).
  // ---------------------------------------------------------------------------

  mortality_deaths_period: {
    id: "mortality_deaths_period",
    label: "Fallecimientos registrados (período)",
    numerator: "COUNT death_recorded events in the ctx period, in scope",
    denominator: "n/a — flow count, compared against the PRIOR period for the deltaV2 chip",
    source: "pet_events (death_recorded)",
    fetcherName: "fetchMortalityDisposition (total)",
    fetcherPath: "lib/analytics/mortality-metrics.ts",
    cadence:
      "matches the caller's ProjectionContext period (adjustable via /gob/mortalidad's period picker) vs the prior period",
    unit: "count",
    suppression: "none",
    caveat:
      "Distinto de mortality_deaths_12m (catálogo): ese usa una ventana FIJA de 12 meses (el home no tiene selector de período); este usa el período seleccionado en /gob/mortalidad, que puede ser cualquier rango.",
    window: "period",
    species: "all_species",
    basis: "flow",
    question:
      "¿Cuántos fallecimientos se registraron en el período seleccionado, y cómo viene la tendencia?",
    semaphore: { paintAgainst: "none" },
    guards: {
      unstableDeltaBase: { minPriorBase: 5 },
      // H16 (external red-team 2026-07-30): unstableDeltaBase above only
      // distrusts a TINY prior base. An order-of-magnitude swing over a
      // HEALTHY base ("1 ↓ −99,6% desde 274") is the other half of the same
      // class and reads as an incomplete load, not a programme.
      deltaImplausible: DELTA_IMPLAUSIBLE_GUARD,
      zeroDenominator: "dash",
    },
  },

  mortality_unknown_disposal_rate: {
    id: "mortality_unknown_disposal_rate",
    label: "Disposición desconocida",
    numerator: "COUNT death_recorded events where disposition_method IS NULL OR = 'unknown'",
    denominator: "COUNT death_recorded events in the ctx period — null when 0",
    source: "pet_events (death_recorded)",
    fetcherName: "fetchMortalityDisposition (unknownRate)",
    fetcherPath: "lib/analytics/mortality-metrics.ts",
    cadence: "matches the caller's ProjectionContext period",
    unit: "percent",
    suppression: "none",
    caveat:
      "Es el complemento negativo de mortality_disposal_traceability — mismo denominador, numerador inverso. Umbral de incumplimiento (no meta a alcanzar): superar el umbral activa el banner OpBreach.",
    window: "period",
    species: "all_species",
    basis: "ratio",
    question: "¿Qué porcentaje de fallecimientos no tiene método de disposición registrado?",
    target: {
      value: TARGETS.DISPOSAL_UNKNOWN_BREACH_PCT,
      source: "Ley CABA 5470 (umbral de incumplimiento — lower-is-better)",
      // Same law family as mortality_disposal_traceability — the law mandates
      // traceability, not this specific 25% breach threshold.
      sourceKind: "programmatic-target",
    },
    semaphore: { paintAgainst: "target" },
    guards: {
      // A handful of total deaths can make this rate read as a dramatic
      // percentage from just 1-2 unknown-disposition cases.
      smallN: { min: 5 },
      zeroDenominator: "dash",
    },
  },

  mortality_reportable_share: {
    id: "mortality_reportable_share",
    label: "Muertes notificables",
    numerator: "COUNT death_recorded events where is_reportable = true",
    denominator: "COUNT death_recorded events in the ctx period — null when 0",
    source: "pet_events (death_recorded)",
    fetcherName: "fetchMortalityDisposition (reportableShare)",
    fetcherPath: "lib/analytics/mortality-metrics.ts",
    cadence: "matches the caller's ProjectionContext period",
    unit: "percent",
    suppression: "none",
    caveat:
      "Sin meta numérica — cualquier valor > 0% requiere notificación ENO a la autoridad sanitaria (B9); el tono de atención (ámbar cuando >0) no deriva de un umbral porcentual, deriva de la sola presencia de casos notificables.",
    window: "period",
    species: "all_species",
    basis: "ratio",
    question:
      "¿Qué porcentaje de fallecimientos corresponde a enfermedades de notificación obligatoria?",
    semaphore: { paintAgainst: "none" },
    // NO smallN guard here (deliberate, unlike its ratio siblings): a
    // reportable death is a compliance-actionable fact regardless of how
    // small the total-deaths sample is — even 1-of-1 genuinely requires ENO
    // notification. Forcing the warn tone to neutral under a tiny N would
    // mask a real signal instead of protecting against a false one.
    guards: {
      zeroDenominator: "dash",
    },
  },

  // ---------------------------------------------------------------------------
  // C1 sweep (2026-07-22) — /gob/perdidas' remaining KPI row tiles
  // (reunification_rate itself was already migrated in an earlier consumer
  // batch; these are its stock/flow siblings on the same page).
  // ---------------------------------------------------------------------------

  lost_pets_active_stock: {
    id: "lost_pets_active_stock",
    label: "Pérdidas activas",
    numerator: "COUNT pets where status = 'lost', in scope",
    denominator: "n/a — absolute count",
    source: "pets",
    fetcherName: "fetchPerdidasMetrics (activeCount)",
    fetcherPath: "lib/analytics/dashboards/perdidas.ts",
    cadence: "'now' snapshot",
    unit: "count",
    suppression: "none",
    caveat:
      "Es el stock co-primario que SIEMPRE debe leerse junto a la tasa de reunificación (reunification_rate) — una tasa alta con pocos episodios no es una victoria poblacional si este stock sigue siendo grande.",
    window: "now",
    species: "all_species",
    basis: "stock",
    question: "¿Cuántas mascotas están actualmente perdidas en la cobertura?",
    semaphore: { paintAgainst: "none" },
  },

  lost_pets_recovered_30d: {
    id: "lost_pets_recovered_30d",
    label: "Recuperados (30 días)",
    numerator:
      "COUNT status_changed events where payload.from_status='lost' AND payload.to_status='active', occurred_at within the trailing 30 days",
    denominator: "n/a — absolute count",
    source: "pets, pet_events (status_changed)",
    fetcherName: "fetchPerdidasMetrics (recoveredMonth)",
    fetcherPath: "lib/analytics/dashboards/perdidas.ts",
    cadence: "trailing 30 days",
    unit: "count",
    suppression: "none",
    caveat:
      "Excluye bajas (fallecimiento u otras salidas mientras estaban perdidas) — solo reunificaciones reales. Tono siempre 'ok' (no deriva de una meta).",
    window: "30d",
    species: "all_species",
    basis: "flow",
    question: "¿Cuántas mascotas volvieron de 'perdido' a 'activo' en los últimos 30 días?",
    exclusions:
      "DISTINTO de reunification_rate.recovered (catálogo): ese cuenta, de los episodios de pérdida INICIADOS en los últimos 30 días, cuántos se recuperaron (cohorte por inicio, sin ventana en la recuperación misma). Este conteo cuenta eventos de RECUPERACIÓN ocurridos en los últimos 30 días, sin importar cuándo empezó el episodio (ventana por evento, no por cohorte). Ambos son honestos; miden preguntas distintas y pueden diferir en valor.",
    semaphore: { paintAgainst: "none" },
  },

  lost_pets_avg_days_active: {
    id: "lost_pets_avg_days_active",
    label: "Antigüedad media (días)",
    numerator: "AVG(now − markedLostAt) over currently-lost pets, in days",
    denominator: "n/a — average, not a ratio",
    source: "pets, pet_events (status_changed)",
    fetcherName: "fetchPerdidasMetrics (avgDaysActive)",
    fetcherPath: "lib/analytics/dashboards/perdidas.ts",
    cadence: "'now' snapshot",
    unit: "days",
    suppression: "none",
    caveat: "0 cuando no hay mascotas actualmente perdidas en scope.",
    window: "now",
    species: "all_species",
    basis: "stock",
    question:
      "¿Cuál es el promedio de días transcurridos desde la pérdida, entre las mascotas actualmente perdidas?",
    semaphore: { paintAgainst: "none" },
  },

  reunification_median_recovery_days: {
    id: "reunification_median_recovery_days",
    label: "Mediana recuperación (días)",
    numerator:
      "PERCENTILE_CONT(0.5) of (recovery_at − lost_at) over recovered episodes, trailing 30 days",
    denominator: "n/a — median, not a ratio; gated by the recovered-episode count",
    source: "pets, pet_events (status_changed)",
    fetcherName: "fetchReunificationRate (medianDaysToRecovery)",
    fetcherPath: "lib/analytics/compliance-metrics.ts",
    cadence: "FIXED trailing 30 days (same fetcher/window as reunification_rate)",
    unit: "days",
    suppression: "none",
    caveat:
      "Comparte fetcher con reunification_rate pero es una unidad DISTINTA (días, no %) — por eso tiene su propio descriptor sin meta (una meta de 39% no aplica a una mediana de días). Gated por el MISMO smallN que reunification_rate (sobre `recovered`, no `lostEpisodes`): con menos de 5 recuperaciones se muestra '—' en vez de un número (más estricto que el guard genérico — no hay valor-visible-con-nota, directamente se oculta, ver app/gob/perdidas/page.tsx).",
    window: "30d",
    species: "all_species",
    basis: "stock",
    question:
      "¿Cuántos días, en mediana, tardaron las mascotas recuperadas en los últimos 30 días entre perderse y volver?",
    semaphore: { paintAgainst: "none" },
    guards: {
      // Mirrors reunification_rate's smallN floor (5) — same underlying
      // `recovered` count. Kept as a literal (not TARGETS.*) because it is a
      // presentation-guard convention, not a legal/programmatic target.
      smallN: { min: 5 },
      // Via an inline smallNGate call at /gob/perdidas (value stays visible).
      manualEnforcement: true,
    },
  },

  // ---------------------------------------------------------------------------
  // C1 sweep (2026-07-22) — /gob/analytics' remaining KPI row tiles.
  // ---------------------------------------------------------------------------

  acquisition_adoption_rate: {
    id: "acquisition_adoption_rate",
    label: "Tasa de adopción (12 meses)",
    numerator:
      "COUNT pet_registered events where payload.acquisition_method='adopted', trailing 12 months",
    denominator:
      "COUNT pet_registered events (ALL acquisition methods) in the SAME trailing 12 months — 0 when no registrations",
    source: "pet_events (pet_registered)",
    fetcherName: "fetchAnalyticsMetrics (adoptionRate)",
    fetcherPath: "lib/analytics/dashboards/analytics.ts",
    cadence: "trailing 12 months",
    unit: "percent",
    suppression: "none",
    caveat:
      "DISTINTO de adoption_application_conversion (catálogo): ese mide el embudo de postulaciones ONLINE (demanda); este mide qué fracción de las ALTAS de mascotas en el padrón llegaron por adopción vs. otros métodos de adquisición (compra, hallazgo, regalo, camada, etc.) — lado de OFERTA/adquisición, no de postulación.",
    window: "12m",
    species: "all_species",
    basis: "ratio",
    question:
      "¿Qué porcentaje de las mascotas dadas de alta en los últimos 12 meses llegó por adopción, del total de adquisiciones?",
    target: {
      value: TARGETS.ADOPTION_RATE_PCT,
      source: "meta interna de adquisición (A3)",
      sourceKind: "benchmark",
    },
    semaphore: { paintAgainst: "target" },
    guards: {
      // A small registrations volume in a small jurisdiction/window can make
      // this rate read as a confident percentage from just 1-2 adoptions.
      smallN: { min: 5 },
      zeroDenominator: "dash",
    },
    // FORECAST-A-META (2026-07-22): the ONLY catalog KPI wired to a forecast
    // line — see the "honest remainder" audit below KPI_CATALOG for why every
    // other target-bearing ratio was investigated and rejected. This one
    // qualifies because /gob/analytics ALREADY fetches fetchAcquisitionTrend
    // (month × acquisition_method_bucket rows) in its bounded Promise.all —
    // summing y where method==="shelter_adoption" (numerator) over the SAME
    // month's total y across all buckets (denominator) reconstructs a genuine
    // per-month adoption-RATE series, zero new query fan-out.
    forecast: {
      trendSource:
        "fetchAcquisitionTrend (lib/analytics/dashboards/analytics.ts) — per-(month, acquisition_method_bucket) rows, aggregated at the render site into a monthly adoption-rate series (shelter_adoption / total)",
    },
  },

  custody_disputes_open: {
    id: "custody_disputes_open",
    label: "Disputas de custodia",
    numerator: "COUNT custody_disputes rows in dispute (open o escalated), in scope",
    denominator: "n/a — absolute count",
    source: "custody_disputes",
    fetcherName: "fetchAnalyticsMetrics (custodyDisputes)",
    fetcherPath: "lib/analytics/dashboards/analytics.ts",
    cadence: "'now' snapshot",
    unit: "count",
    suppression: "none",
    caveat:
      "Misma fuente que la cola de disputas en /gob/casos?expediente=disputas (custody_disputes, no cases) — el conteo y la cola siempre reconcilian. Incluye las escaladas: una disputa escalada pasó a la vía judicial, no se cerró, y sigue reteniendo el bloqueo de custodia. Sin meta formal — el tono de atención (ámbar cuando >0) es operativo.",
    window: "now",
    species: "n/a",
    basis: "stock",
    question: "¿Cuántas disputas de custodia siguen en curso en la cobertura?",
    semaphore: { paintAgainst: "none" },
  },

  // ---------------------------------------------------------------------------
  // C1 sweep (2026-07-22) — /gob/decomisos' single KPI tile.
  // ---------------------------------------------------------------------------

  seizures_period_count: {
    id: "seizures_period_count",
    label: "Decomisos del período",
    numerator:
      "COUNT shelter_intake_recorded events where payload.intake_reason='seizure', in the ctx period",
    denominator: "n/a — absolute count",
    source: "pet_events (shelter_intake_recorded)",
    fetcherName: "fetchSeizures (total)",
    fetcherPath: "lib/analytics/compliance-metrics.ts",
    cadence: "matches the caller's ProjectionContext period (default trailing 30 days)",
    unit: "count",
    suppression: "none",
    caveat:
      "Sin meta formal — Ley 14.346 no fija un umbral numérico de incautaciones; el tono de atención (ámbar cuando >0) es operativo, no un veredicto de cumplimiento.",
    window: "period",
    species: "all_species",
    basis: "flow",
    question: "¿Cuántas incautaciones (decomisos) por Ley 14.346 se registraron en el período?",
    semaphore: { paintAgainst: "none" },
  },

  // ---------------------------------------------------------------------------
  // C1 sweep (2026-07-22) — /gob/maltrato's 4 KPI tiles (triage queue counts,
  // Ley Nacional 14.346). Genuinely metrics (each answers a real triage
  // question), not bare row counts of an arbitrary view — cataloged rather
  // than left descriptor-less.
  // ---------------------------------------------------------------------------

  maltrato_unassigned_count: {
    id: "maltrato_unassigned_count",
    label: "Denuncias sin asignar",
    numerator:
      "COUNT welfare_reports where assigned_to_user_id IS NULL AND status NOT IN (closed/invalid/duplicate terminal states), in scope",
    denominator: "n/a — absolute count",
    source: "welfare_reports",
    fetcherName: "fetchWelfareMetrics (unassignedCount)",
    fetcherPath: "lib/analytics/dashboards/welfare.ts",
    cadence: "'now' snapshot",
    unit: "count",
    suppression: "none",
    caveat:
      "Sin meta formal — el tono de atención (ámbar cuando >0) es operativo: son denuncias que requieren triage inmediato, no un veredicto de cumplimiento con umbral.",
    window: "now",
    species: "n/a",
    basis: "stock",
    question: "¿Cuántas denuncias de maltrato están sin asignar y requieren triage inmediato?",
    semaphore: { paintAgainst: "none" },
  },

  maltrato_assigned_to_me_count: {
    id: "maltrato_assigned_to_me_count",
    label: "Denuncias asignadas a mí",
    numerator:
      "COUNT welfare_reports where assigned_to_user_id = current_user AND status IN (open/triaged/in_progress), in scope",
    denominator: "n/a — absolute count",
    source: "welfare_reports",
    fetcherName: "fetchWelfareMetrics (myCount)",
    fetcherPath: "lib/analytics/dashboards/welfare.ts",
    cadence: "'now' snapshot, per-operator (current_user)",
    unit: "count",
    suppression: "none",
    caveat: "Personalizado por operador — no comparable entre operadores como métrica de programa.",
    window: "now",
    species: "n/a",
    basis: "stock",
    question: "¿Cuántas denuncias de maltrato tengo asignadas y en curso?",
    semaphore: { paintAgainst: "none" },
  },

  maltrato_in_progress_count: {
    id: "maltrato_in_progress_count",
    label: "Denuncias en investigación",
    numerator: "COUNT welfare_reports where status = 'in_progress', in scope",
    denominator: "n/a — absolute count",
    source: "welfare_reports",
    fetcherName: "fetchWelfareMetrics (inProgressCount)",
    fetcherPath: "lib/analytics/dashboards/welfare.ts",
    cadence: "'now' snapshot",
    unit: "count",
    suppression: "none",
    window: "now",
    species: "n/a",
    basis: "stock",
    question: "¿Cuántas denuncias de maltrato están actualmente en investigación?",
    semaphore: { paintAgainst: "none" },
  },

  maltrato_closed_30d_count: {
    id: "maltrato_closed_30d_count",
    label: "Denuncias cerradas (30 días)",
    numerator:
      "COUNT welfare_reports where status = 'closed' AND closed_at within the trailing 30 days, in scope",
    denominator: "n/a — absolute count",
    source: "welfare_reports",
    fetcherName: "fetchWelfareMetrics (closedMonth)",
    fetcherPath: "lib/analytics/dashboards/welfare.ts",
    cadence: "trailing 30 days",
    unit: "count",
    suppression: "none",
    caveat:
      "Tono siempre 'ok' (no deriva de una meta) — es un conteo de throughput, no un veredicto.",
    window: "30d",
    species: "n/a",
    basis: "flow",
    question: "¿Cuántas denuncias de maltrato se cerraron en los últimos 30 días?",
    semaphore: { paintAgainst: "none" },
  },

  // ---------------------------------------------------------------------------
  // C1 sweep (2026-07-22) — /admin/inteligencia's KPI row (territorial
  // aggregates + record-level reconciliation counts — NO individual scoring,
  // Ley 25.326).
  // ---------------------------------------------------------------------------

  territorial_index_provinces_evaluated: {
    id: "territorial_index_provinces_evaluated",
    label: "Provincias evaluadas (índice territorial)",
    numerator: "COUNT provinces with ≥5 active pets (k-anonymity floor)",
    denominator: "n/a — absolute count",
    source: "derivado de fetchCrossJurisdictionOutliers vía computeJurisdictionIndex",
    fetcherName: "computeJurisdictionIndex (row count)",
    fetcherPath: "lib/analytics/territorial-index.ts",
    cadence: "matches the caller's ProjectionContext period",
    unit: "count",
    suppression:
      "k-anon (k=5) — provinces below the floor are entirely omitted, not shown as suppressed rows",
    window: "period",
    species: "all_species",
    basis: "stock",
    question:
      "¿Cuántas provincias tienen población suficiente para calcular el índice territorial?",
    semaphore: { paintAgainst: "none" },
  },

  territorial_index_average_score: {
    id: "territorial_index_average_score",
    label: "Índice territorial promedio",
    numerator:
      "SUM per-province composite score (mean of min(100, rate/target×100) across rabies/sterilization/microchip), across evaluated provinces",
    denominator: "COUNT evaluated provinces — null when 0",
    source: "derivado de fetchCrossJurisdictionOutliers vía computeJurisdictionIndex",
    fetcherName: "computeJurisdictionIndex (national average)",
    fetcherPath: "lib/analytics/territorial-index.ts",
    cadence: "matches the caller's ProjectionContext period",
    unit: "count",
    suppression: "k-anon (k=5) inherited from the per-province index",
    caveat:
      "Promedio SIMPLE entre provincias evaluadas (no ponderado por población) — una provincia grande y una chica pesan igual.",
    window: "period",
    species: "all_species",
    basis: "ratio",
    question:
      "¿Cuál es el promedio del índice compuesto de cumplimiento (antirrábica/esterilización/chip) entre las provincias evaluadas?",
    semaphore: { paintAgainst: "none" },
  },

  policy_outcome_rule_changes_analyzed: {
    id: "policy_outcome_rule_changes_analyzed",
    label: "Cambios de reglas analizados",
    numerator:
      "COUNT govt_business_rule_{created,updated,deleted} audit_log rows with a mapped aggregate metric available for before/after comparison",
    denominator: "n/a — absolute count",
    source: "audit_log",
    fetcherName: "fetchPolicyOutcomes",
    fetcherPath: "lib/analytics/policy-outcome.ts",
    cadence:
      "FIXED ±window (POLICY_OUTCOME_WINDOW_DAYS) anchored to each rule change's own timestamp — does NOT use the page's period picker",
    unit: "count",
    suppression:
      "k-anon (k=5) on the before/after metric pair — a pair with <5 in either window is masked, not this count",
    caveat:
      "Correlación temporal, no atribución causal — un cambio de regla y un movimiento de métrica coincidentes no implican causa-efecto.",
    window: "mixed",
    species: "all_species",
    basis: "flow",
    question:
      "¿Cuántos cambios recientes de reglas jurisdiccionales tienen una métrica agregada mapeada para observar su antes/después?",
    semaphore: { paintAgainst: "none" },
  },

  ghost_records_count: {
    id: "ghost_records_count",
    label: "Registros fantasma",
    numerator:
      "COUNT active pets with NO ownership record AND no owner activity in the trailing 12 months, across evaluated (non-suppressed, province-assigned) provinces",
    denominator: "COUNT active pets across the SAME evaluated provinces — 0 when no records",
    source: "pets, ownerships, pet_events",
    fetcherName: "fetchProvinceDataQuality (totalGhosts)",
    fetcherPath: "lib/analytics/territorial-data-quality.ts",
    cadence: "matches the caller's ProjectionContext period",
    unit: "count",
    suppression: `k-anon (k=${"5"}) — provincias con <5 mascotas activas o sin provincia asignada se excluyen del total, y se lo dice explícitamente en el tile (ghostExclusionNote)`,
    caveat:
      "Los umbrales de color (>10% ámbar, >20% rojo, aplicados sobre el % mostrado en 'sub') son heurísticas operativas internas, no una meta legal o programática con fuente citable. Señal a NIVEL REGISTRO (conciliación de datos) — nunca puntuación de personas (Ley 25.326). El tile muestra el CONTEO absoluto como valor principal; el % es contexto secundario ('sub'), no el valor renderizado.",
    window: "period",
    species: "all_species",
    basis: "stock",
    question:
      "¿Cuántos registros activos no tienen titular ni actividad reciente (candidatos a conciliación de datos)?",
    semaphore: { paintAgainst: "none" },
  },
};

// ---------------------------------------------------------------------------
// FORECAST-A-META (2026-07-22) — the honest remainder, condensed
// (file-size fence, 2026-08-01 — see dim-interno:docs/reviews/2026-07-22 for the
// original per-KPI prose if the reasoning below needs re-deriving).
//
// Every target-bearing KPI was checked for a genuine, ALREADY-FETCHED
// per-bucket ratio trend (both numerator and denominator resolvable within
// the same bucket — `forecast.trendSource` must clear). Only
// `acquisition_adoption_rate` qualified. Excluded, each for a fetcher gap
// (a FLOW/count trend exists but not the matching per-bucket RATIO; each is
// feasible future work, not wired here to respect the zero-new-query-fan-out
// rule this task set): rabies_coverage_dogs_12m (fetchRabiesVaccinationTrend
// is vaccinations/bucket, not coverage-%/bucket — the "now" active-dog
// denominator has no historical back-dating), microchip_penetration (zero
// trend fetched anywhere), mortality_disposal_traceability /
// mortality_unknown_disposal_rate (fetchDeathCausesTrend is a count, not a
// traceable/total ratio), custody_return_rate (fetchAdoptionTrend counts
// finalizations, not the reversed/finalized ratio), eno_sla_compliance (no
// trend anywhere, snapshot only), reunification_rate (no trend fetch, and a
// FIXED 30d window with no period picker to bucket against),
// rabies_observation_compliance_10d (a started-count flow, not the
// closed-within-10d/closed ratio), campaign_completion_rate (an enrollment
// count, not attended/enrollment). ppp_registry_compliance has a target but
// `semaphore.paintAgainst: "none"` (uptake, not a legal-verdict ratio) and no
// trend either way — excluded on both counts.
// ---------------------------------------------------------------------------

/** All catalog entries as an array — convenience for iteration/rendering. */
export const KPI_CATALOG_LIST: KpiDefinition[] = Object.values(KPI_CATALOG);

/**
 * Look up a catalog entry by its fetcher function name.
 * Used by tests/tooling that start from "which fetcher renders this tile"
 * rather than from the KpiId.
 */
export function findKpiByFetcherName(fetcherName: string): KpiDefinition | undefined {
  return KPI_CATALOG_LIST.find((k) => k.fetcherName === fetcherName);
}

/**
 * Resolve a catalogued KPI's es-AR OpKpi ⓘ tooltip copy — the #15a wiring
 * point. Render sites call `getKpiInfo("some_kpi_id")` and pass the result
 * straight to `<OpKpi info={...}>` instead of repeating an inline
 * `info={{ definition, formula, caveat }}` object literal.
 *
 * Returns `undefined` for KPIs that don't have `ui` copy yet (either
 * uncatalogued, or catalogued but not yet wired) — callers should fall back
 * to their existing inline `info` prop in that case, not render a blank ⓘ.
 */
export function getKpiInfo(id: KpiId): KpiInfoTooltip | undefined {
  return KPI_CATALOG[id]?.ui;
}
