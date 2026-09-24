-- Migration 0114 — Harden the critical Supabase security-advisor WARNINGs (2026-06-24).
--
-- SOURCE
-- ------
-- Same advisor run as 0113 (project DIM, 2026-06-24). 0113 closed the 5 ERROR;
-- this closes the two CODE-fixable critical WARN groups. Plan:
-- docs/superpowers/plans/2026-06-24-supabase-advisor-errors.md §Fuera de alcance.
-- (The third critical WARN — leaked-password protection — is a hosted Auth
-- dashboard toggle, not SQL; tracked in the PR body for the owner.)
--
-- WHAT
-- ----
--   (A) function_search_path_mutable x6 — pin search_path on every project
--       function that lacked one. All six bodies fully schema-qualify their
--       object references (verified), so `SET search_path = ''` (Supabase's
--       recommended value; pg_catalog is always implicitly resolvable) is safe
--       and changes no behavior. ALTER FUNCTION only sets the GUC, not the body.
--   (B) export_subject_data / erase_subject_data executable by `anon`. The
--       migrations 0059/0087/0106 did REVOKE ALL FROM PUBLIC, but Supabase's
--       init grants EXECUTE directly to the `anon` role (not via PUBLIC), so the
--       revoke did not remove it. Both functions already self-guard
--       (`IF auth.uid() IS NULL OR (auth.uid() <> p_user_id AND NOT
--       pii.caller_is_admin(auth.uid())) THEN RAISE 'forbidden'`), so anon
--       cannot actually export/erase anything — this is defense-in-depth, not an
--       exploit fix, and revoking EXECUTE from anon changes no app behavior
--       (the app calls these as `authenticated`).
--
-- SAFETY
-- ------
-- Forward-only, idempotent: ALTER FUNCTION ... SET search_path is a set-to-same
-- no-op on re-run; REVOKE of an absent grant is a no-op notice. No data touched;
-- no table/RLS change. No -- dim:no-transaction needed.

BEGIN;

-- (A) function_search_path_mutable — pin search_path = '' (all refs qualified).
ALTER FUNCTION public.can_read_case(uuid, uuid)            SET search_path = '';
ALTER FUNCTION public.cases_set_updated_at()               SET search_path = '';
ALTER FUNCTION public.check_pet_event_case_id_immutable()  SET search_path = '';
ALTER FUNCTION public.enforce_audit_log_append_only()      SET search_path = '';
ALTER FUNCTION public.enforce_institutional_no_pets()      SET search_path = '';
ALTER FUNCTION public.enforce_pet_events_append_only()     SET search_path = '';

-- (B) Subject-rights RPCs — remove the direct anon EXECUTE grant (defense in
-- depth; the functions self-guard on auth.uid()). authenticated/service_role
-- keep EXECUTE (the real app paths).
REVOKE EXECUTE ON FUNCTION public.export_subject_data(uuid)       FROM anon;
REVOKE EXECUTE ON FUNCTION public.erase_subject_data(uuid, text)  FROM anon;

COMMIT;
