// Panorama application use-case: resolve a layer's GeoJSON FeatureCollection.
//
// F1 Panorama v2: density+signal point layers (perdidas, mordeduras, denuncias,
// zoonosis) are now routed through per-unit aggregation loaders that COUNT(*)
// GROUP BY province or locality. Reference layers (refugios, decomisos) keep
// their discrete-pin path. The toggle axis (level) now drives BOTH choropleth
// layers AND the aggregated point layers.
//
// Return shape carries an envelope ({ truncated, suppressedCount, level }) so
// the LayerPanel can surface the per-layer 2.000 cap and k-anon suppression
// count, and the map knows which render mode to apply.

import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";

import {
  type AggregatedPointRows,
  type ChoroplethMetric,
  type ChoroplethRows,
  type LayerRows,
  type ProvinceChoroplethRows,
  loadBiteEvents,
  loadCensusLookup,
  loadChoroplethByLevel,
  loadClinics,
  loadDecomisos,
  loadDenunciaCentroids,
  loadDenunciasByUnit,
  loadMordedurassByUnit,
  loadPerdidasByUnit,
  loadPerdidasEvents,
  loadReunificacionByUnit,
  loadShelters,
  loadSintomasByUnit,
  loadTendenciaByProvince,
  loadTerritorialIndexByProvince,
  loadVetDesertByProvince,
  loadZoonosisByUnit,
} from "@/src/modules/panorama/infrastructure/repository";

import { enrichPerCapita, isPercapitaEligible } from "@/src/modules/panorama/domain/percapita";
import type { TimeBasis } from "@/src/modules/panorama/domain/time-scrub";
import type {
  AggregationLevel,
  FeatureCollection,
  LayerId,
} from "@/src/modules/panorama/domain/types";
import {
  buildAggregatedPointFeatures,
  buildChoroplethFeatures,
  buildDecomisosFeatures,
  buildDenunciasFeatures,
  buildMordedurasFeatures,
  buildPerdidasFeatures,
  buildProvinceChoroplethFeatures,
  buildRefugiosFeatures,
} from "./build-features";

/**
 * panorama-event-points Slice 1 — SERVER-AUTHORITATIVE points-mode gate (A1).
 *
 * The client's `pointsEligible` is UX only; THIS is the security boundary. Points
 * mode requires BOTH the client-requested `mode=points` AND a province actually
 * resolved server-side (for admin this is the drilled-in province; for govt the
 * selected province, on top of the always-on `petsScope` binding). A crafted
 * `?mode=points` with no province resolves to false → aggregated bubbles, never a
 * national dot-dump of every lost-pet coordinate in the country.
 */
export function resolvePointsMode(modeParam: string | null, provinceResolved: boolean): boolean {
  return modeParam === "points" && provinceResolved;
}

/**
 * The active period plus an optional `asOf` upper bound (F4 temporal reproduction).
 * When `asOf` is set, event-windowable layers filter `occurred_at/created_at/
 * opened_at <= asOf` (in addition to `>= since`) so the operator can scrub the
 * situation back in time. Non-temporal layers (refugios + the current-state
 * choropleths) ignore `asOf` — the console dims them while a scrub is active.
 *
 * `basis` (task #77 bitemporal): "valid" (occurred_at, default — "what happened
 * when") or "transaction" (recorded_at — "what the State KNEW when"). Honored by
 * the pet_events-backed layers (perdidas, mordeduras, zoonosis); denuncias/decomisos
 * have no distinct recorded_at and replay by their single timestamp in both modes.
 */
export type LayerPeriod = { since: Date; asOf?: Date; basis?: TimeBasis };

/**
 * Aggregation axis. Controls both choropleth layers AND the density+signal point
 * layers (F1 Panorama v2). Defaults to "locality". Reference layers ignore it.
 */
export type { AggregationLevel };

/**
 * The use-case result. `features` is the GeoJSON the map plots; the envelope
 * fields are surfaced by the LayerPanel:
 *  - `truncated`       — the per-layer 2.000 cap clipped the result.
 *  - `suppressedCount` — choropleth cells hidden by k-anon (k=5); 0 otherwise.
 *  - `level`           — the aggregation level the features were built at, so
 *                        the map knows whether to fill polygons (province) or
 *                        plot centroids (locality / point layers).
 */
