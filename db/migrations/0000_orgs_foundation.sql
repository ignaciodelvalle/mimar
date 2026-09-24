-- DIM organizations foundation — schema migration
-- ------------------------------------------------
-- Lands the Organizations / OrganizationCoverage / OrganizationMembership
-- tables, the polymorphic Ownership rewrite, and the PetEvent author_organization_id
-- column. See AGENTS.md → Organizations / Ownership / PetEvent for design rationale.
--
-- Apply once per environment by pasting into Supabase Studio → SQL Editor.
-- Idempotent — safe to re-run; uses IF NOT EXISTS / IF EXISTS guards throughout.
--
-- DO NOT apply this via `pnpm db:push`. Push detects the existing welfare_reports
-- RLS policies as drift (they live in db/welfare_rls.sql, not in db/schema.ts) and
-- proposes to DROP them. See engram gotcha `gotchas/drizzle-rls-drift`.

-- ============================================================================
-- 1. New enum types
-- ============================================================================

do $$ begin
  create type "public"."org_type" as enum (
    'clinic', 'shelter', 'rescue_network', 'sanitary_authority', 'other'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type "public"."org_status" as enum ('active', 'suspended', 'dissolved');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type "public"."organization_membership_role" as enum (
    'admin', 'coordinator', 'member', 'volunteer', 'foster', 'vet_individual'
  );
exception when duplicate_object then null;
end $$;

-- ============================================================================
-- 2. Extend existing enums (idempotent)
-- ============================================================================
-- Note: ALTER TYPE ... ADD VALUE cannot run inside a transaction block in some
-- Postgres versions. If a single paste fails, run these four statements separately.

alter type "public"."ownership_role" add value if not exists 'shelter_custody';
alter type "public"."ownership_role" add value if not exists 'foster';
alter type "public"."author_role" add value if not exists 'shelter';

-- ============================================================================
-- 3. New tables
-- ============================================================================

create table if not exists "public"."organizations" (
  "id" uuid primary key default gen_random_uuid(),
  "public_token" text not null unique,
  "legal_name" text not null,
  "display_name" text not null,
  "org_type" "public"."org_type" not null,
  "cuit" text unique,
  "personeria_juridica_number" text,
  "email" text not null,
  "phone" text,
  "website" text,
  "avatar_url" text,
  "verified" boolean not null default false,
  "verified_at" timestamptz,
  "verified_by_user_id" uuid references "public"."profiles"("id") on delete set null,
  "tier_0_show_branding" boolean not null default false,
  "jurisdiction_country" text not null default 'AR',
  "jurisdiction_province" text,
  "jurisdiction_locality" text,
  "status" "public"."org_status" not null default 'active',
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  "created_by_user_id" uuid references "public"."profiles"("id") on delete set null
);
create index if not exists "organizations_org_type_idx" on "public"."organizations" ("org_type");
create index if not exists "organizations_verified_idx" on "public"."organizations" ("verified");

create table if not exists "public"."organization_coverage" (
  "id" uuid primary key default gen_random_uuid(),
  "organization_id" uuid not null references "public"."organizations"("id") on delete cascade,
  "jurisdiction_country" text not null default 'AR',
  "jurisdiction_province" text,
  "jurisdiction_locality" text,
  "is_primary" boolean not null default false,
  "created_at" timestamptz not null default now()
);
create index if not exists "organization_coverage_org_id_idx"
  on "public"."organization_coverage" ("organization_id");
create index if not exists "organization_coverage_jurisdiction_idx"
  on "public"."organization_coverage" ("jurisdiction_province", "jurisdiction_locality");

create table if not exists "public"."organization_memberships" (
  "id" uuid primary key default gen_random_uuid(),
  "organization_id" uuid not null references "public"."organizations"("id") on delete cascade,
  "user_id" uuid not null references "public"."profiles"("id") on delete cascade,
  "role" "public"."organization_membership_role" not null,
  "title" text,
  "can_write_pet_events" boolean not null default false,
  "joined_at" timestamptz not null default now(),
  "left_at" timestamptz,
  "invited_by_user_id" uuid references "public"."profiles"("id") on delete set null
);
create index if not exists "organization_memberships_org_id_idx"
  on "public"."organization_memberships" ("organization_id");
create index if not exists "organization_memberships_user_id_idx"
  on "public"."organization_memberships" ("user_id");
create index if not exists "organization_memberships_active_idx"
  on "public"."organization_memberships" ("organization_id", "user_id")
  where "left_at" is null;

-- ============================================================================
-- 4. Ownership rewrite (polymorphic holder)
-- ============================================================================
-- The rename below is non-destructive — Postgres preserves all existing rows.
-- After the rename, every existing row has owner_user_id set and owner_organization_id
-- NULL, which satisfies the new CHECK constraint (exactly one holder).
-- Wrapped in a guard so re-runs after a successful apply do not error.

do $$ begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ownerships' and column_name = 'user_id'
  ) then
    alter table "public"."ownerships" rename column "user_id" to "owner_user_id";
  end if;
end $$;
alter table "public"."ownerships" alter column "owner_user_id" drop not null;

alter table "public"."ownerships"
  add column if not exists "owner_organization_id" uuid
  references "public"."organizations"("id") on delete cascade;

alter table "public"."ownerships" drop constraint if exists "ownerships_polymorphic_holder";
alter table "public"."ownerships"
  add constraint "ownerships_polymorphic_holder"
  check (("owner_user_id" is not null)::int + ("owner_organization_id" is not null)::int = 1);

-- Swap the unique index: was "any active row per pet" → now "active OWNER row per pet only".
-- This relaxation allows multiple active shelter_custody / foster / caretaker / co_owner
-- rows to coexist with an active owner (and with each other when no owner exists yet).
drop index if exists "public"."ownerships_one_active_per_pet";
create unique index if not exists "ownerships_one_active_owner_per_pet"
  on "public"."ownerships" ("pet_id")
  where "role" = 'owner' and "ended_at" is null;

-- Replace the user_id index with one targeting the renamed column, and add an org index.
drop index if exists "public"."ownerships_user_id_idx";
create index if not exists "ownerships_owner_user_id_idx"
  on "public"."ownerships" ("owner_user_id");
create index if not exists "ownerships_owner_organization_id_idx"
  on "public"."ownerships" ("owner_organization_id");

-- ============================================================================
-- 5. PetEvent — institutional author attribution
-- ============================================================================

alter table "public"."pet_events"
  add column if not exists "author_organization_id" uuid
  references "public"."organizations"("id") on delete set null;
