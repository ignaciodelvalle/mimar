-- 0218 — `avatars` declares a size and a type, like the other three.
--
-- WHY THIS EXISTS. Audit 2026-09-fresh, lens A07, finding A07-2. The avatar
-- use-case enforced its ceiling against a caller-supplied NUMBER (`fileSize`)
-- that travelled beside the blob and was never compared to it, so
-- `fileSize: 1` with a 50 MB body validated and was uploaded through the
-- SERVICE ROLE client. `mimeType` was trusted the same way, with no check on
-- the bytes. `src/modules/pets/application/profile/upload-avatar.ts` now takes
-- both off the blob — but that is only the half of the fix that runs when OUR
-- code runs.
--
-- THIS IS THE OTHER HALF, and it is the one that does not depend on a call
-- site. Migration 0171 grants `insert`, `update`, `select` and `delete` on
-- `storage.objects` to every authenticated account whose `auth.uid() = owner`
-- inside `bucket_id = 'avatars'`.
--
-- READ THAT GRANT CAREFULLY, because the first draft of this header did not
-- and understated the door. `with check (bucket_id = 'avatars' and auth.uid()
-- = owner)` carries NO predicate on the object name. Ownership is not a path
-- constraint: on INSERT, Storage sets `owner` to the caller's uid, so the
-- check is satisfied by construction at ANY key in the bucket — including
-- `${someOtherUserId}/foto.jpg`, squarely inside another person's prefix. What
-- the caller cannot do is UPDATE or DELETE a row it does not already own. So
-- the door is: write anything, anywhere in this bucket, as yourself. Until
-- this migration it was also: at any size and of any type. Measured on the
-- local database 2026-09-10, `avatars` carried `file_size_limit = null` and
-- `allowed_mime_types = null`, exactly as `pet-photos` and `event-attachments`
-- did before 0213.
--
-- Objects written by the app are not reachable through those policies at all:
-- `uploadAvatarForUser` uploads with the SERVICE ROLE client, which leaves
-- `owner = null`, and `auth.uid() = owner` is never true against null. The
-- policies exist for a caller acting with its own token — precisely the path
-- this migration bounds.
--
-- FOLLOW-UP THIS DOES NOT DO, recorded so the next reader does not have to
-- rediscover it: adding `(storage.foldername(name))[1] = auth.uid()::text` to
-- 0171's four policies would confine each caller to its own prefix — the
-- constraint the first draft of this comment mistakenly believed was already
-- there. That is a policy change to a frozen grant, it is its own work unit,
-- and it is deliberately NOT written here.
--
-- THE NUMBERS ARE NOT NEW AND ARE NOT CHOSEN HERE. `lib/media/validate.ts`
-- owns both — `MAX_IMAGE_BYTES` (5 MiB) and `RASTER_IMAGE_TYPES` (the three
-- raster mimes) — and its header states why the bucket must repeat them:
--
--     "A limit the client volunteers is not a limit; a limit the object store
--      enforces is."
--
-- `uploads-staging` (0206), `pet-photos` and `event-attachments` (0213) all
-- declare exactly these values. `avatars` was the last of the four write
-- destinations that did not. That asymmetry is the whole of this migration —
-- it is 0213 applied to the bucket 0213 deliberately left alone.
--
-- WHAT IT DOES NOT DO, said plainly because 0213 had to say it too:
-- `allowed_mime_types` rejects a DECLARED `image/svg+xml`; it does not look at
-- a single byte. An SVG declared `image/jpeg` still satisfies the bucket. The
-- content check is `detectRasterMime`, it runs in the use-case, and after this
-- migration the direct-to-Storage path is bounded to 5 MiB and a declared
-- raster type with the bytes still arbitrary. That residual is real and is not
-- closed here.
--
-- WHY IT BREAKS NOTHING, measured rather than assumed (2026-09-10, local DB):
--   · avatars — 0 objects. The bucket only came into existence in 0171 (before
--     it, uploading a profile photo had never once worked), and nothing has
--     been written to it locally since. There is no object that this ceiling
--     could retroactively invalidate, and the only writer in the repo — the
--     use-case above — now refuses over 5 MiB and over anything the magic-byte
--     table does not recognise, before it reaches the Storage API at all.

update storage.buckets
set
  file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'avatars';

-- REPLAY-TIME ASSERTION — and unlike 0213's, this one DEMANDS the row.
--
-- 0213 could not: `pet-photos` and `event-attachments` are created by
-- `db/storage.sql`, which runs AFTER the migrations in both `deploy-provision.ts`
-- and `db-bootstrap.ts`, so on a virgin project its two rows legitimately do
-- not exist yet and raising would break every fresh provision.
--
-- `avatars` is the opposite case and that is the whole reason the shape differs
-- here. It appears in no `db/*storage*.sql` file at all; its ONE creator is
-- migration 0171, which runs earlier in this same chain. So by the time this
-- file executes the row exists on every path — fresh or existing — and "zero
-- rows" is not a legitimate no-op, it is 0171 having been reverted or the
-- bucket deleted by hand. A guard that let that pass would be asserting nothing
-- on the only environment shape it can see.
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
   where id = 'avatars';

  if present <> 1 then
    raise exception
      '0218: expected exactly 1 avatars bucket row (created by 0171), found %', present;
  end if;

  if bounded <> 1 then
    raise exception
      '0218: the avatars bucket row did not take the declared bounds';
  end if;
end $$;
