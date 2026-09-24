-- Migration 0164 — welfare-evidence: remove the anon/authenticated storage
-- policies. (RA-8 finding R2, 2026-07-31.)
--
-- THE HOLE
-- --------
-- db/welfare_storage.sql shipped the private `welfare-evidence` bucket with
-- two policies on storage.objects, both `TO anon, authenticated`:
--
--   INSERT: with check (bucket_id = 'welfare-evidence')
--   SELECT: using (
--             bucket_id = 'welfare-evidence'
--             and exists (select 1 from public.welfare_reports wr
--                         where split_part(name, '/', 1) = wr.id::text))
--
-- The SELECT clause never mentions the CALLER. It asks only "does SOME
-- welfare_reports row own this path prefix", which is true of every object in
-- the bucket by construction. The header called this an "unguessable path"
-- model — but Supabase's list endpoint
-- (POST /storage/v1/object/list/welfare-evidence) is filtered by this very
-- policy, so the paths were never unguessable: an ANONYMOUS list at the root
-- enumerated every object, and a GET on each returned path passed the
-- identical check. That is anonymous download of the complete national corpus
-- of cruelty-complaint evidence — photos and video of abuse scenes, filmed at
-- addresses, attached to named investigations.
--
-- The INSERT policy is the write half: unauthenticated, unbounded upload into
-- a bucket nobody is billed to watch.
--
-- Migration 0123(B) closed exactly this enumeration class for `pet-photos`.
-- This bucket never got the sibling; this is it.
--
-- WHY DROPPING BOTH DOES NOT BREAK THE PRODUCT
-- --------------------------------------------
-- Nothing in the browser ever touches this bucket. Both legs run server-side:
--   · WRITE — uploadWelfareEvidence() inside createWelfareReportAction /
--     createOrgWelfareReportAction / submitClaimDispute, all server actions.
--   · READ  — welfareAttachmentSignedUrl() inside server components
--     (/denuncias/codigo/[code], /denuncias/[id], /gob/maltrato/[id],
--     /gob/moderacion/[id], /admin/moderacion/[id], the inspector detail
--     loader) and the MPF export. Every one of those has ALREADY authorized
--     the caller — receipt code, ownership, jurisdiction fence, or admin role —
--     before it asks for a URL.
-- The paired commit repoints both helpers at the service-role client, which
-- bypasses RLS. So authorization moves from "a policy that cannot see who is
-- asking" to the server code that already knows. Anonymous denuncias still
-- upload; an anonymous reporter with their receipt code still sees their own
-- evidence; nobody can list the bucket.
--
-- No replacement policy is created. storage.objects keeps RLS enabled, and
-- with no policy for anon/authenticated on this bucket the answer is deny —
-- which is what a private evidence bucket should have said from the start.
-- (storage.objects is not in the public schema, so check-rls-coverage.ts's
-- "≥1 policy per table" rule does not apply; other buckets' policies are
-- untouched and continue to govern their own bucket_id.)
--
-- Forward-only and idempotent: DROP POLICY IF EXISTS is a no-op on re-run.
-- Mirrored into db/welfare_storage.sql (the bootstrap copy) in the same commit.

BEGIN;

DROP POLICY IF EXISTS "Anyone can upload welfare evidence" ON storage.objects;
DROP POLICY IF EXISTS "Welfare evidence readable when parent report exists" ON storage.objects;
-- Pre-rename form of the SELECT policy (db/welfare_storage.sql:30), in case an
-- environment predates the rename and still carries the old name.
DROP POLICY IF EXISTS "Reporter can read own welfare evidence" ON storage.objects;

COMMIT;
