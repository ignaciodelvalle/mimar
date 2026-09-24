// Panorama aggregate cube BUILDER (road-to-10 infra #1, migration 0139).
//
// ORCHESTRATOR AMENDMENT over dim-interno:docs/plans/2026-07-11-cube-design.md: the builder is
// a TypeScript worker that REUSES the existing choropleth loaders — NOT a plpgsql
// re-expression. It calls the SAME `loadChoroplethByLevel` invocations the live
// admin-national read uses (metric rollups → aggregateCellsToDepartment → k-anon →
// complementarySuppress → province sums incl. the no-locality residual) and writes
// the RESULT in ONE transaction. This makes SQL/TS drift structurally impossible:
// the cube stores exactly what the loader produced, so the reader replaying
// build-features over it is a set-equal (order-independent) FeatureCollection to a
// live read (parity is near-tautology). NOTE: the guarantee is SET equality — same
// features, envelope, and flags irrespective of row order — NOT literal byte order;
// do not build an order-sensitive consumer on top of it.
//
// PRIVACY: the loaders already null every sub-k count before returning (suppressed
// cells carry value = null). So a raw sub-k value NEVER enters this module's memory,
// let alone the store — there is no private build layer at all. The worst a mis-wired
// reader can emit is a NULL.
//
// UNSCOPED, GEOGRAPHICALLY-DECOMPOSED: the build runs the loaders as an ADMIN actor
// with NO drill (national). Because every rollup is COUNT(DISTINCT pets.id) and each
// pet has exactly one home (province, locality→department), a province total is the
// exact sum of its departments and the national suppression is the correct suppression
// for any COMPLETE geographic slice (admin national, or an admin province drill —
// complementarySuppress is province-grouped, so a province's group is identical whether
// computed nationally or scoped to it). Locality drills are NOT cube-served (see the
// reader) because a department cell here aggregates ALL localities in the department,
// not the single drilled locality.

import { type SQL, sql } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  panoramaCube,
  panoramaCubeMeta,
  panoramaKpiCube,
  panoramaKpiCubeMeta,
  petEvents,
  runWithAnalyticsReadHandle,
  statementTimeoutOptions,
} from "@/db";
import * as schema from "@/db/schema";
import type { NewPanoramaCubeRow, NewPanoramaKpiCubeRow } from "@/db/schema";
import { resolveAnalyticsPeriod } from "@/lib/analytics/analytics-period";
import type { AnalyticsPeriod, DashboardActor, DashboardJurisdiction } from "@/lib/metrics";
import { buildProjectionContext } from "@/lib/metrics";
import { fetchNetGrowth } from "@/lib/metrics/population-control";
import { defaultPanoramaPresetPeriod } from "@/src/modules/panorama/domain/presets";

import type { PanoramaKpis } from "@/src/modules/panorama/application/get-panorama-kpis";
import { getPanoramaKpis } from "@/src/modules/panorama/application/get-panorama-kpis";
// The reader owns the KPI cube read contract (scope + row ids), mirroring how
// load-layer-features-cube owns the flag + staleness constants.
import {
  KPI_CUBE_BIRTHS_KPI,
  KPI_CUBE_SCOPE_NATIONAL,
} from "@/src/modules/panorama/application/load-panorama-kpis-cube";

import type {
  ChoroplethCell,
  ProvinceChoroplethCell,
} from "@/src/modules/panorama/application/build-features";
import {
  type ChoroplethMetric,
  loadChoroplethByLevel,
  noLocalityByProvince,
} from "@/src/modules/panorama/infrastructure/repository";

/** The 5 choropleth metrics the cube covers (v1). Mirrors the layer→metric map
 * in get-layer-features.ts (cobertura→rabies-coverage, etc.). */
export const CUBE_METRICS: readonly ChoroplethMetric[] = [
  "rabies-coverage",
  "sterilization-coverage",
  "microchip-penetration",
  "ppp-compliance",
  "mortality",
] as const;

/** The admin-national actor the build runs the loaders as: no jurisdictions, no
 * drill → petsScope resolves to null (national), the whole decomposed set. */
const ADMIN: DashboardActor = { role: "admin" };
const NO_JURISDICTIONS: DashboardJurisdiction[] = [];

/** Per-metric build outcome, for the report. */
export type CubeBuildMetricStat = {
  metric: ChoroplethMetric;
  departmentRows: number;
  provinceRows: number;
  suppressed: number;
};

