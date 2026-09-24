-- Migration 0188 — tighten the `revocations` bucket INSERT policy to admin/govt.
--
-- THE HOLE (native-readiness review RN-4 / B24, 2026-08-19)
-- --------------------------------------------------------
-- The revocations bucket's upload policy was `TO authenticated WITH CHECK
-- (bucket_id = 'revocations')` (db/revocations_storage.sql) — the predicate is
-- the bucket name and NOTHING else, so it is TRUE for EVERY authenticated
-- account. Uploads are browser-direct (lib/ui/use-evidence-upload.ts →
-- supabase.storage.from("revocations").upload(...)), so any signed-up citizen
-- could write arbitrary bytes, of any content-type and size, under any key in
-- this bucket with six lines of supabase-js — bypassing every server-side
-- control. The role check in uploadRevocationEvidence gates the attachments
-- ROW, never the storage WRITE.
--
-- Reads were already locked (migration 0172 dropped the SELECT policy; reads
-- are service-role signed URLs), so the residual vector was arbitrary WRITE.
-- This closes it at the RLS layer: only an institutional admin/govt operator —
-- the same principal requireAdminOrGovtOrRedirect authorizes at the action
-- boundary (app/actions/revocation-evidence.ts) — may write to the bucket.
--
-- The sibling grants on pet-photos and event-attachments (db/storage.sql) carry
-- the same bucket_id-only shape, but ~30 legitimate upload sites run as the
-- signed-in user under those grants; tightening them requires uid-prefixed keys
-- or the signed-upload-ticket endpoint, and is deliberately deferred to that
-- work (see docs/architecture/api-invariants.md). revocations is separable
-- because its only writer is this one admin/govt flow.
--
-- Self-contained: ensures the bucket exists (bootstrap does NOT apply
-- db/revocations_storage.sql — only deploy-provision does — so the migration
-- tree is the single guaranteed application path for local + CI). Idempotent.

BEGIN;

INSERT INTO storage.buckets (id, name, public)
VALUES ('revocations', 'revocations', false)
ON CONFLICT (id) DO NOTHING;

-- Drop the permissive policy (old name) and this migration's own policy (re-run).
DROP POLICY IF EXISTS "revocations_authenticated_upload" ON storage.objects;
DROP POLICY IF EXISTS "revocations_admin_govt_upload" ON storage.objects;

-- Only an institutional admin/govt, not deactivated and not erased, may upload.
-- Mirrors the requireAdminOrGovtOrRedirect invariant at the action boundary.
CREATE POLICY "revocations_admin_govt_upload"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'revocations'
    AND EXISTS (
      -- (select auth.uid()) not bare auth.uid() — migration 0137 convention,
      -- so the auth_rls_initplan advisor is not re-tripped (it flags calls
      -- nested inside EXISTS too).
      SELECT 1
      FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.account_type = 'institutional'
        AND p.role IN ('admin', 'govt')
        AND p.deactivated_at IS NULL
        AND p.deleted_at IS NULL
    )
  );

COMMIT;
