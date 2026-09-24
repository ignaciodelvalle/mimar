-- Cases system — Fase F. Full per-kind RLS.
--
-- Replaces the Fase A shell (cases_rls.sql) with the production rules.
-- After this migration:
--   - `can_read_case(case_id, user_id)` returns true for admin, govt-in-
--     scope, subject-pet-owner (except welfare_denuncia), and per-kind
--     parties (foster, org member, applicant, dispute party).
--   - `cases` SELECT policy delegates to `can_read_case`.
--   - `pet_events` SELECT policy gains an OR branch via `can_read_case`
--     so case-attached events surface to case participants who aren't
--     the pet owner (e.g. a dispute party).
--   - `attachments` SELECT policy gains the same OR branch.
--
-- Drizzle bypasses RLS via the service role. These policies guard
-- PostgREST and any future RLS-aware reader.
--
-- Idempotent — safe to re-run.

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

  -- Admin: universal scope.
  if exists (
    select 1 from public.profiles
    where id = p_user_id and role = 'admin' and deactivated_at is null
  ) then
    return true;
  end if;

  -- Govt: jurisdiction-scoped match against active govt_assignments. A
  -- govt user sees the case when (province, locality) match AT LEAST one
  -- of their assigned scopes.
  if exists (
    select 1
    from public.profiles p
    inner join public.govt_assignments ga on ga.user_id = p.id
    where p.id = p_user_id
      and p.role = 'govt'
      and p.deactivated_at is null
      and ga.revoked_at is null
      and ga.jurisdiction_province = c.jurisdiction_province
      and ga.jurisdiction_locality = c.jurisdiction_locality
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

  -- bite_incident already covered above via subject-pet owner.
  -- lost_pet_episode: same.
  -- Anything else: deny.
  return false;
end;
$$;

-- ===========================================================================
-- cases SELECT — single composed policy
-- ===========================================================================

drop policy if exists cases_select_subject_owner on public.cases;
drop policy if exists cases_select_admin on public.cases;
drop policy if exists cases_select_visible on public.cases;

create policy cases_select_visible on public.cases for select
  using (public.can_read_case(id, auth.uid()));

-- ===========================================================================
-- pet_events SELECT — extend with case visibility
-- ===========================================================================
-- Current policy (from db/rls.sql) only allows the active owner. Extend
-- so a non-owner who legitimately can read the case (foster, dispute
-- party, govt-in-scope, etc.) also sees the case-attached events.

drop policy if exists "Pet events readable by active owner" on public.pet_events;
create policy "Pet events readable by active owner"
  on public.pet_events
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.ownerships o
      where o.pet_id = pet_events.pet_id
        and o.owner_user_id = auth.uid()
        and o.ended_at is null
    )
    or (
      pet_events.case_id is not null
      and public.can_read_case(pet_events.case_id, auth.uid())
    )
  );

-- ===========================================================================
-- attachments SELECT — extend with case visibility
-- ===========================================================================

drop policy if exists "Attachments readable by pet owner" on public.attachments;
create policy "Attachments readable by pet owner"
  on public.attachments
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.ownerships o
      where o.owner_user_id = auth.uid()
        and o.ended_at is null
        and (
          o.pet_id = attachments.pet_id
          or o.pet_id = (
            select pe.pet_id from public.pet_events pe where pe.id = attachments.event_id
          )
        )
    )
    or exists (
      select 1 from public.pet_events pe
      where pe.id = attachments.event_id
        and pe.case_id is not null
        and public.can_read_case(pe.case_id, auth.uid())
    )
  );