/** KPI-strip cube phase outcome (independent failure domain from the layer
 * cube: a KPI failure never rolls back the layer swap, and vice versa — the
 * reader of each falls back to live on its own meta gate). */
export type CubeKpiBuildStat = {
  status: "ok" | "error";
  rowCount: number;
  durationMs: number;
  error?: string;
};

export type CubeBuildResult = {
  status: "ok" | "error";
  rowCount: number;
  durationMs: number;
  watermark: Date | null;
  builtAt: Date;
  perMetric: CubeBuildMetricStat[];
  /** KPI-strip cube phase (cube-the-KPI-strip train). */
  kpi: CubeKpiBuildStat;
  error?: string;
};

/** Serialize a number to the string form Drizzle expects for a `numeric` column.
 * null stays null (suppressed department values, absent centroids). */
function num(v: number | null | undefined): string | null {
  return v == null ? null : String(v);
}

// ---------------------------------------------------------------------------
// Dedicated BUILDER READ client (task #22 — read-timeout architecture fix).
//
// The builder's reads reuse the live loaders, which resolve to the module-level
// `analyticsDb` — a pool whose 15s request-path statement_timeout is baked at
// MODULE LOAD (env is per-deployment on Vercel, and the cron imports this module
// statically, so no per-invocation env can reach that pool). A national-scale
// rollup (a Buenos Aires department read measures ~96s) is cancelled at 15s
// (SQLSTATE 57014) → the whole build fails → reader falls back to live for
// everything. Raising the env project-wide would reopen the request-path
// death-spiral the 15s backstop prevents (#74).
//
// So the builder constructs its OWN session-pooler read client, LAZILY inside
// refreshCube (env read per invocation, mirroring the write client), with a long
// statement_timeout, and routes the read phase to it via
// runWithAnalyticsReadHandle — covering every downstream analyticsDb call
// (repository loaders + the lib/metrics + lib/analytics fetchers they compose)
// with zero call-site changes. Request paths keep the 15s backstop untouched.
// ---------------------------------------------------------------------------

/** Default statement_timeout for the builder's read client. 120s: the worst
 * measured single read (Buenos Aires department rollup) is ~96s; the cron route
 * pins maxDuration=300s, so there is headroom without letting a truly wedged
 * query eat the whole invocation. */
export const CUBE_BUILDER_DEFAULT_STATEMENT_TIMEOUT_MS = 120_000;

/** Resolve the builder read client's statement_timeout (ms) from env
 * (CUBE_BUILDER_STATEMENT_TIMEOUT_MS), falling back to the 120s default on
 * unset/invalid values. Pure; exported for tests. */
export function cubeBuilderStatementTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const n = Number(env.CUBE_BUILDER_STATEMENT_TIMEOUT_MS ?? "");
  return Number.isFinite(n) && n > 0 ? n : CUBE_BUILDER_DEFAULT_STATEMENT_TIMEOUT_MS;
}

/** Construct the dedicated read client. Session pooler (honors the startup GUC —
 * same reasoning as the write client), tiny pool, long timeout. Lazy by design:
 * called per refreshCube invocation, never at module load. */
function createBuilderReadClient(): ReturnType<typeof postgres> {
  const readUrl = (process.env.ANALYTICS_DATABASE_URL ?? process.env.DATABASE_URL) as string;
  const timeoutMs = cubeBuilderStatementTimeoutMs();
  return postgres(readUrl, {
    prepare: false,
    // max: 3 — the per-metric fan-out (province + residual in parallel, then 6-way
    // mapLimit over provinces) multiplexes over these. Session mode pins one
    // backend per connection, so keep it small; the build is off the request path
    // and total wall-clock (not per-query latency) is what matters.
    max: 3,
    connect_timeout: 15,
    idle_timeout: 5,
    max_lifetime: 300,
    connection: {
      options: statementTimeoutOptions(timeoutMs),
      // Distinct name: exempt from the stuck-backend reaper (migration 0136
      // targets application_name='Supavisor' only) and identifiable in pg_stat.
      application_name: "cube-builder-read",
    },
    onnotice: () => {},
  });
}

