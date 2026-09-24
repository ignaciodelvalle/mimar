-- Migration 0227 — `org-logos` exists, and it is bounded from its first row.
--
-- WHAT WAS WRONG (fresh review 2026-09, A07-1 remainder)
-- ---------------------------------------------------------------------------
-- 0213 and 0218 put a size and a type on `pet-photos`, `event-attachments` and
-- `avatars`. The fourth bucket the finding named could not be bounded, because
-- nothing creates it: `orgLogoUrl()` (lib/infra/storage.ts) builds a public URL
-- against `org-logos`, the refugio page and its hero render it, and no
-- `db/**.sql` file declares the bucket (lib/infra/storage-gc.ts says so in its
-- own reachability notes). Whoever creates it by hand in the Studio gets the
-- project defaults — no size limit, any type — on a PUBLIC bucket.
--
-- WHAT THIS DOES
-- ---------------------------------------------------------------------------
-- Creates the bucket with the bounds every other image bucket carries:
--   · public = true — the only reader builds `/object/public/org-logos/…`, the
--     same shape as `pet-photos`. A private bucket would break the one path
--     that exists.
--   · file_size_limit = 5242880 and allowed_mime_types = jpeg/png/webp —
--     `MAX_IMAGE_BYTES` and `RASTER_IMAGE_TYPES` from lib/media/validate.ts.
--     As 0213 says of its two buckets, the type list rejects a DECLARED type,
--     not the bytes.
--   · NO storage.objects policy at all. There is no writer in the repo
--     (`organizations.logo_storage_path` has none), so the bucket starts
--     deny-all to every caller — the uploads-staging posture (0206), not the
--     open B24 grant pet-photos still carries. Whoever builds the logo upload
--     writes through the service role, or adds a scoped policy and meets
--     `pnpm lint:storage-policies` on the way.
--   · No public SELECT policy either: a public bucket serves a known object
--     without consulting RLS, and a `to public` SELECT policy would only let
--     anon LIST the bucket (the reason db/storage.sql drops pet_photos_public_read).
--
-- `on conflict do update` sets the two bounds and leaves `public` alone, like
-- db/storage.sql: an environment where somebody already created the bucket by
-- hand is tightened, not re-shaped.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'org-logos',
  'org-logos',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- REPLAY-TIME ASSERTION — demands the row, like 0218 and unlike 0213: this
-- migration is the bucket's creator, so after the statement above the row
-- exists on every path, fresh or existing, and anything else is a failure.
do $$
declare
  present int;
  bounded int;
begin
  select
    count(*),
    count(*) filter (
      where file_size_limit = 5242880
        and allowed_mime_types @> array['image/jpeg', 'image/png', 'image/webp']
        and allowed_mime_types <@ array['image/jpeg', 'image/png', 'image/webp']
    )
    into present, bounded
    from storage.buckets
   where id = 'org-logos';

  if present <> 1 then
    raise exception '0227: expected exactly 1 org-logos bucket row, found %', present;
  end if;

  if bounded <> 1 then
    raise exception '0227: the org-logos bucket row did not take the declared bounds';
  end if;
end $$;
