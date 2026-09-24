// upload-avatar.ts — uploadAvatarForUser use-case.
//
// Validates the BYTES (size + magic-byte type), checks profile existence,
// uploads to the "avatars" private Supabase Storage bucket (or a test stub),
// updates the profiles row, and inserts an audit_log entry.
// Storage bucket: "avatars" (private).
//   - If bucket is missing, uploadAvatarForUser fails gracefully and logs
//     'profile_avatar_upload_failed' to audit_log.
//   - A _storageStub escape hatch lets tests inject a fake upload function.
//
// WHAT CHANGED, AND WHY IT WAS A HOLE (audit 2026-09-fresh, finding A07-2).
// ---------------------------------------------------------------------------
// The size ceiling used to be enforced against `input.fileSize` — a NUMBER the
// caller sends on the wire, next to the blob but independent of it. Every one
// of the four fields (`fileBlob`, `fileName`, `mimeType`, `fileSize`) is
// caller-controlled and nothing tied them together, so `fileSize: 1` with a
// 50 MB `fileBlob` passed validation and was uploaded through the SERVICE ROLE
// client. `mimeType` was trusted the same way: an arbitrary payload labelled
// `image/jpeg` was stored under that content type.
//
// A limit the client volunteers is not a limit. Both halves now come off the
// bytes: `fileBlob.size` for the ceiling and `detectRasterMime` for the type —
// the same magic-byte table `lib/infra/uploads.ts` and `pet-photo-upload.ts`
// use, deliberately imported rather than restated (`lib/media/validate.ts`:
// "IT IS ONE COPY, NOT A SECOND ONE").
//
// The BUCKET is the other half and it is not this file's: migration 0218 gives
// `avatars` its own `file_size_limit` and `allowed_mime_types`, so a caller who
// reaches the Storage API directly with its own token — never running this
// code — is bounded too. This check exists so the person gets a Spanish
// sentence telling them what to do instead of an opaque storage error.
//
// THE DECLARED MIME IS NOW A SIGNAL, NOT A GATE, and that is a deliberate
// reversal of the first draft of this fix. That draft kept the old zod enum as
// a "cheap pre-check" while calling it something that "decides nothing" — and
// it was not true in the negative: `File.type` is filled in by the operating
// system from the FILE EXTENSION, so a perfectly real JPEG that somebody saved
// as `foto.heic` arrives declared `image/heic` and that enum refused it before
// a single byte was read. A false refusal, produced by the layer with no
// authority, against a person who did nothing wrong. Once the declared type
// decides nothing it may not refuse anything either, so the enum is gone: the
// bytes are the only gate. What the caller declared is recorded on the audit
// row when it DISAGREES with the bytes — a mismatch is usually that same
// harmless rename, but a polyglot upload is the same shape and must not pass
// through leaving no trace at all.
//
// `fileName` survives on the input type for wire compatibility with
// `uploadAvatarAction` and reaches NOTHING: not the object key (see
// `avatarObjectKey`), not the audit row, not the upload.

import { eq } from "drizzle-orm";

import { db, profiles } from "@/db";
import { writeAuditLog } from "@/lib/infra/audit-log";
import { avatarSignedUrl } from "@/lib/infra/storage";
import { metadataStripRefusalMessage } from "@/lib/media/heic";
import {
  MAX_IMAGE_BYTES,
  type RasterMime,
  detectRasterMime,
  rasterExtension,
  reencodeRaster,
} from "@/lib/media/validate";
import { createAdminClient } from "@/lib/supabase/admin";

import type { UploadAvatarResult } from "./types";

// ---------------------------------------------------------------------------
// The object key
// ---------------------------------------------------------------------------

/**
 * The storage key for a user's avatar, derived from the VALIDATED mime.
 *
 * EXPORTED SO IT CAN BE TESTED, which is the whole reason it is a function at
 * all. It used to be two inline lines ending in `fileName.split(".").pop()` —
 * a client string in the object key, which is how `x.jpg/../../evil` gets into
 * a storage path. `lib/infra/uploads.ts:84` derives it from the validated mime
 * for the same reason. Inline, the fix was unobservable: every test drove the
 * writer through `_storageStub`, which computes no key, so restoring the old
 * line left the whole suite green. Key derivation now lives in exactly one
 * place and that place has a test.
 *
 * Nothing the caller sent reaches the return value.
 */
export function avatarObjectKey(userId: string, mimeType: RasterMime): string {
  return `${userId}/${Date.now()}.${rasterExtension(mimeType)}`;
}

