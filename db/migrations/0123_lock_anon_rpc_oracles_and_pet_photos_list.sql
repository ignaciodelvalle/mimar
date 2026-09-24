-- Migration 0123 — Revoke anon on the SECURITY DEFINER case oracles; lock the
-- pet-photos LIST surface. (deploy-readiness residuals, 2026-07-04.)
--
-- SOURCE
-- ------
-- Security capstone residuals (engram capstone/security + capstone/privacy).
-- Two anon-reachable surfaces that the RLS table policies do not cover:
--
--   (A) SECURITY DEFINER boolean ORACLES reachable via PostgREST /rpc.
--       public.can_read_case(uuid, uuid) and
--       public.is_hidden_from_subject_case(uuid) both run as their owner
--       (BYPASSRLS) and return a boolean. They exist to be composed inside RLS
--       policies (pet_events / cases / attachments SELECT), NOT to be called
--       directly. But a function in `public` is callable via
--       POST /rest/v1/rpc/<name> by any role that holds EXECUTE. Anon holding
--       EXECUTE turns each into a free probing oracle:
--         - can_read_case(case_id, victim_uid) → "does this user see this case?"
--         - is_hidden_from_subject_case(case_id) → "is this a welfare_denuncia?"
--       Neither is gated by auth.uid() internally (unlike the subject-rights
--       RPCs hardened in 0114), so the only thing standing between anon and the
--       oracle is the EXECUTE grant. Revoke it.
--
--       WHY REVOKE FROM PUBLIC *and* anon (not just anon like 0114): these two
--       functions are created by OUR migrations (0094 / 0115), so Postgres'
--       default `GRANT EXECUTE ... TO PUBLIC` applies and anon inherits EXECUTE
--       via PUBLIC — a bare `REVOKE ... FROM anon` would leave the PUBLIC grant
--       (and thus anon's inherited access) intact. Supabase may ALSO grant anon
--       directly, so we revoke both, then GRANT back to the two roles that must
--       keep it: `authenticated` (RLS policy evaluation for logged-in users
--       calls these) and `service_role`. The app's Drizzle path connects as a
--       BYPASSRLS superuser and is unaffected by these grants either way.
--
--   (B) pet-photos public LIST / enumeration.
--       db/storage.sql shipped a `to public` SELECT policy on storage.objects
--       `using (bucket_id = 'pet-photos')`. pet-photos is a PUBLIC bucket, so a
--       known object is served by the public object endpoint
--       (/storage/v1/object/public/pet-photos/<path>, what petPhotoUrl() builds)
--       WITHOUT consulting RLS. The SELECT policy therefore adds nothing to the
--       GET path — its only effect is to let anon ENUMERATE the bucket via the
--       storage list API (POST /storage/v1/object/list/pet-photos), leaking
--       every pet's photo object path. Drop it: anon can still GET a known
--       object, but can no longer LIST the bucket. (Mirrored in db/storage.sql,
--       which db-bootstrap.ts replays for local/dev; this migration is the
--       tracked production path.)
--
-- SAFETY
-- ------
-- Forward-only, idempotent: REVOKE of an absent grant and DROP POLICY IF EXISTS
-- are both no-ops on re-run; GRANT is set-to-same. No data touched, no table or
-- RLS-table-policy change. The RLS matrix harness (__tests__/rls/matrix.test.ts)
-- exercises authenticated reads through both oracles and is the tripwire that
-- would catch an over-broad revoke.

BEGIN;

-- (A) Anon-reachable /rpc oracles — remove EXECUTE from PUBLIC + anon, keep it
-- for the roles that legitimately compose these inside RLS / server paths.
REVOKE EXECUTE ON FUNCTION public.can_read_case(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.can_read_case(uuid, uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.is_hidden_from_subject_case(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.is_hidden_from_subject_case(uuid) TO authenticated, service_role;

-- (B) pet-photos LIST lockdown — drop the enumeration-enabling public SELECT
-- policy. Public GET of a known object is served by the public-bucket object
-- endpoint without RLS, so no replacement SELECT policy is needed.
DROP POLICY IF EXISTS "pet_photos_public_read" ON storage.objects;

COMMIT;
