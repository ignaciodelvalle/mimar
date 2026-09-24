-- Admin Page — Fase 5 Foundation (institutional accounts schema)
--
-- Closes the Fase 0 schema deuda: profiles table was missing account_type
-- and deactivated_at columns. These are required by every Fase 5 feature.
--
-- Columns:
--   account_type — distinguishes self-serve (owner/vet) from institutional
--                  (admin/govt) accounts. Stored as text+CHECK to avoid enum
--                  migration cost when adding values in future Fases.
--   deactivated_at — irreversible soft-deactivation marker. NULL = active.
--
-- Backfill: existing admin/govt rows (seeded via Studio in Fase 0/3) get
-- account_type='institutional'. Owner/vet rows keep 'personal' (the DEFAULT).
--
-- Applied non-transactionally if run via drizzle-kit push or supabase db reset.

-- ============================================================================
-- 1. Add account_type column
-- ============================================================================
alter table "public"."profiles"
  add column if not exists "account_type" text not null default 'personal';

alter table "public"."profiles"
  add constraint "profiles_account_type_valid"
  check ("account_type" in ('personal', 'institutional'))
  not valid;

alter table "public"."profiles"
  validate constraint "profiles_account_type_valid";

-- ============================================================================
-- 2. Add deactivated_at column
-- ============================================================================
alter table "public"."profiles"
  add column if not exists "deactivated_at" timestamptz;

-- ============================================================================
-- 3. Backfill: existing admin/govt rows are institutional accounts
-- ============================================================================
update "public"."profiles"
  set "account_type" = 'institutional'
  where "role" in ('admin', 'govt');

-- ============================================================================
-- 4. Partial index for active institutional operators
-- ============================================================================
create index if not exists "profiles_institutional_active_idx"
  on "public"."profiles" ("role")
  where "account_type" = 'institutional' and "deactivated_at" is null;
