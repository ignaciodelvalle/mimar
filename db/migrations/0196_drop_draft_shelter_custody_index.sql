-- 0196 — DROP the never-shipped DRAFT per-pet shelter_custody index
-- (rehome-by-titular; WU3 review carry-forward #5, landed in WU4).
--
-- WHAT THIS IS
-- ---------------------------------------------------------------------------
-- 0195 was first written (commit ba46c055, never pushed) as
--   UNIQUE (pet_id) WHERE role = 'shelter_custody' AND ended_at IS NULL
-- under the name `ownerships_one_active_shelter_custody_per_pet`. The review
-- found it would turn a second neighbour's found-pet confirmation into an
-- unhandled 23505 (user-held custody has owner_organization_id NULL and was
-- never constrained), so 0195 was rewritten IN PLACE before publication as the
-- org-scoped `ownerships_one_active_org_shelter_custody_per_pet`. 0195 is now
-- published and immutable.
--
-- On every database where only the published 0195 ran, the draft name does
-- not exist and this file is a no-op that proves it. On a database where the
-- DRAFT ran (a developer's local before the rewrite, a preview environment),
-- the published 0195 passes every one of its own checks and leaves the draft
-- index in place — H-1 re-armed, invisibly. `DROP INDEX IF EXISTS` reports ok
-- either way, which is why the post-condition asserts the ABSENCE by name
-- ("aplicada no es cerrada", docs/ops/migrations.md).
--
-- The org-scoped index and `ownerships_one_active_owner_per_pet` are named in
-- the post-condition as siblings this file must not touch.

BEGIN;

DROP INDEX IF EXISTS public.ownerships_one_active_shelter_custody_per_pet;

DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
  org_def text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'ownerships'
      AND indexname = 'ownerships_one_active_shelter_custody_per_pet'
  ) THEN
    missing := missing || 'ownerships_one_active_shelter_custody_per_pet (the draft) still exists after DROP'::text;
  END IF;

  SELECT indexdef INTO org_def
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'ownerships'
    AND indexname = 'ownerships_one_active_org_shelter_custody_per_pet';
  IF org_def IS NULL THEN
    missing := missing || '0196 touched ownerships_one_active_org_shelter_custody_per_pet (absent)'::text;
  ELSIF org_def NOT LIKE '%UNIQUE INDEX%' OR org_def NOT LIKE '%owner_organization_id IS NOT NULL%' THEN
    missing := missing || '0196 touched ownerships_one_active_org_shelter_custody_per_pet (definition changed)'::text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'ownerships'
      AND indexname = 'ownerships_one_active_owner_per_pet'
  ) THEN
    missing := missing || '0196 touched ownerships_one_active_owner_per_pet'::text;
  END IF;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION '0196 post-condition failed: %', array_to_string(missing, '; ');
  END IF;
END
$$;

COMMIT;
