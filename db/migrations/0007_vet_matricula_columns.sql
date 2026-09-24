-- DIM profiles — vet matricula columns
-- Adds matricula_number (nullable, unique when present),
-- matricula_jurisdiccion (the province/jurisdiction that issued the
-- matricula — admins need this to verify against the right registry),
-- and matricula_verified flag so vets can submit their professional ID
-- for admin review before role='vet' is granted.

ALTER TABLE profiles
  ADD COLUMN matricula_number TEXT,
  ADD COLUMN matricula_jurisdiccion TEXT,
  ADD COLUMN matricula_verified BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX profiles_matricula_unique_when_present
  ON profiles (matricula_number)
  WHERE matricula_number IS NOT NULL;
