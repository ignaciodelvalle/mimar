// Panorama infrastructure repository — the SINGLE @/db module of the module.
//
// Hexagonal-lite: every scope-aware SELECT for the F2 layers lives here. The
// pure GeoJSON shaping is in application/build-features.ts; the use-case
// (get-layer-features.ts) wires the two. The domain stays free of @/db.
//
// Privacy / k-anon / cap invariants enforced here (spec §8, §13):
//   - denuncias (welfare_reports) are COARSE: each report is snapped to its
//     locality CENTROID via a join to ar_localities. The exact lat/lng NEVER
//     leaves this module — it is not even SELECTed into the returned rows.
//   - the two choropleth layers (rabies-coverage, mortality) are per-locality
//     rollups passed through suppressSmallCells (k=5); suppressed cells carry a
//     `suppressed` flag and NO real value so the map renders them muted.
//   - every loader caps at PER_LAYER_CAP rows and sets `truncated` in the
//     envelope when the cap is hit (no silent caps — the LayerPanel surfaces it).
//
// Scope: every loader threads (actor, jurisdictions). admin → universal;
// govt → intersection with its assignments. The scope clauses are the SAME
// tested helpers the /gob dashboards use.
//
// FILE-SIZE SPLIT (behavior-preserving, mechanical extraction only): this file
// used to hold every loader directly; it now re-exports the same public
// surface from sibling modules so every external import keeps working
// unchanged:
//   - ./repository-scope      — scope clauses, event predicates, province/geo
//                                shaping helpers shared by every group below.
//   - ./repository-points     — point layers (mordeduras, denuncias, zoonosis
//                                signals, refugios, clinicas, decomisos).
//   - ./repository-choropleth — coverage choropleths + territorial index.
//   - ./repository-by-unit    — F1 per-unit aggregation loaders + sighting dots.
//   - ./repository-histogram  — TimeScrubber scope-total daily counts (+ the
//                                k-anon envelope that guards them).
//   - ./repository-history    — F4 per-unit catalogued event history.
// Cube reads (migration 0139/0151) and the census lookup stay here (small,
// no cross-group dependency).

import { and, eq, sql } from "drizzle-orm";

// Heavy read-only analytics — routed through the ANALYTICS pool (session
// pooler in production; see db/index.ts, task #74 dual-pool split).
import {
  type PanoramaCubeRow,
  type PanoramaKpiCubeRow,
  analyticsDb as db,
  jurisdictionsCensus,
  panoramaCube,
  panoramaCubeMeta,
  panoramaKpiCube,
  panoramaKpiCubeMeta,
} from "@/db";
import type { CensusLookup } from "@/src/modules/panorama/domain/percapita";

import type { ChoroplethMetric } from "./repository-choropleth";

// ---------------------------------------------------------------------------
// Re-exports — the module's public surface, unchanged by the split.
// ---------------------------------------------------------------------------

export {
  PER_LAYER_CAP,
  type LayerRows,
} from "./repository-scope";

export {
  loadBiteEvents,
  loadDenunciaCentroids,
  loadOutbreakSignals,
  loadShelters,
  loadClinics,
  loadDecomisos,
} from "./repository-points";

export {
  type ChoroplethRows,
  type ProvinceChoroplethRows,
  type ChoroplethMetric,
  noLocalityByProvince,
  loadRabiesCoverage,
  loadSterilizationCoverage,
  loadMicrochipCoverage,
  loadPppCompliance,
  loadMortality,
  loadVetAccess,
  loadDewormingCoverage,
  loadRabiesCoverageByProvince,
  loadSterilizationCoverageByProvince,
  loadMicrochipCoverageByProvince,
  loadPppComplianceByProvince,
  loadMortalityByProvince,
  loadMortalityRawRollupByProvince,
  loadVetAccessByProvince,
  loadTendenciaByProvince,
  loadVetDesertByProvince,
  loadDewormingCoverageByProvince,
  loadTerritorialIndexByProvince,
  loadChoroplethByLevel,
} from "./repository-choropleth";

export {
  type AggregatedPointRows,
  loadPerdidasByUnit,
  type PointEventsRows,
  loadPerdidasEvents,
  loadMordedurassByUnit,
  loadDenunciasByUnit,
  loadZoonosisByUnit,
  loadZoonosisSignalScopeTotal,
  loadSintomasByUnit,
  loadReunificacionByUnit,
} from "./repository-by-unit";

export {
  type ScopeDailyCount,
  type ScopeDailyHistogram,
  loadScopeDailyCounts,
} from "./repository-histogram";
export {
  type UnitHistoryEvent,
  type TrendBucket,
  type UnitHistoryResult,
  type LoadUnitHistoryParams,
  loadUnitHistory,
} from "./repository-history";

