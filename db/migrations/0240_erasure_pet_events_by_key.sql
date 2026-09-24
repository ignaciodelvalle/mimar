-- Migration 0240 — art. 16 erasure of pet_events, classified by key (T3-A2b).
-- PROVISIONAL NUMBER: 0239 is claimed by T3-J1 in flight; recount the next
-- free integer when this lands.
--
-- THE PRINCIPLE (PO decision 5A, 2026-09-22)
-- ---------------------------------------------------------------------------
-- An erasure removes what belongs to the PERSON, never the pet's health or
-- compliance history. Vaccines, bites, castration, death, rabies observation,
-- seizures and microchips survive in full, including who signed them as a
-- professional. Contacts, private names, the person's own free text and
-- addresses inside those events are erased or anonymised.
--
-- WHAT WAS WRONG (0159 → 0228)
-- ---------------------------------------------------------------------------
-- erase_subject_data sentinel-redacted a fixed list of payload KEY NAMES
-- across EVERY event type on the subject's currently-owned pets, whoever wrote
-- the row:
--   · `reason` is prose on status_changed and an ENUM on microchip_replaced,
--     foster_ended, custody_transferred (both variants) and
--     custody_transfer_proposed. The sweep overwrote the enum with
--     '[dato removido]' and the row stopped validating against its own schema.
--     THOSE VALUES CANNOT BE RESTORED: no pre-image existed before 0235, and
--     0235's images never copy `reason` (not in its enum_keys). This migration
--     stops the destruction; it cannot undo it.
--   · it erased professional acts because the OWNER asked to be forgotten: a
--     vet's diagnosis, a rabies observation's closure note, a disease report's
--     clinical notes, a shelter's ineligibility notes.
--   · it missed personal data outside the list: note_added's finderName /
--     finderContact / message, incident_reported.injuries_summary and
--     victim_age_estimate, symptom_observed.free_text, the adoption
--     application's prose, credential_scanned's device location, insurance
--     data in pet_registered and pet_profile_updated.changes, amended copies in
--     event_amended.changes[].old/new, the notes column, and the precise
--     coordinates of incidents, sightings, loss reports and scans.
--   · it reached only the subject's CURRENT pets: what the subject wrote on a
--     pet they no longer own, or on somebody else's pet, was never touched.
--
-- WHAT THIS DOES
-- ---------------------------------------------------------------------------
-- A. pii.pet_event_redaction_rules — one row per (event type, key path) that
--    erasure transforms, seeded LITERALLY from
--    scripts/generate-pet-event-redaction-rules.ts, i.e. from the
--    classification in lib/events/payload-privacy.ts. Keys not listed are
--    compliance facts and are never touched. Column rules use a '#' key
--    ('#notes' for every type, '#location_lat/lng' per coarsened type).
--    lint:subject-rights compares the LIVE table with the TypeScript both ways.
-- B. pii.* helpers — pet_event_kept_author_roles, pet_event_verified_author_roles,
--    pet_event_author_kept, pet_event_code_pattern, try_uuid, victim_age_band,
--    redact_at, redact_changes_mirror, changes_mirror_type, payload_names_party,
--    pet_event_scopes, redacted_payload, redacted_notes, redacted_coordinate. search_path = '';
--    EXECUTE revoked from public, anon and authenticated.
-- C. erase_subject_data — 0228's definition VERBATIM except its two pet_events
--    blocks (0228:173-292), replaced by ONE UPDATE driven by a scope bitmask:
--      S1  (1) authored: recorded_by_user_id = subject, any pet, ever;
--      S1b (2) authored legacy: recorded_by_user_id IS NULL, author_role
--              'owner', occurred_at inside one of the subject's owner
--              intervals (ended ones included);
--      S2  (4) pet going dark: the subject's current owner pets (0228's set);
--      S3  (8) named party: a rule's party key names the subject — only the
--              keys ABOUT that person (adoption application, foster notes, …).
--    S1/S1b/S2 redact every personal_data key plus every author-gated key
--    whose row author is not kept (see the PO default below); S3 redacts only the
--    rules whose party key matches. Only rows that actually change are
--    updated, so a second run writes no override audit row.
--    Audit counters: events_pii_redacted now counts rows whose PAYLOAD
--    changed, events_free_text_redacted rows whose NOTES changed; new
--    pet_events_redacted (rows updated) and pet_events_redaction_by_scope.
-- D. Replay-time assertions: the rules table is non-empty and no rule targets
--    the enum `reason` of the four types above, nor any `*_id` key.
-- E. Backfill: every already-erased subject (profiles.deleted_at IS NOT NULL
--    AND display_name LIKE 'erased:%') is re-run through the new redaction
--    under a seeded system actor (00000000-0000-0000-0000-000000000240, the
--    0235 pattern). Asserted afterwards: a re-run would change nothing.
--
-- SECURITY REVIEW (fresh context, before landing) — what it changed:
--   · MACHINE CODES under prose keys survive. status_changed.reason
--     ('return_to_original_owner'), adoption_application_resolved.reason,
--     foster_proposal_resolved.cancellation_reason and
--     custody_transfer_cancelled.reason also carry codes; the sentinel never
--     overwrites a string matching pii.pet_event_code_pattern() (snake_case
--     with an underscore, no 5-digit run, <= 64 chars). The fence requires
--     every code a writer passes to be declared and code-shaped.
--   · An author gate never combines with party keys: adoption_reversed.reason
--     and custody_dispute_raised.reason are personal data of the party they
--     name; an official proceeding reference stays author-gated.
--   · The shelter's info request to an applicant has its own key,
--     note_added.info_request_message (party: the applicant). Legacy rows
--     carry it in `text`; the rule 'note_added:adoption_info_requested' (a
--     per-kind rule, applied when payload.kind matches) reaches them.
--   · PO DEFAULT on the author gate: a professional act is kept only when
--     author_role is vet / shelter / govt / system AND, for shelter,
--     author_verified is true (pii.pet_event_author_kept). An unverified org
--     member's words are personal data — the safe direction.
--   · COORDINATES FAIL CLOSED: every event type is classified in
--     COORDINATE_PRIVACY and all coarsen today, welfare reports included;
--     lint:subject-rights fails on a live type carrying a point that is not.
--   · Legacy keys no current schema declares (staging census 2026-09-22) are
--     classified too: viewer_name, notes, motives, found-at locations.
--   · victim_age_band: a number followed by "años" wins ("70 años y 2 meses"
--     is senior), then "meses", then the first 1-3 digit number.
--   · pii.pet_event_scopes prefilters the named-party scope on the direct
--     party keys and on referenced rows before evaluating rules per row.
--
-- APPEND-ONLY. Same override window as 0228 (app.allow_event_mutation +
-- actor), one pet_events_mutation_override audit row per changed row, written
-- by enforce_pet_events_append_only (NOT touched here; 0238 owns it and
-- db/triggers.sql). Its 0235/0238 allowlisted images copy no value this
-- migration redacts: every redacted key is prose, a dropped key, an object, an
-- array or a nullable enum outside enum_keys (housing_type, prior_pets,
-- victim_age_band); canKeepUntil does not match the case-sensitive `_until$`;
-- coordinates and notes are never imaged.
--
-- RESIDUALS THIS DOES NOT REACH (stated, not hidden)
--   · event_notification_outbox.payload_snapshot — a copy of the source
--     payload (scripts/check-subject-rights-coverage.ts: bothGap).
--   · other audit_log actions: decomiso writes judicial_ref into its own audit
--     payload (src/modules/decomiso/application/execute-decomiso.ts).
--   · notification bodies already delivered to OTHER people.

