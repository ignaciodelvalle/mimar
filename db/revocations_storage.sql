-- DIM revocation/deactivation evidence — private, authenticated upload only
-- ------------------------------------------------------------------------
-- Apply once per environment (Supabase Studio → SQL Editor, or the DIM
-- provisioner). Idempotent. Version-controlled so prod parity is reproducible
-- (closes the "revocations bucket has no SQL coverage" deploy gap — the org /
-- user revocation evidence upload 500'd with "Bucket not found" on a fresh
-- deploy because no db/*storage.sql declared it; had to be hot-patched by hand
-- on the first staging deploy).
--
-- Bucket: revocations
--   Holds evidence files attached to admin/govt revocation + deactivation
--   actions (deactivate admin, deactivate govt, revoke locality assignment,
--   revoke org verification / vet role). PRIVATE bucket: reads are served
--   through short-lived signed URLs generated server-side.
--
--   Uploaded client-side by the acting admin/govt operator on SUBMIT
--   (lib/ui/use-evidence-upload.ts → supabase.storage.from("revocations")),
--   namespaced by the TARGET being acted on.
--
-- Path convention: {targetId}/{timestamp}-{rand}.{ext}
--   (lib/domain/revocation-evidence-path.ts — targetId is the admin/govt user
--    id or the locality assignment id.)

insert into storage.buckets (id, name, public)
values ('revocations', 'revocations', false)
on conflict (id) do nothing;

-- NOTE: the EXISTS subselect below depends on the "Profiles readable by self"
-- SELECT policy (db/rls.sql) staying in place — the invoker must be able to
-- read its own profiles row for the check to see it. If that policy is ever
-- narrowed, every revocation upload 403s with an opaque storage error.
--
-- INSERT (upload) — only an institutional admin/govt may write to the bucket.
-- Migration 0188 (native-readiness RN-4/B24): the old policy checked bucket_id
-- and NOTHING else, so it was TRUE for every authenticated account — and since
-- uploads are browser-direct (lib/ui/use-evidence-upload.ts), any signed-up
-- citizen could write arbitrary bytes here. Reads were already locked (0172);
-- this closes the arbitrary-WRITE vector at the RLS layer, mirroring the
-- requireAdminOrGovtOrRedirect invariant the action boundary enforces. Kept in
-- sync with the migration verbatim so deploy-provision and the migration tree
-- converge to the same tight policy regardless of application order.
drop policy if exists "revocations_authenticated_upload" on storage.objects;
drop policy if exists "revocations_admin_govt_upload" on storage.objects;
create policy "revocations_admin_govt_upload"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'revocations'
    and exists (
      select 1
      from public.profiles p
      where p.id = (select auth.uid())
        and p.account_type = 'institutional'
        and p.role in ('admin', 'govt')
        and p.deactivated_at is null
        and p.deleted_at is null
    )
  );

-- NO SELECT POLICY — AND NONE MAY BE ADDED (migration 0172).
-- This bucket used to carry `revocations_authenticated_read`:
--   for select to authenticated using (bucket_id = 'revocations')
-- The predicate names no caller, so it was TRUE for every object: any
-- signed-up account could POST /storage/v1/object/list/revocations and download
-- the disciplinary evidence attached to named admin/govt operators. The old
-- comment justified it as "needed to mint signed URLs for the evidence viewer" —
-- but there is no such viewer: nothing in the repo mints a signed URL for this
-- bucket. The policy was pure exposure with no consumer.
-- If an evidence viewer is built later, sign as service role behind the same
-- institutional guard that authorizes the revocation itself (see
-- lib/infra/storage.ts for the shape); do not reintroduce this policy.
