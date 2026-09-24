-- Migration 0158 — pets: align disclose_*_when_lost column DEFAULTs with the
-- affirmative-consent model (defense in depth, cursor privacy P4).
--
-- THE GAP
-- -------
-- disclose_first_name_when_lost / disclose_phone_when_lost /
-- disclose_last_location_when_lost DEFAULTed to true (the old hardcoded
-- Tier 1 reveal), while MarkLostWizard's DISCLOSURE_DEFAULTS (the only
-- production caller of setPetLostAction) present all owner-PII toggles OFF
-- and always submits explicit true/false values. As long as every write path
-- goes through the wizard this is harmless — but the DB default is the last
-- line of defense for any insert/update path that skips it (a future admin
-- tool, a script, a bug in a future writer). A permissive DEFAULT there means
-- such a path silently republishes owner PII on the public credential.
--
-- THE FIX
-- -------
-- ALTER the three PII-disclosing columns' DEFAULT to false, matching the
-- wizard. disclose_email_when_lost is already false; allow_finder_form_when_lost
-- stays true (it exposes no owner PII — see MarkLostWizard's own comment: "The
-- finder form starts ON because it exposes no owner data").
--
-- SCOPE — column DEFAULT only, no backfill. Existing pet rows keep whatever
-- value they currently hold; this migration does not touch data, only the
-- DEFAULT applied to future inserts that omit these columns. A data backfill
-- would require distinguishing "owner explicitly chose true" from "never
-- touched, inherited the old default", which this migration cannot do safely
-- and is out of scope here.
--
-- Companion app-side fix (same batch): src/modules/events/actions.ts
-- parseDisclosurePrefsFromForm now fails CLOSED (returns all-false) when the
-- disclosure form section is absent, instead of falling back to the pet's
-- current (possibly permissive) prefs.

BEGIN;

ALTER TABLE public.pets
  ALTER COLUMN disclose_first_name_when_lost SET DEFAULT false,
  ALTER COLUMN disclose_phone_when_lost SET DEFAULT false,
  ALTER COLUMN disclose_last_location_when_lost SET DEFAULT false;

COMMIT;
