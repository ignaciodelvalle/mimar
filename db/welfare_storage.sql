-- DIM welfare reports — storage bucket + RLS
-- --------------------------------------------
-- Apply once per environment via Supabase Studio → SQL Editor. Idempotent.
-- The tracked production path for the policy state below is migration
-- db/migrations/0164_welfare_evidence_bucket_lockdown.sql — keep the two in
-- sync.
--
-- Bucket: welfare-evidence (PRIVATE)
--   - NO anon or authenticated policy. Every access is server-side through the
--     service-role client, which bypasses RLS:
--       · write — uploadWelfareEvidence() / removeWelfareEvidence()
--         (lib/infra/welfare-uploads.ts), called from the denuncia server
--         actions and submitClaimDispute.
--       · read  — welfareAttachmentSignedUrl() (lib/infra/storage.ts), called
--         from server components that have already authorized the viewer
--         (receipt code, reporter identity, jurisdiction fence, admin role).
--   - UPDATE / DELETE: service role only, same as above.
--
-- WHY (RA-8 R2, 2026-07-31): this file used to grant `anon, authenticated`
-- unrestricted INSERT plus a SELECT gated only on "some welfare_reports row
-- owns this path prefix" — a clause with NO caller identity in it. Supabase's
-- list endpoint is filtered by that same policy, so the "unguessable path"
-- premise was false: an anonymous LIST at the bucket root enumerated every
-- object and a GET on each passed the identical check. Anonymous download of
-- every cruelty-complaint evidence file in the country. RLS cannot express
-- "this anonymous reporter holds the receipt code", so the authorization moved
-- to the server code that already performs it, and the bucket went deny-all.
-- Migration 0123(B) closed the same enumeration class for pet-photos.
--
-- Path convention: {welfare_report_id}/{attachment_id}.{ext}

insert into storage.buckets (id, name, public)
values ('welfare-evidence', 'welfare-evidence', false)
on conflict (id) do nothing;

drop policy if exists "Anyone can upload welfare evidence" on storage.objects;
drop policy if exists "Reporter can read own welfare evidence" on storage.objects;
drop policy if exists "Welfare evidence readable when parent report exists" on storage.objects;
