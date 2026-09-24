-- Migration 0200 — Close the anonymous backend-kill RPC left open by 0136.
--
-- SOURCE
-- ------
-- Fresh-context review of 698e7ea3..40d64c41, 2026-08-22, finding U2.
--
-- WHAT IS OPEN
-- ------------
-- 0136 created `public.reap_stuck_app_backends()` as SECURITY DEFINER — it must
-- be, because it calls pg_terminate_backend over pg_stat_activity, which the
-- calling role cannot do — and then revoked it FROM PUBLIC only:
--
--     revoke all on function public.reap_stuck_app_backends() from public;
--
-- Supabase's init grants EXECUTE to `anon` DIRECTLY, so revoking PUBLIC does not
-- remove it. This is the same trap 0114's comment already documented and the
-- same one 0190 fell into. The live catalog, measured before this migration:
--
--   proname                 | args | prosecdef | provolatile | anon_execute
--   reap_stuck_app_backends |      | t         | v           | t
--   proacl = {postgres=X/postgres,anon=X/postgres,
--             authenticated=X/postgres,service_role=X/postgres}
--
-- Note the shape: the default PUBLIC grant (`=X/postgres`) IS gone — 0136's
-- revoke did that much — while `anon=X/postgres` stands untouched. The function
-- takes no arguments and is VOLATILE, which is precisely what makes it
-- reachable at POST /rest/v1/rpc/reap_stuck_app_backends with nothing but the
-- publishable key.
--
-- SCALE, HONESTLY
-- ---------------
-- Not arbitrary process kill. The WHERE clause only matches Supavisor client
-- backends that are already stuck (runaway >60 s, abandoned resultset >30 s, or
-- idle-in-transaction >60 s), and never the caller's own pid. An anonymous
-- caller therefore cannot choose a victim, and on a healthy pool the call is a
-- no-op returning 0.
--
-- It is still an unauthenticated remote call with a side effect, and it is
-- hammerable: a loop can keep re-running the scan, and it races the legitimate
-- pg_cron job for the same rows. An unauthenticated caller has no business
-- reaching a function whose body terminates backends, whatever its predicate.
--
-- WHY `authenticated` IS REVOKED TOO
-- ----------------------------------
-- A deliberate divergence from 0199, which DID grant back to `authenticated`
-- because the RLS policies of 0190 compose that predicate while evaluating as
-- that role. NOTHING composes this one. Its only caller is the pg_cron job
-- scheduled by 0136, which runs as the `postgres` role that owns the function,
-- so it is unaffected by any grant here; `app/api/health/route.ts` is a
-- read-only TWIN of the predicate and never calls the function. Supabase's init
-- had also granted `authenticated=X/postgres`, and leaving that standing would
-- keep the identical hammering vector open to anyone who can sign up — a
-- smaller population than anon, but no more entitled to terminate backends.
-- `service_role` keeps EXECUTE so a server-side maintenance path stays possible
-- without exposing it to a browser session.
--
-- SAFETY
-- ------
-- Forward-only and idempotent: REVOKE of an absent grant is a no-op, GRANT is
-- set-to-same. No data touched, no function body redefined, no RLS policy
-- changed, and the pg_cron schedule from 0136 is not re-declared here. The
-- tripwire that keeps this closed is the RULE in
-- __tests__/rls/function-hardening.test.ts, which enumerates pg_proc for
-- prosecdef + has_function_privilege('anon', …) instead of trusting a
-- hand-kept list of names — the list is what missed this function for the whole
-- life of 0136.
--
-- LOCAL ONLY at time of writing. Applying this to the hosted project is
-- Ignacio-gated (remote DB changes are never an agent action).

BEGIN;

REVOKE EXECUTE ON FUNCTION public.reap_stuck_app_backends() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.reap_stuck_app_backends() TO service_role;

-- ---------------------------------------------------------------------------
-- Post-condition — the fence AFTER, because a REVOKE reports success whether
-- or not it removed anything (migration 0199's lesson, kept).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  missing text[] := '{}';
  fn text := 'public.reap_stuck_app_backends()';
BEGIN
  IF has_function_privilege('anon', fn, 'EXECUTE') THEN
    missing := missing || format('%s is still EXECUTE-able by anon', fn);
  END IF;

  IF has_function_privilege('authenticated', fn, 'EXECUTE') THEN
    missing := missing || format('%s is still EXECUTE-able by authenticated', fn);
  END IF;

  -- The revoke must not have overshot: the maintenance path stays open.
  IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN
    missing := missing || format('%s lost EXECUTE for service_role', fn);
  END IF;

  -- The pg_cron job of 0136 runs as the owner; if that stopped being true the
  -- reaper would silently stop reaping and nothing else would notice.
  IF NOT has_function_privilege('postgres', fn, 'EXECUTE') THEN
    missing := missing || format('%s lost EXECUTE for postgres (the pg_cron job would stop)', fn);
  END IF;

  -- The function must still BE a SECURITY DEFINER with a pinned search_path —
  -- if a later edit turned it into a plain function, revoking anon would be
  -- guarding a door that no longer leads anywhere, and we would not notice.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'reap_stuck_app_backends'
      AND p.prosecdef
      AND EXISTS (
        SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c
        WHERE c LIKE 'search_path=%'
      )
  ) THEN
    missing := missing || 'reap_stuck_app_backends is no longer SECURITY DEFINER with a pinned search_path'::text;
  END IF;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION '0200 post-condition failed: %', array_to_string(missing, '; ');
  END IF;
END
$$;

COMMIT;