// ---------------------------------------------------------------------------
// Storage upload helper type (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * ONE FIELD, AND THE SECOND ONE'S REMOVAL IS THE FIX.
 *
 * This used to also carry `publicUrl`:
 * `${NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/sign/avatars/${storagePath}`,
 * and THAT is what went into `profiles.avatar_url`. The `/object/sign/`
 * endpoint requires a `?token=` query parameter; this string never had one. So
 * the column held neither a working URL nor a path — a third thing useful for
 * nothing, which is why `lib/infra/storage-gc.ts` records `avatars` as the
 * bucket most worth collecting and refuses to collect it ("the column's
 * contents cannot currently be trusted to say what an object's path even is.
 * Fix the writer first"), and why an art. 16 erasure left the person's own face
 * in our object store.
 *
 * The path is now what is stored, which is what the comment below the old line
 * always claimed. Rendering signs it: `avatarSignedUrl` in lib/infra/storage.ts.
 */
type StorageUploadResult = { storagePath: string };
type StorageUploadFn = (opts: {
  userId: string;
  /** The bytes, read ONCE by the caller — a 5 MiB blob is not materialised twice. */
  body: ArrayBuffer;
  /** The mime decided by the magic bytes — never the one the caller declared. */
  mimeType: RasterMime;
}) => Promise<StorageUploadResult>;

async function defaultStorageUpload({
  userId,
  body,
  mimeType,
}: {
  userId: string;
  body: ArrayBuffer;
  mimeType: RasterMime;
}): Promise<StorageUploadResult> {
  const supabase = createAdminClient();
  const storagePath = avatarObjectKey(userId, mimeType);

  const { error } = await supabase.storage.from("avatars").upload(storagePath, body, {
    contentType: mimeType,
    upsert: true,
  });

  if (error) throw new Error(error.message);

  // The storage path, bucket-relative. A signed URL is generated at render
  // time (`avatarSignedUrl`) — nothing with an expiry is baked into the row,
  // and the row is something the database can join on.
  return { storagePath };
}

// ---------------------------------------------------------------------------
// Writer: uploadAvatarForUser
// ---------------------------------------------------------------------------

export async function uploadAvatarForUser(
  userId: string,
  input: {
    fileBlob: Blob;
    /**
     * REACHES NOTHING. Wire compatibility with `uploadAvatarAction` only — not
     * the object key, not the audit row, not the upload. See the header.
     */
    fileName: string;
    /** The caller's CLAIM about the type. Recorded on disagreement; gates nothing. */
    mimeType: string;
    /**
     * IGNORED for every decision. The caller's CLAIM about the blob's size,
     * kept only for wire compatibility with `uploadAvatarAction`. The bound is
     * `fileBlob.size`; see this file's header for what happened when it wasn't.
     */
    fileSize?: number;
    // Escape hatch for tests — bypasses Supabase storage
    _storageStub?: StorageUploadFn;
  },
): Promise<UploadAvatarResult> {
  // 1a. THE decision, and it is taken off the blob. `fileBlob.size` is the
  // length of the bytes this process is holding — there is no wire field
  // between it and the upload for a caller to disagree with.
  if (input.fileBlob.size > MAX_IMAGE_BYTES) {
    return {
      error:
        "VALIDATION_ERROR: La imagen no puede superar los 5 MB. Probá con una foto más liviana.",
    };
  }

  // 1b. The type, likewise: the file signature decides, not `input.mimeType`.
  // An SVG, an HTML document or a ZIP labelled `image/jpeg` all die here — and
  // so does a real HEIC, which no branch of this accepts under any label.
  //
  // Read ONCE. `body` is handed to the upload function rather than re-read
  // there, so a 5 MiB photo is materialised a single time.
  const body = await input.fileBlob.arrayBuffer();
  const detectedMime = detectRasterMime(new Uint8Array(body));
  if (!detectedMime) {
    return {
      error:
        "VALIDATION_ERROR: El archivo debe ser una imagen JPG, PNG o WebP. Probá con otra foto.",
    };
  }

  // 1c. RE-ENCODED, SO THE CAMERA'S METADATA NEVER REACHES STORAGE (PO D4,
  // 2026-09-18: "no guardar datos de ciudadanos que no nos dieron
  // concientemente"). The avatar used to be stored byte-for-byte, so a selfie
  // taken at home kept its EXIF GPS in the bucket. Same sharp pass as
  // lib/infra/uploads.ts, and the same failure rule: FAIL CLOSED — if sharp
  // cannot read it, nothing is stored, never the original bytes.
  let reencoded: Buffer;
  try {
    reencoded = await reencodeRaster(Buffer.from(body));
  } catch (err) {
    console.warn("[upload-avatar] EXIF strip failed, refusing rather than storing raw:", err);
    return { error: `VALIDATION_ERROR: ${metadataStripRefusalMessage()}` };
  }
  // The input bound above does not bound the output: sharp adds no resize or
  // quality floor, so a re-encode can come out larger (see uploads.ts).
  if (reencoded.byteLength > MAX_IMAGE_BYTES) {
    return {
      error:
        "VALIDATION_ERROR: La imagen es muy pesada después de procesarla. Probá con una foto más chica.",
    };
  }
  const storedBody = reencoded.buffer.slice(
    reencoded.byteOffset,
    reencoded.byteOffset + reencoded.byteLength,
  ) as ArrayBuffer;

  // 2. Existence check
  const [current] = await db
    // The stored path is read for the audit row's `before` state — replacing an
    // avatar and setting the first one are different facts.
    .select({ id: profiles.id, avatarStoragePath: profiles.avatarStoragePath })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);

  if (!current) return { error: "NOT_FOUND" };

  // 3. Upload
  const uploadFn = input._storageStub ?? defaultStorageUpload;

  let uploadResult: StorageUploadResult;
  try {
    uploadResult = await uploadFn({
      userId,
      // The RE-ENCODED bytes — never `body`, which still carries the EXIF.
      body: storedBody,
      mimeType: detectedMime,
    });
  } catch (err) {
    // Graceful failure: log to audit_log and return error.
    // Deliberately NOT transactional — there is no DB mutation to pair with;
    // the failed thing was a storage upload, and this row IS the whole fact.
    try {
      await writeAuditLog(db, {
        action: "profile_avatar_upload_failed",
        actorUserId: userId,
        targetUserId: userId,
        payload: {
          error: err instanceof Error ? err.message : String(err),
          // The validated facts, not the declared ones — an audit row that
          // records the caller's claim records the wrong number.
          mime_type: detectedMime,
          file_size: input.fileBlob.size,
        },
      });
    } catch {
      // Swallow audit failure — don't mask original error
    }
    return { error: `STORAGE_FAILED: ${err instanceof Error ? err.message : "unknown error"}` };
  }

  // 4+5. Update profile + audit — ONE transaction (2026-08-16). The storage
  // object is already written and cannot join a Postgres transaction, but the
  // profiles row pointing AT it and the record of who pointed it there are one
  // fact and must commit together.
  await db.transaction(async (tx) => {
    await tx
      .update(profiles)
      .set({ avatarStoragePath: uploadResult.storagePath, updatedAt: new Date() })
      .where(eq(profiles.id, userId));

    await writeAuditLog(tx, {
      action: "profile_avatar_updated",
      actorUserId: userId,
      targetUserId: userId,
      payload: {
        storage_path: uploadResult.storagePath,
        // RECORDED ONLY WHEN THEY DISAGREE. A mismatch is nearly always an
        // honest rename — `File.type` comes from the OS extension mapping, so
        // a JPEG saved as `.png` arrives declared PNG — and refusing it would
        // punish that person for nothing. But a polyglot deliberately labelled
        // to slip past a declared-type check has exactly the same shape, and
        // before this the success row recorded neither type, so it left no
        // trace anywhere. Writing the pair only on disagreement keeps the
        // signal without a false-positive tax on the ordinary upload.
        ...(input.mimeType !== detectedMime
          ? { mime_declared: input.mimeType, mime_detected: detectedMime }
          : {}),
      },
      before: { avatar_url: current.avatarStoragePath },
      after: { avatar_url: uploadResult.storagePath },
    });
  });

  // The PATH, not a URL. `uploadAvatarAction` signs it for the browser — this
  // use-case owns the durable fact and the render concern stays at the edge.
  return { ok: true, storagePath: uploadResult.storagePath };
}

