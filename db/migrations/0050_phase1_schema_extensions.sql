-- Phase 1 schema extensions (handoff P1-1 + P1-2 + P1-3).
--
-- Three independent extensions, kept together because they're all small,
-- additive, and unblock Phase 2 (refugio público).
--
-- P1-1: organizations gets 6 public-profile columns + 2 CHECK constraints.
-- P1-2: profiles gets 4 global disclosure prefs.
-- P1-3: service_offerings gets is_public (default false, privacy-first).
--
-- All columns are idempotent (IF NOT EXISTS) so the migration can re-run
-- against a partially-applied database. CHECK constraints use a guard
-- DO block because Postgres lacks `ADD CONSTRAINT IF NOT EXISTS`.

-- ---------------------------------------------------------------------------
-- P1-1 — organizations public-profile fields
-- ---------------------------------------------------------------------------

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS logo_storage_path text,
  ADD COLUMN IF NOT EXISTS disclose_address boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS donation_methods jsonb,
  ADD COLUMN IF NOT EXISTS latitude numeric(9, 6),
  ADD COLUMN IF NOT EXISTS longitude numeric(9, 6);

COMMENT ON COLUMN organizations.description IS
  'Free-text description surfaced on /refugios/[orgToken]. Capped at 2000 chars by CHECK.';
COMMENT ON COLUMN organizations.logo_storage_path IS
  'Supabase Storage key for the org logo. Resolved client-side via signed URL.';
COMMENT ON COLUMN organizations.disclose_address IS
  'When false, /refugios/[orgToken] omits the LocationPanel — for rescue networks operating from private homes.';
COMMENT ON COLUMN organizations.donation_methods IS
  'JSONB blob: { cbu?, cvu?, alias?, mpLink?, btcAddress? }. Only present keys render on the donate sheet.';
COMMENT ON COLUMN organizations.latitude IS
  'Decimal latitude (WGS84). Must be set in pair with longitude (enforced by CHECK).';
COMMENT ON COLUMN organizations.longitude IS
  'Decimal longitude (WGS84). Must be set in pair with latitude (enforced by CHECK).';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organizations_description_length_check'
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_description_length_check
      CHECK (description IS NULL OR length(description) <= 2000);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organizations_coordinates_pair_check'
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_coordinates_pair_check
      CHECK ((latitude IS NULL) = (longitude IS NULL));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- P1-2 — profiles global disclosure prefs
-- ---------------------------------------------------------------------------

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS disclose_name_credential boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS disclose_phone_credential boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_org_contact boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allow_lost_alerts_in_zone boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN profiles.disclose_name_credential IS
  'Show owner name on the public credential / scan card. Privacy-first default: false.';
COMMENT ON COLUMN profiles.disclose_phone_credential IS
  'Show owner phone on the public credential. Privacy-first default: false.';
COMMENT ON COLUMN profiles.allow_org_contact IS
  'Let shelters / clinics initiate contact for adoption replies, follow-ups. Default true (opt-in to community help).';
COMMENT ON COLUMN profiles.allow_lost_alerts_in_zone IS
  'Receive notifications when other pets in your zone are marked lost. Default true (community-help posture).';

-- ---------------------------------------------------------------------------
-- P1-3 — service_offerings.is_public
-- ---------------------------------------------------------------------------

ALTER TABLE service_offerings
  ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN service_offerings.is_public IS
  'Whether the offering surfaces on /refugios/[orgToken]. Default false (privacy-first); owner opts in via the org-side form.';