-- ============================================================================
-- PART A — the rules table
-- ============================================================================

create table if not exists pii.pet_event_redaction_rules (
  -- An event type; '<event_type>:<kind>' for a rule that applies only when
  -- payload.kind equals <kind>; 'pet_profile_updated.changes' for changelog
  -- fields; '*' for a column rule on every type.
  event_type   text    not null,
  key_path     text[]  not null check (cardinality(key_path) >= 1),
  transform    text    not null check (transform in (
                 'sentinel', 'drop', 'null', 'empty_array', 'age_band',
                 'coarsen_point', 'changes_mirror')),
  author_gated boolean not null default false,
  -- Payload keys naming the person the value is ABOUT (scope S3). 'a>b' means
  -- payload.b of the pet_events row whose id is payload.a.
  party_keys   text[],
  primary key (event_type, key_path)
);
alter table pii.pet_event_redaction_rules enable row level security;
revoke all on pii.pet_event_redaction_rules from public, anon, authenticated;

comment on table pii.pet_event_redaction_rules is
  'T3-A2b: what art. 16 erasure does to each pet_events payload key. Seeded from lib/events/payload-privacy.ts (scripts/generate-pet-event-redaction-rules.ts); lint:subject-rights compares both ways.';

-- Seeded from scripts/generate-pet-event-redaction-rules.ts — do not edit by
-- hand; change lib/events/payload-privacy.ts and re-seed in a new migration.
delete from pii.pet_event_redaction_rules;
insert into pii.pet_event_redaction_rules
  (event_type, key_path, transform, author_gated, party_keys)