/** Map with bounded concurrency (the analytics pool is small; don't fan out 24
 * province reads at once). Preserves input order in the output. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Assemble the readable cube rows for one metric by REUSING the live loaders.
 *
 *  - PROVINCE grain: `loadChoroplethByLevel(metric, "province", admin, [])` — one
 *    ratePct/count cell per mappable province (≤24 rows, never truncated). Stored as
 *    unit_level='province', carrying that province's no-locality residual so the
 *    reader can reproduce noLocalityCount.
 *
 *  - DEPARTMENT grain: built PER PROVINCE — `loadChoroplethByLevel(metric,
 *    "locality", admin, [], province)` for each province with data. WHY per province,
 *    not one national call: the national locality rollup is CAPPED at PER_LAYER_CAP
 *    (2000) and the seed exceeds it, so a national build is TRUNCATED — slicing it per
 *    province would drop most localities. A province-scoped rollup is complete (well
 *    under the cap), so its department cells are correct AND set-equal (order-
 *    independent) to a live province drill (the reader calls the same loader). The
 *    national department view
 *    is therefore NOT cube-served (it is the truncated live view; see the reader).
 */
async function buildMetricRows(
  metric: ChoroplethMetric,
): Promise<{ rows: NewPanoramaCubeRow[]; stat: CubeBuildMetricStat }> {
  const [prov, residual] = await Promise.all([
    loadChoroplethByLevel(metric, "province", ADMIN, NO_JURISDICTIONS),
    noLocalityByProvince(metric, ADMIN, NO_JURISDICTIONS),
  ]);

  const residualByProvince = new Map<string, number>();
  for (const r of residual) residualByProvince.set(r.province, r.count);

  const provinceCells = prov.cells as ProvinceChoroplethCell[];
  const provinceNames = provinceCells.map((c) => c.label);

  // Department cells per province — matches a live province drill exactly (same
  // loader call). Normally complete; at extreme scale a single province's LOCALITY
  // rollup can hit PER_LAYER_CAP (Buenos Aires ~2000 INDEC localities), so each
  // result's `truncated` flag is CAPTURED per province and stored on that
  // province's grain row (CB1) — the reader must not claim false completeness.
  const deptPerProvince = await mapLimit(provinceNames, 6, (p) =>
    loadChoroplethByLevel(metric, "locality", ADMIN, NO_JURISDICTIONS, p),
  );
  const deptTruncatedByProvince = new Map<string, boolean>();
  provinceNames.forEach((p, i) => deptTruncatedByProvince.set(p, deptPerProvince[i].truncated));

  const rows: NewPanoramaCubeRow[] = [];

  // Department grain. `cell.key` (`${province}|${unitCode}`) is unique per unit →
  // the PK's unit_code. `cell.locality` is the display label (department/barrio name).
  let suppressed = 0;
  let departmentRows = 0;
  for (const dr of deptPerProvince) {
    for (const cell of dr.cells as ChoroplethCell[]) {
      departmentRows += 1;
      if (cell.suppressed) suppressed += 1;
      rows.push({
        metric,
        unitLevel: "department",
        province: cell.province,
        unitCode: cell.key,
        label: cell.locality,
        departmentCode: cell.departmentCode ?? null,
        departmentName: cell.departmentName ?? null,
        centroidLat: cell.centroidLat,
        centroidLng: cell.centroidLng,
        value: num(cell.value),
        den: null,
        noLocality: null,
        suppressed: cell.suppressed,
        // The reused loader merges primary + complementary into one partition and
        // nulls the raw count, so the two cannot be distinguished at store time. The
        // differencing-defense PROPERTY is enforced upstream (complementarySuppress)
        // and pinned by the sub-k invariant test; this flag stays false in v1.
        complementary: false,
      });
    }
  }

  rows.push(
    ...buildProvinceCubeRows(metric, provinceCells, residualByProvince, deptTruncatedByProvince),
  );

  return {
    rows,
    stat: { metric, departmentRows, provinceRows: provinceCells.length, suppressed },
  };
}

/**
 * Province-grain cube rows. unit_code = provinceCode (unique, non-null, from the
 * loader); province + label = the province display name. value = ratePct or count.
 *
 * `den` REUSE (CB1, fork A — decided 2026-07-11): the department-grain truncation
 * flag for this (metric, province) is stored in the province row's `den` column as
 * 0/1. `den` was reserved for a future rate-by-num/den reader and has been
 * write-only NULL since 0139; reusing it avoids a migration while CUBE_READS is
 * still OFF. A future rate reader MUST first migrate this flag to its own column.
 * Province-grain truncation itself needs no flag: the province loader returns ≤24
 * rows, structurally under PER_LAYER_CAP.
 *
 * Pure; exported for the DB-free truncation-threading tests.
 */
