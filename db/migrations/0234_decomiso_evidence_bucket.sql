-- Migration 0234 — `decomiso-evidence`: a private bucket for seizure evidence,
-- written only by the server.
--
-- WHY (PO decision D10, 2026-09-18)
-- ---------------------------------------------------------------------------
-- A decomiso needs its acta, and actas are PDFs. Decomiso evidence used to go
-- to `event-attachments`, which 0213 bounds to JPG/PNG/WEBP up to 5 MiB. Adding
-- PDF there would widen it for every signed-in account: `db/storage.sql` still
-- grants INSERT on `event-attachments` to any authenticated caller with the
-- bucket name as the whole predicate (the frozen B24 grant in
-- scripts/check-storage-write-policies.ts). So the acta gets its own bucket
-- instead of a wider shared one.
--
-- WHAT THIS DOES
-- ---------------------------------------------------------------------------
--   · public = false. Evidence is read only through short-lived signed URLs
--     that the server issues after deciding the viewer may read the decomiso
--     (lib/infra/decomiso-evidence-access.ts, which reuses canReadCase).
--   · file_size_limit = 10485760 (10 MiB) — `MAX_DECOMISO_EVIDENCE_BYTES` in
--     lib/media/limits.ts. A scanned multi-page acta does not fit in the 5 MiB
--     photo ceiling; 10 MiB does, and stays well inside one request.
--   · allowed_mime_types = jpeg/png/webp/pdf — `DECOMISO_EVIDENCE_MIME_LIST`
--     in lib/media/limits.ts. As 0213 says, this list rejects a DECLARED type;
--     the server action decides the real type from the bytes (`%PDF-` for a
--     PDF, the raster signatures for images) before any upload.
--   · NO storage.objects policy at all, for any role. The only writer is
--     app/actions/decomiso.ts running as the service role, which does not
--     consult RLS; the only reader signs as the service role too. Deny-all to
--     every caller is the uploads-staging posture (0206) and the org-logos one
--     (0227).
--
-- The bytes are stored exactly as they arrived — no re-encode, no metadata
-- strip. PO decision D7 (2026-09-18): the EXIF/GPS of seizure evidence is
-- itself evidence. That is why the bucket is private and why reads go through
-- the decomiso's own read rule rather than the pet's.
--
-- `on conflict do update` forces private and the two bounds: an environment
-- where somebody already created the bucket by hand is tightened to this
-- shape, never left public.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'decomiso-evidence',
  'decomiso-evidence',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- REPLAY-TIME ASSERTION — like 0227, this migration is the bucket's creator, so
-- after the statement above the row exists on every path, and anything other
-- than exactly one private, bounded row is a failure. It also refuses any
-- storage.objects policy that names the bucket: this bucket's whole security
-- model is "no caller-facing grant", and a policy added by hand or by a later
-- file would silently turn it into a shared upload target.
do $$
declare
  present int;
  bounded int;
  policies int;
begin
  select
    count(*),
    count(*) filter (
      where public = false
        and file_size_limit = 10485760
        and allowed_mime_types @> array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
        and allowed_mime_types <@ array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
    )
    into present, bounded
    from storage.buckets
   where id = 'decomiso-evidence';

  if present <> 1 then
    raise exception '0234: expected exactly 1 decomiso-evidence bucket row, found %', present;
  end if;

  if bounded <> 1 then
    raise exception '0234: the decomiso-evidence bucket row is not private with the declared bounds';
  end if;

  select count(*)
    into policies
    from pg_policies
   where schemaname = 'storage'
     and tablename = 'objects'
     and (
       coalesce(qual, '') like '%decomiso-evidence%'
       or coalesce(with_check, '') like '%decomiso-evidence%'
     );

  if policies <> 0 then
    raise exception '0234: % storage.objects policies name decomiso-evidence; the bucket must stay deny-all to callers', policies;
  end if;
end $$;
