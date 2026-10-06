-- Migration 0281 — can_read_case admits the organization parties of a
-- custody_transfer_handshake and the receiving organization of a decomiso
-- custody_episode (notificaciones-destinos, 2026-10).
--
-- THE DEFECT
-- ---------------------------------------------------------------------------
-- Cross-org transfer notifications (cross_org_transfer_proposed_receiver,
-- _proposed_sender, _accepted_*, _rejected_sender, _expired_*) and the decomiso
-- handoff proposal (decomiso_handoff_proposed_receiver, _accepted_receiver)
-- link /casos/{code} for members of the organizations involved. Neither
-- lib/infra/case-access.ts canReadCase nor this function had an arm for those
-- kinds, so every one of those links answered notFound() — audit 2026-10-06
-- (engram notifications/destinations-audit). Precedent: the custody_dispute org
-- arm (case-access.ts, closing the same TS/SQL drift from the other side).
--
-- THE CHANGE — only parties the notifications are addressed to
-- ---------------------------------------------------------------------------
--   custody_transfer_handshake  active members of opened_by_organization_id
--                               (sender) or receiver_organization_id (receiver)
--   custody_episode             active members of receiver_organization_id
--                               (the shelter the authority handed the animal to)
--
-- NOT in this change, deliberately (PO / legal decision pending): the org that
-- OPENED a welfare_denuncia, and a co_owner on any case. The notification
-- resolver explains those refusals instead of widening them.
--
-- Everything else is 0259's body VERBATIM: the admin and govt_scope branches,
-- the subject-owner branch, the per-kind arms, SECURITY DEFINER,
-- `SET search_path = ''` and the ACL (CREATE OR REPLACE keeps grants).
-- scripts/check-function-parity.ts compares prosrc against the LAST defining
-- migration — this file now — so the body below is what must be live.
--
-- db/cases_rls.sql, which scripts/deploy-provision.ts applies AFTER the replay,
-- carries the same body: a provision must not put an older function back.
--
-- Mirrored in TypeScript by lib/infra/case-access.ts canReadCase (same commit).
-- Forward-only and idempotent. Behavioural fence:
-- __tests__/notification-target-matrix.test.ts.

BEGIN;

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
  -- path authorizes against). Active members only. Migration 0281.
  if c.case_kind = 'custody_transfer_handshake' then
    return exists (
      select 1 from public.organization_memberships m
      where m.user_id = p_user_id
        and m.left_at is null
        and m.organization_id in (c.opened_by_organization_id, c.receiver_organization_id)
    );
  end if;

  -- custody_episode — the receiving org of a decomiso handoff
  -- (receiver_organization_id). The opening govt org reads through the
  -- govt_scope branch above; a reassigned-away receiver no longer matches.
  -- Migration 0281.
  if c.case_kind = 'custody_episode' and c.receiver_organization_id is not null then
    return exists (
      select 1 from public.organization_memberships m
      where m.organization_id = c.receiver_organization_id
        and m.user_id = p_user_id
        and m.left_at is null
    );
  end if;

  -- bite_incident already covered above via subject-pet owner.
  -- lost_pet_episode: same.
  -- Anything else: deny.
  return false;
end;
$$;

-- ---------------------------------------------------------------------------
-- Post-condition: ask the catalog ("aplicada no es cerrada").
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'can_read_case'
      AND p.prosecdef
      AND p.proconfig @> ARRAY['search_path=""']
      AND p.prosrc LIKE '%public.govt_scope(p.id) s%'
      AND p.prosrc LIKE '%and p.deleted_at is null%'
      AND p.prosrc LIKE '%c.case_kind = ''custody_transfer_handshake''%'
      AND p.prosrc LIKE '%m.organization_id in (c.opened_by_organization_id, c.receiver_organization_id)%'
      AND p.prosrc LIKE '%c.case_kind = ''custody_episode'' and c.receiver_organization_id is not null%'
      AND p.prosrc LIKE '%cdp.party_organization_id%'
  ) THEN
    RAISE EXCEPTION 'Migration 0281 did not close: public.can_read_case lacks the custody_transfer_handshake / custody_episode org arms, the govt_scope branch, SECURITY DEFINER or search_path = ''''';
  END IF;
END
$$;

COMMIT;
