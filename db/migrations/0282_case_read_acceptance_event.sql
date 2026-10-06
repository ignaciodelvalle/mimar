-- Migration 0282 — can_read_case reads ACCEPTANCE from the acceptance event,
-- not from a 'resolved' close (notificaciones-destinos, final security review
-- F1, 2026-10-06).
--
-- THE DEFECT IN 0281
-- ---------------------------------------------------------------------------
-- 0281 admitted a hand-off org party after acceptance, and read "accepted" as
-- `status = 'closed' and closed_reason = 'resolved'`. For a custody_episode
-- that is false: return-custody-to-owner and adoption-finalize close the
-- episode as 'resolved' WITHOUT clearing receiver_organization_id, so a
-- proposed shelter that never accepted would read the case — and, through the
-- pet_events / attachments RLS that delegates here, its raw notes, payloads
-- (judicial reference, seizure detail, to_user_id) and evidence.
--
-- THE CHANGE
-- ---------------------------------------------------------------------------
-- Both 0281 arms now require the ACCEPTANCE EVENT itself, a custody_transferred
-- pet_event on THIS case addressed to the receiver:
--   custody_episode             payload reason = 'org_to_org_handoff' and
--                               to_organization_id = receiver_organization_id
--                               (accept-decomiso-handoff)
--   custody_transfer_handshake  to_organization_id = receiver_organization_id
--                               (accept-cross-org-transfer; its reason is the
--                               proposal's, so it is not matched)
-- Events are append-only, so no later close can undo or fake it. Everything
-- else is 0281's body VERBATIM — the admin/coordinator role filter, the
-- TS/SQL divergence its header documents (TS admits before acceptance with
-- notes and payloads withheld; SQL only after), the absent welfare_denuncia
-- opening-org arm (PO 2026-10-06, TS only), SECURITY DEFINER and
-- `SET search_path = ''` (CREATE OR REPLACE keeps the ACL).
--
-- The same predicate in TypeScript: lib/infra/case-access.ts handoffAccepted.
-- scripts/check-function-parity.ts compares prosrc against the LAST defining
-- migration — this file now — and db/cases_rls.sql carries the same body.
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
  -- path authorizes against). Active ADMINS and COORDINATORS only — the roles
  -- those writers notify (S2, PO confirmation pending). Migration 0281.
  -- Admitted only AFTER acceptance, read from the acceptance itself: the
  -- custody_transferred event accept-cross-org-transfer writes on THIS case to
  -- the receiver. Migration 0282 (a 'resolved' close is not acceptance).
  if c.case_kind = 'custody_transfer_handshake' then
    return exists (
      select 1 from public.pet_events pe
      where pe.case_id = c.id
        and pe.event_type = 'custody_transferred'
        and pe.payload->>'to_organization_id' = c.receiver_organization_id::text
    ) and exists (
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
  -- Admitted only AFTER acceptance: the custody_transferred event
  -- accept-decomiso-handoff writes on THIS episode to the receiver, reason
  -- 'org_to_org_handoff'. return-custody-to-owner and adoption-finalize close
  -- the episode as 'resolved' too, and must not open it. Migration 0282.
  if c.case_kind = 'custody_episode' and c.receiver_organization_id is not null then
    return exists (
      select 1 from public.pet_events pe
      where pe.case_id = c.id
        and pe.event_type = 'custody_transferred'
        and pe.payload->>'reason' = 'org_to_org_handoff'
        and pe.payload->>'to_organization_id' = c.receiver_organization_id::text
    ) and exists (
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
      AND p.prosrc LIKE '%m.role in (''admin'', ''coordinator'')%'
      AND p.prosrc LIKE '%pe.payload->>''reason'' = ''org_to_org_handoff''%'
      AND p.prosrc LIKE '%pe.payload->>''to_organization_id'' = c.receiver_organization_id::text%'
      AND p.prosrc NOT LIKE '%c.closed_reason = ''resolved'' and exists%'
  ) THEN
    RAISE EXCEPTION 'Migration 0282 did not close: public.can_read_case still reads acceptance from a resolved close, or lost the govt_scope branch, the role filter, SECURITY DEFINER or search_path = ''''';
  END IF;
END
$$;

COMMIT;
