-- Migration 0170 — subject-rights RPCs learn about pet_tags (0169).
-- (physical-tag-lifecycle; Ley 25.326 arts. 14 y 16.)
--
-- THE GAP
-- -------
-- pet_tags (0169) carries two user-referencing FKs — activated_by_user_id and
-- revoked_by_user_id — that the erasure path never touched, and tag rows the
-- subject can manage that the access path never returned.
--
-- THE FIX
-- -------
--   · export_subject_data: adds a `pet_tags` section — rows the subject
--     activated/revoked or that sit on a pet they currently own. The
--     activation_code_hash column is EXCLUDED from the projection: the app
--     never SELECTs it back (tag-lookup.ts compares inside SQL predicates)
--     and the export must not become the one read path that does.
--     schema_version bumps 2 → 3.
--   · erase_subject_data: NULLs both FKs where they reference the subject and
--     counts the touched rows as `pet_tags_scrubbed` in the subject_erasure
--     audit payload. The rows themselves REMAIN (serial, status, pet linkage):
--     a revoked tag's lifecycle is the pet's operational history, not the
--     erased user's PII — the FK was the only personal data on the row.
--
-- IDEMPOTENCY: a re-run finds no rows (FKs already NULL) and counts zero.
-- pet_tags has no append-only trigger, so no override window is needed.
--
-- Everything else in both functions is copied verbatim from their previous
-- definitions (export: 0087; erase: 0166). Forward-only CREATE OR REPLACE.
-- search_path pinned (0114); grants re-asserted after each replace.

BEGIN;

-- ============================================================================
-- A — export_subject_data: art. 14 access, now including pet_tags
-- ============================================================================

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
    'schema_version', 3,
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

-- ============================================================================
-- B — erase_subject_data: art. 16 suppression, now scrubbing pet_tags FKs
-- ============================================================================