// ---------------------------------------------------------------------------
// Upload + sign, composed here rather than in the Server Action
// ---------------------------------------------------------------------------

/**
 * Uploads the avatar and returns a SHORT-LIVED SIGNED URL for the caller to
 * render immediately, alongside nothing else.
 *
 * WHY THIS COMPOSITION LIVES IN THE APPLICATION LAYER AND NOT IN THE ACTION.
 * The action tried to own it first and `check-action-line-budget` refused —
 * correctly. `app/actions/profile.ts` is a known fat action with a frozen line
 * budget, and the fence's message is not a formality: it says migrate logic to
 * `src/modules/<domain>/application/` instead of adding to it. Signing a path
 * is a decision about what the caller is allowed to see, which is application
 * work; the action's whole job is to establish WHO is asking and hand off.
 *
 * THE SPLIT BETWEEN PATH AND URL IS PRESERVED, NOT COLLAPSED. `uploadAvatarForUser`
 * still returns only the durable fact — the object key. This function is a
 * second, explicit step on top of it. Collapsing the two is precisely the
 * mistake that put a fabricated tokenless `/object/sign/avatars/…` string into
 * `profiles.avatar_url`: a value that was neither the durable fact nor a
 * renderable URL. One function may produce a key; another may produce a lease
 * on it; no function produces a thing that is secretly both.
 *
 * `avatarUrl` IS NULLABLE AND THAT IS NOT A FAILURE. The upload succeeded and
 * the row points at the object; only the lease could not be minted. A caller
 * that treats null as an error would tell the person their photo did not
 * upload, which is false — and /cuenta signs the stored path again on its own
 * render anyway. The correct handling is to keep showing whatever preview was
 * already on screen.
 */
export async function uploadAvatarAndSign(
  userId: string,
  input: Parameters<typeof uploadAvatarForUser>[1],
): Promise<{ error: string } | { ok: true; avatarUrl: string | null }> {
  const result = await uploadAvatarForUser(userId, input);
  if ("error" in result) return result;
  // The key just written belongs to THIS user — `avatarObjectKey` derives it
  // from `userId` and nothing the caller sent reaches it — which is what makes
  // signing it here safe without a second ownership check.
  return { ok: true, avatarUrl: await avatarSignedUrl(result.storagePath) };
}
