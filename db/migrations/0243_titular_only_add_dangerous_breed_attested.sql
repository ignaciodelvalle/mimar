-- 0243 — add `dangerous_breed_attested` to the SQL copy of
-- TITULAR_ONLY_EVENT_TYPES (T4-I1 / issue #753).
--
-- WHY THE ATTESTATION IS TITULAR-ONLY
-- ---------------------------------------------------------------------------
-- The two PPP registries DIM models inscribe the PROPIETARIO, not the holder:
-- Ley CABA 4078 + Res. 93/APRA/2021 (owner files at APrA via TAD, with the RC
-- policy, the chip, a current rabies dose and the owner's own course) and Ley
-- PBA 14.107 (owner files at a Delegación Municipal of the Registro
-- Provincial). The number that comes back belongs to the owner. A caretaker
-- asserting that inscription happened is asserting a legal fact about someone
-- else, permanently, in an append-only ledger — and it is precisely the
-- assertion that moves a dog OUT of the visibly-non-compliant cohort the
-- authority reads off `/gob` (metric C7).
--
-- Nothing legitimate is denied. The titular files it from
-- `/mis-mascotas/{token}/eventos/atestar-raza-peligrosa`, and an organization
-- that holds the animal reaches the writer on the ORG path, where
-- `author_organization_id IS NOT NULL` and this function never applied.
--
-- WHY THE FUNCTION IS REDEFINED THOUGH NO POLICY READS IT TODAY
-- ---------------------------------------------------------------------------
-- 0212 dropped the `pet_events` INSERT policy that consumed this function and
-- deliberately kept the function itself, because its equality fence against
-- lib/domain/titular-only.ts (__tests__/caretaker-rls-hardening.test.ts)
-- is what keeps the TS list honest. That fence asserts SET EQUALITY, so adding
-- a member on the TS side without this file turns it red — which is the point.
-- 0194's post-condition additionally required the INSERT policy to reference
-- the function; that check is NOT copied here, because 0212 removed the policy
-- it asserted on and a migration whose fence is false on a correct tree is
-- worse than no fence.
--
-- WHY NOT EDIT 0191 OR 0194: they are committed and applied. Migrations are
-- forward-only and immutable; a shipped file that changes is a checksum drift
-- that turns every environment's history into a guess.
--
-- Event types are TEXT, not a pg enum, and `dangerous_breed_attested` has been
-- a member of EVENT_TYPES since the catalog shipped, so no DDL beyond this
-- function is involved.
--
-- Blast radius: one IMMUTABLE function with no dependent indexes or generated
-- columns. Rollback is the 0194 body.

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
    'rehome_sponsorship_ended',
    'dangerous_breed_attested'
  ]::text[];
$$;

COMMENT ON FUNCTION public.titular_only_event_types() IS
  'SQL mirror of TITULAR_ONLY_EVENT_TYPES in lib/domain/titular-only.ts. Second copy on purpose (defense in depth); the duplication is fenced by an equality test in the db vitest project. 0191 added caretaker_designated (custodia-temporal C5); 0194 added the rehome_sponsorship pair (rehome-by-titular); 0243 added dangerous_breed_attested (T4-I1 / #753 — the PPP registries inscribe the propietario, not the holder).';

-- ---------------------------------------------------------------------------
-- Post-condition fence. "Applied" is not the same as "closed".
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE rewrites the whole body, so dropping a pre-existing member
-- by omission is a one-line typo away. ALL SEVEN pre-existing members are
-- re-asserted below — not a sample of them, which is what a first draft of this
-- block did: it named five, and the two it skipped
-- (custody_transfer_proposed/_cancelled) were exactly the ones a typo could
-- have dropped while the migration still applied cleanly and reported success.
-- Plus the member this migration adds, and the one that must stay OUT.
-- Casts are explicit: 0190 shipped a fence with a missing ::text that applied
-- cleanly only because every branch was false.
DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
  types   text[];
BEGIN
  SELECT public.titular_only_event_types() INTO types;

  IF NOT ('dangerous_breed_attested' = ANY (types)) THEN
    missing := missing || 'titular_only_event_types() is missing dangerous_breed_attested'::text;
  END IF;

  IF NOT ('caretaker_designated' = ANY (types)) THEN
    missing := missing || '0243 dropped caretaker_designated from titular_only_event_types()'::text;
  END IF;

  IF NOT ('rehome_sponsorship_started' = ANY (types)) THEN
    missing := missing || '0243 dropped rehome_sponsorship_started from titular_only_event_types()'::text;
  END IF;

  IF NOT ('rehome_sponsorship_ended' = ANY (types)) THEN
    missing := missing || '0243 dropped rehome_sponsorship_ended from titular_only_event_types()'::text;
  END IF;

  IF NOT ('custody_transfer_proposed' = ANY (types)) THEN
    missing := missing || '0243 dropped custody_transfer_proposed from titular_only_event_types()'::text;
  END IF;

  IF NOT ('custody_transferred' = ANY (types)) THEN
    missing := missing || '0243 dropped custody_transferred from titular_only_event_types()'::text;
  END IF;

  IF NOT ('custody_transfer_cancelled' = ANY (types)) THEN
    missing := missing || '0243 dropped custody_transfer_cancelled from titular_only_event_types()'::text;
  END IF;

  IF NOT ('adoption_eligibility_set' = ANY (types)) THEN
    missing := missing || '0243 dropped adoption_eligibility_set from titular_only_event_types()'::text;
  END IF;

  -- The asymmetry 0191 established, restated so a future redefinition that
  -- "completes the pair" has to argue with a failing migration first.
  IF 'caretaker_ended' = ANY (types) THEN
    missing := missing || 'titular_only_event_types() wrongly denies caretaker_ended'::text;
  END IF;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION '0243 post-condition failed: %', array_to_string(missing, '; ');
  END IF;
END
$$;

COMMIT;
