-- Migration 0228 — the dead letter stops keeping the query parameters, and
-- the erasure redacts error_message as well as payload.
--
-- WHAT WAS WRONG (fresh security review 2026-09, HIGH-1)
-- ---------------------------------------------------------------------------
-- `createNotification` / `createNotificationsBulk` wrote `err.message` to
-- `notification_dead_letter.error_message`. drizzle-orm wraps every failed
-- query in a DrizzleQueryError whose message is
-- `Failed query: <sql>` + newline + `params: <params>`, and the params of a
-- notification insert are the notification itself: recipient id, title, body
-- and CTA — a finder's name and phone for a found-pet or sighting report. The
-- bulk path wrote the whole chunk's params (up to 500 recipients) into EVERY
-- row of a failed chunk, so one row carried third parties' data too.
--
-- CORRECTION OF 0226. Its header and the comment inside erase_subject_data say
-- that error_message "records that a delivery failed and when" and therefore
-- stays. That was wrong; 0226 is immutable, so the correction lives here, in
-- lib/infra/dead-letter-error-summary.ts and in the drain route.
--
-- WHAT THIS DOES
-- ---------------------------------------------------------------------------
-- The write side is fixed in code: error_message now holds only the SQLSTATE
-- and schema identifiers (summarizeDeadLetterError), never params, the query
-- text or the server's `detail`. The drain's resolveAndRedact clears
-- error_message together with payload.
--
-- PART A — erase_subject_data: 0226's definition verbatim, except that the
--   dead-letter redaction also sets error_message to '[redacted]' (NULL stays
--   NULL; the column is nullable). Same transaction as the rest of the erasure.
--   No new audit key: dead_letters_redacted already counts these rows.
--
-- PART B — one-shot backfill: every EXISTING row whose error_message is a
--   query dump ('params:' or 'Failed query') is redacted, whoever the subject.
--   A bulk row carries other recipients' data, so a per-subject erasure could
--   never reach all of it.

-- ============================================================================
-- PART A — erase_subject_data: 0226's definition plus error_message redaction
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
  tag_interest_deleted     int := 0;
  invites_to_subject_revoked int := 0;
  invites_by_subject_revoked int := 0;
  invites_email_scrubbed   int := 0;
  subject_email            text;
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
  --
  -- `note` joined the sweep in 0205, because `pet_caretaker_grants.note` is
  -- DENORMALIZED into caretaker_designated.payload.note by design (AGENTS.md
  -- §6b) and nulling the grant column alone would have left the same sentence
  -- in an append-only event. Verified before adding: the key is declared only
  -- on caretaker_designated and rehome_sponsorship_started
  -- (lib/events/{caretaker,rehome}-event-schemas.ts, both `z.string().nullable()`),
  -- and every occurrence in the live database — five event types once seed
  -- fixtures are counted — is prose. No enum, no identifier, no reader parses it.
  WITH redacted AS (
    UPDATE public.pet_events
       SET payload =
             payload
             || CASE WHEN payload ? 'notes' AND payload->>'notes' <> '[dato removido]'
                     THEN jsonb_build_object('notes', '[dato removido]') ELSE '{}'::jsonb END
             || CASE WHEN payload ? 'note' AND payload->>'note' <> '[dato removido]'
                     THEN jsonb_build_object('note', '[dato removido]') ELSE '{}'::jsonb END
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
         OR (payload ? 'note' AND payload->>'note' <> '[dato removido]')
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
  --    caretaker_designated.payload.note is handled by the free-text sweep
  --    above, which is why `note` was added to it in this same migration.
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
      'tag_interest_deleted',        tag_interest_deleted,
      'org_invites_to_subject_revoked', invites_to_subject_revoked,
      'org_invites_by_subject_revoked', invites_by_subject_revoked,
      'org_invites_email_scrubbed',  invites_email_scrubbed
    )
  );
END;
$$;
REVOKE ALL ON FUNCTION public.erase_subject_data(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.erase_subject_data(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.erase_subject_data(uuid, text) TO authenticated;

-- ============================================================================
-- PART B — no dead letter keeps a query dump
-- ============================================================================

UPDATE public.notification_dead_letter
   SET error_message = '[redacted]'
 WHERE error_message LIKE '%params:%'
    OR error_message LIKE 'Failed query%';

-- REPLAY-TIME ASSERTION — after PART B no row may still hold a query dump.
do $$
declare
  leaked int;
begin
  select count(*) into leaked
    from public.notification_dead_letter
   where error_message LIKE '%params:%'
      or error_message LIKE 'Failed query%';

  if leaked <> 0 then
    raise exception '0228: % notification_dead_letter row(s) still hold a query dump', leaked;
  end if;
end $$;
