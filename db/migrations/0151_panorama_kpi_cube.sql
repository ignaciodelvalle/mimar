-- Panorama KPI-strip cube (cube the KPI strip — extends road-to-10 infra #1).
--
-- The layer endpoints already have a cube dual-path (migration 0139,
-- panorama_cube + panorama_cube_meta, CUBE_READS flag). The KPI strip
-- (/api/panorama/kpis + the panorama server pages) still ran its ~20-query
-- fan-out LIVE on every cold request. This migration adds the KPI-strip cube.
--
-- SAME PHILOSOPHY AS 0139 (the TS-builder amendment): the builder REUSES the
-- live use-case (getPanoramaKpis — the exact fan-out the request path runs) and
-- stores WHAT IT PRODUCED, so cube-vs-live drift is structurally impossible and
-- the parity test is near-tautology. Because the tiles are the FINISHED,
-- formatted PanoramaKpi objects (value/sub/tone/delta/sparkline...), the grain
-- here is (scope, kpi) with a jsonb payload — NOT the per-unit numeric columns
-- of panorama_cube, whose reader re-runs a pure transform. Re-deriving tile
-- formatting from numeric columns would FORK the presentation logic the strip
-- exists to single-source (dashboard parity).
--
-- PRIVACY: getPanoramaKpis returns only k-anon'd, scope-aggregated headline
-- figures (the same payload the API already serves to admins). No sub-k value
-- and no per-unit breakdown enters this table.
--
-- SCOPE GRAIN (v1): 'national' only — the admin landing view, the most common
-- and most expensive request (mirrors the layer cube's admin-only reasoning).
-- Province drills and govt scopes stay live. The scope column exists so a
-- future build can add drill scopes without a migration.
--
-- BIRTHS (the known cube gap): pregnancy/litter aggregates were not cubed
-- anywhere. The builder stores a kpi='births' row (fetchNetGrowth: altas,
-- registeredBirths, deaths, net — lib/metrics/population-control.ts) with
-- position NULL: cubed and parity-tested, but NOT part of the rendered strip
-- (no strip tile renders births today; a future tile can read it cube-first).
--
-- App reads/writes ONLY via analyticsDb/Drizzle (service-role, BYPASSRLS).
-- PostgREST cannot read them (RLS enabled, zero policies) — precedent:
-- panorama_cube, rate_limit_buckets, eno_processing_queue.

-- ---------------------------------------------------------------------------
-- PART 1 — the readable KPI cube surface. One row per (scope, kpi).
-- ---------------------------------------------------------------------------
create table if not exists public.panorama_kpi_cube (
  -- 'national' (v1). Future: a province drill scope per province.
  scope text not null,
  -- PanoramaKpiId ('cobertura' | 'esterilizacion' | ...) for strip tiles, or a
  -- non-strip aggregate id ('births').
  kpi text not null,
  -- Strip display order (0-based). NULL = not a strip tile (births): stored and
  -- parity-tested but never assembled into the served strip.
  position integer,
  -- Strip tiles: the FINISHED PanoramaKpi object exactly as getPanoramaKpis
  -- built it (value/sub/tone/info/delta/sparkline/...). Non-strip aggregates
  -- (births): the raw fetcher result (NetGrowthResult).
  payload jsonb not null,
  primary key (scope, kpi)
);

comment on table public.panorama_kpi_cube is
  'Precomputed panorama KPI strip; built by the TS cube-builder REUSING getPanoramaKpis (admin-national scope, panorama default period). Read only via analyticsDb service-role. Deny-all to PostgREST is safe.';

-- No extra index: every read is by scope — the PK's leading column.

alter table public.panorama_kpi_cube enable row level security;  -- deny-all (no policy)

-- ---------------------------------------------------------------------------
-- PART 2 — build metadata singleton (mirrors panorama_cube_meta). The reader
-- gates on status='ok', built_at freshness, AND the stored period window (the
-- KPIs are period-sensitive, unlike the current-state choropleth cube).
-- ---------------------------------------------------------------------------
create table if not exists public.panorama_kpi_cube_meta (
  id integer primary key default 1 check (id = 1),
  -- transaction time of the last successful KPI build.
  built_at timestamptz,
  -- MAX(pet_events.recorded_at) observed by the same refresh run.
  watermark timestamptz,
  -- 'pending' | 'ok' | 'error'. Reader falls back to live when status != 'ok'.
  status text not null default 'pending',
  row_count integer,
  duration_ms integer,
  -- The AnalyticsPeriod the strip was computed for (panorama default preset,
  -- resolved at build). The reader serves the cube ONLY when the requested
  -- window matches within tolerance — a 12m request never reads a 3y strip.
  period_since timestamptz,
  period_until timestamptz,
  -- Strip-level fields of the built PanoramaKpis payload (recalculatedFor,
  -- dataAsOf, coverageDenominator) — everything except the tiles.
  strip jsonb
);

comment on table public.panorama_kpi_cube_meta is
  'Panorama KPI cube build metadata singleton (built_at, status, period window, strip-level payload). Read only via analyticsDb service-role. Deny-all to PostgREST is safe.';

insert into public.panorama_kpi_cube_meta (id) values (1) on conflict do nothing;

alter table public.panorama_kpi_cube_meta enable row level security;  -- deny-all