values
  ('*', array['#notes'], 'sentinel', true, null),
  ('abandonment_reported', array['#location_lat'], 'coarsen_point', false, null),
  ('abandonment_reported', array['#location_lng'], 'coarsen_point', false, null),
  ('abandonment_reported', array['description'], 'sentinel', true, null),
  ('adoption_application_resolved', array['#location_lat'], 'coarsen_point', false, null),
  ('adoption_application_resolved', array['#location_lng'], 'coarsen_point', false, null),
  ('adoption_application_resolved', array['notes'], 'sentinel', false, array['application_event_id>applicant_user_id']),
  ('adoption_application_resolved', array['reason'], 'sentinel', false, array['application_event_id>applicant_user_id']),
  ('adoption_application_submitted', array['#location_lat'], 'coarsen_point', false, null),
  ('adoption_application_submitted', array['#location_lng'], 'coarsen_point', false, null),
  ('adoption_application_submitted', array['daily_routine'], 'sentinel', false, array['applicant_user_id']),
  ('adoption_application_submitted', array['housing_type'], 'null', false, array['applicant_user_id']),
  ('adoption_application_submitted', array['motivation'], 'sentinel', false, array['applicant_user_id']),
  ('adoption_application_submitted', array['notes'], 'sentinel', false, array['applicant_user_id']),
  ('adoption_application_submitted', array['other_pets'], 'sentinel', false, array['applicant_user_id']),
  ('adoption_application_submitted', array['prior_pets'], 'null', false, array['applicant_user_id']),
  ('adoption_eligibility_set', array['#location_lat'], 'coarsen_point', false, null),
  ('adoption_eligibility_set', array['#location_lng'], 'coarsen_point', false, null),
  ('adoption_eligibility_set', array['ineligible_reason_notes'], 'sentinel', true, null),
  ('adoption_eligibility_set', array['reason'], 'sentinel', true, null),
  ('adoption_finalized', array['#location_lat'], 'coarsen_point', false, null),
  ('adoption_finalized', array['#location_lng'], 'coarsen_point', false, null),
  ('adoption_finalized', array['notes'], 'sentinel', false, array['adopter_user_id', 'foster_user_id']),
  ('adoption_reversed', array['#location_lat'], 'coarsen_point', false, null),
  ('adoption_reversed', array['#location_lng'], 'coarsen_point', false, null),
  ('adoption_reversed', array['reason'], 'sentinel', false, array['reverted_finalization_event_id>adopter_user_id']),
  ('caretaker_designated', array['#location_lat'], 'coarsen_point', false, null),
  ('caretaker_designated', array['#location_lng'], 'coarsen_point', false, null),
  ('caretaker_designated', array['note'], 'sentinel', false, array['caretaker_user_id']),
  ('caretaker_ended', array['#location_lat'], 'coarsen_point', false, null),
  ('caretaker_ended', array['#location_lng'], 'coarsen_point', false, null),
  ('clinical_info_logged', array['#location_lat'], 'coarsen_point', false, null),
  ('clinical_info_logged', array['#location_lng'], 'coarsen_point', false, null),
  ('clinical_info_logged', array['details'], 'sentinel', true, null),
  ('clinical_info_logged', array['title'], 'sentinel', true, null),
  ('content_reported', array['#location_lat'], 'coarsen_point', false, null),
  ('content_reported', array['#location_lng'], 'coarsen_point', false, null),
  ('content_reported', array['reason'], 'sentinel', false, null),
  ('credential_scanned', array['#location_lat'], 'coarsen_point', false, null),
  ('credential_scanned', array['#location_lng'], 'coarsen_point', false, null),
  ('credential_scanned', array['note'], 'sentinel', false, null),
  ('credential_scanned', array['scan_accuracy_m'], 'drop', false, null),
  ('credential_scanned', array['scan_coords'], 'drop', false, null),
  ('credential_scanned', array['scan_ip_area', 'city'], 'null', false, null),
  ('credential_scanned', array['viewer_name'], 'drop', false, null),
  ('custody_dispute_raised', array['#location_lat'], 'coarsen_point', false, null),
  ('custody_dispute_raised', array['#location_lng'], 'coarsen_point', false, null),
  ('custody_dispute_raised', array['external_proceeding_reference'], 'sentinel', true, null),
  ('custody_dispute_raised', array['motive'], 'sentinel', false, array['raised_by_user_id']),
  ('custody_dispute_raised', array['reason'], 'sentinel', false, array['raised_by_user_id']),
  ('custody_dispute_resolved', array['#location_lat'], 'coarsen_point', false, null),
  ('custody_dispute_resolved', array['#location_lng'], 'coarsen_point', false, null),
  ('custody_transfer_cancelled', array['#location_lat'], 'coarsen_point', false, null),
  ('custody_transfer_cancelled', array['#location_lng'], 'coarsen_point', false, null),
  ('custody_transfer_cancelled', array['reason'], 'sentinel', false, null),
  ('custody_transfer_proposed', array['#location_lat'], 'coarsen_point', false, null),
  ('custody_transfer_proposed', array['#location_lng'], 'coarsen_point', false, null),
  ('custody_transfer_proposed', array['notes'], 'sentinel', false, array['from_user_id', 'to_user_id']),
  ('custody_transferred', array['#location_lat'], 'coarsen_point', false, null),
  ('custody_transferred', array['#location_lng'], 'coarsen_point', false, null),
  ('custody_transferred', array['notes'], 'sentinel', false, array['from_user_id', 'to_user_id']),
  ('dangerous_breed_attested', array['#location_lat'], 'coarsen_point', false, null),
  ('dangerous_breed_attested', array['#location_lng'], 'coarsen_point', false, null),
  ('death_recorded', array['#location_lat'], 'coarsen_point', false, null),
  ('death_recorded', array['#location_lng'], 'coarsen_point', false, null),
  ('death_recorded', array['cause_detail'], 'sentinel', true, null),
  ('deworming_administered', array['#location_lat'], 'coarsen_point', false, null),
  ('deworming_administered', array['#location_lng'], 'coarsen_point', false, null),
  ('disease_reported', array['#location_lat'], 'coarsen_point', false, null),
  ('disease_reported', array['#location_lng'], 'coarsen_point', false, null),
  ('disease_reported', array['clinical_notes'], 'sentinel', true, null),
  ('event_amended', array['#location_lat'], 'coarsen_point', false, null),
  ('event_amended', array['#location_lng'], 'coarsen_point', false, null),
  ('event_amended', array['changes', '[]', 'new'], 'changes_mirror', false, null),
  ('event_amended', array['changes', '[]', 'old'], 'changes_mirror', false, null),
  ('event_amended', array['reason'], 'sentinel', true, null),
  ('foster_assigned', array['#location_lat'], 'coarsen_point', false, null),
  ('foster_assigned', array['#location_lng'], 'coarsen_point', false, null),
  ('foster_assigned', array['notes'], 'sentinel', false, array['foster_user_id']),
  ('foster_co_foster_allowed', array['#location_lat'], 'coarsen_point', false, null),
  ('foster_co_foster_allowed', array['#location_lng'], 'coarsen_point', false, null),
  ('foster_co_foster_allowed', array['reason'], 'sentinel', false, null),
  ('foster_ended', array['#location_lat'], 'coarsen_point', false, null),
  ('foster_ended', array['#location_lng'], 'coarsen_point', false, null),
  ('foster_ended', array['notes'], 'sentinel', false, array['foster_user_id']),
  ('foster_proposal_resolved', array['#location_lat'], 'coarsen_point', false, null),
  ('foster_proposal_resolved', array['#location_lng'], 'coarsen_point', false, null),
  ('foster_proposal_resolved', array['cancellation_reason'], 'sentinel', false, null),
  ('foster_proposal_resolved', array['response_notes'], 'sentinel', false, null),
  ('foster_proposed', array['#location_lat'], 'coarsen_point', false, null),
  ('foster_proposed', array['#location_lng'], 'coarsen_point', false, null),
  ('foster_proposed', array['match_warnings'], 'empty_array', false, array['volunteer_user_id']),
  ('foster_proposed', array['reason'], 'sentinel', false, array['volunteer_user_id']),
  ('incident_reported', array['#location_lat'], 'coarsen_point', false, null),
  ('incident_reported', array['#location_lng'], 'coarsen_point', false, null),
  ('incident_reported', array['context'], 'sentinel', true, null),
  ('incident_reported', array['injuries_summary'], 'sentinel', false, null),
  ('incident_reported', array['location_description'], 'sentinel', false, null),
  ('incident_reported', array['victim_age_estimate'], 'age_band', false, null),
  ('incident_reported', array['victim_contact_name'], 'drop', false, null),
  ('incident_reported', array['victim_contact_phone'], 'drop', false, null),
  ('maltreatment_reported', array['#location_lat'], 'coarsen_point', false, null),
  ('maltreatment_reported', array['#location_lng'], 'coarsen_point', false, null),
  ('maltreatment_reported', array['description'], 'sentinel', true, null),
  ('medication_dose_taken', array['#location_lat'], 'coarsen_point', false, null),
  ('medication_dose_taken', array['#location_lng'], 'coarsen_point', false, null),
  ('medication_started', array['#location_lat'], 'coarsen_point', false, null),
  ('medication_started', array['#location_lng'], 'coarsen_point', false, null),
  ('medication_stopped', array['#location_lat'], 'coarsen_point', false, null),
  ('medication_stopped', array['#location_lng'], 'coarsen_point', false, null),
  ('medication_stopped', array['reason'], 'sentinel', true, null),
  ('microchip_implanted', array['#location_lat'], 'coarsen_point', false, null),
  ('microchip_implanted', array['#location_lng'], 'coarsen_point', false, null),
  ('microchip_implanted', array['note'], 'sentinel', true, null),
  ('microchip_replaced', array['#location_lat'], 'coarsen_point', false, null),
  ('microchip_replaced', array['#location_lng'], 'coarsen_point', false, null),
  ('microchip_replaced', array['notes'], 'sentinel', true, null),
  ('movement_recorded', array['#location_lat'], 'coarsen_point', false, null),
  ('movement_recorded', array['#location_lng'], 'coarsen_point', false, null),
  ('movement_recorded', array['purpose'], 'sentinel', true, null),
  ('movement_recorded', array['reason'], 'sentinel', true, null),
  ('note_added:adoption_info_requested', array['text'], 'sentinel', false, array['application_event_id>applicant_user_id']),
  ('note_added', array['#location_lat'], 'coarsen_point', false, null),
  ('note_added', array['#location_lng'], 'coarsen_point', false, null),
  ('note_added', array['author'], 'sentinel', false, null),
  ('note_added', array['canKeepUntil'], 'drop', false, null),
  ('note_added', array['finderContact'], 'drop', false, null),
  ('note_added', array['finderName'], 'drop', false, null),
  ('note_added', array['info_request_message'], 'sentinel', false, array['application_event_id>applicant_user_id']),
  ('note_added', array['location_description'], 'sentinel', false, null),
  ('note_added', array['message'], 'sentinel', false, null),
  ('note_added', array['text'], 'sentinel', true, null),
  ('outbreak_signal', array['#location_lat'], 'coarsen_point', false, null),
  ('outbreak_signal', array['#location_lng'], 'coarsen_point', false, null),
  ('ownership_claimed', array['#location_lat'], 'coarsen_point', false, null),
  ('ownership_claimed', array['#location_lng'], 'coarsen_point', false, null),
  ('pet_profile_updated.changes', array['insurance_company'], 'null', false, null),
  ('pet_profile_updated.changes', array['insurance_policy_number'], 'null', false, null),
  ('pet_profile_updated.changes', array['permanent_conditions_other'], 'sentinel', false, null),
  ('pet_profile_updated', array['#location_lat'], 'coarsen_point', false, null),
  ('pet_profile_updated', array['#location_lng'], 'coarsen_point', false, null),
  ('pet_profile_updated', array['changes', '[]', 'new'], 'changes_mirror', false, null),
  ('pet_profile_updated', array['changes', '[]', 'old'], 'changes_mirror', false, null),
  ('pet_registered', array['#location_lat'], 'coarsen_point', false, null),
  ('pet_registered', array['#location_lng'], 'coarsen_point', false, null),
  ('pet_registered', array['insurance_company'], 'null', false, null),
  ('pet_registered', array['insurance_policy_number'], 'null', false, null),
  ('pet_registered', array['note'], 'sentinel', false, null),
  ('post_adoption_checkin', array['#location_lat'], 'coarsen_point', false, null),
  ('post_adoption_checkin', array['#location_lng'], 'coarsen_point', false, null),
  ('post_adoption_checkin', array['notes'], 'sentinel', false, null),
  ('rabies_observation_ended', array['#location_lat'], 'coarsen_point', false, null),
  ('rabies_observation_ended', array['#location_lng'], 'coarsen_point', false, null),
  ('rabies_observation_ended', array['closure_notes'], 'sentinel', true, null),
  ('rabies_observation_ended', array['notes'], 'sentinel', true, null),
  ('rabies_observation_started', array['#location_lat'], 'coarsen_point', false, null),
  ('rabies_observation_started', array['#location_lng'], 'coarsen_point', false, null),
  ('rehome_sponsorship_ended', array['#location_lat'], 'coarsen_point', false, null),
  ('rehome_sponsorship_ended', array['#location_lng'], 'coarsen_point', false, null),
  ('rehome_sponsorship_started', array['#location_lat'], 'coarsen_point', false, null),
  ('rehome_sponsorship_started', array['#location_lng'], 'coarsen_point', false, null),
  ('rehome_sponsorship_started', array['note'], 'sentinel', false, null),
  ('shelter_intake_recorded', array['#location_lat'], 'coarsen_point', false, null),
  ('shelter_intake_recorded', array['#location_lng'], 'coarsen_point', false, null),
  ('shelter_intake_recorded', array['intake_condition'], 'sentinel', true, null),
  ('shelter_intake_recorded', array['judicial_proceeding_reference'], 'sentinel', true, null),
  ('shelter_intake_recorded', array['location_description'], 'sentinel', false, null),
  ('shelter_intake_recorded', array['location_found'], 'sentinel', false, null),
  ('shelter_intake_recorded', array['notes'], 'sentinel', true, null),
  ('shelter_intake_recorded', array['seizure_motive_other_detail'], 'sentinel', true, null),
  ('status_changed', array['#location_lat'], 'coarsen_point', false, null),
  ('status_changed', array['#location_lng'], 'coarsen_point', false, null),
  ('status_changed', array['location_description'], 'sentinel', false, null),
  ('status_changed', array['lost_description', 'accessories_when_lost'], 'sentinel', false, null),
  ('status_changed', array['lost_description', 'behavior_notes'], 'sentinel', false, null),
  ('status_changed', array['lost_description', 'last_seen_context'], 'sentinel', false, null),
  ('status_changed', array['reason'], 'sentinel', false, null),
  ('sterilization_performed', array['#location_lat'], 'coarsen_point', false, null),
  ('sterilization_performed', array['#location_lng'], 'coarsen_point', false, null),
  ('sterilization_performed', array['notes'], 'sentinel', true, null),
  ('symptom_observed', array['#location_lat'], 'coarsen_point', false, null),
  ('symptom_observed', array['#location_lng'], 'coarsen_point', false, null),
  ('symptom_observed', array['free_text'], 'sentinel', true, null),
  ('tag_activated', array['#location_lat'], 'coarsen_point', false, null),
  ('tag_activated', array['#location_lng'], 'coarsen_point', false, null),
  ('tag_revoked', array['#location_lat'], 'coarsen_point', false, null),
  ('tag_revoked', array['#location_lng'], 'coarsen_point', false, null),
  ('tattoo_recorded', array['#location_lat'], 'coarsen_point', false, null),
  ('tattoo_recorded', array['#location_lng'], 'coarsen_point', false, null),
  ('tattoo_recorded', array['description'], 'sentinel', true, null),
  ('tattoo_updated', array['#location_lat'], 'coarsen_point', false, null),
  ('tattoo_updated', array['#location_lng'], 'coarsen_point', false, null),
  ('tattoo_updated', array['reason'], 'sentinel', true, null),
  ('vaccination_administered', array['#location_lat'], 'coarsen_point', false, null),
  ('vaccination_administered', array['#location_lng'], 'coarsen_point', false, null),
  ('vet_visit_logged', array['#location_lat'], 'coarsen_point', false, null),
  ('vet_visit_logged', array['#location_lng'], 'coarsen_point', false, null),
  ('vet_visit_logged', array['diagnosis'], 'sentinel', true, null),
  ('vet_visit_logged', array['reason'], 'sentinel', true, null),
  ('weight_recorded', array['#location_lat'], 'coarsen_point', false, null),
  ('weight_recorded', array['#location_lng'], 'coarsen_point', false, null);

