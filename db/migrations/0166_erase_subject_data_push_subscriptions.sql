-- Migration 0166 — erase_subject_data: hard-delete the subject's Web Push
-- registrations (PRIV-1, Ley 25.326 art. 16).
--
-- THE GAP
-- -------
-- push_subscriptions (migration 0152) holds one row per browser registration:
-- the push service `endpoint` URL plus the client `p256dh` / `auth` keys and a
-- `user_agent` string. That tuple is device-identifying personal data — the
-- endpoint alone is a stable, per-device address that a push service can
-- deliver to.
--
-- db/schema.ts declares user_id REFERENCES profiles(id) ON DELETE CASCADE, and
-- the table's own header comment says "hard deletion only via profiles
-- cascade". But NOTHING in the erasure path ever hard-deletes a profile:
--   · erase_subject_data (0059 → 0087 → 0129 → 0130 → 0131 → 0159) SOFT-deletes
--     the profile (deleted_at = now()) and nulls its PII columns; the row stays.
--   · src/modules/auth/application/subject-rights/erase-subject-data.ts then
--     calls admin.auth.admin.deleteUser(), which removes the auth.users row —
--     and auth.users carries no FK to public.profiles, so that deletion cannot
--     cascade here either.
-- The cascade the schema comment relies on therefore never fires. Every push
-- endpoint and key pair the subject ever registered survives their exercise of
-- the right of deletion, indefinitely.
--
-- Revocation is not erasure: revoked_at is a soft flag that keeps the endpoint
-- and both keys on the row. Art. 16 asks for the data to be gone.
--
-- THE FIX (this migration)
-- -------------------------
-- DELETE the subject's push_subscriptions rows inside the RPC, in the ordinary
-- (non-append-only) section, and count them into the existing subject_erasure
-- audit payload as `push_subscriptions_deleted` — the same shape every other
-- step in this function already reports.
--
-- WHY DELETE AND NOT REDACT: unlike pet_events (retained under the SENASA /
-- Ord. CABA 41.831 sanitary-retention carve-out) or notifications (whose
-- notification_type is a non-PII routing key worth keeping), a push
-- subscription has no residual value once its owner is gone. It is a delivery
-- address, nothing else. There is no non-PII remainder to preserve, so the row
-- goes.
--
-- SCOPE: rows are keyed by user_id = p_user_id only. There is no shared or
-- third-party push row — one subscription belongs to exactly one user by the
-- table's primary design — so no ownership-role scoping is needed here (unlike
-- the pet_events branches, where a foster's erasure must not touch the owner's
-- data).
--
-- IDEMPOTENCY: a re-run finds no rows and counts zero. push_subscriptions has
-- no append-only trigger, so the delete emits no override audit row.
--
-- Everything else is copied verbatim from 0159. Forward-only CREATE OR REPLACE.
-- search_path pinned (advisor function_search_path_mutable, 0114); all object
-- references are schema-qualified.

BEGIN;

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
      'push_subscriptions_deleted', push_subs_deleted
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.erase_subject_data(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.erase_subject_data(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.erase_subject_data(uuid, text) TO authenticated;

COMMIT;