export function buildProvinceCubeRows(
  metric: ChoroplethMetric,
  provinceCells: readonly ProvinceChoroplethCell[],
  residualByProvince: ReadonlyMap<string, number>,
  deptTruncatedByProvince: ReadonlyMap<string, boolean>,
): NewPanoramaCubeRow[] {
  return provinceCells.map((cell) => ({
    metric,
    unitLevel: "province",
    province: cell.label,
    unitCode: cell.provinceCode,
    label: cell.label,
    departmentCode: null,
    departmentName: null,
    centroidLat: null,
    centroidLng: null,
    value: num(cell.value),
    // den ⇒ department-grain truncated flag (0/1) for this province — see jsdoc.
    den: deptTruncatedByProvince.get(cell.label) ? 1 : 0,
    noLocality: residualByProvince.get(cell.label) ?? 0,
    // #40: was hardcoded `false` under the old "provinces are never suppressed"
    // premise. Province cells now carry k-anon, and the flag MUST round-trip:
    // `value` alone cannot, because the reader coalesces a null value and would
    // republish a protected cell as 0 — a false zero that reads as real data.
    suppressed: cell.suppressed,
    complementary: false,
  }));
}

// ---------------------------------------------------------------------------
// KPI-strip cube phase (migration 0151 — cube the KPI strip).
//
// SAME AMENDMENT PHILOSOPHY as the layer cube: REUSE the live use-case. The
// builder runs getPanoramaKpis — the EXACT ~20-fetcher fan-out the request path
// runs — as the admin-national actor with the window the LANDING preset
// requests (defaultPanoramaPresetPeriod(), the console's landing view — the
// most common and most expensive request), and
// stores the FINISHED PanoramaKpi tiles as jsonb. The reader reassembles the
// strip from the stored tiles, so cube-vs-live drift is structurally
// impossible (parity is near-tautology).
//
// BIRTHS (the known cube gap): pregnancy/litter aggregates were not cubed
// anywhere. fetchNetGrowth (altas / registeredBirths / deaths / net) is cubed
// as a position-NULL row — parity-tested but NOT part of the served strip (no
// strip tile renders births today; a future tile can read it cube-first).
//
// HONESTY FENCE: the cube must only ever hold a FULLY-REAL strip. A degraded
// or partially-unavailable fan-out (any tile.unavailable) fails the phase —
// mirroring the request path's "degraded never cached" invariant — so the
// reader can never serve a placeholder tile as precomputed truth.
// ---------------------------------------------------------------------------

/** Strip-level PanoramaKpis fields stored on the meta row (everything except
 * the tiles, which live one-per-row in panorama_kpi_cube). */
export type KpiCubeStripMeta = Pick<
  PanoramaKpis,
  "recalculatedFor" | "dataAsOf" | "coverageDenominator"
>;

export type KpiCubeBuild = {
  rows: NewPanoramaKpiCubeRow[];
  period: AnalyticsPeriod;
  strip: KpiCubeStripMeta;
};

/**
 * Assemble the KPI cube rows by REUSING the live fan-out. Throws on a degraded
 * or partial strip (the honesty fence above) — the caller records the phase as
 * an error and the last-good KPI cube stays untouched.
 */
async function buildKpiCube(): Promise<KpiCubeBuild> {
  // QA fix 7: build at the window the LANDING actually requests. A bare admin
  // visit auto-activates DEFAULT_PANORAMA_PRESET_ID, whose periodPreset (90d
  // for "bienestar") is what the console asks the KPI strip for — NOT the 3y
  // PANORAMA_DEFAULT_PRESET this used to hardcode, which made the reader's
  // period gate reject the cube on every first visit (always-live fan-out).
  // Single-sourced via defaultPanoramaPresetPeriod(): if the default preset
  // (or its period) changes, the cube window follows automatically.
  const period = resolveAnalyticsPeriod({ period: defaultPanoramaPresetPeriod() });
  const strip = await getPanoramaKpis(ADMIN, NO_JURISDICTIONS, period);
  if (strip.degraded || strip.kpis.length === 0 || strip.kpis.some((k) => k.unavailable)) {
    throw new Error(
      "panorama KPI fan-out produced a degraded or partial strip — not cubeable (the cube must hold a fully-real strip)",
    );
  }

  // Births — the known cube gap. Same admin-national ctx + period as the strip.
  const births = await fetchNetGrowth(buildProjectionContext(ADMIN, NO_JURISDICTIONS, period));

  const rows: NewPanoramaKpiCubeRow[] = strip.kpis.map((tile, position) => ({
    scope: KPI_CUBE_SCOPE_NATIONAL,
    kpi: tile.id,
    position,
    payload: tile,
  }));
  rows.push({
    scope: KPI_CUBE_SCOPE_NATIONAL,
    kpi: KPI_CUBE_BIRTHS_KPI,
    position: null,
    payload: births,
  });

  return {
    rows,
    period,
    strip: {
      recalculatedFor: strip.recalculatedFor,
      dataAsOf: strip.dataAsOf,
      coverageDenominator: strip.coverageDenominator ?? null,
    },
  };
}

