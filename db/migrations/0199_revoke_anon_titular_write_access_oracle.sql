-- Migration 0199 — Close the anonymous ownership oracle opened by 0190.
--
-- SOURCE
-- ------
-- Historical-reviews closing report, 2026-08-22, finding M2 (original HIGH;
-- repro MEDIUM 0.95, impact HIGH 0.90 — final MEDIUM).
--
-- WHAT IS OPEN
-- ------------
-- 0190 created `public.has_titular_write_access(uuid, uuid)` as SECURITY
-- DEFINER — it must be, because it reads `ownerships`, which the calling role
-- generally cannot read — and then never restricted who may CALL it. A function
-- in `public` is reachable by any role holding EXECUTE via
-- POST /rest/v1/rpc/<name>, so the grant is the ONLY thing between an anonymous
-- caller and the answer.
--
-- Reproduced over real HTTP, not inferred: a POST with nothing but the
-- publishable key returned `true` with HTTP 200. The proof that it is a genuine
-- bypass rather than a redundant read: in the SAME anonymous session, counting
-- rows in `ownerships` returns 0. The function reads a table the caller has
-- demonstrably no access to, and hands back the answer.
--
-- This is a REGRESSION OF A CLOSED CLASS. Migration 0123 shut exactly this door
-- for the two case oracles (`can_read_case`, `is_hidden_from_subject_case`)
-- with the same reasoning: an ungated SECURITY DEFINER boolean is a free
-- probing oracle. 0190 reopened it for pet ownership.
--
-- Scale, honestly: the caller needs TWO internal UUIDs it cannot obtain from
-- the system (as anon, `pets` and `profiles` return 0 rows, and the public
-- credential page never ships the internal id to the browser). It is a
-- CONFIRMATION oracle over identifiers you already hold, not an enumerator.
-- That is why the finding landed at MEDIUM — not a reason to leave it open.
--
-- WHY REVOKE FROM PUBLIC *AND* anon
-- ---------------------------------
-- The live catalog shows TWO grants, not one:
--   proacl = {=X/postgres, postgres=X/postgres, anon=X/postgres,
--             authenticated=X/postgres, service_role=X/postgres}
-- `=X/postgres` is the default PUBLIC grant Postgres attaches to every new
-- function; `anon=X/postgres` is Supabase's own. Revoking only PUBLIC would
-- leave the explicit anon grant standing, and revoking only anon would leave
-- the inherited PUBLIC one — either alone is another "applied but not closed".
-- Revoke both, then grant back to the two roles that must keep it:
-- `authenticated` (the RLS policies of 0190 compose this predicate while
-- evaluating as that role) and `service_role`. The app's Drizzle path connects
-- as a BYPASSRLS superuser and is unaffected either way.
--
-- The 0123 pair is re-revoked below. Not busywork: it is idempotent where that
-- work still holds, and it CURES an environment where the live effect was lost
-- (hand-patched staging, a restored dump) instead of letting the post-condition
-- only complain about it.
--
-- SAFETY
-- ------
-- Forward-only and idempotent: REVOKE of an absent grant is a no-op, GRANT is
-- set-to-same. No data touched, no function body redefined, no RLS policy
-- changed. The tripwire that keeps this closed is
-- __tests__/rls/function-hardening.test.ts (NO_ANON_EXECUTE), which now asks
-- has_function_privilege() — the question that also sees a grant inherited
-- through PUBLIC, which the previous acl-shaped predicate could not.
--
-- LOCAL ONLY at time of writing. Applying this to the hosted project is
-- Ignacio-gated (remote DB changes are never an agent action).

BEGIN;

-- The oracle 0190 left open.
REVOKE EXECUTE ON FUNCTION public.has_titular_write_access(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.has_titular_write_access(uuid, uuid) TO authenticated, service_role;

-- The 0123 pair — re-asserted so this migration can cure an environment whose
-- live grants drifted back, rather than merely detect it below.
REVOKE EXECUTE ON FUNCTION public.can_read_case(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.can_read_case(uuid, uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.is_hidden_from_subject_case(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.is_hidden_from_subject_case(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Post-condition — the fence AFTER, because a REVOKE reports success whether
-- or not it removed anything.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  missing text[] := '{}';
  fn text;
  oracles text[] := ARRAY[
    'public.has_titular_write_access(uuid, uuid)',
    'public.can_read_case(uuid, uuid)',
    'public.is_hidden_from_subject_case(uuid)'
  ];
BEGIN
  FOREACH fn IN ARRAY oracles LOOP
    -- has_function_privilege answers the WHOLE question: a direct grant, a
    -- grant inherited through PUBLIC, and a null acl (default EXECUTE to
    -- PUBLIC) all come back true.
    IF has_function_privilege('anon', fn, 'EXECUTE') THEN
      missing := missing || format('%s is still EXECUTE-able by anon', fn);
    END IF;

    -- The revoke must not have overshot: the roles that legitimately compose
    -- these inside RLS / server paths keep EXECUTE.
    IF NOT has_function_privilege('authenticated', fn, 'EXECUTE') THEN
      missing := missing || format('%s lost EXECUTE for authenticated', fn);
    END IF;

    IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN
      missing := missing || format('%s lost EXECUTE for service_role', fn);
    END IF;
  END LOOP;

  -- The function must still BE a SECURITY DEFINER with a pinned search_path —
  -- if a later edit turned it into a plain function, revoking anon would be
  -- guarding a door that no longer leads anywhere, and we would not notice.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'has_titular_write_access'
      AND p.prosecdef
      AND EXISTS (
        SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c
        WHERE c LIKE 'search_path=%'
      )
  ) THEN
    missing := missing || 'has_titular_write_access is no longer SECURITY DEFINER with a pinned search_path'::text;
  END IF;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION '0199 post-condition failed: %', array_to_string(missing, '; ');
  END IF;
END
$$;

COMMIT;
