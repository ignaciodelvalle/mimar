-- ---------------------------------------------------------------------------
-- P1-1 — drop dead global disclosure prefs (owner-ia-redesign, P1 item 1)
-- ---------------------------------------------------------------------------
-- These 4 columns (added by migration 0050) backed a /cuenta "Privacidad"
-- toggle section that claimed to control what the public credential shows
-- and who can contact the owner. It never wired into the public credential
-- page, the lost-alert notifier, or org-contact gating — the UI toggled
-- state nobody read. A privacy screen that claims control it doesn't have
-- is worse than no screen at all, so both the UI and the columns go.
--
-- NOT to be confused with the per-pet `pets.disclose_*_when_lost` columns
-- (migration 0012) — those back the ACTIVE MarkLostWizard/LostDisclosureCard
-- disclosure feature and are untouched by this migration.

ALTER TABLE profiles
  DROP COLUMN IF EXISTS disclose_name_credential,
  DROP COLUMN IF EXISTS disclose_phone_credential,
  DROP COLUMN IF EXISTS allow_org_contact,
  DROP COLUMN IF EXISTS allow_lost_alerts_in_zone;
