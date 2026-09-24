-- Admin Page — Fase 0 (schema foundation)
--
-- Implements the schema described in
-- docs/superpowers/specs/2026-05-17-admin-page-design.md §4.
--
-- Four-role authority model: owner | vet | govt | admin. Govt is scope-
-- limited per (province, locality) via govt_assignments. Approval requests
-- are the canonical contract — every state mutation on profiles role,
-- organizations.verified, etc. flows through an approval_request row that
-- carries evidence + jurisdiction + payload. audit_log records every
-- authority action append-only.
--
-- The spec also references service_providers (scheduling) and
-- target_service_provider_id on approval_requests + audit_log. That column
-- and the matching `service_provider_scheduling` request type are
-- DEFERRED to Fase 8 — service_providers table does not exist yet. When
-- Fase 8 lands, its migration extends both tables (column + FK + check).
--
-- ALTER TYPE ... ADD VALUE cannot run inside a tx block, so this file is
-- applied non-transactionally (the Node script that pipes it uses
-- sql.unsafe which sends statements one at a time).

-- ============================================================================
-- 1. Extend user_role enum
-- ============================================================================
alter type "public"."user_role" add value if not exists 'admin';

-- ============================================================================
-- 2. govt_assignments — multi-locality scope per govt user
-- ============================================================================
create table if not exists "public"."govt_assignments" (
  "id"                     uuid primary key default gen_random_uuid(),
  "user_id"                uuid not null references "public"."profiles"("id") on delete cascade,
  "jurisdiction_country"   text not null default 'AR',
  "jurisdiction_province"  text not null,
  "jurisdiction_locality"  text not null,
  "granted_by_user_id"     uuid references "public"."profiles"("id"),
  "granted_at"             timestamptz not null default now(),
  "revoked_at"             timestamptz,
  "revoked_by_user_id"     uuid references "public"."profiles"("id"),
  "revocation_reason"      text,
  "notes"                  text,
  "created_at"             timestamptz not null default now()
);

-- One active assignment per user per locality. Re-granting after revocation is fine.
create unique index if not exists "govt_assignments_active_unique"
  on "public"."govt_assignments" ("user_id", "jurisdiction_province", "jurisdiction_locality")
  where revoked_at is null;

create index if not exists "govt_assignments_user_active_idx"
  on "public"."govt_assignments" ("user_id")
  where revoked_at is null;

create index if not exists "govt_assignments_locality_idx"
  on "public"."govt_assignments" ("jurisdiction_province", "jurisdiction_locality")
  where revoked_at is null;

-- ============================================================================
-- 3. approval_requests — canonical contract for every state mutation
-- ============================================================================
create table if not exists "public"."approval_requests" (
  "id"                          uuid primary key default gen_random_uuid(),
  "public_token"                text not null unique,
  "type"                        text not null,
  "status"                      text not null default 'pending',

  "applicant_user_id"           uuid not null references "public"."profiles"("id") on delete cascade,
  "initiated_by"                text not null default 'self',
  "initiated_by_user_id"        uuid references "public"."profiles"("id"),

  -- Polymorphic target. Exactly one is set, matching type (CHECK below).
  -- target_service_provider_id deferred to Fase 8.
  "target_user_id"              uuid references "public"."profiles"("id") on delete cascade,
  "target_organization_id"      uuid references "public"."organizations"("id") on delete cascade,

  -- Jurisdiction drives admin/govt scope matching. Always required.
  "jurisdiction_country"        text not null default 'AR',
  "jurisdiction_province"       text not null,
  "jurisdiction_locality"       text not null,

  -- Type-specific payload (matricula, requested locality, etc.). Validated
  -- by Zod schemas in lib/approval-payloads.ts before insert.
  "payload"                     jsonb not null default '{}'::jsonb,

  "decided_at"                  timestamptz,
  "decided_by_user_id"          uuid references "public"."profiles"("id"),
  "decision_notes"              text,
  "withdrawn_at"                timestamptz,

  "created_at"                  timestamptz not null default now(),
  "updated_at"                  timestamptz not null default now(),

  constraint "approval_type_valid" check (type in (
    'role_upgrade_vet',
    'role_upgrade_govt',
    'role_upgrade_admin',
    'organization_verification',
    'govt_assignment_grant'
    -- 'service_provider_scheduling' arrives in Fase 8 alongside the column
  )),

  constraint "approval_status_valid" check (status in (
    'pending', 'approved', 'rejected', 'withdrawn'
  )),

  constraint "approval_initiated_valid" check (initiated_by in ('self', 'authority')),

  constraint "approval_target_consistent" check (
    case type
      when 'role_upgrade_vet'             then target_user_id is not null and target_organization_id is null
      when 'role_upgrade_govt'            then target_user_id is not null and target_organization_id is null
      when 'role_upgrade_admin'           then target_user_id is not null and target_organization_id is null
      when 'organization_verification'    then target_user_id is null     and target_organization_id is not null
      when 'govt_assignment_grant'        then target_user_id is not null and target_organization_id is null
    end
  ),

  constraint "approval_decision_consistent" check (
    (status in ('approved', 'rejected') and decided_at is not null and decided_by_user_id is not null)
    or (status in ('pending', 'withdrawn') and decided_at is null and decided_by_user_id is null)
  )
);

