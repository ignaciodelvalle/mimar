-- Panorama precomputed aggregate cube (road-to-10 infra #1).
--
-- Design: docs/plans/2026-07-11-cube-design.md, with the orchestrator's
-- amendment: the builder is a TypeScript worker that REUSES the existing
-- choropleth loaders (src/modules/panorama/infrastructure/cube-builder.ts) and
-- writes the result in ONE Drizzle transaction. There is NO plpgsql refresh
-- function and NO pg_cron schedule in this migration — the trigger is the
-- /api/cron/refresh-cube route (CRON_SECRET) plus `pnpm cube:refresh` locally.
--
-- Because the builder reuses the loaders, suppression is ALREADY applied before a
-- value is stored: suppressed department cells carry value = NULL and the real
-- sub-k count never leaves the loader (it is nulled in-memory). So there is NO
-- private build layer here — the design's `panorama_cube_build` table is dropped
-- entirely. Two tables only:
--   1. panorama_cube      — the readable k-anon'd surface (deny-all RLS).
--   2. panorama_cube_meta — build metadata singleton (deny-all RLS).
--
-- The app reads both ONLY via analyticsDb/Drizzle (service-role, BYPASSRLS).
-- PostgREST cannot read them (deny-all). Precedent: rate_limit_buckets,
-- eno_processing_queue (RLS ENABLED, zero policies, documented reason).

-- ---------------------------------------------------------------------------
-- PART 1 — readable k-anon'd surface. NEVER contains a sub-k value: suppressed
-- department cells carry value = NULL. Two grains via `unit_level`.
-- ---------------------------------------------------------------------------
create table if not exists public.panorama_cube (
  -- 'rabies-coverage' | 'sterilization-coverage' | 'microchip-penetration'
  -- | 'ppp-compliance' | 'mortality'
  metric text not null,
  -- 'province' | 'department'
  unit_level text not null,
  -- province display name (join key for basemap + ISO map).
  province text not null,
  -- Unique unit identifier WITHIN the (metric, unit_level) grain; the PK's
  -- non-null component. department grain: the fold key (`${province}|dept:<code>`
  -- / `|barrio:<name>` / `|loc:<name>`). province grain: the province name.
  unit_code text not null,
  -- Display label the map/popup shows. department grain: the department/partido
  -- name (barrio name for CABA, or the raw locality when it resolved no INDEC
  -- department). province grain: the province name. Mirrors ChoroplethCell.locality.
  label text,
  -- INDEC 5-digit department code (department grain; NULL for CABA barrios, for a
  -- locality with no INDEC match, and at province grain).
  department_code text,
  department_name text,
  -- department grain only (the centroid the map falls back to when a division
  -- polygon has no match). NULL at province grain (the basemap polygon is the geometry).
  centroid_lat numeric,
  centroid_lng numeric,
  -- department grain: k-anon'd numerator count (NULL when suppressed).
  -- province grain: ratePct (rate metrics) or count (density metrics).
  value numeric,
  -- province rate rows: denominator. Reserved for a future reader that renders
  -- rate-by-num/den; the current reader uses `value` directly so this stays NULL
  -- in v1 (the reused loaders return the final ratePct, not num/den).
  den integer,
  -- province grain: that province's metric-matching pets with a province but NULL
  -- locality (the WARNING-4 residual, invisible at department grain). The reader
  -- sums it over in-scope provinces to reproduce the loader's noLocalityCount.
  -- NULL at department grain.
  no_locality integer,
  -- department grain: k-anon (k=5) suppressed this cell (value withheld).
  suppressed boolean not null default false,
  -- department grain: this cell was withheld by COMPLEMENTARY (secondary)
  -- suppression rather than primary k-anon. NOTE: the TS builder reuses the
  -- loaders, which merge primary + complementary into one `suppressed` partition
  -- and null the raw count, so the two cannot be told apart at store time — this
  -- flag is always false in v1. The differencing-defense PROPERTY is still
  -- enforced upstream by complementarySuppress and verified by the sub-k
  -- invariant test; the flag is retained for schema/forward compatibility.
  complementary boolean not null default false,
  primary key (metric, unit_level, unit_code)
);

comment on table public.panorama_cube is
  'Precomputed panorama choropleth aggregate; k-anon''d at BUILD by the TS cube-builder (reuses the live loaders). Read only via analyticsDb service-role. Deny-all to PostgREST is safe.';

-- The reader always scans by (metric, unit_level) then filters province.
create index if not exists panorama_cube_lookup_idx
  on public.panorama_cube (metric, unit_level, province);

alter table public.panorama_cube enable row level security;  -- deny-all (no policy)

-- ---------------------------------------------------------------------------
-- PART 2 — build metadata singleton. The reader reads built_at (freshness /
-- staleness gate) and status; last-good survives a failed build (no swap on error).
-- ---------------------------------------------------------------------------
create table if not exists public.panorama_cube_meta (
  id integer primary key default 1 check (id = 1),
  -- transaction time the cube was last successfully built (surfaced as the
  -- data-freshness timestamp for cube-served layers).
  built_at timestamptz,
  -- MAX(pet_events.recorded_at) observed at build ("what the system knew when").
  watermark timestamptz,
  -- 'pending' | 'ok' | 'error'. Reader falls back to live when status != 'ok'.
  status text not null default 'pending',
  row_count integer,
  duration_ms integer
);

comment on table public.panorama_cube_meta is
  'Panorama cube build metadata singleton (built_at, watermark, status). Read only via analyticsDb service-role. Deny-all to PostgREST is safe.';

insert into public.panorama_cube_meta (id) values (1) on conflict do nothing;

alter table public.panorama_cube_meta enable row level security;  -- deny-all
