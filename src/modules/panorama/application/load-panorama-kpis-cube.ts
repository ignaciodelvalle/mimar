// Cube-backed KPI-strip reader (migration 0151) — behind CUBE_READS.
//
// Serves the console's headline KPI strip for the ADMIN NATIONAL landing view
// from the precomputed panorama_kpi_cube, producing the SAME PanoramaKpis
// envelope the live fan-out returns — by reassembling the stored tiles the
// builder captured from getPanoramaKpis itself. A cube-served strip is
// therefore field-for-field what the live path produced at build time (parity
// is near-tautology; pinned by the cube-parity test).
//
// The cube COMPOSES IN FRONT of the live path (L1 Map cache → budget → L2 Data
// Cache → fan-out): an eligible request reads the cube; everything else keeps
// the current cached-live path untouched. Flag default ON since the cube-ON
// decision (2026-07-24, K4/S3); CUBE_READS='0' is the kill switch (→ this
// returns null → caller falls back to live, byte-identical to the pre-ON path).
//
// ELIGIBILITY (all must hold, else null → live):
//   - CUBE_READS !== '0' (same flag + default as the layer cube).
//   - actor is ADMIN with NO drill (adminProvince/adminLocality unset) and the
//     empty jurisdiction set (national) — the only scope the v1 cube stores.
//     Mirrors the layer cube's admin-only reasoning; govt scopes stay live.
//   - NOT a temporal scrub (asOf unset): a scrubbed frame recomputes live.
//   - the requested period matches the stored build window within tolerance —
//     the KPIs are period-sensitive (unlike the current-state choropleth
//     cube), so a 12m request must never read a 3y strip.
//   - cube fresh: meta status === 'ok' AND now − built_at ≤ CUBE_STALE_MAX_MS
//     (same staleness doctrine as the layers: day-granularity metrics tolerate
//     the daily refresh cadence and the 26h ceiling; a sub-daily cadence with
//     a tighter ceiling is Vercel Pro — fase 3).

import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import type { AnalyticsPeriod, DashboardActor, DashboardJurisdiction } from "@/lib/metrics";
import { seesSyntheticRows } from "@/lib/metrics/scope";

import { readKpiCubeMeta, readKpiCubeRows } from "@/src/modules/panorama/infrastructure/repository";

import type { PanoramaKpi, PanoramaKpis } from "./get-panorama-kpis";
import { CUBE_STALE_MAX_MS, cubeReadsEnabled } from "./load-layer-features-cube";

/** The only scope the v1 KPI cube stores (admin national). Defined HERE (the
 * reader owns the cube read contract, like load-layer-features-cube owns the
 * flag + staleness); the builder imports it. */
export const KPI_CUBE_SCOPE_NATIONAL = "national";

/** The non-strip births aggregate row id (fetchNetGrowth — the known cube
 * gap). position NULL: parity-tested, never assembled into the served strip. */
export const KPI_CUBE_BIRTHS_KPI = "births";

/**
 * Max drift between each requested period endpoint and the stored build
 * window. The default panorama preset is a trailing window anchored at "now",
 * so a fresh cube's endpoints lag a live request by the cube's age — bounded
 * by CUBE_STALE_MAX_MS via the freshness gate. Reusing that same ceiling makes
 * the tolerance and the staleness doctrine ONE knob, while still excluding
 * every other preset (12m vs 3y differ by two YEARS on `since`).
 */
export const KPI_CUBE_PERIOD_TOLERANCE_MS = CUBE_STALE_MAX_MS;

/** Strip-level fields the meta row stores (everything except the tiles). */
type KpiCubeStrip = Pick<PanoramaKpis, "recalculatedFor" | "dataAsOf" | "coverageDenominator">;

/** A cube-served strip plus the cube's build timestamp (the freshness the
 * caller may surface, mirroring the layer reader's CubeLayerResult). */
export type CubeKpisResult = {
  value: PanoramaKpis;
  builtAt: Date;
};

export type LoadPanoramaKpisFromCubeParams = {
  actor: DashboardActor;
  /** The ALREADY-NARROWED jurisdictions (govt scope enforced upstream). */
  jurisdictions: DashboardJurisdiction[];
  period: AnalyticsPeriod;
  adminProvince?: string;
  adminLocality?: string;
  /** Temporal-scrub cutoff. Non-null → not cube-eligible (live recompute). */
  asOf?: Date | null;
};

/**
 * Try to serve the KPI strip from the cube. Returns null when the request is
 * not cube-eligible OR the cube is stale/absent/malformed — the caller then
 * uses the live path (identical outcome to CUBE_READS off).
 */
export async function loadPanoramaKpisFromCube(
  params: LoadPanoramaKpisFromCubeParams,
): Promise<CubeKpisResult | null> {
  // --- eligibility (cheap checks first, no DB) ---
  if (!cubeReadsEnabled()) return null;
  if (!hasNationalReadScope(params.actor.role)) return null;
  // T1-P1: built as ADMIN, so it counts the synthetic seed — admin-only (see
  // resolveCubeFreshness in load-layer-features-cube.ts).
  if (!seesSyntheticRows(params.actor.role)) return null;
  if (params.adminProvince || params.adminLocality) return null;
  if (params.asOf) return null;
  // Admin national is the empty jurisdiction set; anything else is not stored.
  if (params.jurisdictions.length > 0) return null;

  // --- staleness + period gate ---
  const meta = await readKpiCubeMeta();
  if (!meta || meta.status !== "ok" || !meta.builtAt) return null;
  if (Date.now() - meta.builtAt.getTime() > CUBE_STALE_MAX_MS) return null;
  if (!meta.periodSince || !meta.periodUntil) return null;
  if (
    Math.abs(params.period.since.getTime() - meta.periodSince.getTime()) >
      KPI_CUBE_PERIOD_TOLERANCE_MS ||
    Math.abs(params.period.until.getTime() - meta.periodUntil.getTime()) >
      KPI_CUBE_PERIOD_TOLERANCE_MS
  ) {
    return null;
  }

  // --- read + reassemble the envelope ---
  const rows = await readKpiCubeRows(KPI_CUBE_SCOPE_NATIONAL);
  const tiles = rows
    .filter((r) => r.position != null)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((r) => r.payload as PanoramaKpi);
  // Defensive: an empty or malformed cube (no tiles, or meta.strip missing its
  // caption) falls back to live rather than serving a broken strip. The
  // builder's honesty fence means a committed cube always has real tiles.
  if (tiles.length === 0) return null;
  const strip = (meta.strip ?? {}) as Partial<KpiCubeStrip>;
  if (typeof strip.recalculatedFor !== "string") return null;

  return {
    builtAt: meta.builtAt,
    value: {
      kpis: tiles,
      recalculatedFor: strip.recalculatedFor,
      dataAsOf: strip.dataAsOf ?? null,
      coverageDenominator: strip.coverageDenominator ?? null,
    },
  };
}
