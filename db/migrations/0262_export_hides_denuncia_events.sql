-- Migration 0262 — "Descargar mis datos" no longer hands a denunciado the
-- denuncia filed against them.
--
-- THE DEFECT (privacy audit C1, verified against the live database)
-- ---------------------------------------------------------------------------
-- export_subject_data is SECURITY DEFINER, so the RLS hide 0115 puts on
-- pet_events (an event on a welfare_denuncia case is invisible to the pet's
-- owner) never applies inside it. Its 'pet_events' branch returned
-- row_to_json(ev) for EVERY event on the caller's owned pets — including the
-- welfare bridge events (maltreatment_reported / abandonment_reported /
-- symptom_observed) that create-welfare-report writes with the reporter as
-- recordedByUserId, the relato and the exact point. The subject of a denuncia
-- could read who reported them, and where from, through their own art. 14
-- export: the art. 17 reserve of the reporter, broken.
--
-- THE FIX
-- ---------------------------------------------------------------------------
-- 0245's definition VERBATIM, with one predicate added to that branch:
--   AND (ev.case_id IS NULL OR NOT public.is_hidden_from_subject_case(ev.case_id))
-- — the helper 0115 uses (a case is hidden when case_kind = 'welfare_denuncia').
-- The bridge events carry the denuncia case id (create-welfare-report sets
-- caseId on all three), so this is exactly the rows RLS already hides. Every
-- other event the owner has stays in the export. Nothing else changes; the
-- ACL lines are re-stated as 0245 had them.
--
-- scripts/check-function-parity.ts compares prosrc against the LAST defining
-- migration — this file now; the body below is what is applied, comment
-- included.
--
-- Forward-only. Rollback: a forward migration restoring 0245's body.

BEGIN;