export type LayerFeaturesResult = {
  features: FeatureCollection;
  truncated: boolean;
  suppressedCount: number;
  noLocalityCount: number;
  /** "province" only for a choropleth layer aggregated by province; else "locality". */
  level: AggregationLevel;
  /**
   * panorama-event-points Slice 1: "points" when the result is a REAL
   * sighting-dots collection (server-authorized points mode), else "aggregated".
   * The console branches its residual/cap disclosure copy on this (A6).
   */
  mode?: "points" | "aggregated";
  /**
   * Points mode only: in-scope sightings with no exact coordinate — surfaced as
   * "N avistajes sin ubicación exacta" (a DISTINCT residual from `noLocalityCount`,
   * which means "unknown HOME jurisdiction" and carries the wrong copy — A6).
   */
  sinUbicacionCount?: number;
  /**
   * TRUE when this is a BUDGET/FAILURE fallback, not a real answer (panorama
   * QA 2026-07-14: the PBA cobertura drill's live rollup blew the 8s budget
   * and the empty fallback painted as "sin datos" — a timeout must NEVER be
   * indistinguishable from an empty dataset). Consumers surface an honest
   * "no pudimos calcular esta capa a tiempo" state instead of an empty map.
   */
  degraded?: boolean;
  /**
   * Bivariate province-grain fallback (task panorama-bivariate-2026-07-21).
   * Set ONLY by the "zoonosis" case at `level === "province"` (the national
   * overview) — a SEPARATE province-level rollup, k=5-suppressed at that grain,
   * for the "riesgo de brotes" bivariate join's signal axis. The primary
   * `features` above are UNCHANGED (still the PO 2026-07-16 department-grain
   * bubbles the standalone zoonosis layer paints); this is additional, join-only
   * data so the 3×3 encoding's cells match its cobertura partner's province
   * grain instead of refusing on ~500 near-empty department cells.
   */
  bivariateSignal?: FeatureCollection;
};

const empty = (): LayerFeaturesResult => ({
  features: { type: "FeatureCollection", features: [] },
  truncated: false,
  suppressedCount: 0,
  noLocalityCount: 0,
  level: "locality",
});

/**
 * Degraded/empty layer result — an empty FeatureCollection. Used as the
 * withDbBudget fallback on the page + API paths (task #74) so a slow or failing
 * layer fetch renders an empty map instead of hanging the response. Marked
 * `degraded` so no consumer can mistake a timeout for a real empty dataset.
 */
export const emptyLayerFeatures = (): LayerFeaturesResult => ({ ...empty(), degraded: true });

/** Wrap a point-layer reader result into the use-case envelope. */
function pointResult<Row>(rows: LayerRows<Row>, features: FeatureCollection): LayerFeaturesResult {
  return {
    features,
    truncated: rows.truncated,
    suppressedCount: 0,
    noLocalityCount: 0,
    level: "locality",
  };
}

/**
 * Wrap an F1 per-unit aggregated point result into the use-case envelope.
 * The `level` carried in the result reflects whether the loader used province
 * or locality grouping so the map knows which renderMode to apply.
 */
function aggregatedPointResult(
  result: AggregatedPointRows,
  level: AggregationLevel,
): LayerFeaturesResult {
  return {
    features: buildAggregatedPointFeatures(result.cells),
    truncated: result.truncated,
    suppressedCount: result.suppressedCount,
    // Detail-tier reconciliation (WARNING 4): events with a province but no locality
    // are counted at province level and dropped from the locality/detail rollup, so
    // surface the residual the same way the choropleth path does. 0 at province level.
    noLocalityCount: result.noLocalityCount,
    level,
    // task panorama-bivariate-2026-07-21: only `loadZoonosisByUnit` ever sets
    // `provinceSignal` (province-grain, k=5-suppressed at that grain); every other
    // aggregated-point loader leaves it undefined, so this is a no-op for them.
    bivariateSignal: result.provinceSignal
      ? buildAggregatedPointFeatures(result.provinceSignal)
      : undefined,
  };
}

/** Wrap a LOCALITY choropleth reader result (centroid symbols, k-anon). */
function localityChoroplethResult(rows: ChoroplethRows): LayerFeaturesResult {
  return {
    features: buildChoroplethFeatures(rows.cells),
    truncated: rows.truncated,
    suppressedCount: rows.suppressedCount,
    noLocalityCount: rows.noLocalityCount,
    level: "locality",
  };
}