-- ============================================================================
-- PART B — helpers (schema pii: no USAGE for anon/authenticated)
-- ============================================================================

-- author_role values whose professional acts survive erasure. Must equal
-- KEPT_AUTHOR_ROLES in lib/events/payload-privacy.ts (lint:subject-rights).
create or replace function pii.pet_event_kept_author_roles()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['vet', 'shelter', 'govt', 'system']::text[]
$$;

-- Kept roles that ALSO need author_verified = true. Must equal
-- VERIFICATION_REQUIRED_ROLES (lint:subject-rights). An unverified org member
-- writes as 'shelter'; an unverified org is not an institution whose record
-- outlives the person, so its words are treated as personal data.
create or replace function pii.pet_event_verified_author_roles()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['shelter']::text[]
$$;

-- Is this row's author one whose author-gated keys are a kept professional act?
create or replace function pii.pet_event_author_kept(p_author_role text, p_author_verified boolean)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_author_role = any(pii.pet_event_kept_author_roles())
     and (not (p_author_role = any(pii.pet_event_verified_author_roles()))
          or coalesce(p_author_verified, false))
$$;

-- A MACHINE CODE a writer stores under a prose key ('return_to_original_owner').
-- The sentinel never overwrites a string of this shape (at most 64 chars): it
-- is a code, not a person's words. Lowercase snake_case with at least one
-- underscore (a single lowercase word could be a first name), no run of five
-- or more digits (a phone number). Must equal CODE_PATTERN (lint:subject-rights).
create or replace function pii.pet_event_code_pattern()
returns text
language sql
immutable
set search_path = ''
as $$
  select '^[a-z](?!.*[0-9]{5,})[a-z0-9]*(_[a-z0-9]+)+$'::text
