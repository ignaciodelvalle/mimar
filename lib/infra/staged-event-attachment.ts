import "server-only";

// CLAIMING A STAGED OBJECT AS AN EVENT ATTACHMENT.
//
// The native door has no multipart. `POST /api/v1/pets/{token}/events` is JSON,
// so an asiento that REQUIRES a photo — today exactly one, tatuaje — needs the
// bytes to have arrived by another road and to be named in the body. That road
// already exists and is the pet photo's: `mintPetPhotoTicket` hands out a
// signed PUT into `uploads-staging` (migration 0206, private, deny-all to
// caller roles, read by nothing), and the client PUTs the file there.
//
// THIS MODULE IS THE SECOND HALF, and it is the same shape as
// `confirmPetPhoto`'s — deliberately, because the reasoning is identical and
// docs/architecture/api-invariants.md §1.5 refuses the alternative:
//
//   1. THE PATH. Refuse anything whose first segment is not this pet's id.
//      `stagedPathBelongsToPet` is reused rather than re-derived; the guard is a
//      PREFIX EQUALITY against a pet id the SERVER resolved, never a pattern
//      match against a string a caller sent.
//   2. THE BYTES. Downloaded as service role — the bucket admits nobody else —
//      and bounded again on the way out, because the bucket's `file_size_limit`
//      is configuration on a remote service and configuration drifts.
//   3. THE CONTENT. `detectRasterMime` over what actually arrived. The content
//      type the ticket declared was only ever a claim and only ever picked an
//      extension.
//   4. THE EXIF STRIP. Through sharp, and it FAILS CLOSED on both of its arms.
//      The first version of this module let both fall back to the original
//      bytes, citing `lib/infra/uploads.ts`, which tolerates that for a PRIVATE
//      bucket. That imported the wrong half of the web's rule: `uploads.ts`
//      falls back where stripping is an opt-in nicety, and here it is the
//      reason the road exists. The bytes are a phone photo taken AT HOME, and
//      `event-attachments` is reachable by any org member holding `event.write`
//      through a signed URL — so a fall-back publishes somebody's coordinates
//      to a shelter. See the call site for why both arms answer
//      `photo_not_an_image`.
//   5. THE CLEANUP. The staged object goes on every path out EXCEPT one: an
//      error that is not a definite 404. Deleting on "we could not read it"
//      turns a transient Storage outage into data loss the caller could
//      otherwise recover from by retrying the same staged path, and
//      `isMissingObjectError` below is the whole of that distinction.
//
//      IT GOES ON THE TWO EXIF REFUSALS, which is where this parts company with
//      `confirmPetPhoto` — that one keeps its oversize staged object. The
//      difference is what the object IS: these bytes are the un-stripped
//      original we just refused to propagate, no retry of them can succeed, and
//      nothing in this repo collects an abandoned staged object (RN-4 A9: 24
//      crons, none touches storage). Keeping them would be keeping the exact
//      thing the refusal was about.
//
// WHAT IT DOES NOT DO: write any row. It returns the three facts an
// `attachments` insert needs and nothing else, because the row belongs inside
// the writer's transaction alongside the event it is an attachment OF. That is
// also why the caller owns the unwind — see `appendTattoo`, which removes this
// object when the append fails, the same cleanup `createTattooAction` performs
// on the web.

import { STAGING_BUCKET, stagedPathBelongsToPet } from "@/lib/infra/pet-photo-upload";
import {
  MAX_IMAGE_BYTES,
  type RasterMime,
  detectRasterMime,
  rasterExtension,
  reencodeRaster,
} from "@/lib/media/validate";
import { createAdminClient } from "@/lib/supabase/admin";

import { randomUUID } from "node:crypto";

/** The private bucket an event's attachments live in. */
export const EVENT_ATTACHMENT_BUCKET = "event-attachments";

export type ClaimedAttachment = { path: string; mimeType: RasterMime; size: number };

export type ClaimResult =
  | { ok: true; attachment: ClaimedAttachment }
  /**
   * The same two codes `confirmPetPhoto` answers, reused rather than widened.
   *
   * `photo_not_an_image` covers "that key is not yours", "there is nothing
   * there" and "those bytes are not a raster" with ONE answer on purpose: three
   * codes would make this an oracle for which staged keys exist, which is the
   * rule `/pets/{token}` applies to public tokens and the rule the pet photo's
   * confirm applies to staged keys.
   */
  | { ok: false; code: "photo_not_an_image" | "photo_failed" };