CREATE OR REPLACE FUNCTION public.erase_subject_data(p_user_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pii, pg_temp
AS $$
DECLARE
  pets_marked              int;
  events_redacted          int := 0;
  free_text_events_redacted int := 0;
  cases_redacted           int := 0;
  dispute_parties_scrubbed int := 0;
  notifs_scrubbed          int := 0;
  push_subs_deleted        int := 0;
  pet_tags_scrubbed        int := 0;
  subject_email            text;
BEGIN
  IF auth.uid() IS NULL OR (auth.uid() <> p_user_id AND NOT pii.caller_is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT u.email INTO subject_email FROM auth.users u WHERE u.id = p_user_id;

  -- Profile: hash display_name, null every direct + third-party PII column.
  UPDATE public.profiles
     SET display_name             = 'erased:' || md5(id::text),
         phone                    = NULL,
         dni_hash                 = NULL,
         dni_last4                = NULL,
         miarg_sub                = NULL,
         identity_source          = 'legacy',
         dni_verified             = false,
         dni_verified_at          = NULL,
         emergency_contact_name   = NULL,
         emergency_contact_phone  = NULL,
         preferred_vet_name       = NULL,
         preferred_vet_phone      = NULL,
         avatar_url               = NULL,
         matricula_number         = NULL,
         matricula_jurisdiccion   = NULL,
         deleted_at               = now(),
         updated_at               = now()
   WHERE id = p_user_id;

  -- Owned pets → soft-delete (sanitary events on them are retained). role =
  -- 'owner' is load-bearing: a foster/caretaker row carries the same
  -- owner_user_id, and erasing a helper's account must NOT soft-delete the real
  -- owner's pet (adversarial-review MED).
  WITH affected AS (
    UPDATE public.pets
       SET deleted_at = now(),
           updated_at = now()
     WHERE id IN (
       SELECT pet_id FROM public.ownerships
        WHERE owner_user_id = p_user_id
          AND role = 'owner'
          AND ended_at IS NULL
     )
       AND deleted_at IS NULL
    RETURNING id
  )
  SELECT count(*) INTO pets_marked FROM affected;

  -- ------------------------------------------------------------------------
  -- Append-only event tables (pet_events + case_events) — open ONE override
  -- window for both, then close it. Each redacted row emits its own
  -- *_mutation_override audit row via the append-only trigger.
  -- ------------------------------------------------------------------------
  PERFORM set_config('app.allow_event_mutation', 'true', true);
  PERFORM set_config('app.allow_event_mutation_actor', auth.uid()::text, true);

  -- Third-party PII inside pet_events payloads (Wave D2, finding 27-#3). The
  -- ownership branch is scoped to role = 'owner' AND ended_at IS NULL so a
  -- foster/caretaker erasing does not redact PII on the OWNER's pet
  -- (adversarial-review MED). The recorded_by_user_id branch stays open — the
  -- subject's own authored payloads are always redactable.
  WITH redacted AS (
    UPDATE public.pet_events
       SET payload = payload - 'victim_contact_name' - 'victim_contact_phone'
     WHERE event_type = 'incident_reported'
       AND (payload ? 'victim_contact_name' OR payload ? 'victim_contact_phone')
       AND (
         recorded_by_user_id = p_user_id
         OR pet_id IN (
           SELECT pet_id FROM public.ownerships
            WHERE owner_user_id = p_user_id
              AND role = 'owner'
              AND ended_at IS NULL
         )
       )
    RETURNING id
  )
  SELECT count(*) INTO events_redacted FROM redacted;

  -- Free-text payload keys on the SUBJECT'S OWN pets' events (migration 0159,
  -- finding cursor privacy P6). Scoped to role = 'owner' pets only (same
  -- reasoning as above). Sentinel-replaces each known free-text key in place —
  -- never deletes the key — across ALL event types, not just incident_reported.
  WITH redacted AS (
    UPDATE public.pet_events
       SET payload =
             payload
             || CASE WHEN payload ? 'notes' AND payload->>'notes' <> '[dato removido]'
                     THEN jsonb_build_object('notes', '[dato removido]') ELSE '{}'::jsonb END
             || CASE WHEN payload ? 'description' AND payload->>'description' <> '[dato removido]'
                     THEN jsonb_build_object('description', '[dato removido]') ELSE '{}'::jsonb END
             || CASE WHEN payload ? 'context' AND payload->>'context' <> '[dato removido]'
                     THEN jsonb_build_object('context', '[dato removido]') ELSE '{}'::jsonb END
             || CASE WHEN payload ? 'location_description'
                          AND payload->>'location_description' <> '[dato removido]'
                     THEN jsonb_build_object('location_description', '[dato removido]')
                     ELSE '{}'::jsonb END
             || CASE WHEN payload ? 'reason' AND payload->>'reason' <> '[dato removido]'
                     THEN jsonb_build_object('reason', '[dato removido]') ELSE '{}'::jsonb END
             || CASE WHEN payload ? 'closure_notes' AND payload->>'closure_notes' <> '[dato removido]'
                     THEN jsonb_build_object('closure_notes', '[dato removido]') ELSE '{}'::jsonb END
             || CASE WHEN payload ? 'clinical_notes' AND payload->>'clinical_notes' <> '[dato removido]'
                     THEN jsonb_build_object('clinical_notes', '[dato removido]') ELSE '{}'::jsonb END
             || CASE WHEN payload ? 'response_notes' AND payload->>'response_notes' <> '[dato removido]'
                     THEN jsonb_build_object('response_notes', '[dato removido]') ELSE '{}'::jsonb END
             || CASE WHEN payload ? 'ineligible_reason_notes'
                          AND payload->>'ineligible_reason_notes' <> '[dato removido]'
                     THEN jsonb_build_object('ineligible_reason_notes', '[dato removido]')
                     ELSE '{}'::jsonb END
             -- Nested lost_description sub-object (status_changed, Fase 4):
             -- rebuild the WHOLE object in one shot so the three inner keys
             -- merge instead of clobbering each other.
             || CASE WHEN payload ? 'lost_description' AND payload->'lost_description' IS NOT NULL
                          AND (
                            (payload #>> '{lost_description,accessories_when_lost}' IS NOT NULL
                             AND payload #>> '{lost_description,accessories_when_lost}' <> '[dato removido]')
                            OR (payload #>> '{lost_description,behavior_notes}' IS NOT NULL
                                AND payload #>> '{lost_description,behavior_notes}' <> '[dato removido]')
                            OR (payload #>> '{lost_description,last_seen_context}' IS NOT NULL
                                AND payload #>> '{lost_description,last_seen_context}' <> '[dato removido]')
                          )
                     THEN jsonb_build_object(
                            'lost_description',
                            (payload->'lost_description')
                            || CASE WHEN payload #>> '{lost_description,accessories_when_lost}' IS NOT NULL
                                          AND payload #>> '{lost_description,accessories_when_lost}' <> '[dato removido]'
                                     THEN jsonb_build_object('accessories_when_lost', '[dato removido]')
                                     ELSE '{}'::jsonb END
                            || CASE WHEN payload #>> '{lost_description,behavior_notes}' IS NOT NULL
                                          AND payload #>> '{lost_description,behavior_notes}' <> '[dato removido]'
                                     THEN jsonb_build_object('behavior_notes', '[dato removido]')
                                     ELSE '{}'::jsonb END
                            || CASE WHEN payload #>> '{lost_description,last_seen_context}' IS NOT NULL
                                          AND payload #>> '{lost_description,last_seen_context}' <> '[dato removido]'
                                     THEN jsonb_build_object('last_seen_context', '[dato removido]')
                                     ELSE '{}'::jsonb END
                          )
                     ELSE '{}'::jsonb END
     WHERE pet_id IN (
       SELECT pet_id FROM public.ownerships
        WHERE owner_user_id = p_user_id
          AND role = 'owner'
          AND ended_at IS NULL
     )
       AND (
         (payload ? 'notes' AND payload->>'notes' <> '[dato removido]')
         OR (payload ? 'description' AND payload->>'description' <> '[dato removido]')
         OR (payload ? 'context' AND payload->>'context' <> '[dato removido]')
         OR (payload ? 'location_description' AND payload->>'location_description' <> '[dato removido]')
         OR (payload ? 'reason' AND payload->>'reason' <> '[dato removido]')
         OR (payload ? 'closure_notes' AND payload->>'closure_notes' <> '[dato removido]')
         OR (payload ? 'clinical_notes' AND payload->>'clinical_notes' <> '[dato removido]')
         OR (payload ? 'response_notes' AND payload->>'response_notes' <> '[dato removido]')
         OR (payload ? 'ineligible_reason_notes' AND payload->>'ineligible_reason_notes' <> '[dato removido]')
         OR (payload #>> '{lost_description,accessories_when_lost}' IS NOT NULL
             AND payload #>> '{lost_description,accessories_when_lost}' <> '[dato removido]')
         OR (payload #>> '{lost_description,behavior_notes}' IS NOT NULL
             AND payload #>> '{lost_description,behavior_notes}' <> '[dato removido]')
         OR (payload #>> '{lost_description,last_seen_context}' IS NOT NULL
             AND payload #>> '{lost_description,last_seen_context}' <> '[dato removido]')
       )
    RETURNING id
  )
  SELECT count(*) INTO free_text_events_redacted FROM redacted;

  -- Reporter-comment free text in case_events the SUBJECT authored (finding
  -- 27 re-audit). payload is a fixed {source:'reporter'} marker (no PII) — only
  -- the free-text `notes` carries identifying detail, so only it is redacted.
  WITH redacted AS (
    UPDATE public.case_events
       SET notes = '[contenido eliminado a pedido del titular]'
     WHERE entry_type = 'reporter_comment'
       AND recorded_by_user_id = p_user_id
       AND notes IS NOT NULL
       AND notes <> '[contenido eliminado a pedido del titular]'
    RETURNING id
  )
  SELECT count(*) INTO cases_redacted FROM redacted;

  -- Close the override immediately — the remaining statements must not run under
  -- an open mutation hatch.
  PERFORM set_config('app.allow_event_mutation', 'false', true);
  PERFORM set_config('app.allow_event_mutation_actor', '', true);

  -- ------------------------------------------------------------------------
  -- Ordinary tables (no append-only override needed).
  -- ------------------------------------------------------------------------

  -- The subject's own position statement in any custody dispute (finding 27-#4).
  -- The counterparty's party row and the official resolution_summary are left
  -- intact (their record / the case disposition).
  WITH scrubbed AS (
    UPDATE public.custody_dispute_parties
       SET party_position_summary = NULL
     WHERE party_user_id = p_user_id
       AND party_position_summary IS NOT NULL
    RETURNING id
  )
  SELECT count(*) INTO dispute_parties_scrubbed FROM scrubbed;

  -- The subject's own notifications — redact free-text title/body and drop the
  -- deep-link CTA (may embed pet tokens). notification_type is kept (non-PII
  -- routing key). title is NOT NULL, so redact to a sentinel rather than null.
  WITH scrubbed AS (
    UPDATE public.notifications
       SET title     = '[eliminado]',
           body      = '[contenido eliminado a pedido del titular]',
           cta_label = NULL,
           cta_url   = NULL
     WHERE user_id = p_user_id
       AND title <> '[eliminado]'
    RETURNING id
  )
  SELECT count(*) INTO notifs_scrubbed FROM scrubbed;

  -- Web Push registrations (migration 0166, PRIV-1). Endpoint + p256dh + auth
  -- + user_agent are device-identifying data with no residual non-PII value, so
  -- the rows are DELETED outright rather than redacted. The profiles cascade the
  -- 0152 schema comment relies on never fires: the profile is soft-deleted here
  -- and the auth.users row (deleted by the caller afterwards) has no FK to it.
  WITH removed AS (
    DELETE FROM public.push_subscriptions
     WHERE user_id = p_user_id
    RETURNING id
  )
  SELECT count(*) INTO push_subs_deleted FROM removed;

  -- Physical tags (migration 0170): NULL the subject's actor FKs. The rows
  -- stay — serial, status and pet linkage are the PET's operational history
  -- (the tag itself outlives the account); the FK was the only personal data.
  -- Both columns are ON DELETE SET NULL already, but nothing ever hard-deletes
  -- profiles (same gap as push_subscriptions above), so the RPC must do it.
  WITH scrubbed AS (
    UPDATE public.pet_tags
       SET activated_by_user_id = CASE WHEN activated_by_user_id = p_user_id
                                       THEN NULL ELSE activated_by_user_id END,
           revoked_by_user_id   = CASE WHEN revoked_by_user_id = p_user_id
                                       THEN NULL ELSE revoked_by_user_id END,
           updated_at           = now()
     WHERE activated_by_user_id = p_user_id
        OR revoked_by_user_id = p_user_id
    RETURNING id
  )
  SELECT count(*) INTO pet_tags_scrubbed FROM scrubbed;

  -- Welfare reports the subject FILED: scrub reporter contact + free-text
  -- location address; redact description. (Retained: incident coords + subject
  -- animal description under the art. 16 exemption — see 0087 header.)
  UPDATE public.welfare_reports
     SET reporter_contact_email = NULL,
         reporter_contact_phone = NULL,
         location_address = NULL,
         description = '[contenido eliminado a pedido del titular]'
   WHERE reporter_user_id = p_user_id;

  -- Pending transfers the subject is a party to: cancel first.
  UPDATE public.pet_transfers
     SET status = 'cancelled',
         updated_at = now()
   WHERE (from_owner_id = p_user_id
          OR to_owner_id = p_user_id
          OR (subject_email IS NOT NULL AND to_owner_email = subject_email))
     AND status = 'pending';

  -- Pet transfers: null the recipient email (subject's PII footprint).
  UPDATE public.pet_transfers
     SET to_owner_email = 'erased@invalid.local'
   WHERE (from_owner_id = p_user_id
          OR to_owner_id = p_user_id
          OR (subject_email IS NOT NULL AND to_owner_email = subject_email))
     AND to_owner_email <> 'erased@invalid.local';

  -- Org contact messages the subject sent: null the inquirer email + name.
  IF subject_email IS NOT NULL THEN
    UPDATE public.org_contact_messages
       SET inquirer_email = 'erased@invalid.local',
           inquirer_name  = NULL
     WHERE inquirer_email = subject_email
       AND inquirer_email <> 'erased@invalid.local';
  END IF;

  -- Audit the erasure itself (mirrors 0087/0129/0130/0131 audit shape).
  INSERT INTO public.audit_log (actor_user_id, action, target_user_id, payload)
  VALUES (
    auth.uid(),
    'subject_erasure',
    p_user_id,
    jsonb_build_object(
      'reason',                     p_reason,
      'norma',                      'Ley 25.326 art. 16',
      'self_erasure',               auth.uid() = p_user_id,
      'pets_soft_deleted',          pets_marked,
      'events_pii_redacted',        events_redacted,
      'events_free_text_redacted',  free_text_events_redacted,
      'case_events_pii_redacted',   cases_redacted,
      'dispute_parties_scrubbed',   dispute_parties_scrubbed,
      'notifications_scrubbed',     notifs_scrubbed,
      'push_subscriptions_deleted', push_subs_deleted,
      'pet_tags_scrubbed',          pet_tags_scrubbed
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.erase_subject_data(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.erase_subject_data(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.erase_subject_data(uuid, text) TO authenticated;

COMMIT;
