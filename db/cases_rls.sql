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

-- Body kept byte-identical to the LAST defining migration (0281 at the time
-- of writing): scripts/deploy-provision.ts applies this file AFTER the
-- migration replay, so an older body here would silently replace the live one
-- on every fresh provision (it did: until 0281 this file still carried the
-- 0094-era body, without govt_scope or `SET search_path = ''`).
create or replace function public.can_read_case(p_case_id uuid, p_user_id uuid)
  returns boolean
  language plpgsql
  stable
  security definer
  set search_path = ''
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

  -- Govt: what the operator's ACTIVE grants cover, from public.govt_scope
  -- (localidades-por-id D8, migration 0259). A legacy grant (no authority
  -- unit) keeps 0241's name match, whole-province sentinel included; a
  -- provincial unit covers its province, unresolved cases included; any other
  -- unit covers its active member localities by id. An erased profile is not
  -- a govt operator either — migration 0216.
  if exists (
    select 1
    from public.profiles p
    cross join lateral public.govt_scope(p.id) s
    where p.id = p_user_id
      and p.role = 'govt'
      and p.deactivated_at is null
      and p.deleted_at is null
      and (
        (s.source = 'legacy'
          and s.jurisdiction_province = c.jurisdiction_province
          and (
            s.jurisdiction_locality = c.jurisdiction_locality
            or s.jurisdiction_locality = ''
            or (s.jurisdiction_province = 'CABA'
              and s.jurisdiction_locality = 'Ciudad Autónoma de Buenos Aires')
          ))
        or (s.source = 'province'
          and s.province_code = public.ar_province_code(c.jurisdiction_province))
        or (s.source = 'locality'
          and s.locality_id = c.locality_id)
      )
  ) then
    return true;
  end if;

  -- Subject-pet owner — except welfare_denuncia, where the owner is the
  -- subject of the investigation and must not see the case.
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

  -- Per-kind extensions.
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
    -- (a) the active foster user, OR (b) members of the org that opened the case.
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

  -- custody_transfer_handshake — the two organization parties the handshake's
  -- notifications are addressed to: the sending org (opened_by_organization_id)
  -- and the receiving org (receiver_organization_id, the column the accept
  -- path authorizes against). Active ADMINS and COORDINATORS only — the roles
  -- those writers notify (S2, PO confirmation pending). Migration 0281.
  if c.case_kind = 'custody_transfer_handshake' then
    return exists (
      select 1 from public.organization_memberships m
      where m.user_id = p_user_id
        and m.left_at is null
        and m.role in ('admin', 'coordinator')
        and m.organization_id in (c.opened_by_organization_id, c.receiver_organization_id)
    );
  end if;

  -- custody_episode — the receiving org of a decomiso handoff
  -- (receiver_organization_id). The opening govt org reads through the
  -- govt_scope branch above; a reassigned-away receiver no longer matches.
  -- Admins and coordinators only (S2, PO confirmation pending). Migration 0281.
  if c.case_kind = 'custody_episode' and c.receiver_organization_id is not null then
    return exists (
      select 1 from public.organization_memberships m
      where m.organization_id = c.receiver_organization_id
        and m.user_id = p_user_id
        and m.left_at is null
        and m.role in ('admin', 'coordinator')
    );
  end if;

  -- bite_incident already covered above via subject-pet owner.
  -- lost_pet_episode: same.
  -- Anything else: deny.
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
