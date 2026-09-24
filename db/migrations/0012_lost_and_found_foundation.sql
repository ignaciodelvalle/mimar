-- Lost & Found — schema foundation (Fase 1)
-- Adds per-field disclosure preference columns on pets, a defensive lookup
-- index on microchip_id, and the receives_broadcasts opt-in column on
-- organization_memberships (Fase 6 broadcast fanout will filter on it).
--
-- All columns use ADD COLUMN IF NOT EXISTS for idempotency.

-- 1) Per-field disclosure preferences on pets.
--    Defaults reflect the current hardcoded Tier 1 reveal behaviour (first
--    name + phone + last_location + finder_form true; email false). Existing
--    rows receive the defaults automatically — no data migration required.
ALTER TABLE public.pets
  ADD COLUMN IF NOT EXISTS disclose_first_name_when_lost    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS disclose_phone_when_lost         BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS disclose_email_when_lost         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS disclose_last_location_when_lost BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allow_finder_form_when_lost      BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.pets.disclose_first_name_when_lost IS
  'Owner-controlled disclosure pref: show owner first name on public credential when pet is lost.';
COMMENT ON COLUMN public.pets.disclose_phone_when_lost IS
  'Owner-controlled disclosure pref: show phone with tel: link on public credential when pet is lost.';
COMMENT ON COLUMN public.pets.disclose_email_when_lost IS
  'Owner-controlled disclosure pref: show email with mailto: link on public credential when pet is lost.';
COMMENT ON COLUMN public.pets.disclose_last_location_when_lost IS
  'Owner-controlled disclosure pref: show last known location on public credential when pet is lost.';
COMMENT ON COLUMN public.pets.allow_finder_form_when_lost IS
  'Owner-controlled disclosure pref: enable the FoundPetForm on the public credential when pet is lost.';

-- 2) Defensive partial index on pets.microchip_id for cross-check lookups.
--    The unique partial index already created in 0000 covers uniqueness; this
--    is an explicit named index for clarity in query plans.
CREATE INDEX IF NOT EXISTS pets_microchip_lookup_idx
  ON public.pets (microchip_id)
  WHERE microchip_id IS NOT NULL;

-- 3) Broadcast opt-in flag on organization_memberships.
--    Fase 6 will filter on this when fanning out lost_pet_broadcast notifications.
--    Default true: all existing members opt in. Members can opt out individually.
ALTER TABLE public.organization_memberships
  ADD COLUMN IF NOT EXISTS receives_broadcasts BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.organization_memberships.receives_broadcasts IS
  'Opt-in flag: member receives lost_pet_broadcast notifications when a lost pet is reported in their org coverage jurisdiction.';

-- Reverse (documented, not run in production):
-- ALTER TABLE public.pets
--   DROP COLUMN IF EXISTS disclose_first_name_when_lost,
--   DROP COLUMN IF EXISTS disclose_phone_when_lost,
--   DROP COLUMN IF EXISTS disclose_email_when_lost,
--   DROP COLUMN IF EXISTS disclose_last_location_when_lost,
--   DROP COLUMN IF EXISTS allow_finder_form_when_lost;
-- DROP INDEX IF EXISTS pets_microchip_lookup_idx;
-- ALTER TABLE public.organization_memberships
--   DROP COLUMN IF EXISTS receives_broadcasts;
