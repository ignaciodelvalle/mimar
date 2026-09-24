-- 0206 — the `uploads-staging` bucket: where bytes land BEFORE anyone believes
-- anything about them.
--
-- WHY A SECOND BUCKET AND NOT A SECOND GRANT ON pet-photos
-- ---------------------------------------------------------------------------
-- docs/architecture/api-invariants.md §1.5 states the rule this migration is
-- built to keep:
--
--     "native uploading direct-to-storage with a signed URL loses all three at
--      once [magic bytes, no-SVG, sharp re-encode]. No createSignedUploadUrl
--      exists anywhere today — every signed URL in the repo is a download.
--      Keep it that way, or replicate all three server-side first."
--
-- A signed upload URL pointed at `pet-photos` would break that outright:
-- `pet-photos` is PUBLIC, `lib/infra/uploads.ts` re-encodes every object bound
-- for it and fails CLOSED on a sharp error precisely so attacker-controlled
-- bytes never reach a public URL, and a signed PUT has no server in the path to
-- do either. So the signed PUT lands HERE instead — a private bucket nothing
-- reads from and no page links to — and a second, re-authorized server step
-- fetches the object, runs the same three checks over the bytes, and only then
-- writes a normalised copy into `pet-photos`.
--
-- The staged object is inert on its own: private, unreadable by any caller
-- role, under an unguessable key, and pointed at by no row in `public`.
--
-- WHAT THE OBJECT STORE ENFORCES, AS OPPOSED TO WHAT A CLIENT PROMISES
-- ---------------------------------------------------------------------------
-- `file_size_limit` and `allowed_mime_types` are set ON THE BUCKET. They are
-- the only two limits in this flow that hold WITHOUT any of our code running:
-- a signed upload URL is a bearer capability, so between minting and expiry the
-- holder talks to the Storage API and not to us. Everything else — the magic
-- bytes, the re-encode, the destination path, who the photo belongs to — is
-- decided by the confirm step, after the bytes exist and can be read.
--
--   file_size_limit    5 MiB   — MAX_IMAGE_BYTES in lib/media/validate.ts.
--   allowed_mime_types jpeg/png/webp — RASTER_IMAGE_TYPES, same file. NOT the
--                      content check: this rejects a DECLARED `image/svg+xml`,
--                      and an SVG declared as `image/jpeg` still gets in. That
--                      one is caught by detectRasterMime at confirm time, which
--                      is why both exist.
--
-- NO POLICY ON THIS BUCKET, AND THAT IS THE POINT
-- ---------------------------------------------------------------------------
-- Not one `create policy` for `anon`, `authenticated` or `public`. Writes reach
-- it in exactly two ways: the service-role key (RLS does not apply), and a
-- signed upload token minted BY the service-role key for ONE exact object key
-- (`POST /storage/v1/object/upload/sign/...`, which validates the token instead
-- of consulting RLS). Reads reach it one way: service role.
--
-- This is deliberately the SHAPE that `scripts/check-storage-write-policies.ts`
-- describes as the end state for the two grants it has frozen —
-- "server mints a scoped URL, bucket goes deny-all to callers". Those two
-- grants are NOT closed by this migration: ~30 Server-Action upload sites still
-- run as the signed-in user against `pet-photos` and `event-attachments`, and
-- closing the grants before those sites move would break every one of them. The
-- fence keeps them pinned; this bucket is the primitive that lets them move.
--
-- A bucket with no policy is invisible to that fence (it only reports policies
-- that EXIST), so this migration ends with its own DO-block assertion instead:
-- if a caller-facing policy is ever added to `uploads-staging`, a replay of this
-- migration on a fresh database fails loudly. That is weaker than a CI fence and
-- it is stated as weaker — the CI half is the fence's own `unfrozen` rule, which
-- catches a bucket-name-only grant on ANY bucket, this one included.
--
-- LIFECYCLE, INCLUDING THE PART THAT IS NOT SOLVED
-- ---------------------------------------------------------------------------
-- Confirm deletes the staged object on EVERY path out — success, "that is not
-- an image", and a failed write alike. Erasure sweeps the whole `{petId}/`
-- prefix (`purgeOwnedPetAttachments`), which is why the key carries the pet id
-- rather than being flat: a staged upload that was never confirmed has no row
-- to be found by, so a supresión has to reach it by prefix or not at all.
--
-- WHAT IS LEFT: an upload that was ticketed, PUT, and never confirmed by a
-- client that crashed or lost signal. Nothing deletes it. This repo has NO
-- storage garbage collection for ANY bucket — RN-4 A9 measured it: "no storage
-- GC cron (24 crons, none touches storage)" — and inventing one for this bucket
-- alone, wired into a dispatcher whose drain contract counts ROWS, would be a
-- half-built version of the thing that has to exist for all six buckets.
--
-- So it is bounded rather than collected, and the bounds are real: the objects
-- are private and unreadable, capped at 5 MiB each, and the `media-upload`
-- rate-limit family caps one account at 120 requests a day — an upper bound of
-- roughly 600 MB/day per account, and less than that in practice because half
-- the requests are confirms. Closing it properly is the storage-GC work RN-4
-- ranks at #7, not this migration.

-- ---------------------------------------------------------------------------
-- The bucket
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'uploads-staging',
  'uploads-staging',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- NO `comment on table storage.buckets` HERE, deliberately. `storage.buckets` is
-- owned by `supabase_storage_admin`, not by the role migrations run as, and
-- `COMMENT ON` requires ownership — so it would fail on a remote project with
-- "must be owner of table buckets" and take the whole migration with it, in
-- exchange for a string nothing reads. The design intent lives in this header.

-- ---------------------------------------------------------------------------
-- Fence — replay-time assertion, stated as the weaker half (see the header)
-- ---------------------------------------------------------------------------

do $$
declare
  offending text;
begin
  -- The bucket exists and is PRIVATE. A public uploads-staging would put
  -- unvalidated, un-re-encoded bytes on a public URL — the exact property the
  -- whole two-step exists to prevent.
  if not exists (
    select 1 from storage.buckets where id = 'uploads-staging' and public = false
  ) then
    raise exception '0206 fence: uploads-staging is missing or is not private';
  end if;

  -- The two object-store-enforced limits are actually set. A null
  -- file_size_limit means "the project default", which is not a limit this
  -- repo chose and not one lib/media/validate.ts agrees with.
  if not exists (
    select 1
      from storage.buckets
     where id = 'uploads-staging'
       and file_size_limit = 5242880
       and allowed_mime_types @> array['image/jpeg', 'image/png', 'image/webp']
  ) then
    raise exception '0206 fence: uploads-staging lost its size or mime-type limits';
  end if;

  -- No caller-facing policy. `roles` is a name[] of the roles the policy is
  -- granted to; a policy with no TO clause is {public}, which is the widest.
  select string_agg(policyname, ', ')
    into offending
    from pg_policies
   where schemaname = 'storage'
     and tablename = 'objects'
     -- Both halves are coalesced: an INSERT policy has a null `qual` and a
     -- SELECT policy a null `with_check`, and `null || text` is null — so
     -- concatenating them raw would make every INSERT grant invisible here,
     -- which is the exact command this fence most needs to see.
     and coalesce(qual, '') || ' ' || coalesce(with_check, '') like '%uploads-staging%'
     and roles && array['anon', 'authenticated', 'public']::name[];

  if offending is not null then
    raise exception
      '0206 fence: uploads-staging has caller-facing storage policy/policies (%). It is deny-all by design — writes arrive through service-role-minted signed upload URLs, which do not consult RLS.',
      offending;
  end if;
end $$;