/**
 * Does this returned Storage error mean the object IS NOT THERE, as opposed to
 * "we could not find out"?
 *
 * THE ONLY QUESTION WHOSE ANSWER DELETES SOMEBODY'S PHOTO, so it is answered
 * narrowly and it defaults to NO. `@supabase/storage-js@2.105.4` returns two
 * shapes on this path: a `StorageApiError`, which carries the service's HTTP
 * `status`, and a `StorageUnknownError` for a refused connection, a DNS
 * failure or a timeout, whose `status` is `undefined`. A missing key is a 404
 * and nothing else is, so a 404 is the whole of the affirmative case — and a
 * transport fault, a 5xx, a 403 and anything this list has not met all answer
 * `false` and keep the bytes.
 *
 * Exported so a test can exercise it directly: a guard reachable only through a
 * Storage round trip is a guard that gets tested through a mock of itself —
 * `stagedPathBelongsToPet` next door is exported for the same reason.
 */
export function isMissingObjectError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const status = (error as { status?: unknown }).status;
  return status === 404;
}

/**
 * Turn a staged object into an event attachment, or refuse it.
 *
 * THE CALLER MUST HAVE AUTHORIZED ALREADY. It takes a `petId`, not a public
 * token, for the same reason `mintPetPhotoTicket` does: it cannot check
 * anything about the caller, so it must not look like it does.
 */