/** Chunked multi-row insert (bounds the bind-parameter count well under 65535). */
async function insertRows(
  tx: PostgresJsDatabase<typeof schema>,
  rows: NewPanoramaCubeRow[],
): Promise<void> {
  const CHUNK = 400;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await tx.insert(panoramaCube).values(rows.slice(i, i + CHUNK));
  }
}

/** Best-effort stamp of the KPI cube meta as 'error' (reader falls back to the
 * live strip) + the structured phase stat for the cron telemetry. */
async function stampKpiError(
  writeDb: PostgresJsDatabase<typeof schema>,
  t0: number,
  error: string,
): Promise<CubeKpiBuildStat> {
  try {
    await writeDb
      .update(panoramaKpiCubeMeta)
      .set({ status: "error" })
      .where(sql`${panoramaKpiCubeMeta.id} = 1` as SQL);
  } catch {
    // best-effort; the phase already failed.
  }
  return { status: "error", rowCount: 0, durationMs: Date.now() - t0, error };
}

/**
 * Full-rebuild the cube. Reads (loaders) run OUTSIDE the write transaction on a
 * DEDICATED lazy session-pooler READ client with a long statement_timeout (task
 * #22 — see createBuilderReadClient; the shared analyticsDb pool's 15s
 * request-path backstop would cancel a national-scale rollup). The write
 * (DELETE + INSERT + meta) runs INSIDE one transaction on its own dedicated
 * session-pooler client, also long-timeout (a background build — NOT
 * withDbBudget's 8s request budget). Postgres MVCC gives every reader the ENTIRE
 * old cube or the ENTIRE new one, never a half-swap.
 *
 * On any failure — READ phase included (previously a read error THREW out of
 * this function, bypassing the error result the cron's 57014 retry inspects) —
 * the last-good cube stays untouched (write txn rolls back or never starts), the
 * meta row is stamped status='error' in a separate statement, and a structured
 * error result is returned — an honest, detectable degradation the reader's
 * staleness gate catches.
 */
