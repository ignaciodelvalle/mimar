-- 0171 — create the "avatars" storage bucket.
--
-- WHY. src/modules/pets/application/profile/upload-avatar.ts has uploaded to a
-- bucket named "avatars" since it was written. That bucket exists in neither
-- the local database nor staging, so uploading a profile photo from
-- /cuenta/editar has NEVER worked — not once, for any user.
--
-- What makes this worth reading twice: the use-case's own docstring says "If
-- bucket is missing, uploadAvatarForUser fails gracefully and logs
-- 'profile_avatar_upload_failed' to audit_log". The author anticipated the
-- missing bucket and built the degradation. Nobody then created the bucket, so
-- the graceful path became the ONLY path, and the failure was silent by design.
-- Found 2026-08-10 by __tests__/storage-buckets-exist.test.ts, written the same
-- night after the identical class killed the entire decomiso flow
-- ("pet-attachments", also nonexistent, also named in exactly one place).
--
-- PRIVATE, like event-attachments: the writer builds a /object/sign/ URL, so a
-- public bucket would contradict the read path it already implements.
-- Object layout is `${userId}/${timestamp}.${ext}` — the owner-scoped policies
-- below mirror pet-photos and event-attachments rather than inventing a shape.

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', false)
on conflict (id) do nothing;

drop policy if exists "Users can upload own avatar" on storage.objects;
drop policy if exists "Users can read own avatar" on storage.objects;
drop policy if exists "Users can update own avatar" on storage.objects;
drop policy if exists "Users can delete own avatar" on storage.objects;

create policy "Users can upload own avatar"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'avatars' and auth.uid() = owner);

create policy "Users can read own avatar"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'avatars' and auth.uid() = owner);

-- The use-case uploads with `upsert: true`, so replacing a photo is an UPDATE
-- on an existing object, not only an INSERT.
create policy "Users can update own avatar"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'avatars' and auth.uid() = owner);

create policy "Users can delete own avatar"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'avatars' and auth.uid() = owner);
