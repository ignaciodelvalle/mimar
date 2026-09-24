-- Catalog of Argentine localities, populated from INDEC CPPDyL (Códigos de
-- provincias, departamentos y localidades) via scripts/import-indec-localities.ts.
--
-- See docs/superpowers/specs/2026-05-18-localities-catalog-indec-design.md §4.
--
-- Idempotent: every CREATE uses IF NOT EXISTS guards. The extension and
-- indexes are safe to re-apply.

-- ============================================================================
-- 1. pg_trgm extension (for typeahead partial matching)
-- ============================================================================
create extension if not exists pg_trgm;

-- ============================================================================
-- 2. ar_localities — the canonical locality catalog
-- ============================================================================
create table if not exists "public"."ar_localities" (
  "id"               uuid primary key default gen_random_uuid(),

  "province_code"    text not null,
  "department_name"  text,
  "department_code"  text,

  "locality_name"    text not null,
  "locality_slug"    text not null,
  "indec_id"         text unique,
  "category"         text not null,

  "latitude"         numeric(10, 7),
  "longitude"        numeric(10, 7),

  "source"           text not null,
  "source_version"   text,
  "last_imported_at" timestamptz not null default now(),

  "removed_at"       timestamptz,

  constraint "ar_localities_province_valid"
    check (province_code ~ '^AR-[A-Z]$'),
  constraint "ar_localities_category_valid"
    check (category in ('localidad','ciudad','pueblo','comuna','barrio','componente')),
  constraint "ar_localities_source_valid"
    check (source in ('indec_cppdyl','bahra','manual'))
);

create unique index if not exists "ar_localities_province_slug_uniq"
  on "public"."ar_localities" ("province_code", "locality_slug")
  where "removed_at" is null;

create index if not exists "ar_localities_province_idx"
  on "public"."ar_localities" ("province_code")
  where "removed_at" is null;

create index if not exists "ar_localities_name_search"
  on "public"."ar_localities"
  using gin (to_tsvector('spanish', locality_name));

create index if not exists "ar_localities_name_trgm"
  on "public"."ar_localities"
  using gin (locality_name gin_trgm_ops);

-- ============================================================================
-- 3. ar_localities_import_runs — trace of every import script execution
-- ============================================================================
create table if not exists "public"."ar_localities_import_runs" (
  "id"              uuid primary key default gen_random_uuid(),
  "started_at"      timestamptz not null default now(),
  "finished_at"     timestamptz,
  "source"          text not null,
  "source_url"      text not null,
  "source_version"  text,
  "status"          text not null default 'running',
  "inserted_count"  integer not null default 0,
  "updated_count"   integer not null default 0,
  "noop_count"      integer not null default 0,
  "removed_count"   integer not null default 0,
  "details"         jsonb not null default '{}'::jsonb,

  constraint "ar_imports_status_valid" check (status in ('running','ok','failed'))
);

create index if not exists "ar_localities_import_runs_idx"
  on "public"."ar_localities_import_runs" ("started_at" desc);

-- ============================================================================
-- 4. RLS — any authenticated user can SELECT (the catalog is reference data,
--    not user data). Writes only via the service role (the import script).
-- ============================================================================
alter table "public"."ar_localities" enable row level security;
alter table "public"."ar_localities_import_runs" enable row level security;

drop policy if exists "ar_localities select authenticated" on "public"."ar_localities";
create policy "ar_localities select authenticated"
  on "public"."ar_localities" for select
  using (auth.uid() is not null);

drop policy if exists "ar_localities_import_runs select admin" on "public"."ar_localities_import_runs";
create policy "ar_localities_import_runs select admin"
  on "public"."ar_localities_import_runs" for select
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role = 'admin'
        and p.account_type = 'institutional'
        and p.deactivated_at is null
    )
  );
