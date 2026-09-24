-- Migration 0160 — pets.seed_tag: internal, NON-RENDERED provenance marker
-- distinguishing a synthetic seeded pet from a real registration.
--
-- THE GAP
-- -------
-- There was NO column on `pets` that said "this row came from a seed script".
-- Provenance was inferred from the public_token prefix ('PANO-', 'PERF-'),
-- which is a rendered, user-facing identifier — it appears on the public
-- credential page and in QR codes. Overloading it as a provenance channel
-- means any fence that wants to exempt synthetic rows has to pattern-match a
-- column whose format is a product decision, not an infrastructure one.
--
-- The concrete need: the spine-integrity fence (every pet must have a
-- pet_registered event) is blocking from day one. seed-perf.ts legitimately
-- bulk-inserts — its whole purpose is volume, not intake fidelity — so it must
-- be exempt EXPLICITLY and visibly, not silently via a token-prefix LIKE.
--
-- THE SHAPE
-- ---------
-- Mirrors welfare_reports.seed_tag (migration 0155) exactly: a plain nullable
-- text column carrying the generating script's tag. NULL for every real pet.
-- No application code path outside scripts/seed-*.ts writes it, and no
-- rendering query selects it.
--
-- Values in use:
--   'panorama'       — scripts/seed-panorama.ts, routed through registerPet
--                      (the real intake circuit); spine-complete.
--   'panorama-hist'  — the multi-year history backfill inside seed-panorama.
--   'perf'           — scripts/seed-perf.ts bulk insert. DELIBERATELY exempt
--                      from the spine-integrity fence: volume fixture, not an
--                      intake-fidelity fixture.
--
-- The partial index supports the fence's exemption predicate and the seeds'
-- own idempotent delete-and-reseed, both of which filter on seed_tag IS NOT NULL
-- (a tiny fraction of the table in production, all of it in local/staging).
--
-- IDEMPOTENCY: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- Safe to replay. No backfill — existing rows keep NULL until a seed re-runs.

BEGIN;

ALTER TABLE public.pets
  ADD COLUMN IF NOT EXISTS seed_tag text;

COMMENT ON COLUMN public.pets.seed_tag IS
  'Internal seed-provenance marker (''panorama'', ''panorama-hist'', ''perf''). NULL for every real pet registration. Never rendered — do not select this column in citizen/operator-facing queries. Consumed by the spine-integrity fence to exempt bulk volume fixtures explicitly.';

CREATE INDEX IF NOT EXISTS pets_seed_tag_idx
  ON public.pets (seed_tag)
  WHERE seed_tag IS NOT NULL;

COMMIT;
