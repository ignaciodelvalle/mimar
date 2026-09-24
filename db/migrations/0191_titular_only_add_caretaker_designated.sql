-- 0191 — add `caretaker_designated` to the SQL copy of TITULAR_ONLY_EVENT_TYPES.
--
-- WHY A WHOLE MIGRATION FOR ONE ARRAY ELEMENT
-- ---------------------------------------------------------------------------
-- `public.titular_only_event_types()` (0190) is a SECOND COPY of the TS
-- constant in lib/domain/titular-only.ts, on purpose: the app-layer fence
-- (scripts/check-titular-gate.ts) and the RLS layer are two uncorrelated
-- defenses, and defense in depth costs a copy. The copy is only tolerable
-- because it is FENCED — __tests__/caretaker-rls-hardening.test.ts asserts the
-- SQL array equals the TS array and goes red the moment either side moves
-- alone. C5 adds `caretaker_designated` to the TS side, so this is the other
-- half of the same change. Without it the RLS policy would keep allowing a
-- caretaker to POST a forged `caretaker_designated` straight to PostgREST while
-- the app-layer fence reported itself green.
--
-- WHY NOT EDIT 0190: it is committed and applied. Migrations are forward-only
-- and immutable; a shipped file that changes is a checksum drift that makes
-- every environment's history a guess.
--
-- WHAT THIS DENIES, PRECISELY: a caretaker naming a SUB-CARETAKER. Ending an
-- arrangement (`caretaker_ended`) is deliberately NOT in the list — a caretaker
-- withdrawing from their own arrangement is legitimate, and the expiry cron
-- writes it with no acting user at all.
--
-- WHY NO POLICY IS TOUCHED: the `pet_events` INSERT policy already reads
-- `event_type = ANY (public.titular_only_event_types())`. Redefining the
-- function is the whole change; the policy picks it up on the next statement.
--
-- Event types are TEXT, not a pg enum, so `caretaker_designated` itself needed
-- no DDL — it arrived as a code change in 0189's train (EVENT_TYPES in
-- db/schema.ts).
--
-- Blast radius: one IMMUTABLE function with no dependent indexes or generated
-- columns. Rollback is the 0190 body.

BEGIN;

CREATE OR REPLACE FUNCTION public.titular_only_event_types()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path TO ''
AS $$
  SELECT ARRAY[
    'custody_transfer_proposed',
    'custody_transferred',
    'custody_transfer_cancelled',
    'adoption_eligibility_set',
    'caretaker_designated'
  ]::text[];
$$;

COMMENT ON FUNCTION public.titular_only_event_types() IS
  'SQL mirror of TITULAR_ONLY_EVENT_TYPES in lib/domain/titular-only.ts. Second copy on purpose (defense in depth); the duplication is fenced by an equality test in the db vitest project. 0191 added caretaker_designated (custodia-temporal C5).';

-- ---------------------------------------------------------------------------
-- Post-condition fence. "Applied" is not the same as "closed".
-- ---------------------------------------------------------------------------
-- 0190 shipped a fence like this with a missing ::text cast — it applied
-- cleanly because every branch was false, so the broken line never ran. A fence
-- that only executes on the failure path has to be exercised on that path
-- before anyone believes it. The casts below are explicit for that reason.
DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
  types   text[];
BEGIN
  SELECT public.titular_only_event_types() INTO types;

  IF NOT ('caretaker_designated' = ANY (types)) THEN
    missing := missing || 'titular_only_event_types() is missing caretaker_designated'::text;
  END IF;

  IF 'caretaker_ended' = ANY (types) THEN
    missing := missing || 'titular_only_event_types() wrongly denies caretaker_ended'::text;
  END IF;

  -- The policy that consumes the function must still reference it. Dropping
  -- that reference elsewhere would make this migration a no-op in effect while
  -- still reporting success.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'pet_events'
      AND cmd = 'INSERT'
      AND with_check LIKE '%titular_only_event_types%'
  ) THEN
    missing := missing || 'pet_events INSERT policy no longer consults titular_only_event_types()'::text;
  END IF;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION '0191 post-condition failed: %', array_to_string(missing, '; ');
  END IF;
END
$$;

COMMIT;
