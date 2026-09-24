-- Admin Page — Fase 0+ closure
--
-- Closes spec drift between v2.1 and v2.2:
--   1. Replace enforce_admin_no_pets (role='admin' only) with the spec-correct
--      enforce_institutional_no_pets (account_type='institutional', covers both
--      govt and admin). Pre-condition guard aborts if any institutional user
--      already owns pets — no silent data corruption.
--   2. ADD CONSTRAINT profiles_account_type_role_match — enforces the canonical
--      two-column invariant: personal→{owner,vet}, institutional→{govt,admin}.
--   3. ADD CONSTRAINT profiles_institutional_no_pii — institutional accounts
--      cannot hold personal-identity fields (dni_number, matricula_number).
--   4. DELETE stale rows for removed approval types, then ALTER the type CHECK
--      on approval_requests to only allow (role_upgrade_vet, organization_verification).
--
-- Idempotent: every ADD CONSTRAINT is wrapped in a DO $$ BEGIN … EXCEPTION WHEN
-- duplicate_object THEN NULL END $$; block. Trigger and function use
-- CREATE OR REPLACE / DROP IF EXISTS.
--
-- Applied via:
--   cat db/migrations/0015_admin_page_closure.sql | docker exec -i supabase_db_DIM psql -U postgres -d postgres -v ON_ERROR_STOP=1

-- ============================================================================
-- 1. Precondition guard — abort if any institutional user owns a pet
-- ============================================================================
do $$
declare
  n integer;
begin
  select count(*) into n
  from public.ownerships o
  join public.profiles p on p.id = o.owner_user_id
  where p.account_type = 'institutional';

  if n > 0 then
    raise exception
      'Precondition failed: % institutional user(s) own pet(s). Transfer or remove these ownerships before applying migration 0015.',
      n
      using errcode = 'check_violation';
  end if;
end $$;

-- ============================================================================
-- 2. Drop the old trigger + function (admin-only scope), replace with
--    enforce_institutional_no_pets (account_type='institutional' scope)
-- ============================================================================

-- Drop old trigger
drop trigger if exists "ownerships_admin_no_pets" on "public"."ownerships";

-- Drop old function
drop function if exists "public"."enforce_admin_no_pets"();

-- New function: checks account_type = 'institutional' (covers both govt and admin)
create or replace function "public"."enforce_institutional_no_pets"()
returns trigger
language plpgsql
as $$
declare
  target_account_type text;
begin
  -- Only check user-owned ownerships; organization-owned rows are unaffected.
  if new.owner_user_id is null then
    return new;
  end if;

  select account_type into target_account_type
  from public.profiles
  where id = new.owner_user_id;

  if target_account_type = 'institutional' then
    raise exception
      'Institutional accounts (govt, admin) cannot own pets. Transfer ownership before using this account for governance.'
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists "ownerships_institutional_no_pets" on "public"."ownerships";
create trigger "ownerships_institutional_no_pets"
  before insert or update on "public"."ownerships"
  for each row execute function "public"."enforce_institutional_no_pets"();

-- ============================================================================
-- 3. ADD CONSTRAINT profiles_account_type_role_match
--    personal → {owner, vet}; institutional → {govt, admin}
-- ============================================================================
do $$ begin
  alter table public.profiles
    add constraint profiles_account_type_role_match
    check (
      (account_type = 'personal'     and role in ('owner', 'vet'))
      or
      (account_type = 'institutional' and role in ('govt',  'admin'))
    );
exception when duplicate_object then null;
end $$;

-- ============================================================================
-- 4. ADD CONSTRAINT profiles_institutional_no_pii
--    institutional accounts must have NULL personal-identity text fields.
--    Note: boolean verified-flags (dni_verified, matricula_verified) are NOT
--    included in this CHECK — they default to false but may be set by seed
--    scripts without semantic impact. Only the text fields carry PII.
-- ============================================================================
do $$ begin
  alter table public.profiles
    add constraint profiles_institutional_no_pii
    check (
      account_type = 'personal'
      or (
        dni_number                 is null
        and matricula_number       is null
        and matricula_jurisdiccion is null
      )
    );
exception when duplicate_object then null;
end $$;

-- ============================================================================
-- 5. Remove stale approval_requests rows for the deleted types (defensive;
--    none should exist in a real install — these types were never in prod use)
-- ============================================================================
delete from public.approval_requests
where type in ('role_upgrade_govt', 'role_upgrade_admin', 'govt_assignment_grant');

-- ============================================================================
-- 6. Tighten the approval_type_valid CHECK on approval_requests
--    Drop old constraint, add narrowed one
-- ============================================================================
do $$ begin
  alter table public.approval_requests
    drop constraint approval_type_valid;
exception when undefined_object then null;
end $$;

do $$ begin
  alter table public.approval_requests
    add constraint approval_type_valid
    check (type in ('role_upgrade_vet', 'organization_verification'));
exception when duplicate_object then null;
end $$;

-- ============================================================================
-- 7. Tighten approval_target_consistent to match the two remaining types
-- ============================================================================
do $$ begin
  alter table public.approval_requests
    drop constraint approval_target_consistent;
exception when undefined_object then null;
end $$;

do $$ begin
  alter table public.approval_requests
    add constraint approval_target_consistent
    check (
      case type
        when 'role_upgrade_vet'          then target_user_id is not null and target_organization_id is null
        when 'organization_verification' then target_user_id is null     and target_organization_id is not null
      end
    );
exception when duplicate_object then null;
end $$;