export async function refreshCube(): Promise<CubeBuildResult> {
  const t0 = Date.now();
  const builtAt = new Date();

  // Both clients are constructed LAZILY here (per invocation): postgres() does
  // not connect until first query, and env (URLs, timeout override) is read at
  // call time — never baked at module load like the shared analyticsDb pool.
  const readClient = createBuilderReadClient();
  const readDb = drizzle(readClient, { schema });

  // Dedicated write client: session pooler (honors the GUC), generous timeout.
  const writeUrl = (process.env.ANALYTICS_DATABASE_URL ?? process.env.DATABASE_URL) as string;
  const writeClient = postgres(writeUrl, {
    prepare: false,
    max: 1,
    connect_timeout: 15,
    idle_timeout: 5,
    max_lifetime: 300,
    connection: {
      // A background build, not a request. Session mode honors this GUC.
      options: statementTimeoutOptions(cubeBuilderStatementTimeoutMs()),
      // Distinct name exempts the build from the stuck-backend reaper
      // (migration 0136 targets application_name='Supavisor' only). The write
      // txn is seconds-long anyway; this is belt-and-braces.
      application_name: "cube-builder",
    },
    onnotice: () => {},
  });
  const writeDb = drizzle(writeClient, { schema });

  let watermark: Date | null = null;

  try {
    // ---- READ PHASE — on the dedicated long-timeout client. ----

    // Build watermark: transaction time — "what the system knew when the cube was
    // built" (MAX(recorded_at)). A row inserted mid-build is attributed to the NEXT
    // refresh (watermark is a floor, not a fence) — acceptable at day granularity.
    const [wm] = await readDb
      .select({ w: sql<string | null>`max(${petEvents.recordedAt})` })
      .from(petEvents);
    // Raw max() comes back as a string; normalize to Date for the meta column + report.
    watermark = wm?.w ? new Date(wm.w) : null;

    // Reuse the live loaders for all 5 metrics (reads, no transaction), with every
    // downstream analyticsDb call in this async context dispatched to the dedicated
    // read client (runWithAnalyticsReadHandle — covers the repository loaders AND
    // the lib/metrics + lib/analytics fetchers they compose, zero call-site edits).
    // Sequential per metric to bound concurrency on the small read pool (each
    // metric's queries still run in parallel inside buildMetricRows) — the build is
    // off the request path, so total wall-clock, not per-metric latency, matters.
    const built = await runWithAnalyticsReadHandle(readDb, async () => {
      const out: { rows: NewPanoramaCubeRow[]; stat: CubeBuildMetricStat }[] = [];
      for (const m of CUBE_METRICS) {
        out.push(await buildMetricRows(m));
      }
      return out;
    });
    const allRows = built.flatMap((b) => b.rows);
    const perMetric = built.map((b) => b.stat);

    // ---- KPI-STRIP READ PHASE — same dedicated read handle, OWN failure
    // domain: a KPI fan-out failure records kpi.status='error' (reader falls
    // back to the live strip) without failing the layer build. ----
    const kpiT0 = Date.now();
    let kpiBuild: KpiCubeBuild | null = null;
    let kpiError: string | null = null;
    try {
      kpiBuild = await runWithAnalyticsReadHandle(readDb, () => buildKpiCube());
    } catch (err) {
      kpiError = err instanceof Error ? err.message : String(err);
    }

    // ---- WRITE PHASE — atomic full swap in one transaction. ----
    await writeDb.transaction(async (tx) => {
      await tx.delete(panoramaCube);
      await insertRows(tx, allRows);
      const durationMs = Date.now() - t0;
      await tx
        .update(panoramaCubeMeta)
        .set({
          builtAt,
          watermark,
          status: "ok",
          rowCount: allRows.length,
          durationMs,
        })
        .where(sql`${panoramaCubeMeta.id} = 1` as SQL);
    });

    // ---- KPI-STRIP WRITE PHASE — its OWN transaction, AFTER the layer swap
    // committed (independent failure domains: a KPI write failure can never
    // roll back the layer cube, and the layer swap above never waits on the
    // KPI rows). MVCC gives KPI readers the entire old strip or the entire
    // new one, never a half-swap. ----
    let kpi: CubeKpiBuildStat;
    if (kpiBuild) {
      const b = kpiBuild;
      try {
        await writeDb.transaction(async (tx) => {
          await tx.delete(panoramaKpiCube);
          await tx.insert(panoramaKpiCube).values(b.rows);
          await tx
            .update(panoramaKpiCubeMeta)
            .set({
              builtAt,
              watermark,
              status: "ok",
              rowCount: b.rows.length,
              durationMs: Date.now() - kpiT0,
              periodSince: b.period.since,
              periodUntil: b.period.until,
              strip: b.strip,
            })
            .where(sql`${panoramaKpiCubeMeta.id} = 1` as SQL);
        });
        kpi = { status: "ok", rowCount: b.rows.length, durationMs: Date.now() - kpiT0 };
      } catch (err) {
        kpiError = err instanceof Error ? err.message : String(err);
        kpi = await stampKpiError(writeDb, kpiT0, kpiError);
      }
    } else {
      kpi = await stampKpiError(writeDb, kpiT0, kpiError ?? "unknown");
    }

    return {
      status: "ok",
      rowCount: allRows.length,
      durationMs: Date.now() - t0,
      watermark,
      builtAt,
      perMetric,
      kpi,
    };
  } catch (err) {
    // Read-phase failure → nothing was written; write-phase failure → transaction
    // rolled back. Either way the last-good cube is intact. Record the failure so
    // the reader's staleness gate falls back to live (status != 'ok') and return a
    // structured result (the cron route's 57014 retry inspects `error`).
    const message = err instanceof Error ? err.message : String(err);
    try {
      await writeDb
        .update(panoramaCubeMeta)
        .set({ status: "error" })
        .where(sql`${panoramaCubeMeta.id} = 1` as SQL);
    } catch {
      // best-effort; the build already failed.
    }
    // The KPI phase either never ran (layer read phase threw first) or its
    // swap never happened (layer write threw). Stamp its meta too so the KPI
    // reader's gate falls back to live rather than trusting a stale 'ok'.
    const kpi = await stampKpiError(writeDb, t0, `layer build failed: ${message}`);
    return {
      status: "error",
      rowCount: 0,
      durationMs: Date.now() - t0,
      watermark,
      builtAt,
      perMetric: [],
      kpi,
      error: message,
    };
  } finally {
    await Promise.all([readClient.end({ timeout: 5 }), writeClient.end({ timeout: 5 })]);
  }
}