CREATE OR REPLACE FUNCTION public.export_subject_data(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pii, pg_temp
AS $$
DECLARE
  result jsonb;
BEGIN
  IF auth.uid() IS NULL OR (auth.uid() <> p_user_id AND NOT pii.caller_is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'profile', (
      SELECT row_to_json(p)::jsonb
        FROM public.profiles p
       WHERE p.id = p_user_id
    ),
    'pets', COALESCE((
      SELECT jsonb_agg(row_to_json(pe)::jsonb)
        FROM public.pets pe
        JOIN public.ownerships o ON o.pet_id = pe.id
       WHERE o.owner_user_id = p_user_id
         AND o.ended_at IS NULL
         AND pe.deleted_at IS NULL
    ), '[]'::jsonb),
    'identifications', COALESCE((
      SELECT jsonb_agg(row_to_json(pi)::jsonb)
        FROM public.pet_identifications pi
        JOIN public.ownerships o ON o.pet_id = pi.pet_id
       WHERE o.owner_user_id = p_user_id
         AND o.ended_at IS NULL
         AND pi.deleted_at IS NULL
    ), '[]'::jsonb),
    'pet_events', COALESCE((
      SELECT jsonb_agg(row_to_json(ev)::jsonb)
        FROM public.pet_events ev
        JOIN public.ownerships o ON o.pet_id = ev.pet_id
       WHERE o.owner_user_id = p_user_id
         AND o.ended_at IS NULL
         -- 0262: the same hide as the 0115 RLS policy. An event on a denuncia
         -- case (the welfare bridge events: relato, exact point, reporter)
         -- is not the owner's to download (art. 17 reporter reserve).
         AND (ev.case_id IS NULL OR NOT public.is_hidden_from_subject_case(ev.case_id))
    ), '[]'::jsonb),
    -- art. 14 additions: relations the subject is directly party to. -----------
    -- Welfare reports the subject FILED (reporter_user_id). Self-identifying PII
    -- in description/contact fields is their own data.
    'welfare_reports_filed', COALESCE((
      SELECT jsonb_agg(row_to_json(wr)::jsonb)
        FROM public.welfare_reports wr
       WHERE wr.reporter_user_id = p_user_id
    ), '[]'::jsonb),
    -- Custody disputes the subject is party to — either raised by them or listed
    -- as a party. Distinct on dispute id so a self-raised + self-party dispute
    -- is not duplicated.
    'custody_disputes', COALESCE((
      SELECT jsonb_agg(row_to_json(cd)::jsonb)
        FROM public.custody_disputes cd
       WHERE cd.deleted_at IS NULL
         AND (
           cd.raised_by_user_id = p_user_id
           OR EXISTS (
             SELECT 1 FROM public.custody_dispute_parties cdp
              WHERE cdp.dispute_id = cd.id
                AND cdp.party_user_id = p_user_id
           )
         )
    ), '[]'::jsonb),
    -- Pet transfers the subject initiated (from_owner_id) or is the target of
    -- (to_owner_id, or to_owner_email matching their auth email).
    'pet_transfers', COALESCE((
      SELECT jsonb_agg(row_to_json(pt)::jsonb)
        FROM public.pet_transfers pt
       WHERE pt.from_owner_id = p_user_id
          OR pt.to_owner_id = p_user_id
          OR pt.to_owner_email = (SELECT u.email FROM auth.users u WHERE u.id = p_user_id)
    ), '[]'::jsonb),
    -- Physical tags (migration 0170): rows the subject activated or revoked,
    -- plus tags on pets they currently own. activation_code_hash is EXCLUDED —
    -- the app never reads it back and neither may the export.
    'pet_tags', COALESCE((
      SELECT jsonb_agg(row_to_json(tg)::jsonb - 'activation_code_hash')
        FROM public.pet_tags tg
       WHERE tg.activated_by_user_id = p_user_id
          OR tg.revoked_by_user_id = p_user_id
          OR tg.pet_id IN (
            SELECT o.pet_id FROM public.ownerships o
             WHERE o.owner_user_id = p_user_id
               AND o.ended_at IS NULL
          )
    ), '[]'::jsonb),
    -- Temporary-caretaker grants (migration 0205). The same triple predicate
    -- pet_transfers uses above, for the same reason: the subject may be the
    -- GRANTOR, the invitee BY ACCOUNT, or the invitee BY EMAIL — an invitation
    -- can be addressed to somebody who has no account at all.
    --
    -- Both parties get the whole row, including the counterparty's identifier:
    -- when the subject is the invitee, `granted_by_user_id` is an opaque uuid
    -- (exactly what pet_transfers already returns for from_owner_id); when the
    -- subject is the grantor, `caretaker_email` is an address THEY typed, which
    -- their own caretaker panel already shows them (AGENTS.md §6b).
    'pet_caretaker_grants', COALESCE((
      SELECT jsonb_agg(row_to_json(g)::jsonb)
        FROM public.pet_caretaker_grants g
       WHERE g.granted_by_user_id = p_user_id
          OR g.caretaker_user_id = p_user_id
          OR lower(g.caretaker_email) = lower((SELECT u.email FROM auth.users u WHERE u.id = p_user_id))
    ), '[]'::jsonb),
    -- Foster-volunteer enrolment (migration 0205). One row per user, entirely
    -- self-reported: the subject's OWN declared jurisdiction, what they will
    -- take in, the household composition, and free-text notes.
    'foster_volunteers', COALESCE((
      SELECT jsonb_agg(row_to_json(fv)::jsonb)
        FROM public.foster_volunteers fv
       WHERE fv.user_id = p_user_id
    ), '[]'::jsonb),
    -- Contact / volunteer messages the subject sent to an organization
    -- (migration 0205). Keyed on the email because the sender needs no account.
    -- submitter_ip IS returned: it is the subject's own IP, held about them,
    -- and art. 14 is the right to be told what we hold — not a place to be
    -- discreet about our own retention.
    'org_contact_messages', COALESCE((
      SELECT jsonb_agg(row_to_json(ocm)::jsonb)
        FROM public.org_contact_messages ocm
       WHERE lower(ocm.inquirer_email) = lower((SELECT u.email FROM auth.users u WHERE u.id = p_user_id))
    ), '[]'::jsonb),
    -- Web Push registrations (migration 0205). erase_subject_data has DELETED
    -- these since 0166 while art. 14 never returned them — the subject could
    -- not see what art. 16 was about to destroy. p256dh + auth are EXCLUDED
    -- (RFC 8291 content-encryption keys; same move 0170 made for
    -- activation_code_hash), which leaves the endpoint unable to deliver
    -- anything a browser would accept.
    'push_subscriptions', COALESCE((
      SELECT jsonb_agg(row_to_json(ps)::jsonb - 'p256dh' - 'auth')
        FROM public.push_subscriptions ps
       WHERE ps.user_id = p_user_id
    ), '[]'::jsonb),
    -- Native push targets (migration 0222). The art. 14 half of the same pair
    -- 0208 closed for push_subscriptions: erase_subject_data deletes these
    -- below, so the subject must be able to SEE what art. 16 is about to
    -- destroy.
    --
    -- `expo_push_token` IS EXCLUDED, and the reason differs from the web row's
    -- exclusions above. There, p256dh + auth are dropped and `endpoint` is kept
    -- because an endpoint without its content-encryption keys cannot deliver
    -- anything a browser would accept. An Expo token has no such second factor:
    -- it IS the deliverable address, and anyone holding it plus a project
    -- access token can push to that lock screen. Returning it would put a live
    -- delivery credential into a file the subject may forward by email. What
    -- art. 14 needs is that the subject can see a device is registered and
    -- since when — device_id, platform, app_version and the timestamps carry
    -- that without carrying the credential.
    'push_targets', COALESCE((
      SELECT jsonb_agg(row_to_json(pt)::jsonb - 'expo_push_token')
        FROM public.push_targets pt
       WHERE pt.user_id = p_user_id
    ), '[]'::jsonb),
    -- Operator feed watermark (migration 0208). At most ONE row — user_id is
    -- the primary key. It is the subject's own reading position on the /gob
    -- and /admin "Novedades" feed, and erase_subject_data DELETES it below;
    -- returning it here is the art. 14 half that push_subscriptions went
    -- without between 0166 and 0205.
    'operator_feed_watermarks', COALESCE((
      SELECT jsonb_agg(row_to_json(w)::jsonb)
        FROM public.operator_feed_watermarks w
       WHERE w.user_id = p_user_id
    ), '[]'::jsonb),
    -- user_surface_visits (migration 0245, T4-O3). Per-user "have you visited
    -- this /gob screen" watermark backing the first-run onboarding checklist.
    -- Same shape as operator_feed_watermarks immediately above: at most a
    -- handful of rows (one per tracked surface), DELETED by erase_subject_data
    -- below, so art. 14 returns them first.
    'user_surface_visits', COALESCE((
      SELECT jsonb_agg(row_to_json(v)::jsonb)
        FROM public.user_surface_visits v
       WHERE v.user_id = p_user_id
    ), '[]'::jsonb),
    -- Physical-tag interest (migration 0208). The subject's own demand signal
    -- per pet, including the free-text `notes` they typed. Deleted by
    -- erase_subject_data below, so art. 14 must show it first.
    'physical_tag_interest', COALESCE((
      SELECT jsonb_agg(row_to_json(ti)::jsonb)
        FROM public.physical_tag_interest ti
       WHERE ti.user_id = p_user_id
    ), '[]'::jsonb),
    -- Organization invitations (migration 0208). Three predicates because the
    -- subject can stand in three places: the INVITEE BY EMAIL (who may have no
    -- account at all), the INVITEE BY ACCOUNT once they accepted
    -- (accepted_by_user_id), or the INVITER (invited_by_user_id).
    --
    -- `invitation_token` is EXCLUDED — a live bearer credential, and this RPC
    -- is callable by an admin over another subject. Same exclusion as
    -- activation_code_hash (0170) and p256dh / auth (0205).
    'organization_invitations', COALESCE((
      SELECT jsonb_agg(row_to_json(oi)::jsonb - 'invitation_token')
        FROM public.organization_invitations oi
       WHERE oi.invited_by_user_id = p_user_id
          OR oi.accepted_by_user_id = p_user_id
          OR lower(oi.email) = lower((SELECT u.email FROM auth.users u WHERE u.id = p_user_id))
    ), '[]'::jsonb),
    -- Notifications addressed to the subject.
    'notifications', COALESCE((
      SELECT jsonb_agg(row_to_json(n)::jsonb)
        FROM public.notifications n
       WHERE n.user_id = p_user_id
    ), '[]'::jsonb),
    -- Organization memberships the subject holds (active + historical).
    'organization_memberships', COALESCE((
      SELECT jsonb_agg(row_to_json(om)::jsonb)
        FROM public.organization_memberships om
       WHERE om.user_id = p_user_id
    ), '[]'::jsonb),
    -- Audit rows where the subject is the actor or the target — personal data
    -- "held about the subject" in the sense of art. 14.
    'audit_log', COALESCE((
      SELECT jsonb_agg(row_to_json(al)::jsonb)
        FROM public.audit_log al
       WHERE al.actor_user_id = p_user_id
          OR al.target_user_id = p_user_id
    ), '[]'::jsonb),
    'schema_version', 5,
    'exported_at', now(),
    'exported_under', 'Ley 25.326 art. 14',
    'subject_user_id', p_user_id
  ) INTO result;

  -- Audit. Actor is the caller; target is the subject.
  INSERT INTO public.audit_log (actor_user_id, action, target_user_id, payload)
  VALUES (
    auth.uid(),
    'subject_data_exported',
    p_user_id,
    jsonb_build_object(
      'norma', 'Ley 25.326 art. 14',
      'self_export', auth.uid() = p_user_id
    )
  );

  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.export_subject_data(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.export_subject_data(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.export_subject_data(uuid) TO authenticated;

-- Post-condition: the live body carries the hide, and is still SECURITY DEFINER.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'export_subject_data'
       AND p.prosecdef
       AND p.prosrc LIKE '%AND (ev.case_id IS NULL OR NOT public.is_hidden_from_subject_case(ev.case_id))%'
  ) THEN
    RAISE EXCEPTION 'Migration 0262 did not close: export_subject_data lacks the denuncia hide on pet_events';
  END IF;
END
$$;

COMMIT;
