-- DIM storage buckets and policies
-- ---------------------------------
-- Apply by pasting into Supabase Studio → SQL Editor. Idempotent.
--
-- The pet-photos bucket holds primary photos and any attached images for pets.
-- The bucket is PUBLIC, so a known object is served by the public object
-- endpoint (/storage/v1/object/public/pet-photos/<path>, what petPhotoUrl()
-- builds) WITHOUT consulting RLS. Uploads go through our own server action,
-- which verifies the user owns the pet. Update / delete are scoped to the
-- uploader.

-- Create the bucket if it doesn't already exist.
-- THE BOUNDS ARE DECLARED AT CREATION, and `do update` rather than
-- `do nothing`, because THIS FILE is what owns bucket creation on a fresh tree
-- and it runs AFTER the migrations. Migration 0213 hardens an environment that
-- already has these rows; on a virgin project `storage.buckets` is still empty
-- when it replays, so it matches nothing, the ledger marks it applied, and —
-- migrations being forward-only — it can never come back. Every fresh
-- environment and every CI bootstrap would carry unbounded buckets while the
-- ledger said otherwise. That is "aplicada no es cerrada" arriving from the
-- other direction, and this line is the half that stops it.
--
-- `do update` and not `do nothing` for the same reason the `drop policy if
-- exists` below gives: this file is replayed on every bootstrap and is supposed
-- to CONVERGE, so an existing bucket gets tightened rather than skipped. Only
-- the two bound columns are set — `public` is left alone so a deliberate
-- change is never clobbered by a replay.
--
-- The numbers are `MAX_IMAGE_BYTES` and `RASTER_IMAGE_TYPES` from
-- lib/media/validate.ts. And the type list rejects a DECLARED type, not the
-- bytes: an SVG declared as image/jpeg still gets in, and on THESE buckets —
-- unlike uploads-staging — there is no confirm-time byte check on the direct
-- path. See 0213 for the full statement of what this does and does not close.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'pet-photos', 'pet-photos', true,
  5242880, array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- NO public SELECT policy on pet-photos (deploy-readiness residual, 2026-07-04;
-- tracked in migration 0123). Because the bucket is public, GET of a known
-- object never consults RLS, so a `to public` SELECT policy would add nothing
-- to the read path — its ONLY effect is to let anon ENUMERATE the bucket via
-- the storage list API (POST /storage/v1/object/list/pet-photos), leaking every
-- pet's photo object path. Dropping it lets anon GET a known object but NOT
-- LIST the bucket. Kept as an explicit drop so an existing DB is tightened on
-- the next bootstrap replay.
drop policy if exists "pet_photos_public_read" on storage.objects;

-- Any authenticated user can upload to pet-photos.
--
-- B24, AND IT IS NOT FINE. The predicate is the bucket name and nothing else,
-- so it is TRUE for every authenticated caller and every path: uploads are
-- supposed to be gated by the server action that verifies pet ownership, but
-- the GRANT does not know that and a client can call the storage API directly
-- with its own token. It stays until signed uploads land (server mints a scoped
-- URL, the bucket goes deny-all to callers) — the two must land together,
-- because ~30 upload sites legitimately run as the signed-in user today.
--
-- FROZEN in the meantime: `pnpm lint:storage-policies` pins this policy's
-- predicate exactly and fails on any NEW bucket-name-only write grant or any
-- change to this one. check-rls-coverage.ts does not see it — that fence reads
-- SELECT and ALL only, by a deliberate decision, and this is the blind spot the
-- decision left.
drop policy if exists "pet_photos_authenticated_upload" on storage.objects;
create policy "pet_photos_authenticated_upload"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'pet-photos');

-- Only the uploader can update their object.
drop policy if exists "pet_photos_uploader_update" on storage.objects;
create policy "pet_photos_uploader_update"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'pet-photos' and auth.uid() = owner);

-- Only the uploader can delete their object.
drop policy if exists "pet_photos_uploader_delete" on storage.objects;
create policy "pet_photos_uploader_delete"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'pet-photos' and auth.uid() = owner);

-- ---------------------------------------------------------------------------
-- event-attachments bucket
-- ---------------------------------------------------------------------------
-- Holds optional images attached to pet events (vaccine cards, vet receipts,
-- weight-scale photos, free-form note photos). Private bucket: discovery is
-- gated by the SSR layer (only the pet's owner reaches the page that renders
-- the URLs) and the URLs themselves are short-lived signed URLs generated
-- server-side. Tier-3 data per AGENTS.md — owner only.

-- Same bounds and the same reasoning as pet-photos above.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'event-attachments', 'event-attachments', false,
  5242880, array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- NO SELECT POLICY — AND NONE MAY BE ADDED (migration 0172).
-- This bucket used to carry `event_attachments_authenticated_read`:
--   for select to authenticated using (bucket_id = 'event-attachments')
-- The predicate is the bucket name and nothing else, so it was TRUE for every
-- object. POST /storage/v1/object/list/event-attachments is filtered by that
-- policy — not, as the old comment claimed, "by what the SSR layer shows" — so
-- any signed-up account could enumerate and download every pet's vaccine cards,
-- vet receipts and note photos in the country. Tier-3 owner-only data.
-- (The 2026-07-04 scope review logged this as LOW on the "discovery gated by
-- app" reasoning; that reasoning was wrong for the same reason it was wrong for
-- welfare-evidence in 0164 and the export buckets in 0172.)
-- Reads now sign as service role via lib/infra/storage.ts, whose callers have
-- already run requirePetAccess. Signed URLs are redeemed by token, not by RLS.

-- Any authenticated user can upload (the server action verifies pet ownership
-- before calling storage). INSERT is kept as the caller's own grant: an
-- insert-only policy cannot enumerate, and ~30 upload sites legitimately run as
-- the signed-in user.
--
-- B24: "cannot enumerate" is true and is not the whole question. It can still
-- WRITE — any authenticated account, any path, into a bucket holding vaccine
-- cards and vet receipts (Tier 3). The read side of this bucket was closed by
-- migration 0172; the write side is open and waits on signed uploads, same
-- change as pet-photos above. FROZEN by `pnpm lint:storage-policies` until then.
drop policy if exists "event_attachments_authenticated_upload" on storage.objects;
create policy "event_attachments_authenticated_upload"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'event-attachments');

-- Only the uploader can update or delete their object.
drop policy if exists "event_attachments_uploader_update" on storage.objects;
create policy "event_attachments_uploader_update"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'event-attachments' and auth.uid() = owner);

drop policy if exists "event_attachments_uploader_delete" on storage.objects;
create policy "event_attachments_uploader_delete"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'event-attachments' and auth.uid() = owner);
