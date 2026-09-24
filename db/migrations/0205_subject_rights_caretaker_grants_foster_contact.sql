-- Migration 0205 — five live Ley 25.326 gaps in the subject-rights RPCs.
-- (arts. 14 y 16. Supersedes the coverage written by 0170.)
--
-- THE GAPS
-- --------
--  1. `pet_caretaker_grants` (0189) was in NEITHER RPC. AGENTS.md §6b called it
--     an open hole in as many words. `caretaker_email` is a NOT NULL cleartext
--     address belonging to a person who may have no account at all, and `note`
--     is free text the GRANTOR writes about a third party's household.
--  2. `foster_volunteers` was in NEITHER RPC: the subject's own declared
--     jurisdiction, household composition and free-text notes.
--  3. `profiles.jurisdiction_province` / `_locality` survived erasure — and are
--     collected with no purpose at all (see PART C1).
--  4. `pets.emergency_contact_*` / `preferred_vet_*` / `insurance_*` survived
--     erasure. The RPC has nulled the PROFILE-level defaults since 0059; the
--     per-pet mirrors of the same fields were never touched.
--  5. `org_contact_messages.submitter_ip` (a raw caller IP with no reader
--     anywhere) and `.message` (the subject's own free text) survived erasure;
--     the whole table was absent from the export.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES *NOT* DO
-- ----------------------------------------------
-- It does NOT flip an ACCEPTED `pet_caretaker_grants` row to 'ended'. That is
-- not timidity, it is invariant #3. Ending an accepted arrangement is THREE
-- writes that must land together — close the `ownerships` row, emit
-- `caretaker_ended`, flip the grant — and there is exactly one definition of
-- them: `endCaretakerGrantAtomically()` in lib/infra/end-pet-ownerships.ts,
-- which exists precisely because a second copy of that invariant is the drift
-- this repo keeps paying for. A status flip in SQL with no event would leave a
-- grant the spine cannot explain: `detect-pet-cache-drift` reports it as
-- `pet_caretaker_ownership_drift`, `rederive-pet-ownerships` reports the
-- ownership row's `ended_at` as unmatched, and `lib/projections/pet-caretaker.ts`
-- would show the interval open forever. So the ENDING happens in
-- src/modules/auth/application/subject-rights/erase-subject-data.ts, through
-- that one writer, BEFORE this RPC is called.
--
-- The split is the domain's own, not a compromise. `lib/infra/end-pet-ownerships.ts`
-- states it: "ACCEPTED → ended, through the atomic three-step. The arrangement
-- happened, so the spine owes an ending fact. PENDING → cancelled, a plain
-- status flip with no event. `pending` is workflow state, not a fact about the
-- animal." Everything on the PENDING side of that line is done here; nothing on
-- the ACCEPTED side is.
--
-- CONSEQUENCE, SAID OUT LOUD: a caller that invokes this RPC WITHOUT going
-- through eraseMySubjectDataAction (an admin at a psql prompt) scrubs the PII
-- and leaves the arrangement open. There is no such path in the app today —
-- `rg "rpc\(\"erase_subject_data"` finds exactly one call site — and the fence
-- in PART D asserts the invariant this RPC can actually uphold, not one it
-- cannot.
--
-- THE FIX
-- -------
--   · export_subject_data: adds `pet_caretaker_grants`, `foster_volunteers`,
--     `org_contact_messages` and `push_subscriptions`. schema_version 3 → 4.
--   · erase_subject_data: the caretaker-grant PII scrub + pending flips, the
--     foster_volunteers row DELETE, the profile jurisdiction NULL, the per-pet
--     contact/vet/insurance scrub, and submitter_ip + message on
--     org_contact_messages. Seven new counters in the subject_erasure payload.
--   · Backfills for every subject already erased under the old definitions.
--
-- WHY push_subscriptions IS IN THE EXPORT NOW. erase_subject_data has DELETED
-- those rows outright since 0166, and art. 14 never returned them: the subject
-- could not see what art. 16 was about to destroy. `p256dh` and `auth` are
-- EXCLUDED from the projection, the same move 0170 made for
-- `activation_code_hash` — they are the RFC 8291 content-encryption keys, and
-- without them the `endpoint` that stays in the projection cannot be used to
-- deliver anything a browser will accept.
--
-- WHY `lower()` ON THE EMAIL MATCH. `pet_caretaker_grants.caretaker_email` is
-- lowercased at its single write path today (designate-caretaker.ts), but every
-- READ in that module decides "is this the same person" with
-- `caretakerEmail.toLowerCase() === viewer.email.toLowerCase()`. A compliance
-- function must use the app's own notion of identity, not a stricter one that
-- silently misses a row. Same reason the ORDER below is load-bearing.
--
-- The `pet_transfers` statements a few blocks down still compare `to_owner_email`
-- with a plain `=`, inherited verbatim from 0170. That asymmetry is deliberate
-- and it is LATENT, not live: `initiate-pet-transfer.ts` lowercases the address
-- at its single write path and `auth.users.email` is stored lowercased, so no
-- row the app can write is missed today. It is named here rather than silently
-- left as two adjacent predicates in one file that disagree — the day a second
-- writer appears, this is the paragraph that says which one is the bug.
--
-- WHAT AN ADVERSARIAL REVIEW CAUGHT BEFORE THIS FILE RAN ANYWHERE REAL. PART C2
-- was written without `o.ended_at IS NULL`, which would have nulled a LIVING
-- third party's contact data on a pet an erased user had merely transferred
-- away. Full reasoning at C2. The file was corrected in place rather than
-- superseded, because a corrective migration runs AFTER this one in the same
-- `pnpm db:migrate` invocation: it could not have un-nulled a column, only
-- apologised for it. 0205 had been applied to no environment but a local dev
-- database, whose ledger row was deleted and re-recorded so the checksum still
-- matches the bytes that ran.
--
-- ORDERING INSIDE THE ERASE, AND WHY IT IS NOT COSMETIC. The pending-invitation
-- flips match the subject BY EMAIL; the sentinel then overwrites that email.
-- Run the sentinel first and the flips find nothing. Flips precede the sentinel.
--
-- WHAT IS UNREACHABLE, STATED RATHER THAN PRETENDED. A grant whose invitee was
-- identified ONLY by an email address that a previous erasure already replaced
-- with the sentinel can no longer be linked back to that subject. The PART C
-- backfill cannot reach those rows and does not claim to; the inventory in
-- PART 0 counts what it CAN see.
--
-- IDEMPOTENCY: every statement below is predicated on the un-scrubbed state, so
-- a re-run counts zero. Verified for each block in __tests__/subject-rights-*.
--
-- Everything else in both functions is copied verbatim from 0170. Forward-only
-- CREATE OR REPLACE. search_path pinned (0114); the REVOKE PUBLIC / REVOKE anon
-- / GRANT authenticated trio is replayed after each replace — `anon` needs its
-- OWN revoke because Supabase's init grants EXECUTE to it directly and
-- `REVOKE ALL FROM PUBLIC` does not reach a direct grant (0114:47-48).

BEGIN;

-- ============================================================================
-- PART 0 — INVENTORY. What the backfills in PART C are about to find.
--
-- Inventory BEFORE the change, because in this repo a statement that reports
-- success and does nothing is a documented trap (the DROP POLICY lesson): a
-- backfill over an environment that was hand-patched reports "UPDATE 0" and
-- reads exactly like a backfill that had nothing to do.
-- ============================================================================

DO $inventory$
DECLARE
  n_profiles_jurisdiction_all     bigint;
  n_profiles_jurisdiction_erased  bigint;
  n_pets_contact                  bigint;
  n_grants_email                  bigint;
  n_grants_note                   bigint;
  n_foster                        bigint;
  n_contact_ip                    bigint;
  n_contact_message               bigint;
BEGIN
  SELECT count(*) INTO n_profiles_jurisdiction_all
    FROM public.profiles
   WHERE jurisdiction_province IS NOT NULL OR jurisdiction_locality IS NOT NULL;

  SELECT count(*) INTO n_profiles_jurisdiction_erased
    FROM public.profiles
   WHERE deleted_at IS NOT NULL
     AND (jurisdiction_province IS NOT NULL OR jurisdiction_locality IS NOT NULL);

  -- The predicate is THE SAME ONE the live RPC uses (see PART C2's header for
  -- why `o.ended_at IS NULL` is load-bearing rather than decorative). Counting
  -- with a wider predicate than the backfill applies would report a number
  -- nobody is about to act on.
  SELECT count(*) INTO n_pets_contact
    FROM public.pets p
   WHERE EXISTS (
           SELECT 1 FROM public.ownerships o
             JOIN public.profiles pr ON pr.id = o.owner_user_id
            WHERE o.pet_id = p.id AND o.role = 'owner' AND o.ended_at IS NULL
              AND pr.deleted_at IS NOT NULL
         )
     AND (p.emergency_contact_name IS NOT NULL OR p.emergency_contact_phone IS NOT NULL
          OR p.preferred_vet_name IS NOT NULL OR p.preferred_vet_phone IS NOT NULL
          OR p.insurance_company IS NOT NULL OR p.insurance_policy_number IS NOT NULL);

  SELECT count(*) INTO n_grants_email
    FROM public.pet_caretaker_grants g
    JOIN public.profiles pr ON pr.id = g.caretaker_user_id
   WHERE pr.deleted_at IS NOT NULL AND g.caretaker_email <> 'erased@invalid.local';

  SELECT count(*) INTO n_grants_note
    FROM public.pet_caretaker_grants g
    JOIN public.profiles pr ON pr.id = g.granted_by_user_id
   WHERE pr.deleted_at IS NOT NULL AND g.note IS NOT NULL;

  SELECT count(*) INTO n_foster
    FROM public.foster_volunteers fv
    JOIN public.profiles pr ON pr.id = fv.user_id
   WHERE pr.deleted_at IS NOT NULL;

  SELECT count(*) INTO n_contact_ip
    FROM public.org_contact_messages
   WHERE inquirer_email = 'erased@invalid.local' AND submitter_ip IS NOT NULL;

  SELECT count(*) INTO n_contact_message
    FROM public.org_contact_messages
   WHERE inquirer_email = 'erased@invalid.local'
     AND message <> '[contenido eliminado a pedido del titular]';

  RAISE NOTICE '0205 inventory — profiles with account jurisdiction: % total, % on already-erased profiles',
    n_profiles_jurisdiction_all, n_profiles_jurisdiction_erased;
  RAISE NOTICE '0205 inventory — pets of erased owners still carrying contact/vet/insurance data: %', n_pets_contact;
  RAISE NOTICE '0205 inventory — caretaker grants of erased invitees with a live email: %', n_grants_email;
  RAISE NOTICE '0205 inventory — caretaker grants of erased grantors with a note: %', n_grants_note;
  RAISE NOTICE '0205 inventory — foster_volunteers rows of erased subjects: %', n_foster;
  RAISE NOTICE '0205 inventory — already-erased org_contact_messages still holding an IP: %', n_contact_ip;
  RAISE NOTICE '0205 inventory — already-erased org_contact_messages still holding the message: %', n_contact_message;
  RAISE NOTICE '0205 inventory — NOT COUNTED (unreachable): grants whose invitee was identified only by an email a previous erasure already replaced.';
END;
$inventory$;

-- ============================================================================
-- PART A — export_subject_data: art. 14 access, schema_version 4
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
    'schema_version', 4,
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
-- PART B — erase_subject_data: art. 16 suppression, five gaps closed
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
      'contact_messages_scrubbed',  contact_msgs_scrubbed
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.erase_subject_data(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.erase_subject_data(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.erase_subject_data(uuid, text) TO authenticated;

-- ============================================================================
-- PART C — BACKFILLS. Every subject erased under an older definition.
--
-- The predicate for the subject-scoped ones is `profiles.deleted_at IS NOT NULL`.
-- That is sound because erase_subject_data is the only writer of that column:
-- no other migration and no application path sets profiles.deleted_at (the
-- retention_until columns are inert by explicit decision — see
-- lib/infra/data-lifecycle.ts and docs/architecture/retention-policy-pending-decision.md).
-- ============================================================================

-- C1 — profiles.jurisdiction_*: nulled for EVERY row, not only erased ones.
--
-- This is data minimisation, not erasure. The account-level jurisdiction had
-- exactly one writer and ZERO readers, and the public privacy page told users
-- it was used "para enrutar denuncias y estimar coberturas" — which is false of
-- the code and is corrected in the same change. Holding a personal datum for a
-- purpose that does not exist is itself a finalidad problem under art. 4, so
-- the honest fix is to stop collecting it and to drop what was collected.
--
-- WHY pets.jurisdiction_* IS NOT TOUCHED, by contrast, and must not be. Two
-- independent disqualifiers, either one sufficient: (a) it is a STRICT
-- rederivable projection (lib/projections/pet-jurisdiction.ts,
-- rederive-pet-cache.ts) — nulling it erases nothing and the next rederive
-- puts it back; (b) panorama and census aggregate soft-deleted pets with NO
-- deleted_at filter (lib/metrics/census.ts, repository-by-unit.ts), so nulling
-- would silently drop every erased owner's events out of official counts.
UPDATE public.profiles
   SET jurisdiction_province = NULL,
       jurisdiction_locality = NULL,
       updated_at            = now()
 WHERE jurisdiction_province IS NOT NULL
    OR jurisdiction_locality IS NOT NULL;

COMMENT ON COLUMN public.profiles.jurisdiction_province IS
  'INERT since migration 0205 — no longer collected and never read. The account-level jurisdiction had one writer (complete-identity.ts, removed in 0205) and zero readers: every aggregate, k-anonymity cell and routing path keys on pets.*, welfare_reports.*, service_offerings.*, govt_assignments.* or organizations.*. Kept as a column rather than dropped because export_subject_data projects the whole profile row; do not write to it.';

COMMENT ON COLUMN public.profiles.jurisdiction_locality IS
  'INERT since migration 0205 — see the comment on jurisdiction_province.';

-- C2 — pets of an erased owner still carrying owner-provided contact data.
--
-- THE PREDICATE IS DELIBERATELY IDENTICAL TO THE LIVE RPC'S (PART B, the
-- `pets_contact_scrubbed` statement): owner_user_id is an erased profile, the
-- role is 'owner', AND THE OWNERSHIP ROW IS STILL LIVE. The two must not drift,
-- and the `o.ended_at IS NULL` half is the whole reason to say so out loud —
-- it was MISSING from this backfill in the first cut, and an adversarial review
-- caught it before the file ran anywhere real.
--
-- What the missing filter did: `ownerships` keeps CLOSED rows forever, so an
-- EXISTS without `ended_at IS NULL` matches any pet that an erased profile once
-- owned. A transfers A -> B (accept closes A's owner row via
-- `closeOwnerOwnerships`), A later erases their account, and this statement
-- would then null B's CURRENT emergency contact, vet and insurance on B's own
-- animal. B asked for nothing, B is not the data subject, and a NULL is not
-- recoverable. That is the exact inversion of what an art. 16 backfill is for:
-- destroying a living third party's data in the name of somebody else's right.
--
-- Dropping the filter also gains nothing. `erase_subject_data` never ends an
-- ownership row, so every pet the backfill is meant to reach — an erased owner
-- whose row is still open — already satisfies the narrow predicate. The wide
-- one adds transferred-away pets and nothing else.
--
-- The values on such a transferred pet MAY be the erased ex-owner's stale
-- entries (a transfer does not clear these six columns), but this statement
-- cannot tell those from the new owner's own. "May be stale" is not a licence.
-- Cleaning them up belongs to a transfer-time decision, not to an erasure.
UPDATE public.pets p
   SET emergency_contact_name  = NULL,
       emergency_contact_phone = NULL,
       preferred_vet_name      = NULL,
       preferred_vet_phone     = NULL,
       insurance_company       = NULL,
       insurance_policy_number = NULL,
       updated_at              = now()
 WHERE EXISTS (
         SELECT 1
           FROM public.ownerships o
           JOIN public.profiles pr ON pr.id = o.owner_user_id
          WHERE o.pet_id = p.id
            AND o.role = 'owner'
            AND o.ended_at IS NULL
            AND pr.deleted_at IS NOT NULL
       )
   AND (p.emergency_contact_name IS NOT NULL
        OR p.emergency_contact_phone IS NOT NULL
        OR p.preferred_vet_name IS NOT NULL
        OR p.preferred_vet_phone IS NOT NULL
        OR p.insurance_company IS NOT NULL
        OR p.insurance_policy_number IS NOT NULL);

-- C3 — caretaker grants whose INVITEE has been erased: sentinel the email.
--      Reachable only through caretaker_user_id. A grant addressed to an email
--      that a previous erasure already replaced is unreachable by construction
--      and is NOT counted as fixed anywhere in this file.
UPDATE public.pet_caretaker_grants g
   SET caretaker_email = 'erased@invalid.local',
       updated_at      = now()
  FROM public.profiles pr
 WHERE pr.id = g.caretaker_user_id
   AND pr.deleted_at IS NOT NULL
   AND g.caretaker_email <> 'erased@invalid.local';

-- C4 — caretaker grants whose GRANTOR has been erased: drop the note.
UPDATE public.pet_caretaker_grants g
   SET note       = NULL,
       updated_at = now()
  FROM public.profiles pr
 WHERE pr.id = g.granted_by_user_id
   AND pr.deleted_at IS NOT NULL
   AND g.note IS NOT NULL;

-- C5 — foster_volunteers rows belonging to an erased subject.
DELETE FROM public.foster_volunteers fv
 USING public.profiles pr
 WHERE pr.id = fv.user_id
   AND pr.deleted_at IS NOT NULL;

-- C6 — org_contact_messages already sentinel-erased but still holding the raw
--      IP and the subject's own message. The sentinel email IS the marker that
--      a previous erase_subject_data ran over the row; there is no other link
--      back to the subject once inquirer_email has been replaced.
UPDATE public.org_contact_messages
   SET submitter_ip = NULL,
       message      = '[contenido eliminado a pedido del titular]'
 WHERE inquirer_email = 'erased@invalid.local'
   AND (submitter_ip IS NOT NULL
        OR message <> '[contenido eliminado a pedido del titular]');

-- ============================================================================
-- PART D — POST-CONDITION FENCE. Refuses to commit a migration that reported
-- success and changed nothing (0192's pattern).
-- ============================================================================

DO $fence$
DECLARE
  export_def text;
  erase_def  text;
  tbl        text;
  leftovers  bigint;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO export_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'export_subject_data';

  SELECT pg_get_functiondef(p.oid) INTO erase_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'erase_subject_data';

  IF export_def IS NULL OR erase_def IS NULL THEN
    RAISE EXCEPTION '0205 fence: one of the subject-rights RPCs is missing after the replace';
  END IF;

  -- D1 — every newly enumerated table is actually named in the live body.
  FOREACH tbl IN ARRAY ARRAY[
    'pet_caretaker_grants', 'foster_volunteers', 'org_contact_messages', 'push_subscriptions'
  ] LOOP
    IF position(tbl IN export_def) = 0 THEN
      RAISE EXCEPTION '0205 fence: export_subject_data does not mention %', tbl;
    END IF;
  END LOOP;

  FOREACH tbl IN ARRAY ARRAY[
    'pet_caretaker_grants', 'foster_volunteers', 'org_contact_messages'
  ] LOOP
    IF position(tbl IN erase_def) = 0 THEN
      RAISE EXCEPTION '0205 fence: erase_subject_data does not mention %', tbl;
    END IF;
  END LOOP;

  IF position('''schema_version'', 4' IN export_def) = 0 THEN
    RAISE EXCEPTION '0205 fence: export_subject_data did not bump schema_version to 4';
  END IF;

  IF position('jurisdiction_province    = NULL' IN erase_def) = 0 THEN
    RAISE EXCEPTION '0205 fence: erase_subject_data does not null profiles.jurisdiction_province';
  END IF;

  -- D2 — the REVOKE trio actually took. `anon` needs its own check: a direct
  -- grant survives REVOKE ALL FROM PUBLIC (0114), so "revoked from PUBLIC" is
  -- not evidence that the key shipped in the client bundle cannot call these.
  IF has_function_privilege('anon', 'public.export_subject_data(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0205 fence: anon can still EXECUTE export_subject_data';
  END IF;
  IF has_function_privilege('anon', 'public.erase_subject_data(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0205 fence: anon can still EXECUTE erase_subject_data';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.export_subject_data(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0205 fence: authenticated lost EXECUTE on export_subject_data';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.erase_subject_data(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0205 fence: authenticated lost EXECUTE on erase_subject_data';
  END IF;

  -- D3 — every backfill predicate is now empty.
  SELECT count(*) INTO leftovers FROM public.profiles
   WHERE jurisdiction_province IS NOT NULL OR jurisdiction_locality IS NOT NULL;
  IF leftovers > 0 THEN
    RAISE EXCEPTION '0205 fence: % profile(s) still carry an account jurisdiction', leftovers;
  END IF;

  -- Same predicate as C2 and as the live RPC, for the third time and on purpose:
  -- a fence that asserts a WIDER emptiness than the backfill produces would fail
  -- the migration over rows it deliberately does not touch.
  SELECT count(*) INTO leftovers
    FROM public.pets p
   WHERE EXISTS (
           SELECT 1 FROM public.ownerships o
             JOIN public.profiles pr ON pr.id = o.owner_user_id
            WHERE o.pet_id = p.id AND o.role = 'owner' AND o.ended_at IS NULL
              AND pr.deleted_at IS NOT NULL
         )
     AND (p.emergency_contact_name IS NOT NULL OR p.emergency_contact_phone IS NOT NULL
          OR p.preferred_vet_name IS NOT NULL OR p.preferred_vet_phone IS NOT NULL
          OR p.insurance_company IS NOT NULL OR p.insurance_policy_number IS NOT NULL);
  IF leftovers > 0 THEN
    RAISE EXCEPTION '0205 fence: % pet(s) of erased owners still carry contact data', leftovers;
  END IF;

  SELECT count(*) INTO leftovers
    FROM public.pet_caretaker_grants g JOIN public.profiles pr ON pr.id = g.caretaker_user_id
   WHERE pr.deleted_at IS NOT NULL AND g.caretaker_email <> 'erased@invalid.local';
  IF leftovers > 0 THEN
    RAISE EXCEPTION '0205 fence: % grant(s) still carry an erased invitee email', leftovers;
  END IF;

  SELECT count(*) INTO leftovers
    FROM public.pet_caretaker_grants g JOIN public.profiles pr ON pr.id = g.granted_by_user_id
   WHERE pr.deleted_at IS NOT NULL AND g.note IS NOT NULL;
  IF leftovers > 0 THEN
    RAISE EXCEPTION '0205 fence: % grant(s) still carry an erased grantor note', leftovers;
  END IF;

  SELECT count(*) INTO leftovers
    FROM public.foster_volunteers fv JOIN public.profiles pr ON pr.id = fv.user_id
   WHERE pr.deleted_at IS NOT NULL;
  IF leftovers > 0 THEN
    RAISE EXCEPTION '0205 fence: % foster_volunteers row(s) of erased subjects remain', leftovers;
  END IF;

  SELECT count(*) INTO leftovers
    FROM public.org_contact_messages
   WHERE inquirer_email = 'erased@invalid.local'
     AND (submitter_ip IS NOT NULL OR message <> '[contenido eliminado a pedido del titular]');
  IF leftovers > 0 THEN
    RAISE EXCEPTION '0205 fence: % erased contact message(s) still hold an IP or a body', leftovers;
  END IF;

  -- D4 — no caretaker ownership row left open under a TERMINAL grant. This is
  -- the zombie `caretakers-repository.ts` documents: a closed arrangement whose
  -- ownership row still grants write access on somebody else's animal and whose
  -- contact `caretaker-public-contact.ts` may still publish. Nothing in this
  -- migration can create one — the RPC never flips an accepted grant — so a
  -- non-zero count here means the environment already held one.
  SELECT count(*) INTO leftovers
    FROM public.pet_caretaker_grants g
    JOIN public.ownerships o ON o.id = g.ownership_id
   WHERE g.status IN ('ended', 'cancelled', 'rejected', 'expired')
     AND o.role = 'caretaker'
     AND o.ended_at IS NULL;
  IF leftovers > 0 THEN
    RAISE EXCEPTION '0205 fence: % caretaker ownership row(s) still open under a terminal grant', leftovers;
  END IF;

  RAISE NOTICE '0205 fence: all post-conditions hold.';
END;
$fence$;

COMMIT;