/** Wrap a PROVINCE choropleth reader result (filled polygons, no k-anon; U5). */
function provinceChoroplethResult(rows: ProvinceChoroplethRows): LayerFeaturesResult {
  return {
    features: buildProvinceChoroplethFeatures(rows.cells),
    truncated: rows.truncated,
    // NOT "almost always 0" — every province loader can suppress (k-anon protects
    // the cell's DENOMINATOR, so a rate over 11 dogs hatches exactly like a sub-k
    // department). The field is REQUIRED upstream, so there is no `?? 0` fallback
    // to silently paper over a loader that forgot to count: a fully-hatched map
    // must never report 0 and leave the notice + footer silent.
    suppressedCount: rows.suppressedCount,
    // Province level counts every pet in the province — nothing is invisible.
    noLocalityCount: 0,
    level: "province",
  };
}

/** Resolve a choropleth layer at the requested aggregation level (U5). The
 * metric is fixed per layer id; the level selects province vs locality. */
async function choroplethResult(
  metric: ChoroplethMetric,
  level: AggregationLevel,
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
  // task #78 Part 3: vet-signed numerator narrowing — honored only by the
  // rabies-coverage metric inside loadChoroplethByLevel.
  verifiedOnly = false,
): Promise<LayerFeaturesResult> {
  if (level === "province") {
    return provinceChoroplethResult(
      await loadChoroplethByLevel(
        metric,
        "province",
        actor,
        jurisdictions,
        adminProvince,
        adminLocality,
        verifiedOnly,
      ),
    );
  }
  return localityChoroplethResult(
    await loadChoroplethByLevel(
      metric,
      "locality",
      actor,
      jurisdictions,
      adminProvince,
      adminLocality,
      verifiedOnly,
    ),
  );
}

