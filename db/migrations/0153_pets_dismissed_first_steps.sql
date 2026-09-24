-- Migration 0153 — pets.dismissed_first_steps: per-pet "Primeros pasos"
-- dismiss state (owner-onboarding train).
--
-- The owner pet profile shows a "Primeros pasos" onboarding checklist derived
-- live from the pet's own fields/ledger events (has photo? has microchip?
-- has vaccines? emergency contact set? disclosure prefs decided?). Every step
-- is optional and dismissible ("Omitir") — dismissing removes just that
-- nudge, it does NOT disable the underlying capability (the owner can still
-- add a photo, set disclosure prefs, etc. later via their normal surfaces).
--
-- This is a per-pet UI PREFERENCE, not a fact about the pet, so it is a
-- mutable column on `pets` — the SAME posture as the disclose_*_when_lost /
-- emergency_info_visible columns already on this table (migration 0037/0042):
-- changes here do NOT emit a pet_profile_updated event. Piggybacks on the
-- existing `pets` row instead of a new table — there is no other per-pet
-- prefs surface to reuse, and a single small array column is the smallest
-- option for a handful of step keys.
--
-- IDEMPOTENCY: ADD COLUMN IF NOT EXISTS. Safe to replay.

BEGIN;

ALTER TABLE public.pets
  ADD COLUMN IF NOT EXISTS dismissed_first_steps text[] NOT NULL DEFAULT '{}';

COMMIT;
