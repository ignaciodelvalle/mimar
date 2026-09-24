// Result types for profile-self-service use-cases.

export type VetSelfResignResult = { error: string } | { ok: true; noOp?: boolean };

export type PersonalSelfDeactivateResult = { error: string } | { ok: true; noOp?: boolean };

/**
 * The inverse of PersonalSelfDeactivateResult. Same shape on purpose: the two
 * use-cases are mirror images and the UI treats their outcomes identically.
 */
export type PersonalSelfReactivateResult = { error: string } | { ok: true; noOp?: boolean };

export type GovtSelfDeactivateResult =
  | { error: string; uncoveredLocalities?: { province: string; locality: string }[] }
  | { ok: true; noOp?: boolean };

export type UpdateProfileResult = { error: string } | { ok: true };

/**
 * `storagePath`, not `avatarUrl`, and the rename is the point: what the
 * use-case produces is a bucket-relative key into the private `avatars` bucket.
 * The old field carried a fabricated `/object/sign/avatars/…` URL with no
 * `?token=` — unrenderable and unjoinable (see upload-avatar.ts). The browser
 * gets a signed URL from `uploadAvatarAction`, which signs this path.
 */
export type UploadAvatarResult = { error: string } | { ok: true; storagePath: string };