async function resolveLayerFeatures(
  layer: LayerId,
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  period: LayerPeriod,
  /**
   * Aggregation axis. For choropleth layers (cobertura, mortalidad): selects
   * province (filled polygons) vs locality (centroid symbols). For density+signal
   * point layers (F1 Panorama v2): selects the GROUP BY granularity for per-unit
   * aggregation. Reference layers (refugios, decomisos) ignore this entirely.
   * Defaults to "locality" (historical / pre-U5 behavior).
   */
  level: AggregationLevel = "locality",
  /**
   * Admin province drill-down (Panorama only). When an ADMIN selects a province
   * via JurisdictionSwitcher, this narrows all layer loaders to that province
   * (and optionally locality). Only applied when actor.role === "admin".
   * Govt actors must NOT pass these — their scope is already enforced by
   * filteredJurisdictions.
   */
  adminProvince?: string,
  adminLocality?: string,
  /**
   * panorama-event-points: SERVER-authorized near-zoom points mode (A1). Honored
   * for the layers with a `renderPolicy.points` (POINTS_LAYER_IDS):
   *   - perdidas (Slice 1): REAL sighting DOTS (loadPerdidasEvents).
   *   - mordeduras (Slice 2): REAL incident DOTS (loadBiteEvents), operator-scoped.
   *   - denuncias (Slice 3): LOCALITY-CENTROID dots (loadDenunciaCentroids) — the
   *     exact report coordinate is NEVER selected.
   * Zoonosis is deliberately NOT points-capable: both outbreak_signal writers
   * persist no columnar location_lat/lng (only pet_jurisdiction_* snapshots), so
   * there is nothing to plot as a real dot — it stays aggregated (plan §5 "if the
   * writer sets no coords → aggregated + document the gap").
   * The caller MUST have already gated this via `resolvePointsMode` (mode=points
   * AND a province resolved) — this function trusts the resolved flag, not a raw
   * query param.
   */
  pointsMode = false,
  /**
   * task #78 Part 3: the panorama "solo firmado por matrícula" toggle. When true,
   * the `cobertura` (rabies-coverage) choropleth counts ONLY vet-signed doses in
   * its numerator. NARROWS the numerator only — never widens scope, k-anon or
   * auth. Every other layer ignores it.
   */
  verifiedOnly = false,
): Promise<LayerFeaturesResult> {
  switch (layer) {
    // -----------------------------------------------------------------------
    // F1: DENSITY point layers — per-unit aggregated (province or locality).
    // The toggle axis now drives the GROUP BY granularity; reference layers keep
    // their discrete-pin path below. BOTH levels apply suppressSmallCells (k=5,
    // #40b) — see repository-by-unit.ts, which these loaders dispatch to: the
    // "province level has no k-anon" premise was retired there because a
    // province's POPULATION being large does not make its DENOMINATOR large,
    // and the denominator is what k-anonymity actually protects.
    // -----------------------------------------------------------------------
    case "perdidas": {
      // panorama-event-points Slice 1: at server-authorized points mode, plot
      // REAL sighting coordinates as dots instead of aggregated bubbles.
      if (pointsMode) {
        const r = await loadPerdidasEvents(
          actor,
          jurisdictions,
          period.since,
          period.asOf,
          adminProvince,
          adminLocality,
          period.basis,
        );
        return {
          features: buildPerdidasFeatures(r.rows),
          truncated: r.truncated,
          suppressedCount: 0,
          noLocalityCount: 0,
          // Points ignore the aggregation axis; report "locality" for the map.
          level: "locality",
          mode: "points",
          sinUbicacionCount: r.noCoordCount,
        };
      }
      const r = await loadPerdidasByUnit(
        level,
        actor,
        jurisdictions,
        period.since,
        period.asOf,
        adminProvince,
        adminLocality,
        period.basis,
      );
      return aggregatedPointResult(r, level);
    }
    case "mordeduras": {
      // panorama-event-points Slice 2: at server-authorized points mode, plot REAL
      // incident coordinates as dots instead of aggregated bubbles. loadBiteEvents
      // scopes by petsScope (operator's OWN jurisdiction, pet-home attribution) and
      // filters isNotNull(locationLat) — a govt user physically cannot fetch a bite
      // outside their scope. Old bites (no columnar coord) fall into the residual.
      if (pointsMode) {
        const r = await loadBiteEvents(
          actor,
          jurisdictions,
          period.since,
          period.asOf,
          adminProvince,
          adminLocality,
          period.basis,
        );
        return {
          features: buildMordedurasFeatures(r.rows),
          truncated: r.truncated,
          suppressedCount: 0,
          noLocalityCount: 0,
          level: "locality",
          mode: "points",
          sinUbicacionCount: r.noCoordCount,
        };
      }
      const r = await loadMordedurassByUnit(
        level,
        actor,
        jurisdictions,
        period.since,
        period.asOf,
        adminProvince,
        adminLocality,
        period.basis,
      );
      return aggregatedPointResult(r, level);
    }
    case "denuncias": {
      // panorama-event-points Slice 3: at server-authorized points mode, denuncias
      // render at the LOCALITY CENTROID only. loadDenunciaCentroids resolves the
      // ar_localities centroid via a correlated subquery and NEVER SELECTs the exact
      // welfare_reports.location_lat/lng (hard anonymous-reporter invariant). Each
      // dot is coarse (coarse:true); MapLibre clustering merges same-locality dots.
      if (pointsMode) {
        const r = await loadDenunciaCentroids(
          actor,
          jurisdictions,
          period.since,
          period.asOf,
          adminProvince,
          adminLocality,
        );
        return {
          features: buildDenunciasFeatures(r.rows),
          truncated: r.truncated,
          suppressedCount: 0,
          noLocalityCount: 0,
          level: "locality",
          mode: "points",
          // Reports whose locality has no resolvable centroid are dropped by the
          // loader; surface that as the honest "sin ubicación" residual count.
          sinUbicacionCount: 0,
        };
      }
      // Still COARSE at any level: the exact coordinate never leaves the DB.
      // At locality level, each unit's centroid represents all reports in that
      // locality (no individual coordinates). At province level, the province
      // centroid is used. k-anon applies at locality level only.
      const r = await loadDenunciasByUnit(
        level,
        actor,
        jurisdictions,
        period.since,
        period.asOf,
        adminProvince,
        adminLocality,
      );
      return aggregatedPointResult(r, level);
    }
    // -----------------------------------------------------------------------
    // F1: SIGNAL point layer — per-unit aggregated.
    // -----------------------------------------------------------------------
    case "zoonosis": {
      const r = await loadZoonosisByUnit(
        level,
        actor,
        jurisdictions,
        period.since,
        period.asOf,
        adminProvince,
        adminLocality,
        period.basis,
      );
      return aggregatedPointResult(r, level);
    }
    case "sintomas": {
      const r = await loadSintomasByUnit(
        level,
        actor,
        jurisdictions,
        period.since,
        period.asOf,
        adminProvince,
        adminLocality,
        period.basis,
      );
      return aggregatedPointResult(r, level);
    }
    case "reunificacion": {
      // No replay basis — the underlying fetchReunificationByUnit rollup
      // (lib/metrics/reunification-rollups.ts) is period-windowed but not
      // bitemporal (it has no recorded_at/occurred_at split of its own).
      const r = await loadReunificacionByUnit(
        level,
        actor,
        jurisdictions,
        period.since,
        period.asOf,
        adminProvince,
        adminLocality,
      );
      return aggregatedPointResult(r, level);
    }
    // -----------------------------------------------------------------------
    // REFERENCE layers — discrete pins, unchanged by the toggle axis.
    // Each represents an individual shelter / expediente — aggregating would
    // destroy the identity of each entity.
    // -----------------------------------------------------------------------
    case "refugios": {
      // Shelters have no time dimension — period/asOf are not applied. The
      // console dims this layer while a scrub is active (not reproducible in time).
      const r = await loadShelters(actor, jurisdictions, adminProvince, adminLocality);
      return pointResult(r, buildRefugiosFeatures(r.rows));
    }
    case "clinicas": {
      // Verified veterinary clinics — a current directory (no time dimension),
      // disjoint from refugios (orgType='clinic'). Same reference-pin shape, so
      // the shelter feature builder (token/name/verified props) is reused.
      const r = await loadClinics(actor, jurisdictions, adminProvince, adminLocality);
      return pointResult(r, buildRefugiosFeatures(r.rows));
    }
    case "decomisos": {
      const r = await loadDecomisos(
        actor,
        jurisdictions,
        period.since,
        period.asOf,
        adminProvince,
        adminLocality,
      );
      return pointResult(r, buildDecomisosFeatures(r.rows));
    }
    // -----------------------------------------------------------------------
    // CHOROPLETH layers (rate/density via lib/metrics rollups).
    // -----------------------------------------------------------------------
    case "cobertura": {
      // Current-state rollup (EXISTS rabies vaccination) — not event-windowed in
      // v1, so `asOf` is intentionally ignored; the console dims it under a scrub.
      // U5: the level selects province (filled polygons, ratePct) vs locality (centroids, count).
      // task #78 Part 3: verifiedOnly narrows the numerator to vet-signed doses.
      return choroplethResult(
        "rabies-coverage",
        level,
        actor,
        jurisdictions,
        adminProvince,
        adminLocality,
        verifiedOnly,
      );
    }
    case "esterilizacion": {
      // Current-state rollup (EXISTS sterilization_performed) — not event-windowed in
      // v1, so `asOf` is intentionally ignored; the console dims it under a scrub.
      // Province level: ratePct (true percentage, divergent at complianceTarget:70).
      // Locality level: count-density (v1 limitation; rate-by-locality deferred).
      return choroplethResult(
        "sterilization-coverage",
        level,
        actor,
        jurisdictions,
        adminProvince,
        adminLocality,
      );
    }
    case "microchip": {
      // Current-state rollup (EXISTS active microchip_iso) — not event-windowed
      // in v1, so `asOf` is intentionally ignored; the console dims it under a scrub.
      return choroplethResult(
        "microchip-penetration",
        level,
        actor,
        jurisdictions,
        adminProvince,
        adminLocality,
      );
    }
    case "ppp": {
      // Current-state rollup (EXISTS dangerous_breed_attested) — not
      // event-windowed in v1; `asOf` is intentionally ignored.
      return choroplethResult(
        "ppp-compliance",
        level,
        actor,
        jurisdictions,
        adminProvince,
        adminLocality,
      );
    }
    case "mortalidad": {
      // Current-state rollup (pets.status='deceased') — not event-windowed in v1;
      // `asOf` is intentionally ignored; the console dims it under a scrub.
      // U5: the level selects province (filled polygons) vs locality (centroids).
      return choroplethResult(
        "mortality",
        level,
        actor,
        jurisdictions,
        adminProvince,
        adminLocality,
      );
    }
    case "acceso-veterinario": {
      // Trailing-12m access signal — not event-windowed in v1, so `asOf` is
      // ignored; the console dims it under a scrub. Province: visits per 1.000
      // active pets (rate magnitude, sequential fill). Locality: count-density of
      // pets with a visit (v1 interim; k-anon'd num/den per department deferred).
      return choroplethResult(
        "vet-access",
        level,
        actor,
        jurisdictions,
        adminProvince,
        adminLocality,
      );
    }
    case "antiparasitario": {
      // Trailing-12m coverage rollup (EXISTS deworming_administered) — not
      // event-windowed in v1; `asOf` ignored, dimmed under a scrub. Province:
      // ratePct (divergent at complianceTarget:80). Locality: count-density (v1).
      return choroplethResult(
        "deworming",
        level,
        actor,
        jurisdictions,
        adminProvince,
        adminLocality,
      );
    }
    case "tendencia": {
      // Two-window event DELTA (current period vs the prior equivalent period)
      // — PROVINCE-ONLY v1 (PROVINCE_ONLY_CHOROPLETH_IDS), `level` ignored.
      // Temporal: `asOf` shifts both windows; `basis` replays by
      // occurred_at/recorded_at. k-anon: the differencing rule (deltaCells)
      // suppresses a cell when EITHER raw window carries a protected sub-k
      // count (suppressedCount discloses it).
      return provinceChoroplethResult(
        await loadTendenciaByProvince(
          actor,
          jurisdictions,
          period.since,
          period.asOf,
          adminProvince,
          adminLocality,
          period.basis,
        ),
      );
    }
    case "desierto-veterinario": {
      // Period-windowed vet-activity RECENCY (days since the last
      // vet_visit_logged, capped at the window length) — PROVINCE-ONLY v1
      // (PROVINCE_ONLY_CHOROPLETH_IDS), so `level` is ignored. Temporal: `asOf`
      // replays the recency as of t. k-anon: a scoped province universe under
      // k=5 pets gets no cell (suppressedCount discloses it).
      return provinceChoroplethResult(
        await loadVetDesertByProvince(
          actor,
          jurisdictions,
          period.since,
          period.asOf,
          adminProvince,
          adminLocality,
        ),
      );
    }
    case "indice-territorial": {
      // PROVINCE-ONLY composite index (0-100). Province-grain by design: the
      // underlying computeJurisdictionIndex scores ≤24 provinces and has no
      // locality/department grain, so `level` is IGNORED — the loader always
      // returns province cells (filled province polygons at every zoom). No
      // k-anon hatch: <5-pet provinces are dropped upstream (no cell). Not
      // event-windowed → `asOf` ignored, dimmed under a scrub.
      return provinceChoroplethResult(
        await loadTerritorialIndexByProvince(actor, jurisdictions, adminProvince, adminLocality),
      );
    }
    default: {
      // EXHAUSTIVENESS FENCE. This used to be a bare `return empty()`, so a new
      // LayerId whose case someone forgot COMPILED CLEAN and served an empty
      // FeatureCollection forever — a layer that silently shows nothing, on a
      // console whose whole job is to show what is there. The `never`
      // assignment makes the omission a TYPE ERROR at the point of the mistake.
      const unreachable: never = layer;
      void unreachable;
      return empty();
    }
  }
}

