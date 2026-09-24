-- ---------------------------------------------------------------------------
-- P2 — per-pet emergency contact / preferred vet override (owner-ia-redesign)
-- ---------------------------------------------------------------------------
-- PO decision 2 (2026-07-13): emergency contacts become "per-pet override +
-- account default". The account-level defaults already live on `profiles`
-- (preferred_vet_name / preferred_vet_phone / emergency_contact_name /
-- emergency_contact_phone, migration 0042). These 4 additive, nullable
-- columns mirror them on `pets` so an owner can override the contacts for a
-- single pet; when a pet column is NULL the profile-level value is shown
-- instead (fallback resolved in lib/domain/emergency-contacts.ts).
--
-- Additive only — no drops. New columns ride the existing pets row-level
-- policies (scoped by ownership); a per-pet UI preference needs no policy of
-- its own. Like the sibling pets.disclose_*_when_lost / emergency_info_visible
-- flags, editing these does NOT emit a pet event — they are display prefs.

ALTER TABLE pets
  ADD COLUMN IF NOT EXISTS preferred_vet_name text,
  ADD COLUMN IF NOT EXISTS preferred_vet_phone text,
  ADD COLUMN IF NOT EXISTS emergency_contact_name text,
  ADD COLUMN IF NOT EXISTS emergency_contact_phone text;
