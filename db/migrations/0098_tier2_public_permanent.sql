-- Tier 2 público permanente — boolean flag for no-expiry share option
--
-- The existing tier2_public_enabled_until timestamp covers bounded windows
-- (24h / 7d / 30d). A NULL value reads as inactive on the public page, so
-- a dedicated boolean is required for the "siempre visible" (permanent,
-- no-expiry) option that shows the medical summary indefinitely until the
-- owner explicitly revokes it.
--
-- Active when tier2_public_permanent = true, regardless of
-- tier2_public_enabled_until.  Revocation sets both columns off
-- (tier2_public_permanent = false, tier2_public_enabled_until = null).
--
-- Privacy boundary: identical to the bounded window — no owner contact,
-- address, DNI, or free-text notes are exposed.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.pets
  ADD COLUMN IF NOT EXISTS tier2_public_permanent boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.pets.tier2_public_permanent IS
  'When true, the public credential at /p/[publicToken] permanently reveals the curated medical summary, regardless of tier2_public_enabled_until. Set by enableTier2PublicAction when duration="siempre", cleared by revokeTier2PublicAction.';
