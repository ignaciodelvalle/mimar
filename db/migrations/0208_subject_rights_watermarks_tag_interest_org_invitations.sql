-- 0208 — three live Ley 25.326 gaps closed: operator_feed_watermarks,
-- physical_tag_interest and organization_invitations.
-- (arts. 14 y 16. Supersedes the export written by 0205 and the erase by 0207.)
--
-- These three sat in the KNOWN_GAP register of
-- scripts/check-subject-rights-coverage.ts — tables that DO hold subject data
-- and that NEITHER RPC reached. That register is a debt list, not an exemption
-- list, and this migration pays three of it. The fence's ceiling drops 20 → 17
-- in the same commit, which is the half that stops the freed slots being
-- silently refilled.
--
-- THE QUESTION EACH TABLE WAS ASKED
-- ---------------------------------------------------------------------------
-- Not "can we delete it" — "what does art. 16 actually reach here". Three
-- different answers, because the tables are three different kinds of record:
--
--  1. `operator_feed_watermarks` — per-user UI state. One row per user
--     (user_id IS the PK): the "Novedades" feed read position, advanced only by
--     an explicit "Marcar como visto". It records no official act, describes no
--     animal and names no third party. DELETED outright, on the
--     push_subscriptions / foster_volunteers precedent (0166 / 0205): every
--     column is the subject's own, so nothing of residual non-PII value
--     survives redaction.
--
--  2. `physical_tag_interest` — demand signal, plus free text. `notes` is the
--     subject's own prose and `user_id` is NOT NULL, which settles the
--     question structurally: the row CANNOT be anonymised in place, because it
--     cannot exist without naming the subject. Keeping it de-identified would
--     need a schema change, and a product convenience (how many owners want a
--     physical tag) is not a reason to hold a named person's row against their
--     art. 16 request. DELETED. The (pet_id, user_id) unique index frees its
--     slot, which is the correct outcome — a later owner may re-express
--     interest on the same pet.
--
--  3. `organization_invitations` — the one with an accountability side, and the
--     reason this file is not three DELETEs. See the next block.
--
-- WHY organization_invitations IS REDACTED AND NOT DELETED
-- ---------------------------------------------------------------------------
-- An ACCEPTED invitation is the provenance of an organization membership: the
-- record of who let whom into an organization, and with what role and write
-- powers. `organization_memberships` (already in both RPCs since 0059) is the
-- live fact; this table is how that fact came to be. Deleting the row would
-- erase a third party's accountability trail to satisfy one party's art. 16
-- request — precisely what the EXEMPT header of the coverage fence says art. 16
-- may NOT reach ("the accountability trail they form is the thing art. 16 may
-- NOT erase").
--
-- So the split is: the subject's OWN identifier is scrubbed, the arrangement's
-- shape is kept.
--   · `email` — cleartext, and the shape 0205 had to close on
--     pet_caretaker_grants.caretaker_email. Sentinelled WHERE THE SUBJECT IS
--     THE INVITEE. Where the subject is the INVITER the address is a THIRD
--     PARTY'S and is left alone — the same PO decision 0207 records for
--     caretaker_email (0207:420-421).
--   · `invited_by_user_id` / `accepted_by_user_id` — KEPT, both of them. They
--     are opaque actor FKs onto a profile this same RPC has just soft-deleted
--     and anonymised, so the personal data is already gone at the referent;
--     what remains is "some account granted this access", which is the trail
--     itself. Identical posture to pet_caretaker_grants.caretaker_user_id
--     (0207:422-426) and to pet_transfers' actor FKs.
--   · Outstanding PENDING invitations are REVOKED, on both sides. An
--     unanswered invite addressed to an erased subject is an open door onto
--     their address; an unanswered invite SENT by an erased subject lets a
--     stranger accept membership on the authority of an account that no longer
--     exists — the same reasoning 0205 gives for cancelling the grants the
--     subject sent (0207:402-405).
--
-- NOTE: `accepted_by_user_id` is a THIRD subject link this table has and the
-- KNOWN_GAP note did not mention (it named only `email` and
-- `invited_by_user_id`). It matters: once an invitation is accepted the invitee
-- is identified by FK, not only by an address, so the export and the email
-- scrub both reach rows the email match alone would miss.
--
-- WHY invitation_token IS EXCLUDED FROM THE EXPORT
-- ---------------------------------------------------------------------------
-- It is a live bearer credential: whoever holds it can accept the invitation.
-- `export_subject_data` is callable by an admin over another subject
-- (pii.caller_is_admin), so returning it would turn an art. 14 access request
-- into a working key to an organization. Same exclusion, same reason, as
-- `activation_code_hash` in 0170 and `p256dh` / `auth` in 0205. The token is
-- NOT scrubbed on erase — `revoked_at` is the gate the acceptance path checks,
-- and the token is a random string, not the subject's personal data.
--
-- ORDERING INSIDE THE ERASE, AND WHY IT IS NOT COSMETIC
-- ---------------------------------------------------------------------------
-- The invitation revoke matches the subject BY EMAIL; the sentinel then
-- overwrites that email. Run the sentinel first and the revoke finds nothing.
-- Revokes precede the sentinel. This is the same trap 0205 documented for
-- pet_caretaker_grants, and it is the reason that file says the order is
-- load-bearing.
--
-- THE EMAIL SENTINEL vs org_invitations_active_unique — CHECKED, NOT ASSUMED
-- ---------------------------------------------------------------------------
-- That partial unique index is on (organization_id, lower(email)) WHERE
-- accepted_at IS NULL AND revoked_at IS NULL, so two erased subjects in the
-- same organization would collide on 'erased@invalid.local' if both rows were
-- still inside the predicate. A unique violation inside a SECURITY DEFINER
-- compliance function would abort the whole erasure, so this was checked
-- rather than assumed:
--
--   · rows reached by the EMAIL branch — statement 1 has already revoked every
--     active one, so they are outside the predicate. Airtight.
--   · rows reached by `accepted_by_user_id` — outside the predicate as long as
--     `accepted_at` is also set. Nothing in the SCHEMA enforces that pairing:
--     there is no CHECK constraint tying the two columns (verified against the
--     live catalogue — the table carries only its PK, the token UNIQUE and
--     three FKs). The coupling is application discipline in the accept path,
--     and the live database holds ZERO rows with accepted_by_user_id set and
--     accepted_at NULL.
--
-- So this is safe on every row that exists, and it is safe by CONSTRUCTION on
-- the email side only. A future writer that stamps accepted_by_user_id without
-- accepted_at would reintroduce the risk. Said here instead of claiming an
-- impossibility the schema does not actually give us.
--
-- WHAT IS UNREACHABLE, STATED RATHER THAN PRETENDED
-- ---------------------------------------------------------------------------
-- A PENDING invitation addressed to a subject by email alone, where
-- `auth.users.email` can no longer be read for that subject, is matched by
-- nothing here: there is no FK to fall back on until the invitation is
-- accepted. `subject_email IS NULL` is guarded rather than silently coerced,
-- and the PART C backfill counts only what it CAN see.
--
-- IDEMPOTENCY: every statement is predicated on the un-scrubbed state, so a
-- re-run counts zero. The two DELETEs are idempotent by construction.
--
-- Everything else in both functions is copied verbatim — the export from 0205,
-- the erase from 0207. Forward-only CREATE OR REPLACE. search_path pinned
-- (0114); the REVOKE PUBLIC / REVOKE anon / GRANT authenticated trio is
-- replayed after each replace — `anon` needs its OWN revoke because Supabase's
-- init grants EXECUTE to it directly and `REVOKE ALL FROM PUBLIC` does not
-- reach a direct grant (0114:47-48).
--
-- export_subject_data schema_version 4 → 5 (three new sections).

-- ============================================================================
-- PART 0 — INVENTORY. What the backfills in PART C are about to find.
--
-- Inventory BEFORE the change, for the reason 0205 gives: a backfill over an
-- environment that was hand-patched reports "UPDATE 0" and reads exactly like a
-- backfill that had nothing to do.
-- ============================================================================

DO $inventory$
DECLARE
  n_watermarks_erased      bigint;
  n_tag_interest_erased    bigint;
  n_invites_by_erased      bigint;
  n_invites_accepted_erased bigint;
BEGIN
  SELECT count(*) INTO n_watermarks_erased
    FROM public.operator_feed_watermarks w
    JOIN public.profiles pr ON pr.id = w.user_id
   WHERE pr.deleted_at IS NOT NULL;

  SELECT count(*) INTO n_tag_interest_erased
    FROM public.physical_tag_interest ti
    JOIN public.profiles pr ON pr.id = ti.user_id
   WHERE pr.deleted_at IS NOT NULL;

  SELECT count(*) INTO n_invites_by_erased
    FROM public.organization_invitations oi
    JOIN public.profiles pr ON pr.id = oi.invited_by_user_id
   WHERE pr.deleted_at IS NOT NULL
     AND oi.accepted_at IS NULL
     AND oi.revoked_at IS NULL;

  SELECT count(*) INTO n_invites_accepted_erased
    FROM public.organization_invitations oi
    JOIN public.profiles pr ON pr.id = oi.accepted_by_user_id
   WHERE pr.deleted_at IS NOT NULL
     AND oi.email <> 'erased@invalid.local';

  RAISE NOTICE '0208 inventory — operator_feed_watermarks rows of erased subjects: %', n_watermarks_erased;
  RAISE NOTICE '0208 inventory — physical_tag_interest rows of erased subjects: %', n_tag_interest_erased;
  RAISE NOTICE '0208 inventory — outstanding invitations sent by erased subjects: %', n_invites_by_erased;
  RAISE NOTICE '0208 inventory — invitations accepted by erased subjects still holding their email: %', n_invites_accepted_erased;
  RAISE NOTICE '0208 inventory — NOT COUNTED (unreachable): pending invitations addressed by email alone to a subject whose auth email is gone.';
END;
$inventory$;

-- ============================================================================
-- PART A — export_subject_data: art. 14 access, schema_version 5
--
-- 0205's definition verbatim plus three sections:
-- operator_feed_watermarks, physical_tag_interest, organization_invitations.
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
-- PART B — erase_subject_data: art. 16 suppression, three gaps closed.
--
-- 0207's definition verbatim plus:
--   · DECLARE `watermarks_deleted`, `tag_interest_deleted`,
--     `invites_to_subject_revoked`, `invites_by_subject_revoked`,
--     `invites_email_scrubbed`;
--   · the two DELETEs and the three invitation statements (after the
--     org_contact_messages scrub);
--   · five new keys in the subject_erasure audit payload.
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
      'push_subscriptions_deleted', push_subs_deleted,
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
-- PART C — BACKFILL. What older definitions left behind.
--
-- Soundness argument, the same one 0205 PART C and 0207 PART B rest on:
-- `erase_subject_data` is the only writer of `profiles.deleted_at`, so a
-- soft-deleted profile IS an erased subject and every row below belongs to one.
--
-- The email-only population is NOT reachable and is not claimed: a pending
-- invitation addressed to an erased subject by address alone has no FK to that
-- subject, and their `auth.users` row was deleted by the caller after the RPC
-- ran. PART 0 counts what these statements can see, and says so.
-- ============================================================================

DO $backfill$
DECLARE
  n_watermarks int;
  n_interest   int;
  n_invites    int;
  n_emails     int;
BEGIN
  -- C1 — watermarks of erased subjects.
  WITH removed AS (
    DELETE FROM public.operator_feed_watermarks w
     USING public.profiles pr
     WHERE pr.id = w.user_id
       AND pr.deleted_at IS NOT NULL
    RETURNING w.user_id
  )
  SELECT count(*) INTO n_watermarks FROM removed;

  -- C2 — tag-interest rows of erased subjects.
  WITH removed AS (
    DELETE FROM public.physical_tag_interest ti
     USING public.profiles pr
     WHERE pr.id = ti.user_id
       AND pr.deleted_at IS NOT NULL
    RETURNING ti.id
  )
  SELECT count(*) INTO n_interest FROM removed;

  -- C3 — outstanding invitations sent by an erased subject. Same reasoning as
  -- statement 2 of the RPC: an unanswered invite on a dead account's authority.
  WITH revoked AS (
    UPDATE public.organization_invitations oi
       SET revoked_at = now()
      FROM public.profiles pr
     WHERE pr.id = oi.invited_by_user_id
       AND pr.deleted_at IS NOT NULL
       AND oi.accepted_at IS NULL
       AND oi.revoked_at IS NULL
    RETURNING oi.id
  )
  SELECT count(*) INTO n_invites FROM revoked;

  -- C4 — the email on invitations an erased subject ACCEPTED. Reachable only
  -- through accepted_by_user_id, which is exactly why the RPC above matches on
  -- it and not on the address alone. Every row here has accepted_at NOT NULL,
  -- so none is inside org_invitations_active_unique.
  WITH scrubbed AS (
    UPDATE public.organization_invitations oi
       SET email = 'erased@invalid.local'
      FROM public.profiles pr
     WHERE pr.id = oi.accepted_by_user_id
       AND pr.deleted_at IS NOT NULL
       AND oi.email <> 'erased@invalid.local'
    RETURNING oi.id
  )
  SELECT count(*) INTO n_emails FROM scrubbed;

  RAISE NOTICE '0208 backfill — operator_feed_watermarks rows deleted for prior erasures: %', n_watermarks;
  RAISE NOTICE '0208 backfill — physical_tag_interest rows deleted for prior erasures: %', n_interest;
  RAISE NOTICE '0208 backfill — outstanding invitations revoked for prior erasures: %', n_invites;
  RAISE NOTICE '0208 backfill — accepted-invitation emails sentinelled for prior erasures: %', n_emails;
  RAISE NOTICE '0208 backfill — NOT REACHED (no FK): pending invitations addressed to an erased subject by email alone.';
END
$backfill$;
