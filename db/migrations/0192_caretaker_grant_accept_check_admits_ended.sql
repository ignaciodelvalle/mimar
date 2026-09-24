-- 0192 — the accept CHECK made ENDING an accepted grant impossible.
--
-- THE BUG, found by implementing against it (C5)
-- ---------------------------------------------------------------------------
-- 0189 shipped:
--
--   CHECK ((status = 'accepted') = (caretaker_user_id IS NOT NULL
--                                   AND ownership_id IS NOT NULL))
--
-- read as "an accepted grant points at both; a non-accepted one points at
-- neither". The first half is the real invariant. The second half is TRUE only
-- for the statuses a grant can reach WITHOUT ever being accepted — pending,
-- rejected, cancelled, expired. It is FALSE for `ended`, which is reachable
-- ONLY from `accepted` and which, by construction, has both pointers set.
--
-- So the terminal UPDATE `status: 'accepted' -> 'ended'` violated the
-- constraint every single time: LHS goes false while RHS stays true. The whole
-- ending path — titular revocation, caretaker withdrawal, the expiry cron —
-- was unreachable. Nothing caught it earlier because 0189's schema tests only
-- ever built rows, and a row is legal until you try to move it.
--
-- THE FIX, and why not the obvious one. Nulling the two pointers on end would
-- satisfy the old constraint, and it is the wrong answer twice over: it erases
-- WHO cared for the animal (a fact, in a system whose first invariant is that
-- facts are not edited away), and it destroys the `ownership_id` pointer that
-- the caretaker drift harness compares against. The constraint is what has to
-- move, not the data.
--
-- The new form keeps everything 0189 was actually protecting:
--   accepted OR ended  ⇒ both pointers set   (an arrangement that HAPPENED
--                                             always says who and which row)
--   any other status   ⇒ NOT both set        (a cancelled invitation can never
--                                             keep a phantom ownership pointer,
--                                             which was 0189's stated worry)
--
-- Note what stays permitted, and is now used: a `pending` row MAY carry
-- `caretaker_user_id` when the invitee already has an account, as long as
-- `ownership_id` is still NULL. That was true under 0189 too; C5 takes
-- advantage of it so a cancelled invitation can notify the right person.
--
-- HARD-DELETE CONSEQUENCE, widened deliberately. `caretaker_user_id` is
-- ON DELETE SET NULL, so a HARD `profiles` delete of someone who is or WAS a
-- caretaker is now refused with 23514 instead of orphaning the grant. 0189
-- already accepted that for `accepted`; extending it to `ended` is the same
-- trade and the same reasoning — DIM erases subjects SOFTLY
-- (erase_subject_data), and the only hard profile delete in the codebase is the
-- stub-claim path, where a stub can never have been an accepted caretaker.
--
-- Blast radius: one CHECK on a table that ships with zero rows outside local
-- dev. No data rewrite; the validation below proves every existing row passes.

BEGIN;

ALTER TABLE public.pet_caretaker_grants
  DROP CONSTRAINT IF EXISTS pet_caretaker_grants_accept_check;

ALTER TABLE public.pet_caretaker_grants
  ADD CONSTRAINT pet_caretaker_grants_accept_check
  CHECK (
    (status IN ('accepted','ended'))
    = (caretaker_user_id IS NOT NULL AND ownership_id IS NOT NULL)
  );

COMMENT ON CONSTRAINT pet_caretaker_grants_accept_check ON public.pet_caretaker_grants IS
  'An arrangement that actually happened (accepted or ended) must name the caretaker and the ownership row it produced; one that never did (pending/rejected/cancelled/expired) must not carry both. 0189 wrote this over accepted alone, which made the accepted -> ended transition impossible.';

-- ---------------------------------------------------------------------------
-- Post-condition fence. "Applied" is not the same as "closed".
-- ---------------------------------------------------------------------------
-- Exercised on its failure path before being believed: with the 0189 predicate
-- in place, the `ended` probe below raises. The casts are explicit because
-- `text[] || 'literal'` makes Postgres parse the literal AS AN ARRAY.
DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
  probe_ok boolean;
BEGIN
  -- The transition 0189 forbade must now be legal...
  BEGIN
    -- INCLUDING DEFAULTS as well as CONSTRAINTS: without the defaults the
    -- NOT NULL columns that carry a default (created_at, updated_at) reject
    -- the probe row for the wrong reason, and the fence reports a failure that
    -- has nothing to do with the constraint under test.
    CREATE TEMP TABLE _c0192_probe (
      LIKE public.pet_caretaker_grants INCLUDING CONSTRAINTS INCLUDING DEFAULTS
    ) ON COMMIT DROP;
    probe_ok := true;
  EXCEPTION WHEN others THEN
    probe_ok := false;
  END;

  IF NOT probe_ok THEN
    missing := missing || 'could not build the constraint probe table'::text;
  ELSE
    BEGIN
      INSERT INTO _c0192_probe (id, public_token, pet_id, granted_by_user_id,
                                caretaker_user_id, caretaker_email, status,
                                starts_at, ends_at, ownership_id)
      VALUES (gen_random_uuid(), 'probe-ended', gen_random_uuid(), gen_random_uuid(),
              gen_random_uuid(), 'probe@example.com', 'ended',
              now(), now() + interval '1 day', gen_random_uuid());
    EXCEPTION WHEN check_violation THEN
      missing := missing || 'an ENDED grant with both pointers is still refused'::text;
    END;

    -- ...and the thing 0189 was protecting must still be forbidden.
    BEGIN
      INSERT INTO _c0192_probe (id, public_token, pet_id, granted_by_user_id,
                                caretaker_user_id, caretaker_email, status,
                                starts_at, ends_at, ownership_id)
      VALUES (gen_random_uuid(), 'probe-cancelled', gen_random_uuid(), gen_random_uuid(),
              gen_random_uuid(), 'probe@example.com', 'cancelled',
              now(), now() + interval '1 day', gen_random_uuid());
      missing := missing || 'a CANCELLED grant may still keep a phantom ownership pointer'::text;
    EXCEPTION WHEN check_violation THEN
      NULL; -- correct: refused
    END;
  END IF;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION '0192 post-condition failed: %', array_to_string(missing, '; ');
  END IF;
END
$$;

COMMIT;
