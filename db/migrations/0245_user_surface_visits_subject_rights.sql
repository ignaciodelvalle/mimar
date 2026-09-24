-- Migration 0245 — user_surface_visits joins the subject-rights RPCs
-- (T4-O3, per PO review 2026-09-22: "a brand-new table cannot be born with a
-- hole in both export and erasure").
--
-- user_surface_visits (migration 0244) records which /gob surfaces an
-- operator has visited and when — personal data about a person's behaviour,
-- same class the pet_events redaction migration (0240, PO decision 5A) spent
-- a full pass closing for a much bigger table. This closes it here instead of
-- letting it start life as a gap.
--
-- ART. 14 (export_subject_data) — 0222's definition VERBATIM plus one new
-- key, 'user_surface_visits', inserted immediately after
-- 'operator_feed_watermarks' (same shape: a handful of rows, all three
-- columns the subject's own — no third-party data to exclude, unlike
-- push_targets' expo_push_token or pet_tags' activation_code_hash).
--
-- ART. 16 (erase_subject_data) — 0240's definition VERBATIM plus:
--   · DECLARE `surface_visits_deleted`;
--   · the DELETE, immediately after the operator_feed_watermarks one it
--     mirrors (same reasoning: the composite PK IS the subject, the other
--     columns are timestamps, no accountability trail, no FK dependents);
--   · one new key, 'surface_visits_deleted', in the subject_erasure audit
--     payload, immediately after 'operator_watermarks_deleted'.
--
-- schema_version stays at 5 — adding an export key is not a breaking change
-- to the envelope (0222 added push_targets under the same schema_version,
-- see packages/contract/src/api/my-privacy.ts's own note that the shape
-- "grows every time a fence finds another table").
--
-- RETENTION (PO review 2026-09-22, item 2): no TTL is added here, and that is
-- a considered choice, not an oversight — see
-- dim-interno/docs/ops/cutover-debts.md §6 for the full reasoning (a
-- time-based purge would un-derive G1/G2/G4 of the onboarding checklist and
-- reproduce the "checklist reappears after success" bug class this codebase
-- already closed once for org-setup-checklist.ts, S3-F04).
--
-- Forward-only, immutable. Applying to the remote DB is Ignacio-gated
-- (CLAUDE.md norm) — this file shipping does NOT mean it ran anywhere.

-- ============================================================================
-- ART. 14 — export_subject_data
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

-- ============================================================================
-- ART. 16 — erase_subject_data
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
  dead_letters_redacted    int := 0;
  push_subs_deleted        int := 0;
  push_targets_deleted     int := 0;
  pet_tags_scrubbed        int := 0;
  pets_contact_scrubbed    int := 0;
  grants_invitee_rejected  int := 0;
  grants_grantor_cancelled int := 0;
  grants_email_scrubbed    int := 0;
  grants_note_scrubbed     int := 0;
  foster_rows_deleted      int := 0;
  contact_msgs_scrubbed    int := 0;
  libreta_shares_revoked   int := 0;
  watermarks_deleted       int := 0;
  surface_visits_deleted   int := 0;
  tag_interest_deleted     int := 0;
  invites_to_subject_revoked int := 0;
  invites_by_subject_revoked int := 0;
  invites_email_scrubbed   int := 0;
  subject_email            text;
  -- 0240: rows updated, and how many each scope reached.
  pet_events_redacted      int := 0;
  pet_events_by_scope      jsonb := '{}'::jsonb;
BEGIN
  IF auth.uid() IS NULL OR (auth.uid() <> p_user_id AND NOT pii.caller_is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT u.email INTO subject_email FROM auth.users u WHERE u.id = p_user_id;

  -- Profile: hash display_name, null every direct + third-party PII column.
  --
  -- jurisdiction_province / jurisdiction_locality joined this list in 0205.
  -- They were the subject's declared account location and NOTHING read them —
  -- every aggregate, panorama layer, k-anonymity cell and routing path keys on
  -- pets.*, welfare_reports.*, service_offerings.*, govt_assignments.* or
  -- organizations.*, never on profiles (lib/infra/admin-search.ts records the
  -- profile→jurisdiction link being rejected on purpose). Collecting them is
  -- itself a finalidad problem, so the write was removed as well
  -- (src/modules/auth/application/complete-identity.ts) and PART C1 nulls the
  -- column for every profile, not only the erased ones.
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
         jurisdiction_province    = NULL,
         jurisdiction_locality    = NULL,
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

  -- Per-pet owner-provided contact data (migration 0205). These six columns are
  -- the PET-level mirror of profile defaults the UPDATE above has nulled since
  -- 0059; nobody ever nulled the copies. db/schema.ts states they are "UI
  -- preference, NOT a fact about the pet — editing does NOT emit a pet event",
  -- so they are not derived from the spine and a plain NULL sticks: no
  -- rederivation resurrects them (contrast jurisdiction_*, which is a STRICT
  -- projection — see PART C1's note on why pets.jurisdiction_* is untouched).
  --
  -- The predicate is the ownership set WITHOUT `deleted_at IS NULL` on the pet,
  -- so a second run over an already soft-deleted pet still reaches any column a
  -- previous definition left behind.
  WITH scrubbed AS (
    UPDATE public.pets
       SET emergency_contact_name    = NULL,
           emergency_contact_phone   = NULL,
           preferred_vet_name        = NULL,
           preferred_vet_phone       = NULL,
           insurance_company         = NULL,
           insurance_policy_number   = NULL,
           updated_at                = now()
     WHERE id IN (
       SELECT pet_id FROM public.ownerships
        WHERE owner_user_id = p_user_id
          AND role = 'owner'
          AND ended_at IS NULL
     )
       AND (emergency_contact_name IS NOT NULL
            OR emergency_contact_phone IS NOT NULL
            OR preferred_vet_name IS NOT NULL
            OR preferred_vet_phone IS NOT NULL
            OR insurance_company IS NOT NULL
            OR insurance_policy_number IS NOT NULL)
    RETURNING id
  )
  SELECT count(*) INTO pets_contact_scrubbed FROM scrubbed;

  -- ------------------------------------------------------------------------
  -- Append-only event tables (pet_events + case_events) — open ONE override
  -- window for both, then close it. Each redacted row emits its own
  -- *_mutation_override audit row via the append-only trigger.
  -- ------------------------------------------------------------------------
  PERFORM set_config('app.allow_event_mutation', 'true', true);
  PERFORM set_config('app.allow_event_mutation_actor', auth.uid()::text, true);

  -- pet_events, classified by key (migration 0240, T3-A2b; PO decision 5A).
  -- Replaces 0228's two blocks: the incident_reported victim-contact drop and
  -- the key-NAME free-text sweep across every event type, which destroyed the
  -- enum `reason` of microchip_replaced / foster_ended / custody_transferred /
  -- custody_transfer_proposed and professional acts (a vet's diagnosis, a
  -- rabies closure note). Now every key is transformed by its class in
  -- pii.pet_event_redaction_rules (seeded from lib/events/payload-privacy.ts):
  -- personal data is erased; professional acts written by vet / govt / system
  -- or a VERIFIED shelter survive; compliance facts and machine codes are
  -- never touched.
  --
  -- Scopes (pii.pet_event_scopes): 1 authored by the subject, any pet, ever;
  -- 2 legacy owner rows with no recorded author inside the subject's owner
  -- intervals; 4 the subject's current owner pets (the pets going dark — the
  -- role = 'owner' AND ended_at IS NULL set, so a foster's erasure does not
  -- reach the owner's pet); 8 rows whose party key names the subject, and only
  -- the keys about that person. Only rows that CHANGE are updated, so a re-run
  -- writes no audit row.
  WITH computed AS (
    SELECT e.id,
           s.scopes,
           e.payload      AS old_payload,
           e.notes        AS old_notes,
           e.location_lat AS old_lat,
           e.location_lng AS old_lng,
           pii.redacted_payload(e.event_type, e.author_role::text, e.author_verified, e.payload, s.scopes, p_user_id) AS new_payload,
           pii.redacted_notes(e.event_type, e.author_role::text, e.author_verified, e.notes, s.scopes) AS new_notes,
           pii.redacted_coordinate(e.event_type, 'location_lat', e.location_lat, s.scopes) AS new_lat,
           pii.redacted_coordinate(e.event_type, 'location_lng', e.location_lng, s.scopes) AS new_lng
      FROM pii.pet_event_scopes(p_user_id) s
      JOIN public.pet_events e ON e.id = s.event_id
  ),
  changed AS (
    SELECT c.*
      FROM computed c
     WHERE c.new_payload IS DISTINCT FROM c.old_payload
        OR c.new_notes IS DISTINCT FROM c.old_notes
        OR c.new_lat IS DISTINCT FROM c.old_lat
        OR c.new_lng IS DISTINCT FROM c.old_lng
  ),
  redacted AS (
    UPDATE public.pet_events e
       SET payload      = ch.new_payload,
           notes        = ch.new_notes,
           location_lat = ch.new_lat,
           location_lng = ch.new_lng
      FROM changed ch
     WHERE e.id = ch.id
    RETURNING ch.scopes,
              (ch.new_payload IS DISTINCT FROM ch.old_payload) AS payload_changed,
              (ch.new_notes IS DISTINCT FROM ch.old_notes) AS notes_changed
  )
  SELECT count(*),
         count(*) FILTER (WHERE payload_changed),
         count(*) FILTER (WHERE notes_changed),
         jsonb_build_object(
           'authored',        count(*) FILTER (WHERE scopes & 1 <> 0),
           'authored_legacy', count(*) FILTER (WHERE scopes & 2 <> 0),
           'pet_going_dark',  count(*) FILTER (WHERE scopes & 4 <> 0),
           'named_party',     count(*) FILTER (WHERE scopes & 8 <> 0)
         )
    INTO pet_events_redacted, events_redacted, free_text_events_redacted, pet_events_by_scope
    FROM redacted;

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

  -- Undelivered notifications addressed to the subject (0226). A dead-letter
  -- row stores the FULL insert payload verbatim — title, body and CTA, which
  -- for a found-pet or sighting report carry a third party's name and phone —
  -- and the drain cron replays it into public.notifications. The redaction one
  -- block above never reached it, so the next drain run re-created the very
  -- notification this function had just scrubbed. Every row for the subject,
  -- resolved or not, loses its payload and is marked resolved. payload is NOT
  -- NULL, so the redacted value is the empty object, which the drain's
  -- validator refuses to replay.
  --
  -- error_message is redacted too (0228). 0226 kept it on the belief that it
  -- only said that a delivery failed and when; it held drizzle's
  -- `Failed query: <sql> params: <params>`, and the params ARE the
  -- notification. dedupe_key and the timestamps stay.
  WITH redacted AS (
    UPDATE public.notification_dead_letter
       SET payload       = '{}'::jsonb,
           error_message = CASE WHEN error_message IS NULL THEN NULL ELSE '[redacted]' END,
           resolved_at   = COALESCE(resolved_at, now())
     WHERE payload ->> 'userId' = p_user_id::text
    RETURNING id
  )
  SELECT count(*) INTO dead_letters_redacted FROM redacted;

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

  -- Native push targets (migration 0222). DELETED outright on the exact
  -- push_subscriptions precedent one block above: device_id is an install
  -- identifier, expo_push_token is a deliverable address for that install, and
  -- platform + app_version describe the subject's own hardware. Every column is
  -- the subject's own and none of it describes an animal or a third party, so
  -- there is nothing of residual non-PII value that redaction would preserve.
  --
  -- The profiles ON DELETE CASCADE the 0222 schema comment names does not save
  -- us here either, for the same reason it does not for push_subscriptions: the
  -- profile is soft-deleted in this function, not deleted, so the cascade never
  -- fires.
  WITH removed_targets AS (
    DELETE FROM public.push_targets
     WHERE user_id = p_user_id
    RETURNING id
  )
  SELECT count(*) INTO push_targets_deleted FROM removed_targets;

  -- Foster-volunteer enrolment (migration 0205). DELETED outright, following
  -- the push_subscriptions precedent above: every column is the subject's own
  -- self-reported data (declared jurisdiction, household composition, free-text
  -- notes) and none of it describes an animal or a third party, so nothing of
  -- residual non-PII value survives redaction. Nothing breaks downstream —
  -- every pool query filters `status = 'active' AND available_slots > 0`, and
  -- foster_proposals references profiles.id, NOT this table, so the DELETE has
  -- no FK dependents.
  WITH removed AS (
    DELETE FROM public.foster_volunteers
     WHERE user_id = p_user_id
    RETURNING id
  )
  SELECT count(*) INTO foster_rows_deleted FROM removed;

  -- Operator feed watermark (migration 0208). DELETED outright, third table on
  -- the push_subscriptions / foster_volunteers precedent: user_id IS the
  -- primary key, so the row cannot exist without naming the subject, and the
  -- other two columns are a read position and its timestamp. It records no
  -- official act — the feed advances only on an explicit "Marcar como visto" —
  -- so no accountability trail is lost. No FK dependents: nothing in the schema
  -- references this table.
  WITH removed AS (
    DELETE FROM public.operator_feed_watermarks
     WHERE user_id = p_user_id
    RETURNING user_id
  )
  SELECT count(*) INTO watermarks_deleted FROM removed;

  -- user_surface_visits (migration 0245, T4-O3). DELETED outright, same
  -- precedent as operator_feed_watermarks immediately above: (user_id,
  -- surface) is the composite PK, so a row cannot exist without naming the
  -- subject, and the other two columns are visit timestamps with no
  -- accountability trail behind them (this is not an audited action, just a
  -- passive "have you been here" fact -- see lib/infra/surface-visits.ts). No
  -- FK dependents.
  WITH removed AS (
    DELETE FROM public.user_surface_visits
     WHERE user_id = p_user_id
    RETURNING user_id
  )
  SELECT count(*) INTO surface_visits_deleted FROM removed;

  -- Physical-tag interest (migration 0208). DELETED, and the NOT NULL on
  -- user_id is what settles it: this row cannot be anonymised in place, because
  -- it cannot exist without naming the subject. Keeping a de-identified demand
  -- signal would need a schema change, and a product metric is not a lawful
  -- basis for holding a named person's row against their art. 16 request.
  -- `notes` is the subject's own free text. No FK dependents; the
  -- (pet_id, user_id) unique index simply frees its slot.
  WITH removed AS (
    DELETE FROM public.physical_tag_interest
     WHERE user_id = p_user_id
    RETURNING id
  )
  SELECT count(*) INTO tag_interest_deleted FROM removed;

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

  -- ------------------------------------------------------------------------
  -- Temporary-caretaker grants (migration 0205). FOUR statements, in this
  -- order, and the order is load-bearing: the two flips identify the subject BY
  -- EMAIL and statement 3 overwrites that email.
  --
  -- Only the PENDING side is touched. An accepted arrangement is ended through
  -- endCaretakerGrantAtomically() before this RPC runs — see the header.
  -- ------------------------------------------------------------------------

  -- 1. Invitations addressed TO the subject and still unanswered → rejected.
  --    `pending` is workflow state, not a fact about the animal: there is no
  --    `caretaker_proposed` event, so there is nothing for the spine to record
  --    (lib/infra/end-pet-ownerships.ts states the rule). responded_at is
  --    stamped rather than left NULL — the titular's cockpit and the drift
  --    harness both read "when was this resolved", and a NULL there is
  --    indistinguishable from a row nobody ever answered.
  WITH flipped AS (
    UPDATE public.pet_caretaker_grants
       SET status       = 'rejected',
           responded_at = now(),
           updated_at   = now()
     WHERE status = 'pending'
       AND (caretaker_user_id = p_user_id
            OR (subject_email IS NOT NULL AND lower(caretaker_email) = lower(subject_email)))
    RETURNING id
  )
  SELECT count(*) INTO grants_invitee_rejected FROM flipped;

  -- 2. Invitations the subject SENT and nobody has answered → cancelled.
  --    Leaving them is what lets an invitee accept an invitation onto a pet
  --    whose owner no longer exists: write access on an animal nobody can
  --    revoke it for, and their contact published on its public credential.
  WITH flipped AS (
    UPDATE public.pet_caretaker_grants
       SET status       = 'cancelled',
           responded_at = now(),
           updated_at   = now()
     WHERE status = 'pending'
       AND granted_by_user_id = p_user_id
    RETURNING id
  )
  SELECT count(*) INTO grants_grantor_cancelled FROM flipped;

  -- 3. The invitee's email, on EVERY status. This is the subject's own address
  --    sitting in cleartext on a row that belongs to somebody else's animal.
  --
  --    Where the subject is the GRANTOR the email is a THIRD PARTY'S and is
  --    left alone (PO decision; the same reasoning §6c applies to an anonymous
  --    reporter's row). caretaker_user_id is likewise NOT nulled: the profile
  --    it points at is soft-deleted and anonymized, nothing hard-deletes
  --    profiles, and `pet_caretaker_grants_accept_check` (0192) makes NULLing
  --    it on an accepted/ended row a constraint violation. pet_transfers is
  --    treated identically — it sentinels the email and keeps the actor FKs.
  WITH scrubbed AS (
    UPDATE public.pet_caretaker_grants
       SET caretaker_email = 'erased@invalid.local',
           updated_at      = now()
     WHERE (caretaker_user_id = p_user_id
            OR (subject_email IS NOT NULL AND lower(caretaker_email) = lower(subject_email)))
       AND caretaker_email <> 'erased@invalid.local'
    RETURNING id
  )
  SELECT count(*) INTO grants_email_scrubbed FROM scrubbed;

  -- 4. The note the subject WROTE. Free text about a third party's household
  --    and routines, possibly health data (AGENTS.md §6b). The copy inside
  --    caretaker_designated.payload.note is handled by the pet_events
  --    redaction above (0240: rule caretaker_designated.note, scope 1 or 8).
  WITH scrubbed AS (
    UPDATE public.pet_caretaker_grants
       SET note       = NULL,
           updated_at = now()
     WHERE granted_by_user_id = p_user_id
       AND note IS NOT NULL
    RETURNING id
  )
  SELECT count(*) INTO grants_note_scrubbed FROM scrubbed;

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

  -- Libreta shares (migration 0207). A share link serves the pet's FULL
  -- Tier-2 medical libreta to whoever holds the URL, can be NON-EXPIRING
  -- (expires_at is nullable), and until 0207 nothing here touched it — the
  -- erasure left an ongoing outbound data flow running with no live holder
  -- able to revoke it (the revocation actions 404 on an erased pet). Same
  -- posture as the pending-transfer cancel above: outstanding grants of
  -- access die with the account. Two populations, one statement:
  --
  --   · shares the SUBJECT created — on their own pet or as a helper on
  --     somebody else's (their outstanding grant, their erasure ends it);
  --   · un-revoked shares on the pets THIS erasure soft-deletes (same
  --     role='owner' + ended_at IS NULL set as the soft-delete above), whoever
  --     created them — the animal's credential went dark, its libreta links
  --     go with it.
  --
  -- The share page also filters pets.deleted_at caller-side (belt and
  -- braces); this is the half that makes the revocation a FACT in the data
  -- rather than a behavior of one reader. Expired shares are not exempted:
  -- revoked_at IS NULL is the only predicate, and stamping a dead share is
  -- harmless while exempting one risks a clock-skew resurrection.
  WITH revoked AS (
    UPDATE public.libreta_share_tokens
       SET revoked_at        = now(),
           revoked_by_user_id = auth.uid()
     WHERE revoked_at IS NULL
       AND (created_by_user_id = p_user_id
            OR pet_id IN (
              SELECT pet_id FROM public.ownerships
               WHERE owner_user_id = p_user_id
                 AND role = 'owner'
                 AND ended_at IS NULL
            ))
    RETURNING id
  )
  SELECT count(*) INTO libreta_shares_revoked FROM revoked;

  -- Org contact messages the subject sent. 0170 nulled the inquirer email +
  -- name and left two things behind, both closed in 0205:
  --
  --   · `message` is the subject's OWN free text, typed into an unauthenticated
  --     form, and it can self-identify as thoroughly as the name field did.
  --     Same sentinel the notifications + case_events redactions already use.
  --   · `submitter_ip` is a raw caller IP with NO READER ANYWHERE — rate
  --     limiting lives entirely in rate_limit_buckets. It was write-only
  --     archival data with indefinite retention. It is also purged on a 30-day
  --     TTL for everyone now, erased or not (lib/infra/data-lifecycle.ts).
  IF subject_email IS NOT NULL THEN
    WITH scrubbed AS (
      UPDATE public.org_contact_messages
         SET inquirer_email = 'erased@invalid.local',
             inquirer_name  = NULL,
             message        = '[contenido eliminado a pedido del titular]',
             submitter_ip   = NULL
       WHERE lower(inquirer_email) = lower(subject_email)
         AND inquirer_email <> 'erased@invalid.local'
      RETURNING id
    )
    SELECT count(*) INTO contact_msgs_scrubbed FROM scrubbed;
  END IF;

  -- ------------------------------------------------------------------------
  -- Organization invitations (migration 0208). THREE statements, in this
  -- order, and the order is load-bearing for the same reason the caretaker
  -- block above says so: statement 1 identifies the subject BY EMAIL and
  -- statement 3 overwrites that email.
  --
  -- The row is REDACTED, never deleted. An accepted invitation is the
  -- provenance of an organization membership — who let whom in, with what role
  -- and what write powers — and that trail belongs to the organization and to
  -- the counterparty, not only to the subject. See this file's header.
  -- ------------------------------------------------------------------------

  -- 1. Outstanding invitations addressed TO the subject → revoked. An invite
  --    nobody answered is an open door onto an address whose owner has just
  --    asked to be forgotten; leaving it also leaves the row inside the
  --    `org_invitations_active_unique` partial index, blocking a legitimate
  --    re-invite of whoever later holds that address.
  IF subject_email IS NOT NULL THEN
    WITH revoked AS (
      UPDATE public.organization_invitations
         SET revoked_at = now()
       WHERE accepted_at IS NULL
         AND revoked_at IS NULL
         AND lower(email) = lower(subject_email)
      RETURNING id
    )
    SELECT count(*) INTO invites_to_subject_revoked FROM revoked;
  END IF;

  -- 2. Outstanding invitations the subject SENT → revoked. Exactly the
  --    reasoning statement 2 of the caretaker block gives: leaving them lets a
  --    stranger accept membership — with write powers on pet events, if
  --    can_write_pet_events was set — on the authority of an account that no
  --    longer exists and can no longer be asked.
  WITH revoked AS (
    UPDATE public.organization_invitations
       SET revoked_at = now()
     WHERE accepted_at IS NULL
       AND revoked_at IS NULL
       AND invited_by_user_id = p_user_id
    RETURNING id
  )
  SELECT count(*) INTO invites_by_subject_revoked FROM revoked;

  -- 3. The invitee's email, on EVERY status — the subject's own address in
  --    cleartext on a row that belongs to an organization. Two ways to be the
  --    invitee: by address, or by account once the invitation was accepted
  --    (accepted_by_user_id, which the email match alone would miss on a row
  --    whose address was typed differently from the one that ended up on the
  --    account).
  --
  --    Where the subject is the INVITER the address is a THIRD PARTY'S and is
  --    left alone — the same PO decision recorded for caretaker_email above.
  --    invited_by_user_id and accepted_by_user_id are both KEPT: opaque FKs
  --    onto a profile this function has already soft-deleted and anonymised,
  --    and together they are the access trail art. 16 does not reach.
  --
  --    On org_invitations_active_unique: statements 1 and 2 have already
  --    revoked every ACTIVE row reachable by email, so those are outside the
  --    partial index. The accepted_by_user_id branch relies on accepted_at
  --    being set alongside it — application discipline, not a CHECK
  --    constraint. See the header block for what was actually verified.
  WITH scrubbed AS (
    UPDATE public.organization_invitations
       SET email = 'erased@invalid.local'
     WHERE (accepted_by_user_id = p_user_id
            OR (subject_email IS NOT NULL AND lower(email) = lower(subject_email)))
       AND email <> 'erased@invalid.local'
    RETURNING id
  )
  SELECT count(*) INTO invites_email_scrubbed FROM scrubbed;

  -- Audit the erasure itself (mirrors 0087/0129/0130/0131/0170 audit shape).
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
      'pet_events_redacted',        pet_events_redacted,
      'pet_events_redaction_by_scope', pet_events_by_scope,
      'case_events_pii_redacted',   cases_redacted,
      'dispute_parties_scrubbed',   dispute_parties_scrubbed,
      'notifications_scrubbed',     notifs_scrubbed,
      'dead_letters_redacted',      dead_letters_redacted,
      'push_subscriptions_deleted', push_subs_deleted,
      'push_targets_deleted',       push_targets_deleted,
      'pet_tags_scrubbed',          pet_tags_scrubbed,
      'pets_contact_scrubbed',      pets_contact_scrubbed,
      'grants_invitee_rejected',    grants_invitee_rejected,
      'grants_grantor_cancelled',   grants_grantor_cancelled,
      'grants_email_scrubbed',      grants_email_scrubbed,
      'grants_note_scrubbed',       grants_note_scrubbed,
      'foster_volunteers_deleted',  foster_rows_deleted,
      'contact_messages_scrubbed',  contact_msgs_scrubbed,
      'libreta_shares_revoked',     libreta_shares_revoked,
      'operator_watermarks_deleted', watermarks_deleted,
      'surface_visits_deleted',     surface_visits_deleted,
      'tag_interest_deleted',        tag_interest_deleted,
      'org_invites_to_subject_revoked', invites_to_subject_revoked,
      'org_invites_by_subject_revoked', invites_by_subject_revoked,
      'org_invites_email_scrubbed',  invites_email_scrubbed
    )
  );
END;
$$;
REVOKE ALL ON FUNCTION public.erase_subject_data(uuid, text) FROM PUBLIC;