$$;

create or replace function pii.try_uuid(p_text text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when p_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then p_text::uuid
  end
$$;

-- Coarse age band from a free-text victim age. Precedence:
--   1. a number followed by "año(s)"/"anio(s)" — "70 años y 2 meses" is 70;
--   2. "mes"/"meses" with no years — an infant ("18 meses");
--   3. the first run of 1 to 3 digits.
-- <15 child, <=64 adult, <=120 senior; anything else is 'unknown'.
create or replace function pii.victim_age_band(p_text text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  digits text;
  n int;
begin
  if p_text is null then
    return null;
  end if;
  digits := (regexp_match(p_text, '([0-9]{1,3})\s*(a(ñ|n|ni)os?)\M', 'i'))[1];
  if digits is null then
    if p_text ~* '\mmes(es)?\M' then
      return 'child_under_15';
    end if;
    digits := substring(p_text from '[0-9]+');
    if digits is null or length(digits) > 3 then
      return 'unknown';
    end if;
  end if;
  n := digits::int;
  if n < 15 then
    return 'child_under_15';
  elsif n <= 64 then
    return 'adult_15_64';
  elsif n <= 120 then
    return 'senior_65_plus';
  end if;
  return 'unknown';
end;
$$;

-- Apply one transform at one key path. '[]' steps into every array element.
-- A missing key, a JSON null or a value that is already redacted is left as
-- it is, so a second run changes nothing.
--   sentinel     — any non-null value that is not already the sentinel and is
--                  not a MACHINE CODE (pii.pet_event_code_pattern()).
--   drop         — remove the key.
--   null         — set JSON null.
--   empty_array  — set [] (a non-null value that is not already []).
--   age_band     — set the `*_age_band` sibling once from the text, then
--                  sentinel the text.
create or replace function pii.redact_at(p_value jsonb, p_path text[], p_transform text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  k text := p_path[1];
  rest text[] := p_path[2:];
  v jsonb;
  band_key text;
  sentinel constant text := '[dato removido]';
begin
  if p_value is null or k is null then
    return p_value;
  end if;

  if k = '[]' then
    if jsonb_typeof(p_value) <> 'array' then
      return p_value;
    end if;
    return (
      select coalesce(jsonb_agg(pii.redact_at(t.e, rest, p_transform) order by t.o), '[]'::jsonb)
        from jsonb_array_elements(p_value) with ordinality as t(e, o)
    );
  end if;

  if jsonb_typeof(p_value) <> 'object' or not (p_value ? k) then
    return p_value;
  end if;
  v := p_value -> k;

  if cardinality(rest) > 0 then
    return jsonb_set(p_value, array[k], pii.redact_at(v, rest, p_transform));
  end if;

  case p_transform
    when 'sentinel' then
      if jsonb_typeof(v) <> 'null'
         and v is distinct from to_jsonb(sentinel)
         and not (jsonb_typeof(v) = 'string'
                  and length(v #>> '{}') <= 64
                  and (v #>> '{}') ~ pii.pet_event_code_pattern()) then
        return jsonb_set(p_value, array[k], to_jsonb(sentinel));
      end if;
    when 'drop' then
      return p_value - k;
    when 'null' then
      if jsonb_typeof(v) <> 'null' then
        return jsonb_set(p_value, array[k], 'null'::jsonb);
      end if;
    when 'empty_array' then
      if jsonb_typeof(v) <> 'null' and v <> '[]'::jsonb then
        return jsonb_set(p_value, array[k], '[]'::jsonb);
      end if;
    when 'age_band' then
      if jsonb_typeof(v) <> 'null' and v is distinct from to_jsonb(sentinel) then
        band_key := regexp_replace(k, '_age_estimate$', '_age_band');
        if band_key <> k
           and (not (p_value ? band_key) or jsonb_typeof(p_value -> band_key) = 'null')
           and jsonb_typeof(v) = 'string' then
          p_value := p_value || jsonb_build_object(band_key, pii.victim_age_band(v #>> '{}'));
        end if;
        return jsonb_set(p_value, array[k], to_jsonb(sentinel));
      end if;
    else
      null;
  end case;
  return p_value;
end;
$$;

-- The namespace whose rules classify a changelog's `field` values:
-- pet_profile_updated's own field namespace, or the event type an
-- event_amended row corrects.
create or replace function pii.changes_mirror_type(p_event_type text, p_payload jsonb)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  t text;
begin
  if p_event_type = 'pet_profile_updated' then
    return 'pet_profile_updated.changes';
  end if;
  if p_event_type = 'event_amended' then
    select e.event_type into t
      from public.pet_events e
     where e.id = pii.try_uuid(p_payload ->> 'target_event_id');
    return t;
  end if;
  return null;
end;
$$;

-- changes[].old / changes[].new take the class of the field they record. The
-- mirrored rule's own author gate is read against THIS row's author (an
-- amendment by a vet keeps a vet's words). drop and age_band become null and
-- sentinel: a changelog value has no sibling to band and no optional key.
create or replace function pii.redact_changes_mirror(
  p_payload jsonb,
  p_path text[],
  p_mirror_type text,
  p_author_kept boolean
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  arr_key text := p_path[1];
  leaf text := p_path[3];
  out_arr jsonb;
begin
  if p_mirror_type is null or cardinality(p_path) <> 3 or p_path[2] <> '[]'
     or jsonb_typeof(p_payload -> arr_key) is distinct from 'array' then
    return p_payload;
  end if;
  select coalesce(jsonb_agg(
           case
             when r.transform is null or (r.author_gated and p_author_kept) then t.e
             else pii.redact_at(
                    t.e,
                    array[leaf],
                    case r.transform
                      when 'drop' then 'null'
                      when 'age_band' then 'sentinel'
                      else r.transform
                    end)
           end
           order by t.o), '[]'::jsonb)
    into out_arr
    from jsonb_array_elements(p_payload -> arr_key) with ordinality as t(e, o)
    left join pii.pet_event_redaction_rules r
      on r.event_type = p_mirror_type
     and r.key_path = array[t.e ->> 'field'];
  return jsonb_set(p_payload, array[arr_key], out_arr);
end;
$$;

-- Does any of these party keys name the subject? 'a>b' dereferences payload.a
-- to another pet_events row and reads its payload.b. Plain SQL, so the planner
-- sees the direct comparison before it ever follows a reference.
create or replace function pii.payload_names_party(p_payload jsonb, p_keys text[], p_subject uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(p_subject is not null
    and jsonb_typeof(p_payload) = 'object'
    and exists (
      select 1
        from unnest(p_keys) as k(key)
       where case
               when position('>' in k.key) = 0
                 then p_payload ->> k.key = p_subject::text
               else exists (
                 select 1 from public.pet_events t
                  where t.id = pii.try_uuid(p_payload ->> split_part(k.key, '>', 1))
                    and t.payload ->> split_part(k.key, '>', 2) = p_subject::text)
             end
    ), false)
$$;

-- The rows an erasure of p_subject reaches, with the scope bitmask that
-- reached each: 1 authored, 2 authored legacy, 4 pet going dark, 8 named party.
-- The named-party branch prefilters on the direct party keys (payload->>key =
-- subject) and on the ids of rows that name the subject directly, before any
-- per-row rule evaluation.
create or replace function pii.pet_event_scopes(p_subject uuid)
returns table (event_id uuid, scopes int)
language sql
stable
set search_path = ''
as $$
  with owned_now as (
    select o.pet_id
      from public.ownerships o
     where o.owner_user_id = p_subject
       and o.role = 'owner'
       and o.ended_at is null
  ),
  owned_ever as (
    select o.pet_id, o.started_at, o.ended_at
      from public.ownerships o
     where o.owner_user_id = p_subject
       and o.role = 'owner'
  ),
  party_rules as (
    select split_part(r.event_type, ':', 1) as base_type, r.party_keys
      from pii.pet_event_redaction_rules r
     where r.party_keys is not null
  ),
  direct_keys as (
    select distinct pr.base_type, k.key
      from party_rules pr cross join unnest(pr.party_keys) as k(key)
     where position('>' in k.key) = 0
  ),
  ref_keys as (
    select distinct pr.base_type,
           split_part(k.key, '>', 1) as ref_key,
           split_part(k.key, '>', 2) as inner_key
      from party_rules pr cross join unnest(pr.party_keys) as k(key)
     where position('>' in k.key) > 0
  ),
  named_direct as (
    select e.id
      from public.pet_events e
      join direct_keys d on d.base_type = e.event_type
     where e.payload ->> d.key = p_subject::text
  ),
  named_by_ref as (
    select e.id
      from ref_keys rk
      join public.pet_events e on e.event_type = rk.base_type
      join public.pet_events t on t.id = pii.try_uuid(e.payload ->> rk.ref_key)
     where t.payload ->> rk.inner_key = p_subject::text
  ),
  named as (
    select id from named_direct
    union
    select id from named_by_ref
  ),
  candidate_ids as (
    select e.id from public.pet_events e where e.recorded_by_user_id = p_subject
    union
    select e.id from public.pet_events e where e.pet_id in (select pet_id from owned_now)
    union
    select e.id
      from public.pet_events e
     where e.recorded_by_user_id is null
       and e.author_role = 'owner'
       and e.pet_id in (select pet_id from owned_ever)
    union
    select id from named
  ),
  scored as (
    select e.id,
           (case when e.recorded_by_user_id = p_subject then 1 else 0 end)
         | (case when e.recorded_by_user_id is null
                  and e.author_role = 'owner'
                  and exists (
                    select 1 from owned_ever w
                     where w.pet_id = e.pet_id
                       and e.occurred_at >= w.started_at
                       and (w.ended_at is null or e.occurred_at <= w.ended_at))
                 then 2 else 0 end)
         | (case when e.pet_id in (select pet_id from owned_now) then 4 else 0 end)
         | (case when e.id in (select id from named) then 8 else 0 end) as scopes
      from public.pet_events e
     where e.id in (select id from candidate_ids)
  )
  select s.id, s.scopes from scored s where s.scopes <> 0
$$;

-- The payload an erasure leaves behind for one row. Rules of the event type
-- apply, plus the '<event_type>:<kind>' rules when payload.kind matches.
create or replace function pii.redacted_payload(
  p_event_type text,
  p_author_role text,
  p_author_verified boolean,
  p_payload jsonb,
  p_scopes int,
  p_subject uuid
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  r record;
  result jsonb := p_payload;
  author_kept boolean := pii.pet_event_author_kept(p_author_role, p_author_verified);
  broad boolean := (coalesce(p_scopes, 0) & 7) <> 0;
  mirror_type text;
  mirror_resolved boolean := false;
begin
  if coalesce(p_scopes, 0) = 0 or jsonb_typeof(p_payload) is distinct from 'object' then
    return p_payload;
  end if;
  for r in
    select x.key_path, x.transform, x.author_gated, x.party_keys
      from pii.pet_event_redaction_rules x
     where (x.event_type = p_event_type
            or x.event_type = p_event_type || ':' || coalesce(p_payload ->> 'kind', ''))
       and left(x.key_path[1], 1) <> '#'
     order by x.event_type, x.key_path
  loop
    continue when r.author_gated and author_kept;
    -- The party check reads the ORIGINAL payload: party keys are uuids and
    -- compliance facts, never rewritten.
    continue when not broad and not pii.payload_names_party(p_payload, r.party_keys, p_subject);
    if r.transform = 'changes_mirror' then
      if not mirror_resolved then
        mirror_type := pii.changes_mirror_type(p_event_type, p_payload);
        mirror_resolved := true;
      end if;
      result := pii.redact_changes_mirror(result, r.key_path, mirror_type, author_kept);
    else
      result := pii.redact_at(result, r.key_path, r.transform);
    end if;
  end loop;
  return result;
end;
$$;

-- The notes column: a professional act when a kept (and, for shelter,
-- verified) author wrote the row, the sentinel otherwise. Only the broad
-- scopes reach it.
create or replace function pii.redacted_notes(
  p_event_type text,
  p_author_role text,
  p_author_verified boolean,
  p_notes text,
  p_scopes int
)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_notes is null
      or p_notes = '[dato removido]'
      or (coalesce(p_scopes, 0) & 7) = 0 then p_notes
    when exists (
      select 1 from pii.pet_event_redaction_rules r
       where r.event_type in ('*', p_event_type)
         and r.key_path = array['#notes']
         and r.transform = 'sentinel'
         and not (r.author_gated and pii.pet_event_author_kept(p_author_role, p_author_verified))
    ) then '[dato removido]'
    else p_notes
  end
$$;

-- location_lat / location_lng: rounded to 2 decimals (~1.1 km) on every event
-- type COORDINATE_PRIVACY marks 'coarsen'. Only the broad scopes reach it.
create or replace function pii.redacted_coordinate(
  p_event_type text,
  p_column text,
  p_value numeric,
  p_scopes int
)
returns numeric
language sql
stable
set search_path = ''
as $$
  select case
    when p_value is null or (coalesce(p_scopes, 0) & 7) = 0 then p_value
    when exists (
      select 1 from pii.pet_event_redaction_rules r
       where r.event_type = p_event_type
         and r.key_path = array['#' || p_column]
         and r.transform = 'coarsen_point'
    ) then round(p_value, 2)
    else p_value
  end
$$;

revoke all on function pii.pet_event_kept_author_roles() from public, anon, authenticated;
revoke all on function pii.pet_event_verified_author_roles() from public, anon, authenticated;
revoke all on function pii.pet_event_author_kept(text, boolean) from public, anon, authenticated;
revoke all on function pii.pet_event_code_pattern() from public, anon, authenticated;
revoke all on function pii.try_uuid(text) from public, anon, authenticated;
revoke all on function pii.victim_age_band(text) from public, anon, authenticated;
revoke all on function pii.redact_at(jsonb, text[], text) from public, anon, authenticated;
revoke all on function pii.changes_mirror_type(text, jsonb) from public, anon, authenticated;
revoke all on function pii.redact_changes_mirror(jsonb, text[], text, boolean) from public, anon, authenticated;
revoke all on function pii.payload_names_party(jsonb, text[], uuid) from public, anon, authenticated;
revoke all on function pii.pet_event_scopes(uuid) from public, anon, authenticated;
revoke all on function pii.redacted_payload(text, text, boolean, jsonb, int, uuid) from public, anon, authenticated;
revoke all on function pii.redacted_notes(text, text, boolean, text, int) from public, anon, authenticated;
revoke all on function pii.redacted_coordinate(text, text, numeric, int) from public, anon, authenticated;

-- ============================================================================
-- PART D — replay-time assertions on the rules
-- ============================================================================

do $$
declare
  n int;
  bad text;
begin
  select count(*) into n from pii.pet_event_redaction_rules;
  if n = 0 then
    raise exception '0240: pii.pet_event_redaction_rules is empty — erasure would redact nothing';
  end if;

  -- The enum `reason` 0159-0228 destroyed must never be a target again.
  select string_agg(r.event_type || '.' || array_to_string(r.key_path, '.'), ', ') into bad
    from pii.pet_event_redaction_rules r
   where split_part(r.event_type, ':', 1) in ('microchip_replaced', 'foster_ended',
                          'custody_transferred', 'custody_transfer_proposed')
     and r.key_path = array['reason'];
  if bad is not null then
    raise exception '0240: a rule targets an enum reason (a compliance fact): %', bad;
  end if;

  -- An identifier is never personal data to redact: it is the link the
  -- anonymised profile hangs from.
  select string_agg(r.event_type || '.' || array_to_string(r.key_path, '.'), ', ') into bad
    from pii.pet_event_redaction_rules r
   where r.key_path[cardinality(r.key_path)] ~ '(_id|Id)$';
  if bad is not null then
    raise exception '0240: a rule targets an identifier key: %', bad;
  end if;

  -- The code guard must hold on the codes writers really store.
  if 'return_to_original_owner' !~ pii.pet_event_code_pattern()
     or 'Se escapó por el portón' ~ pii.pet_event_code_pattern()
     or 'juan' ~ pii.pet_event_code_pattern() then
    raise exception '0240: pii.pet_event_code_pattern() does not separate codes from prose';
  end if;
end $$;

-- ============================================================================
-- PART C — erase_subject_data: 0228's definition, pet_events classified by key
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
-- PART E — backfill the subjects erased before this migration
-- ============================================================================
-- Their pet_events went through 0228's key-name sweep (or an older one) and
-- still hold everything that sweep missed. Same UPDATE as PART C, under a
-- seeded system actor, one subject at a time. The enum `reason` values the
-- old sweep destroyed stay destroyed — there is no pre-image to restore from.

insert into public.profiles (id, role, display_name, is_system, created_at, updated_at)
values (
  '00000000-0000-0000-0000-000000000240',
  'admin',
  'system:pet-events-erasure-backfill',
  true,
  now(),
  now()
)
on conflict (id) do update set is_system = true;

do $$
declare
  subject uuid;
  n int;
  total int := 0;
begin
  perform set_config('app.allow_event_mutation', 'true', true);
  perform set_config('app.allow_event_mutation_actor', '00000000-0000-0000-0000-000000000240', true);

  for subject in
    select p.id from public.profiles p
     where p.deleted_at is not null
       and p.display_name like 'erased:%'
     order by p.id
  loop
    with computed as (
      select e.id,
             e.payload      as old_payload,
             e.notes        as old_notes,
             e.location_lat as old_lat,
             e.location_lng as old_lng,
             pii.redacted_payload(e.event_type, e.author_role::text, e.author_verified, e.payload, s.scopes, subject) as new_payload,
             pii.redacted_notes(e.event_type, e.author_role::text, e.author_verified, e.notes, s.scopes) as new_notes,
             pii.redacted_coordinate(e.event_type, 'location_lat', e.location_lat, s.scopes) as new_lat,
             pii.redacted_coordinate(e.event_type, 'location_lng', e.location_lng, s.scopes) as new_lng
        from pii.pet_event_scopes(subject) s
        join public.pet_events e on e.id = s.event_id
    ),
    changed as (
      select c.* from computed c
       where c.new_payload is distinct from c.old_payload
          or c.new_notes is distinct from c.old_notes
          or c.new_lat is distinct from c.old_lat
          or c.new_lng is distinct from c.old_lng
    ),
    redacted as (
      update public.pet_events e
         set payload      = ch.new_payload,
             notes        = ch.new_notes,
             location_lat = ch.new_lat,
             location_lng = ch.new_lng
        from changed ch
       where e.id = ch.id
      returning e.id
    )
    select count(*) into n from redacted;
    total := total + n;
  end loop;

  perform set_config('app.allow_event_mutation', 'false', true);
  perform set_config('app.allow_event_mutation_actor', '', true);
  raise notice '0240: backfill redacted % pet_events row(s) of already-erased subjects', total;
end $$;

-- REPLAY-TIME ASSERTION — after the backfill, re-running the redaction for any
-- already-erased subject changes nothing.
do $$
declare
  leftover int;
begin
  select count(*) into leftover
    from public.profiles p
    cross join lateral pii.pet_event_scopes(p.id) s
    join public.pet_events e on e.id = s.event_id
   where p.deleted_at is not null
     and p.display_name like 'erased:%'
     and (pii.redacted_payload(e.event_type, e.author_role::text, e.author_verified, e.payload, s.scopes, p.id)
            is distinct from e.payload
          or pii.redacted_notes(e.event_type, e.author_role::text, e.author_verified, e.notes, s.scopes)
            is distinct from e.notes
          or pii.redacted_coordinate(e.event_type, 'location_lat', e.location_lat, s.scopes)
            is distinct from e.location_lat
          or pii.redacted_coordinate(e.event_type, 'location_lng', e.location_lng, s.scopes)
            is distinct from e.location_lng);
  if leftover <> 0 then
    raise exception '0240: % pet_events row(s) of already-erased subjects still hold redactable data', leftover;
  end if;
end $$;
