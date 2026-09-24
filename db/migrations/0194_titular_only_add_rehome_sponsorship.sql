-- 0194 — add the rehome-sponsorship pair to the SQL copy of
-- TITULAR_ONLY_EVENT_TYPES.
--
-- WHY BOTH TYPES, WHEN THE CARETAKER PAIR IS ASYMMETRIC
-- ---------------------------------------------------------------------------
-- 0191 deliberately gated `caretaker_designated` and NOT `caretaker_ended`, for
-- two named reasons: a caretaker legitimately ends their OWN arrangement, and
-- the expiry cron writes the end with no acting user at all. Neither reason
-- applies to a rehome sponsorship. No caretaker is party to one, and there is
-- no cron (v1 has no sponsorship expiry, on purpose — the titular is never
-- blocked from withdrawing, so nothing needs a deadline).
--
-- Every org-side writer (accept, org-resign, the finalize cascade) reaches
-- pet_events through Drizzle on the org path, where the row carries an
-- `author_organization_id`; the INSERT policy this function feeds only applies
-- to person-path rows (`author_organization_id IS NULL`), so gating costs those
-- writers nothing. The one person-path writer of `rehome_sponsorship_ended` is
-- the TITULAR's own withdraw, which titular-only permits by definition.
--
-- So gating both denies exactly one thing — a caretaker forging either half of
-- a sponsorship straight to PostgREST — at zero cost to any legitimate writer.
-- A forged `rehome_sponsorship_started` would be a permanent lie in an
-- append-only ledger claiming the titular consented to hand their animal to an
-- organization.
--
-- WHY NOT EDIT 0190 OR 0191: they are committed and applied. Migrations are
-- forward-only and immutable; a shipped file that changes is a checksum drift
-- that turns every environment's history into a guess.
--
-- WHY NO POLICY IS TOUCHED: the `pet_events` INSERT policy already reads
-- `event_type = ANY (public.titular_only_event_types())`. Redefining the
-- function IS the change; the policy picks it up on the next statement.
--
-- Event types are TEXT, not a pg enum, so the two new types themselves needed
-- no DDL — they arrived as a code change (EVENT_TYPES in
-- packages/contract/src/events/event-types.ts).
--
-- Blast radius: one IMMUTABLE function with no dependent indexes or generated
-- columns. Rollback is the 0191 body.

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
    'caretaker_designated',
    'rehome_sponsorship_started',
    'rehome_sponsorship_ended'
  ]::text[];
$$;

COMMENT ON FUNCTION public.titular_only_event_types() IS
  'SQL mirror of TITULAR_ONLY_EVENT_TYPES in lib/domain/titular-only.ts. Second copy on purpose (defense in depth); the duplication is fenced by an equality test in the db vitest project. 0191 added caretaker_designated (custodia-temporal C5); 0194 added the rehome_sponsorship pair (rehome-by-titular).';

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

  IF NOT ('rehome_sponsorship_started' = ANY (types)) THEN
    missing := missing || 'titular_only_event_types() is missing rehome_sponsorship_started'::text;
  END IF;

  IF NOT ('rehome_sponsorship_ended' = ANY (types)) THEN
    missing := missing || 'titular_only_event_types() is missing rehome_sponsorship_ended'::text;
  END IF;

  -- 0191's members must survive this redefinition. CREATE OR REPLACE rewrites
  -- the whole body, so dropping one by omission is a one-line typo away.
  IF NOT ('caretaker_designated' = ANY (types)) THEN
    missing := missing || '0194 dropped caretaker_designated from titular_only_event_types()'::text;
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
    RAISE EXCEPTION '0194 post-condition failed: %', array_to_string(missing, '; ');
  END IF;
END
$$;

COMMIT;