create index if not exists "approval_requests_status_idx"
  on "public"."approval_requests" ("status", "created_at")
  where status = 'pending';

create index if not exists "approval_requests_applicant_idx"
  on "public"."approval_requests" ("applicant_user_id", "created_at" desc);

create index if not exists "approval_requests_juris_idx"
  on "public"."approval_requests" ("jurisdiction_province", "jurisdiction_locality")
  where status = 'pending';

create index if not exists "approval_requests_type_idx"
  on "public"."approval_requests" ("type", "status");

-- ============================================================================
-- 4. audit_log — append-only authority-action history
-- ============================================================================
create table if not exists "public"."audit_log" (
  "id"                         uuid primary key default gen_random_uuid(),
  "actor_user_id"              uuid not null references "public"."profiles"("id") on delete restrict,
  "action"                     text not null,
  "approval_request_id"        uuid references "public"."approval_requests"("id"),
  "target_user_id"             uuid references "public"."profiles"("id"),
  "target_organization_id"     uuid references "public"."organizations"("id"),
  -- target_service_provider_id deferred to Fase 8.
  "target_govt_assignment_id"  uuid references "public"."govt_assignments"("id"),
  "payload"                    jsonb not null default '{}'::jsonb,
  "performed_at"               timestamptz not null default now()
);

create index if not exists "audit_log_actor_idx"
  on "public"."audit_log" ("actor_user_id", "performed_at" desc);
create index if not exists "audit_log_request_idx"
  on "public"."audit_log" ("approval_request_id");
create index if not exists "audit_log_target_user_idx"
  on "public"."audit_log" ("target_user_id");
create index if not exists "audit_log_action_idx"
  on "public"."audit_log" ("action", "performed_at" desc);

-- Append-only enforcement. Mirrors pet_events: a GUC bypass
-- (app.allow_audit_mutation='true') is honored so test cleanup and rare
-- migrations can mutate when set explicitly inside a tx.
create or replace function "public"."enforce_audit_log_append_only"()
returns trigger
language plpgsql
as $$
begin
  if current_setting('app.allow_audit_mutation', true) = 'true' then
    return coalesce(new, old);
  end if;
  raise exception 'audit_log is append-only. % blocked.', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists "audit_log_no_update" on "public"."audit_log";
create trigger "audit_log_no_update"
  before update on "public"."audit_log"
  for each row execute function "public"."enforce_audit_log_append_only"();

drop trigger if exists "audit_log_no_delete" on "public"."audit_log";
create trigger "audit_log_no_delete"
  before delete on "public"."audit_log"
  for each row execute function "public"."enforce_audit_log_append_only"();

-- ============================================================================
-- 5. Trigger: admin users cannot own pets (anti-pets invariant)
-- ============================================================================
-- See spec §4.3 + §7.2. The trigger fires only on user-owned ownership rows
-- (org-owned rows are irrelevant for this invariant). Plus the server action
-- that upgrades a user to admin re-checks they have zero active ownerships
-- before mutating profiles.role — the trigger is defense-in-depth.
create or replace function "public"."enforce_admin_no_pets"()
returns trigger
language plpgsql
as $$
declare
  target_role public.user_role;
begin
  if new.owner_user_id is null then
    return new;
  end if;

  select role into target_role from public.profiles where id = new.owner_user_id;
  if target_role = 'admin' then
    raise exception 'Admin users cannot own pets. Transfer ownership before upgrading to admin.'
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists "ownerships_admin_no_pets" on "public"."ownerships";
create trigger "ownerships_admin_no_pets"
  before insert or update on "public"."ownerships"
  for each row execute function "public"."enforce_admin_no_pets"();

-- ============================================================================
-- 6. Extend attachments with optional FKs to approval requests / audit log
-- ============================================================================
-- See spec §4.6. One attachment row can be linked to either an approval
-- request (as evidence submitted by the applicant) or an audit_log entry
-- (as evidence captured during a revocation). The new `purpose` value
-- semantics (`approval_evidence` / `revocation_evidence`) is application-
-- level — no enum on the column, the existing string column suffices.
alter table "public"."attachments"
  add column if not exists "approval_request_id" uuid
    references "public"."approval_requests"("id") on delete cascade,
  add column if not exists "audit_log_id" uuid
    references "public"."audit_log"("id") on delete cascade;

-- ============================================================================
-- Bootstrap (run manually, once, with the founder's user_id)
-- ============================================================================
-- update public.profiles set role = 'admin' where id = '<founder_user_id>';
-- insert into public.audit_log (actor_user_id, action, target_user_id, payload)
--   values ('<founder_user_id>', 'admin_seeded', '<founder_user_id>',
--           '{"source":"studio"}'::jsonb);