export async function claimStagedEventAttachment(params: {
  petId: string;
  stagedPath: string;
}): Promise<ClaimResult> {
  const { petId, stagedPath } = params;
  const admin = createAdminClient();

  if (!stagedPathBelongsToPet(stagedPath, petId)) {
    return { ok: false, code: "photo_not_an_image" };
  }

  const discardStaged = async (): Promise<void> => {
    // `remove()` ANSWERS WITH `{ data, error }` AND DOES NOT THROW, so a
    // `try/catch` around it observes nothing. This function used to have one
    // and no `error` read at all, which meant a failed discard logged NOTHING
    // in a repo with no storage GC for any bucket (RN-4 A9). The catch is kept
    // for a transport fault that escapes the client entirely; the destructure
    // below is what actually fires.
    try {
      const { error } = await admin.storage.from(STAGING_BUCKET).remove([stagedPath]);
      if (error) {
        console.warn("[event-attachment] could not discard the staged object", {
          stagedPath,
          message: error.message,
        });
      }
    } catch (err) {
      console.warn("[event-attachment] discarding the staged object threw", {
        stagedPath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  let bytes: Buffer;
  try {
    const { data, error } = await admin.storage.from(STAGING_BUCKET).download(stagedPath);
    if (error) {
      // THE BRANCH THAT DECIDES WHETHER SOMEBODY'S PHOTO IS DELETED, and it
      // reads the RETURNED error rather than a thrown one. This module's first
      // version discriminated "gone" from "could not read" by whether
      // `download()` THREW — and it almost never does: `@supabase/storage-js`
      // wraps a refused connection, a DNS failure, a timeout and every 5xx in a
      // `StorageUnknownError` and RETURNS it. So a degraded storage-api landed
      // in the missing-object arm, DELETED the owner's tattoo photo, and told
      // them the file was not an image.
      if (isMissingObjectError(error)) {
        await discardStaged();
        return { ok: false, code: "photo_not_an_image" };
      }
      console.error("[event-attachment] could not read the staged object", {
        stagedPath,
        message: error.message,
      });
      return { ok: false, code: "photo_failed" };
    }
    if (!data) {
      // No error and no body is a state the client does not document. UNKNOWN
      // is not MISSING, so the object stays and the caller may retry.
      console.error("[event-attachment] the staged download answered no body and no error", {
        stagedPath,
      });
      return { ok: false, code: "photo_failed" };
    }
    bytes = Buffer.from(await data.arrayBuffer());
  } catch (err) {
    // A fault that escaped the client entirely. NOT discarded — rule 5.
    console.error("[event-attachment] reading the staged object threw", {
      stagedPath,
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "photo_failed" };
  }

  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    await discardStaged();
    return { ok: false, code: "photo_not_an_image" };
  }

  const detected = detectRasterMime(bytes);
  if (!detected) {
    await discardStaged();
    return { ok: false, code: "photo_not_an_image" };
  }

  // THE EXIF STRIP, AND IT FAILS CLOSED ON BOTH ARMS.
  //
  // It used to fall back to the ORIGINAL bytes twice — once when sharp threw,
  // once when the re-encode came back over the bucket limit — on the grounds
  // that `lib/infra/uploads.ts` tolerates that for a PRIVATE bucket. That
  // reasoning imported the wrong half of the web's rule. `uploads.ts` falls
  // back only where stripping was an OPT-IN nicety; here it is the reason this
  // road exists at all. The bytes arriving on it are a phone photo of an animal
  // taken AT HOME, and `event-attachments` is readable by any org member with
  // `event.write` through a signed URL — so a fall-back does not store a
  // slightly-worse image, it publishes somebody's home coordinates to a shelter.
  //
  // The SECOND arm was the worse of the two because it is not an error path at
  // all: an indexed-palette PNG re-encoded non-palettised grows, crosses
  // `MAX_IMAGE_BYTES`, and the old line reverted to the original silently on a
  // perfectly healthy request.
  //
  // `photo_not_an_image` on both, which is `confirmPetPhoto`'s own choice for
  // its oversize arm (pet-photo-upload.ts:402-415) and for its reason: the name
  // is imprecise — the file IS an image — and `photo_failed` would promise in
  // its own contract that retrying is safe, when re-encoding the same bytes
  // produces the same refusal forever. A code that invites an impossible retry
  // is a worse lie than a name that is off.
  let body: Buffer;
  try {
    body = await reencodeRaster(bytes);
  } catch (err) {
    console.warn("[event-attachment] re-encode failed, refusing rather than storing raw EXIF", {
      stagedPath,
      message: err instanceof Error ? err.message : String(err),
    });
    await discardStaged();
    return { ok: false, code: "photo_not_an_image" };
  }

  if (body.byteLength > MAX_IMAGE_BYTES) {
    console.warn("[event-attachment] stripped body exceeds the bucket limit, refusing", {
      petId,
      bytes: body.byteLength,
    });
    await discardStaged();
    return { ok: false, code: "photo_not_an_image" };
  }

  // Derived from what the BYTES turned out to be, never from what the ticket
  // declared, and never from any client string — the rule `uploads.ts` has
  // followed since it was written.
  const finalPath = `${petId}/${randomUUID()}.${rasterExtension(detected)}`;

  const { error: uploadError } = await admin.storage
    .from(EVENT_ATTACHMENT_BUCKET)
    .upload(finalPath, body, { contentType: detected });
  if (uploadError) {
    console.error("[event-attachment] could not write the attachment", {
      petId,
      message: uploadError.message,
    });
    await discardStaged();
    return { ok: false, code: "photo_failed" };
  }

  await discardStaged();

  return {
    ok: true,
    attachment: { path: finalPath, mimeType: detected, size: body.byteLength },
  };
}

/**
 * Take back an attachment this module wrote, when the append it was for failed.
 *
 * Best-effort and never throws: a Storage hiccup during an unwind must not turn
 * one failure into two. The web's `cleanupAttachment` (app/actions/tattoo.ts)
 * is the same function with the same reasoning.
 */
export async function discardClaimedAttachment(path: string): Promise<void> {
  try {
    // THE `error` IS READ, and it is the only thing that ever reports here.
    // `remove()` resolves with `{ data, error }` rather than throwing, so the
    // bare `try/catch` this used to be logged nothing at all when a cleanup
    // failed — leaving an orphaned object in a bucket nothing collects, and no
    // line anywhere saying so.
    const { error } = await createAdminClient()
      .storage.from(EVENT_ATTACHMENT_BUCKET)
      .remove([path]);
    if (error) {
      console.warn("[event-attachment] could not remove the orphaned attachment", {
        path,
        message: error.message,
      });
    }
  } catch (err) {
    console.warn("[event-attachment] removing the orphaned attachment threw", {
      path,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
