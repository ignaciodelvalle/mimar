-- Tier 2 público temporal — owner opt-in window
--
-- Adds a single timestamp column to `pets` that, when in the future, lets
-- the public credential at /p/[token] reveal a curated medical summary
-- (vaccines vigentes, sterilization, active medication, permanent
-- conditions) beyond the Tier 0 identity rollups it normally shows.
--
-- v1 hardcodes the window to 24 hours via enableTier2PublicAction; the
-- mockup proposes 24h / 7d / 30d / always-on but only 24h is enabled in
-- the UI for the initial release. The longer durations stay rendered as
-- disabled cards so users see the roadmap.
--
-- Privacy boundary: this never exposes owner contact, address, DNI, or
-- free-text notes. It only widens the medical projection of the existing
-- public credential.
--
-- Idempotent — safe to re-run.

ALTER TABLE pets
  ADD COLUMN IF NOT EXISTS tier2_public_enabled_until timestamptz;

COMMENT ON COLUMN pets.tier2_public_enabled_until IS
  'When non-null and > now(), the public credential at /p/[publicToken] reveals a curated medical summary. Set by enableTier2PublicAction, cleared by revokeTier2PublicAction or naturally by expiration. v1 always sets +24h.';
