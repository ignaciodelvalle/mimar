-- Migration 0129 — erase_subject_data: redact third-party PII in event payloads.
-- Wave D2, right-to-erasure completeness (Ley 25.326 art. 16). Audit finding 27-#3.
--
-- THE GAP
-- -------
-- erase_subject_data() (last defined in 0106) scrubs the profile, owned pets,
-- welfare_reports, pet_transfers and org_contact_messages — but never touches
-- pet_events payloads. An `incident_reported` event (bite report) carries the
-- VICTIM's identifying contact details as free text:
--     payload->>'victim_contact_name'
--     payload->>'victim_contact_phone'
-- (lib/events/event-schemas.ts — incident_reported, written by report-bite.ts
-- with recorded_by_user_id = the reporting owner). When that owner erases their
-- account, this third-party PII survives forever in the append-only spine.
--
-- The append-only trigger (enforce_pet_events_append_only, migrations 0104/0127)
-- blocks every UPDATE unless the session holds BOTH override GUCs:
--     app.allow_event_mutation       = 'true'
--     app.allow_event_mutation_actor = '<actor uuid>'
-- The RPC never set them, so even if it had tried, the redaction UPDATE would
-- have been refused. This migration adds a NARROW, AUDITED redaction step that
-- sets the override for exactly the duration of the redaction UPDATE and then
-- clears it. Each redacted row emits a `pet_events_mutation_override` audit_log
-- row via the trigger — the same accountability trail as any admin repair.
--
-- SCOPE (deliberately narrow)
-- ---------------------------
--   * Only event_type = 'incident_reported' (the sole schema carrying these
--     fields) — sanitary events (vaccination/medical payloads) are never
--     matched, so retention-relevant records stay intact.
--   * Only the two identifying contact keys are removed; injuries_summary,
--     context and the sanitary columns are left untouched.
--   * Only events tied to the erasing subject: recorded by them, or on a pet
--     they own(ed). Third parties' own incident reports are never touched.
--   * Only rows that still carry a key participate (payload ? key) — so a
--     re-run matches nothing and stays idempotent (no spurious audit rows).
--
-- IDEMPOTENCY
-- -----------
-- CREATE OR REPLACE FUNCTION. Re-running the RPC (or replaying this migration)
-- is safe: the redaction UPDATE's key-presence guard makes the second pass a
-- no-op. Forward-only; grants re-applied to match 0106 + 0114.
--
-- search_path pinned (advisor function_search_path_mutable, 0114); all object
-- references are schema-qualified.

BEGIN;

CREATE OR REPLACE FUNCTION public.erase_subject_data(p_user_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pii, pg_temp
AS $$
DECLARE
  pets_marked      int;
  events_redacted  int := 0;
  subject_email    text;
BEGIN
  IF auth.uid() IS NULL OR (auth.uid() <> p_user_id AND NOT pii.caller_is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT u.email INTO subject_email FROM auth.users u WHERE u.id = p_user_id;

  -- Profile: hash display_name, null every direct + third-party PII column.
  -- Wave 5 Item 25a: dni_number dropped; erase dni_hash, dni_last4, miarg_sub,
  -- and dni_verified_at instead.
  UPDATE public.profiles
     SET display_name             = 'erased:' || md5(id::text),
         phone                    = NULL,
         -- New DNI columns (migration 0106) — erase hash + last4 + OIDC sub.
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

  -- Third-party PII inside event payloads (Wave D2, finding 27-#3).
  -- incident_reported carries the victim's identifying contact details as free
  -- text. Redact ONLY those two keys, ONLY on events the subject authored or
  -- that sit on a pet they own(ed). Everything else in the payload (severity,
  -- injuries_summary, context, sanitary fields) is retained.
  --
  -- The append-only trigger refuses this UPDATE without the override GUCs, so we
  -- enable them for the redaction only, then clear them. Each redacted row emits
  -- a pet_events_mutation_override audit_log row via the trigger (accountability).
  PERFORM set_config('app.allow_event_mutation', 'true', true);
  PERFORM set_config('app.allow_event_mutation_actor', auth.uid()::text, true);

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

  -- Clear the override immediately — the remaining statements must not run under
  -- an open mutation hatch.
  PERFORM set_config('app.allow_event_mutation', 'false', true);
  PERFORM set_config('app.allow_event_mutation_actor', '', true);

  -- Welfare reports the subject FILED: scrub reporter contact fields and the
  -- free-text location address. See migration 0087 for rationale.
  UPDATE public.welfare_reports
     SET reporter_contact_email = NULL,
         reporter_contact_phone = NULL,
         location_address = NULL,
         description = '[contenido eliminado a pedido del titular]'
   WHERE reporter_user_id = p_user_id;

  -- Pet transfers where the subject is a party and the transfer is still
  -- pending: cancel first.
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

  -- Org contact messages the subject sent: null the inquirer email.
  IF subject_email IS NOT NULL THEN
    UPDATE public.org_contact_messages
       SET inquirer_email = 'erased@invalid.local',
           inquirer_name  = NULL
     WHERE inquirer_email = subject_email
       AND inquirer_email <> 'erased@invalid.local';
  END IF;

  -- Audit the erasure itself (mirrors 0087 audit shape).
  INSERT INTO public.audit_log (actor_user_id, action, target_user_id, payload)
  VALUES (
    auth.uid(),
    'subject_erasure',
    p_user_id,
    jsonb_build_object(
      'reason',             p_reason,
      'norma',              'Ley 25.326 art. 16',
      'self_erasure',       auth.uid() = p_user_id,
      'pets_soft_deleted',  pets_marked,
      'events_pii_redacted', events_redacted
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.erase_subject_data(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.erase_subject_data(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.erase_subject_data(uuid, text) TO authenticated;

COMMIT;
