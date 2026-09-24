-- Emergency contact + preferred vet on profiles — J-followup from Chunk J
-- pet detail v2 swap (#114). The <PetEmergencyCard> component takes these
-- as props but had no columns to read from until now.
-- Reference: app/(app)/mis-mascotas/[publicToken]/page.tsx TODO(J-followup)
-- Idempotent — safe to re-run.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS preferred_vet_name text,
  ADD COLUMN IF NOT EXISTS preferred_vet_phone text,
  ADD COLUMN IF NOT EXISTS emergency_contact_name text,
  ADD COLUMN IF NOT EXISTS emergency_contact_phone text;
