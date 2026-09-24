-- Cases RLS — Fase F (expanded). Production rules per kind.
--
-- NOTE (V0-4): This file is now REFERENCE ONLY. The source of truth for
-- applying RLS is db/migrations/0094_cases_rls.sql (applied by db:migrate
-- and replayed by db:bootstrap step 2). This file is no longer applied by
-- db-bootstrap.ts. Keep edits here in sync with migration 0094.
--
-- `can_read_case(case_id, user_id)` is the single hook every related
-- policy composes with (pet_events SELECT, attachments SELECT). The
-- function returns true for admin, govt-in-scope, subject-pet-owner
-- (except welfare_denuncia), and per-kind parties (foster, org member,
-- applicant, dispute party).
--
-- Drizzle (server-side) bypasses RLS via the service role. These
-- policies guard PostgREST and any future RLS-aware reader.
--
-- Idempotent — safe to re-run.

-- ===========================================================================
-- Enable RLS on cases
-- ===========================================================================

alter table public.cases enable row level security;

-- ===========================================================================
-- can_read_case — expanded
-- ===========================================================================

create or replace function public.can_read_case(p_case_id uuid, p_user_id uuid)
  returns boolean
  language plpgsql
  stable
  security definer
as $$
declare
  c record;
begin
  if p_case_id is null or p_user_id is null then
    return false;
  end if;

  select * into c from public.cases where id = p_case_id;
  if not found then
    return false;
  end if;

  -- Admin: universal scope. An erased profile (deleted_at, art. 16) is not an
  -- admin, and neither is a deactivated one — migration 0215.
  if exists (
    select 1 from public.profiles
    where id = p_user_id
      and role = 'admin'
      and deactivated_at is null
      and deleted_at is null
  ) then
    return true;
  end if;

  -- Govt: jurisdiction-scoped. An erased profile is not a govt operator
  -- either — migration 0216.
  if exists (
    select 1
    from public.profiles p
    inner join public.govt_assignments ga on ga.user_id = p.id
    where p.id = p_user_id
      and p.role = 'govt'
      and p.deactivated_at is null
      and p.deleted_at is null
      and ga.revoked_at is null
      and ga.jurisdiction_province = c.jurisdiction_province
      and ga.jurisdiction_locality = c.jurisdiction_locality
  ) then
    return true;
  end if;

  if c.primary_pet_id is not null and exists (
    select 1
    from public.ownerships o
    where o.pet_id = c.primary_pet_id
      and o.ended_at is null
      and o.role = 'owner'
      and o.owner_user_id = p_user_id
  ) then
    if c.case_kind = 'welfare_denuncia' then
      return false;
    end if;
    return true;
  end if;

  if c.case_kind = 'adoption_application' then
    return c.applicant_user_id = p_user_id;
  end if;

  if c.case_kind = 'adoption_listing' and c.opened_by_organization_id is not null then
    return exists (
      select 1 from public.organization_memberships m
      where m.organization_id = c.opened_by_organization_id
        and m.user_id = p_user_id
        and m.left_at is null
    );
  end if;

  if c.case_kind = 'foster_placement' then
    if c.primary_pet_id is not null and exists (
      select 1 from public.ownerships o
      where o.pet_id = c.primary_pet_id
        and o.role = 'foster'
        and o.ended_at is null
        and o.owner_user_id = p_user_id
    ) then
      return true;
    end if;
    if c.opened_by_organization_id is not null and exists (
      select 1 from public.organization_memberships m
      where m.organization_id = c.opened_by_organization_id
        and m.user_id = p_user_id
        and m.left_at is null
    ) then
      return true;
    end if;
    return false;
  end if;

  if c.case_kind = 'custody_dispute' and c.custody_dispute_id is not null then
    return exists (
      select 1 from public.custody_dispute_parties cdp
      where cdp.dispute_id = c.custody_dispute_id
        and (
          cdp.party_user_id = p_user_id
          or (cdp.party_organization_id is not null and cdp.party_organization_id in (
            select m.organization_id from public.organization_memberships m
            where m.user_id = p_user_id and m.left_at is null
          ))
        )
    );
  end if;

  return false;
end;
$$;

-- ===========================================================================
-- cases SELECT — delegate to can_read_case
-- ===========================================================================

drop policy if exists cases_select_subject_owner on public.cases;
drop policy if exists cases_select_admin on public.cases;
drop policy if exists cases_select_visible on public.cases;

create policy cases_select_visible on public.cases for select
  using (public.can_read_case(id, auth.uid()));

-- No INSERT / UPDATE / DELETE policies at this stage — every writer goes
-- through Drizzle on the server which bypasses RLS via service role.
