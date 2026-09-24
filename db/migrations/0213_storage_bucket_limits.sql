-- 0213 — `pet-photos` and `event-attachments` declare a size and a type.
--
-- WHAT THIS IS NOT
-- ---------------------------------------------------------------------------
-- It is NOT the fix for B24. `db/storage.sql` grants INSERT on both buckets to
-- every authenticated account with `bucket_id = '<name>'` as the entire
-- predicate, so any signed-up caller can write objects at any path by calling
-- the Storage API directly with its own token — bypassing the server action
-- that verifies pet ownership. `scripts/check-storage-write-policies.ts` freezes
-- those two grants by name so the pattern cannot spread, and states the reason
-- they are still open: closing them needs ~30 upload sites to stop running as
-- the signed-in user, which is its own work unit. The end state is demonstrated
-- by `uploads-staging` (migration 0206): no caller-facing policy at all, writes
-- only through a service-role-minted signed URL.
--
-- WHAT IT IS
-- ---------------------------------------------------------------------------
-- The half of that blast radius which does NOT depend on those 30 call sites,
-- because it is BUCKET CONFIGURATION rather than a policy. Measured against the
-- live database on 2026-09-09, both buckets carried
-- `file_size_limit = null` and `allowed_mime_types = null`. With the open grant
-- above, that is: any authenticated account may write a file of ANY SIZE and
-- ANY TYPE — and `pet-photos` is `public = true`, so what lands there is
-- readable by anyone with the URL.
--
-- ONLY THE SIZE HALF ACTUALLY BINDS THAT CALLER, and saying otherwise is how a
-- hardening migration becomes a record of protection nobody has. Migration 0206
-- states the reason and this file dropped it in the first draft:
--
--     "allowed_mime_types jpeg/png/webp — RASTER_IMAGE_TYPES, same file. NOT the
--      content check: this rejects a DECLARED `image/svg+xml`, and an SVG
--      declared as `image/jpeg` still gets in."
--
-- 0206 can leave the consequence unsaid because its bucket has NO caller-facing
-- policy at all: nothing reaches it except through a service-role-minted URL,
-- and `detectRasterMime` runs on the bytes at confirm time. These two buckets
-- are the opposite case — the grant is open, and a caller going straight to the
-- Storage API never touches `lib/infra/uploads.ts`. So after this migration the
-- direct path is bounded to 5 MiB per object and a DECLARED image type, with
-- the bytes still arbitrary and the object count still unlimited. That is B24's
-- residual, and it is not closed here.
--
-- The objects are served from the SUPABASE PROJECT origin, not from miMAR's:
-- `next.config.ts` registers `*.supabase.co` under `images.remotePatterns` and
-- there is no proxy rewrite. Smaller than the first draft of this header said,
-- and stated correctly because this file is the record of what was hardened.
--
-- The numbers are not new. `lib/media/validate.ts` already owns both, and its
-- own header says why the bucket must declare them:
--
--     "A limit the client volunteers is not a limit; a limit the object store
--      enforces is."
--
-- `uploads-staging` declares them already (5 MB, three raster types). These two
-- buckets did not. That asymmetry is the whole of this migration.
--
-- WHY IT BREAKS NOTHING, measured rather than assumed (2026-09-09, live DB):
--   · pet-photos       — 64 objects, largest 2 544 066 B, mimetypes exactly
--                        {image/jpeg, image/png, image/webp}. Over 5 MB: 0.
--   · event-attachments — 3 objects, largest 97 589 B, {image/jpeg, image/png}.
-- Every writer already produces a re-encoded raster: `pet-photo-upload.ts`
-- derives the mime from magic bytes and refuses a body over `MAX_IMAGE_BYTES`,
-- and the seed scripts re-encode to 1024×1024 JPEG before uploading (one SOURCE
-- file under `scripts/assets/pet-photos-real/` is 6.1 MB — it is the input to
-- that re-encode, never the object).
--
-- EVENT-ATTACHMENTS IS INCLUDED AND ITS TYPE LIST IS THE SAME THREE, which is a
-- narrowing of what the name suggests and is deliberate. `uploadAttachmentIfPresent`
-- runs the same raster validator; nothing in this build attaches a PDF. The day
-- one does, this list is where it is added — and a refusal at upload time is a
-- better way to discover that than a PDF sitting in a bucket whose policy cannot
-- say who put it there.

update storage.buckets
set
  file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id in ('pet-photos', 'event-attachments');

-- REPLAY-TIME ASSERTION — and it asserts the POSITIVE shape, which the first
-- draft did not.
--
-- That draft counted rows that were "still unbounded" and raised when the count
-- was above zero. It read as a guard and was vacuous in the one case it named:
-- when the bucket rows DO NOT EXIST the count is zero, so it raises nothing —
-- while its own message claimed "the rows were not found" as a case it caught.
-- Against rows that DO exist it could only ever detect a failure the UPDATE two
-- lines above had already made impossible inside the same transaction.
--
-- ZERO ROWS IS A LEGITIMATE NO-OP HERE, and that is why this does not simply
-- demand two rows. On a virgin project `storage.buckets` is empty when
-- migrations replay — `db/storage.sql` creates these buckets, and it runs
-- AFTER, in a later step of both `deploy-provision.ts` and `db-bootstrap.ts`.
-- Raising here would break every fresh provision. So the fresh path is owned by
-- `db/storage.sql`, which now DECLARES the bounds at creation; this migration
-- owns the environments that already have the rows, and asserts that every row
-- it found is bounded to the exact values it wrote.
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
   where id in ('pet-photos', 'event-attachments');

  if present <> bounded then
    raise exception
      '0213: % of % bucket row(s) did not take the declared bounds', present - bounded, present;
  end if;
end $$;
