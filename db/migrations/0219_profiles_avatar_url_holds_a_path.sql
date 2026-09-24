-- 0219 — `profiles.avatar_url` holds a STORAGE PATH, and the rows that already
-- hold something else are fixed only where the fix is certain.
--
-- WHAT WAS WRONG. `defaultStorageUpload` (upload-avatar.ts) wrote
--
--     {NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/sign/avatars/{userId}/{ts}.{ext}
--
-- into this column. The `/object/sign/` endpoint REQUIRES a `?token=` query
-- parameter and that string never had one, so the value was not a working URL
-- AND not a path — a third thing useful for nothing. Two consequences, both
-- measured before this migration:
--   · `lib/infra/storage-gc.ts` names `avatars` "the bucket most worth doing
--     next" and refuses to collect it, because "the column's contents cannot
--     currently be trusted to say what an object's path even is. Fix the writer
--     first." This is that fix's data half.
--   · `erase_subject_data` (Ley 25.326 art. 16) nulls this column and the
--     object stays in the bucket forever. A person exercising their right to
--     erasure kept a photo of their own face on our infrastructure. The
--     deletion added alongside this migration goes by uid PREFIX rather than by
--     this column precisely so it does not depend on the backfill below having
--     been able to parse anything.
--
-- WHY THE COLUMN IS NOT RENAMED, since `avatar_url` now names a path and that
-- reads badly. `erase_subject_data` and `export_subject_data` are SECURITY
-- DEFINER functions that name this column, and their live definitions sit
-- inside immutable migrations (latest: 0208, ~470 lines). A rename means
-- re-creating both RPCs to change one identifier — a blast radius far larger
-- than the defect being fixed, on the two functions a data-subject's rights
-- run through. The DRIZZLE FIELD is renamed instead (`profiles.avatarStoragePath`
-- in db/schema.ts), so every TypeScript reader fails to compile and has to be
-- visited; a reader that silently kept treating the new contents as a URL would
-- render a broken image rather than fail loudly. `organizations.avatar_url` is
-- a DIFFERENT column with different semantics (a public `org-logos`-style URL,
-- read by lib/infra/origin-org.ts) and is NOT touched by anything here.
--
-- ---------------------------------------------------------------------------
-- THE BACKFILL, AND ITS ONE RULE: A ROW THAT CANNOT BE PARSED WITH CERTAINTY IS
-- LEFT EXACTLY AS IT IS.
-- ---------------------------------------------------------------------------
-- Not nulled, not best-effort trimmed, not guessed. The failure mode that
-- matters is a value that parses to the WRONG KEY: `avatarSignedUrl` would then
-- mint a lease on an object that is not this person's. (An earlier draft of
-- this header claimed the danger was pointing the ERASURE sweep at a stranger's
-- object. That was wrong and worth correcting rather than quietly deleting: the
-- sweep is prefix-based and never reads this column at all — see the paragraph
-- above and `purgeSubjectAvatars`. The conservative rule is right; the reason
-- written down for it was not, and the next person to touch this regex would
-- have reasoned from a false model.) The other failure mode is a value that is
-- nulled, which drops a person's avatar with no way back.
--
-- THE UUID IS ANCHORED TO THE ROW'S OWN `id`, WHICH IS WHAT MAKES A WRONG PARSE
-- STRUCTURALLY IMPOSSIBLE rather than merely improbable. `avatarObjectKey`
-- derives the prefix from `profiles.id`, so a legacy value belonging to this
-- row must carry this row's uuid. Matching `id::text` instead of a generic uuid
-- pattern means the backfill cannot move a row onto another person's key even
-- if some value in the column were crafted to look like one.
--
-- So the WHERE clause asserts the ENTIRE value, anchored at both ends:
--
--     <host>/storage/v1/object/sign/avatars/<this row's id>/<digits>.<ext>
--
-- and every piece of that is a fact about the writer, not a guess:
--   * the bucket segment is literally `avatars` — a value naming any other
--     bucket is not this writer's and is left alone;
--   * the uuid is this row's `id`, per the paragraph above;
--   * `{ts}` is `Date.now()`, so digits only;
--   * `$` at the end means a value carrying a query string, a token, a
--     fragment, or any trailing junk does NOT match. If it has a `?token=` it
--     came from somewhere else and we do not know its rules.
--
-- THE EXTENSION IS DELIBERATELY NOT AN ALLOWLIST, and the first draft of this
-- migration got it wrong in a way worth recording. That draft required
-- `(jpg|png|webp)`, justified as "the extension comes from `rasterExtension`,
-- whose entire range is jpg | png | webp". That is true of the writer as it
-- exists TODAY — and it became true at 18:14 the day before this migration was
-- written. For the entire prior life of this column the extension came from the
-- CLIENT FILENAME:
--
--     const ext = fileName.split(".").pop() ?? "jpg";     // pre-2e034bf92
--
-- So the real legacy key space contains `.JPG` (what Windows and older Android
-- hand over), `.jpeg`, and `.img` from a file with no dot at all. The allowlist
-- would have silently skipped essentially every row it existed to fix — failing
-- in the safe direction, but applying a different rule from the one the header
-- claimed. The match is now case-insensitive (`~*`) and the extension is any
-- short alphanumeric run. Nothing discriminating is lost: the host, the bucket,
-- this row's own uuid, the all-digits timestamp and the end anchor all remain,
-- and it is those — not the three characters at the end — that establish the
-- value came out of this writer.
--
-- THE HOST ALTERNATIVE `undefined` IS DELIBERATE and is the one judgement call
-- in here. `NEXT_PUBLIC_SUPABASE_URL` is interpolated into a template literal,
-- so an unset env var produced the literal string `undefined/storage/v1/...`.
-- That is not ambiguity — it is the same writer with a missing variable, and
-- the path half is fully determined. Rows like that are the ones most likely to
-- exist in dev/seed data. Any OTHER host shape is left untouched — including
-- the set-but-EMPTY case (`NEXT_PUBLIC_SUPABASE_URL=""`), which yields a value
-- starting at `/storage/v1/...`. That one is left alone on purpose: it is
-- indistinguishable from a bucket-relative path that happens to start with a
-- slash, and `avatarSignedUrl` fails closed on it.
--
-- Rows already holding a bare path are untouched by construction: they do not
-- match, and they are already correct.
--
-- ONE OUTPUT SHAPE MOVES WITH THIS COLUMN, and it is recorded here because
-- nothing else records it: `export_subject_data` (art. 14) does `row_to_json(p)`
-- over `profiles` (0208), so a data subject's export now carries a bucket path
-- where it used to carry the broken URL. No new disclosure — the path is
-- worthless without the service role, and the fabricated string was already in
-- that payload — but the shape changed and no test covers it.

update profiles
   set avatar_url = regexp_replace(
         avatar_url,
         '^(https?://[^/]+|undefined)/storage/v1/object/sign/avatars/',
         ''
       )
 where avatar_url is not null
   and avatar_url ~* ('^(https?://[^/]+|undefined)/storage/v1/object/sign/avatars/'
                      || id::text
                      || '/[0-9]+\.[A-Za-z0-9]{1,10}$');

comment on column profiles.avatar_url is
  'Bucket-relative STORAGE PATH into the private `avatars` bucket ({user_id}/{ts}.{ext}) - NOT a URL, despite the column name. Sign it at render time (lib/infra/storage.ts avatarSignedUrl). Kept under this name because erase_subject_data/export_subject_data name it. See migration 0219. Rows this migration could not parse with certainty keep their legacy malformed value and are refused by the signer.';