// ---------------------------------------------------------------------------
// Aggregate cube reads (migration 0139). The scope-aware SELECTs against the
// precomputed cube live HERE (the module's single @/db seam); the application
// reader (load-layer-features-cube.ts) does the eligibility/staleness gating and
// rebuilds the LayerFeaturesResult via build-features. Reads go through analyticsDb
// (service-role, BYPASSRLS) — PostgREST cannot read these deny-all tables.
// ---------------------------------------------------------------------------

/** Cube build metadata (freshness + status) the reader's staleness gate reads. */
export async function readCubeMeta(): Promise<{
  builtAt: Date | null;
  status: string;
} | null> {
  const [row] = await db
    .select({ builtAt: panoramaCubeMeta.builtAt, status: panoramaCubeMeta.status })
    .from(panoramaCubeMeta)
    .where(sql`${panoramaCubeMeta.id} = 1`);
  return row ?? null;
}

/** Read the cube rows for one metric, optionally narrowed to a province (an admin
 * province drill). Both grains (province + department) come back; the reader
 * partitions by `unit_level`. */
export async function readCubeRows(
  metric: ChoroplethMetric,
  province?: string,
): Promise<PanoramaCubeRow[]> {
  const conditions = [eq(panoramaCube.metric, metric)];
  if (province) conditions.push(eq(panoramaCube.province, province));
  return db
    .select()
    .from(panoramaCube)
    .where(and(...conditions));
}

// ---------------------------------------------------------------------------
// KPI-strip cube reads (migration 0151). Same seam split as the layer cube:
// the SELECTs live here; the application reader (load-panorama-kpis-cube.ts)
// does the eligibility / staleness / period gating and reassembles the strip.
// ---------------------------------------------------------------------------

/** KPI cube build metadata: freshness + status + the period window the strip
 * was computed for + the strip-level payload fields. */
export async function readKpiCubeMeta(): Promise<{
  builtAt: Date | null;
  status: string;
  periodSince: Date | null;
  periodUntil: Date | null;
  strip: unknown;
} | null> {
  const [row] = await db
    .select({
      builtAt: panoramaKpiCubeMeta.builtAt,
      status: panoramaKpiCubeMeta.status,
      periodSince: panoramaKpiCubeMeta.periodSince,
      periodUntil: panoramaKpiCubeMeta.periodUntil,
      strip: panoramaKpiCubeMeta.strip,
    })
    .from(panoramaKpiCubeMeta)
    .where(sql`${panoramaKpiCubeMeta.id} = 1`);
  return row ?? null;
}

/** All KPI cube rows for one scope (strip tiles + non-strip aggregates; the
 * reader partitions by `position`). */
export async function readKpiCubeRows(scope: string): Promise<PanoramaKpiCubeRow[]> {
  return db.select().from(panoramaKpiCube).where(eq(panoramaKpiCube.scope, scope));
}

// ---------------------------------------------------------------------------
// Per-cápita census lookup (panorama-percapita v1 — province grain)
// ---------------------------------------------------------------------------

/**
 * Process-lifetime cache for the census lookup. `jurisdictions_census` is a
 * STATIC reference table (24 INDEC rows, re-seeded only by a migration when a
 * new national census publishes), so one query per process is enough — the
 * per-cápita enrichment then costs zero extra queries on every layer fetch.
 * A failed/empty read is NOT cached: the next fetch retries, so a transient
 * startup hiccup can't pin "no census" for the process lifetime.
 */
let censusLookupCache: CensusLookup | null = null;

/**
 * Load the province→population census lookup for the per-cápita encoding
 * (domain/percapita.ts). Keyed by the CANONICAL province display name (the
 * table PK — the same vocabulary as pets.jurisdiction_province). Year/source
 * come from the table rows (the newest census year present), so the caption
 * footer is never hardcoded.
 *
 * Returns null — never throws — when the table is empty or unreadable: the
 * caller serves the layer unenriched and the encoding honestly reads no-data.
 */
export async function loadCensusLookup(): Promise<CensusLookup | null> {
  if (censusLookupCache) return censusLookupCache;
  try {
    const rows = await db
      .select({
        provinceName: jurisdictionsCensus.provinceName,
        population: jurisdictionsCensus.population,
        censusYear: jurisdictionsCensus.censusYear,
        source: jurisdictionsCensus.source,
      })
      .from(jurisdictionsCensus);
    if (rows.length === 0) return null;
    const populations: Record<string, number> = {};
    let year = 0;
    let source = "";
    for (const r of rows) {
      populations[r.provinceName] = r.population;
      if (r.censusYear > year) {
        year = r.censusYear;
        source = r.source;
      }
    }
    censusLookupCache = { populations, year, source };
    return censusLookupCache;
  } catch (err) {
    console.warn("[panorama] census lookup unavailable — per-cápita served as no-data", err);
    return null;
  }
}