/**
 * The use-case entry point: resolve the layer's features, then — for a
 * per-cápita-ELIGIBLE layer served at PROVINCE grain (panorama-percapita v1) —
 * join the province cells to `jurisdictions_census` and carry
 * population/per10k/census metadata ON the feature props. The enrichment rides
 * the features (not a side channel) so every payload path — Data Cache,
 * first-visit seed, saved boards — preserves it; the CLIENT projection
 * (domain/percapita.projectPerCapita) swaps count → per10k only while the
 * encoding is active, so the same payload serves both encodings with no
 * refetch on toggle.
 *
 * Never fatal: a missing/unavailable census lookup serves the layer unenriched
 * (the per-cápita encoding then honestly reads as no-data). Points-mode results
 * are real event dots (no per-unit counts) — never enriched. Locality grain is
 * never enriched: v1 has no department/locality denominator (phase 2).
 */
export async function getLayerFeatures(
  ...args: Parameters<typeof resolveLayerFeatures>
): Promise<LayerFeaturesResult> {
  const [layer, , , , level = "locality"] = args;
  const result = await resolveLayerFeatures(...args);
  if (level !== "province" || !isPercapitaEligible(layer)) return result;
  if (result.mode === "points") return result;
  const lookup = await loadCensusLookup();
  if (!lookup) return result;
  return { ...result, features: enrichPerCapita(result.features, lookup) };
}
