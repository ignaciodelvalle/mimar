-- DIM organization capability grants — schema migration
-- ------------------------------------------------------
-- Lands the per-membership capability-grant system that powers the refugio
-- portal and (later) the clinic / sanitary-authority portals. Roles label who
-- an employee is; capabilities (admin-approved) gate what they can do.
-- See AGENTS.md → Organizations and lib/capabilities.ts.
--
-- Apply once per environment by pasting into Supabase Studio → SQL Editor.
-- Idempotent — safe to re-run; uses IF NOT EXISTS / IF EXISTS guards throughout.
--
-- DO NOT apply this via `pnpm db:push`. Push detects existing welfare_reports
-- RLS policies as drift (they live in db/welfare_rls.sql, not in db/schema.ts)
-- and proposes to DROP them. See engram gotcha `gotchas/drizzle-rls-drift`.

-- ============================================================================
-- 1. New enum
-- ============================================================================

do $$ begin
  create type "public"."organization_capability_status" as enum (
    'pending', 'approved', 'denied', 'revoked'
  );
exception when duplicate_object then null;
end $$;

-- ============================================================================
-- 2. New table
-- ============================================================================

create table if not exists "public"."organization_capability_grants" (
  "id" uuid primary key default gen_random_uuid(),
  "membership_id" uuid not null
    references "public"."organization_memberships"("id") on delete cascade,
  "organization_id" uuid not null
    references "public"."organizations"("id") on delete cascade,
  "capability" text not null,
  "status" "public"."organization_capability_status" not null default 'pending',
  "requested_at" timestamptz not null default now(),
  "requested_reason" text,
  "decided_at" timestamptz,
  "decided_by_user_id" uuid references "public"."profiles"("id") on delete set null,
  "decision_reason" text
);

create index if not exists "org_capability_grants_membership_capability_idx"
  on "public"."organization_capability_grants" ("membership_id", "capability");

create index if not exists "org_capability_grants_org_pending_idx"
  on "public"."organization_capability_grants" ("organization_id")
  where "status" = 'pending';

-- At most one open (pending or approved) grant per (membership, capability).
-- Terminal states (denied, revoked) don't block a fresh request — re-asking
-- after a denial is allowed and inserts a new row.
create unique index if not exists "org_capability_grants_one_open_per_capability"
  on "public"."organization_capability_grants" ("membership_id", "capability")
  where "status" in ('pending', 'approved');
