-- Migration 0155 — welfare_reports.seed_tag: internal, NON-RENDERED
-- correlation marker for synthetic seed data.
--
-- Context (plan-maestro-integridad C5 — "el seed es ciudadano de primera"):
-- seed-panorama.ts used to smuggle its cleanup marker INTO description
-- ("PANO-welfare-000123 — denuncia sintética…", "PANO-HIST-WEL-001243 …"),
-- which read as an obvious fake on any operator screen a citizen might see
-- (the funcionario-primerizo review flagged codes appearing inside denuncia
-- text). Description now reads like a real citizen report; runClean()'s
-- idempotent delete-and-reseed still needs SOME way to find "rows this seed
-- created" without depending on rendered text. This column is that mechanism
-- — the same posture pets.public_token already uses for pets (a plain column
-- carries the tag; the rendered field, pets.name, never does).
--
-- NULL for every real citizen report (no application code path outside the
-- seed scripts writes to this column). Never selected by any rendering query
-- — grep confirms welfare-report reads project an explicit column list, none
-- of which includes seed_tag.
--
-- IDEMPOTENCY: ADD COLUMN IF NOT EXISTS. Safe to replay.

BEGIN;

ALTER TABLE public.welfare_reports
  ADD COLUMN IF NOT EXISTS seed_tag text;

COMMENT ON COLUMN public.welfare_reports.seed_tag IS
  'Internal seed-cleanup marker (e.g. ''PANO'', ''PANO-HIST''). NULL for every real report. Never rendered — do not select this column in citizen/operator-facing queries.';

COMMIT;
