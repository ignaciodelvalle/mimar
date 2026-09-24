-- Migration 0130 — erase_subject_data: close the remaining subject-PII holders.
-- Ley 25.326 art. 16 completeness. Audit findings 27-#4 (custody_disputes) +
-- the case_events reporter-comment gap surfaced in the 27 re-audit, plus the
-- subject's own notification content.
--
-- THE GAPS (all present after 0129)
-- ---------------------------------
--   1. custody_dispute_parties.party_position_summary — free text the SUBJECT
--      wrote stating their position in a custody dispute. export_subject_data
--      returns the subject's disputes (art. 14), but erase never scrubbed the
--      subject's own free-text contribution — an art. 14 / art. 16 asymmetry.
--   2. case_events.notes — welfare-denuncia reporter comments (entry_type =
--      'reporter_comment', db/schema.ts) are free text the SUBJECT authored
--      that can name a suspect/victim (third-party PII) or self-identify. The
--      RPC never touched case_events at all.
--   3. notifications.title/body/cta_* — the subject's own notifications embed
--      pet names, transfer counter-party context and deep-link tokens. They are
--      "data held about the subject" (returned by the art. 14 export) and must
--      be redacted on erasure.
--
-- SCOPE / RETENTION (deliberately narrow — mirrors 0087/0129 stance)
-- -----------------------------------------------------------------
--   * Only the subject's OWN contributions are touched:
--       - dispute parties where party_user_id = subject (never the counterparty);
--       - reporter_comment case_events recorded_by the subject (never another
--         reporter's comment on the same case);
--       - notifications addressed to the subject (user_id = subject).
--   * custody_disputes.resolution_summary is NOT scrubbed — it is written by the
--     resolving authority (govt/admin) as the official disposition of the case,
--     retained like audit_log under the art. 16 exemption.
--   * case_events on other cases, and non-reporter_comment entry types, are left
--     intact (forensic timeline for outbreak/decomiso/welfare investigations).
--
-- APPEND-ONLY OVERRIDE
-- --------------------
-- case_events is append-only (migration 0121) and refuses UPDATE unless the
-- session holds app.allow_event_mutation + app.allow_event_mutation_actor — the
-- SAME GUC pair pet_events uses. We extend the existing override window (already
-- opened for the pet_events redaction) to also cover the case_events UPDATE, so
-- one accountable window serves both event tables; each redacted case_events row
-- emits a case_events_mutation_override audit row via the trigger.
-- custody_dispute_parties and notifications are ordinary tables — no override.
--
-- IDEMPOTENCY
-- -----------
-- CREATE OR REPLACE FUNCTION. Every new redaction UPDATE carries a "still dirty"
-- guard (value <> sentinel / IS NOT NULL) so a re-run matches nothing and emits
-- no spurious audit rows. Forward-only; grants re-applied to match 0106/0114/0129.
--
-- search_path pinned (advisor function_search_path_mutable, 0114); all object
-- references are schema-qualified.

BEGIN;

CREATE OR REPLACE FUNCTION public.erase_subject_data(p_user_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pii, pg_temp
AS $$
DECLARE
  pets_marked             int;
  events_redacted         int := 0;
  cases_redacted          int := 0;
  dispute_parties_scrubbed int := 0;
  notifs_scrubbed         int := 0;
  subject_email           text;
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

  -- Owned pets → soft-delete (sanitary events on them are retained).
  WITH affected AS (
    UPDATE public.pets
       SET deleted_at = now(),
           updated_at = now()
     WHERE id IN (
       SELECT pet_id FROM public.ownerships
        WHERE owner_user_id = p_user_id
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

  -- Third-party PII inside pet_events payloads (Wave D2, finding 27-#3).
  WITH redacted AS (
    UPDATE public.pet_events
       SET payload = payload - 'victim_contact_name' - 'victim_contact_phone'
     WHERE event_type = 'incident_reported'
       AND (payload ? 'victim_contact_name' OR payload ? 'victim_contact_phone')
       AND (
         recorded_by_user_id = p_user_id
         OR pet_id IN (SELECT pet_id FROM public.ownerships WHERE owner_user_id = p_user_id)
       )
    RETURNING id
  )
  SELECT count(*) INTO events_redacted FROM redacted;

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

  -- Audit the erasure itself (mirrors 0087/0129 audit shape).
  INSERT INTO public.audit_log (actor_user_id, action, target_user_id, payload)
  VALUES (
    auth.uid(),
    'subject_erasure',
    p_user_id,
    jsonb_build_object(
      'reason',                    p_reason,
      'norma',                     'Ley 25.326 art. 16',
      'self_erasure',              auth.uid() = p_user_id,
      'pets_soft_deleted',         pets_marked,
      'events_pii_redacted',       events_redacted,
      'case_events_pii_redacted',  cases_redacted,
      'dispute_parties_scrubbed',  dispute_parties_scrubbed,
      'notifications_scrubbed',    notifs_scrubbed
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.erase_subject_data(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.erase_subject_data(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.erase_subject_data(uuid, text) TO authenticated;

COMMIT;
