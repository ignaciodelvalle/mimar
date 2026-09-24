// Storage URL helpers.
//
// pet-photos is a public bucket — we build URLs deterministically without
// round-tripping the Supabase client. event-attachments and welfare-evidence are
// private — we generate short-lived signed URLs server-side at render time, as
// service role (migration 0164 for welfare-evidence, 0172 for event-attachments).
// No signer in this module takes a caller client: an authenticated-role SELECT
// on a private bucket is an enumeration grant, not an access check.

import { eventAttachmentLocation } from "@/lib/infra/attachment-location";

// The service-role client is imported dynamically: lib/supabase/admin.ts is
// `server-only`, and this module also exports petPhotoUrl/orgLogoUrl, which
// client components import. The promise is memoised so N concurrent signers
// share ONE module load instead of racing N dynamic imports.
let adminModule: Promise<typeof import("@/lib/supabase/admin")> | null = null;
function loadAdmin(): Promise<typeof import("@/lib/supabase/admin")> {
  adminModule ??= import("@/lib/supabase/admin");
  return adminModule;
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const EVENT_ATTACHMENT_URL_TTL_SECONDS = 3600;
const WELFARE_ATTACHMENT_URL_TTL_SECONDS = 3600;
// An avatar is re-signed on every render of the page that shows it, so the TTL
// only has to outlive one page view.
const AVATAR_URL_TTL_SECONDS = 3600;

export function petPhotoUrl(storagePath: string | null | undefined): string | null {
  if (!storagePath) return null;
  return `${SUPABASE_URL}/storage/v1/object/public/pet-photos/${storagePath}`;
}

// org-logos bucket — public read, like pet-photos. Used by the refugio
// public profile (handoff P2-2).
export function orgLogoUrl(storagePath: string | null | undefined): string | null {
  if (!storagePath) return null;
  return `${SUPABASE_URL}/storage/v1/object/public/org-logos/${storagePath}`;
}

/**
 * Sign an event-attachment object.
 *
 * Takes NO caller client on purpose (migration 0172, same reasoning as
 * welfareAttachmentSignedUrl below). `event_attachments_authenticated_read` was
 * `using (bucket_id = 'event-attachments')` — the bucket name and nothing else,
 * so it was TRUE for every object. That made
 * POST /storage/v1/object/list/event-attachments an enumeration of every pet's
 * vaccine cards, vet receipts and note photos in the country, readable by any
 * signed-up account. The 2026-07-04 scope review logged this as LOW on the
 * grounds that "discovery is gated by the app" — the list endpoint is gated by
 * the policy, not by the app, so that triage was wrong.
 *
 * The INSERT/UPDATE/DELETE policies stay: uploads keep running as the caller
 * (an INSERT-only grant cannot enumerate, and update/delete are `auth.uid() =
 * owner`). Only the read side moves to service role, because only the read side
 * was the enumeration surface.
 *
 * Callers must authorize first — they already do: every call site is an owner
 * page behind requirePetAccess or the pet-scoped timeline signer, and decomiso
 * evidence is additionally filtered by withholdUnreadableDecomisoEvidence.
 *
 * The bucket comes from the path (lib/infra/attachment-location.ts): decomiso
 * evidence uploaded since 0234 lives in the private `decomiso-evidence`
 * bucket and its row path carries that bucket as a prefix; everything else,
 * legacy evidence included, lives in `event-attachments`.
 */
export async function eventAttachmentSignedUrl(
  storagePath: string,
  expiresIn: number = EVENT_ATTACHMENT_URL_TTL_SECONDS,
): Promise<string | null> {
  try {
    const { createAdminClient } = await loadAdmin();
    const { bucket, objectPath } = eventAttachmentLocation(storagePath);
    const { data, error } = await createAdminClient()
      .storage.from(bucket)
      .createSignedUrl(objectPath, expiresIn);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}

/**
 * Sign a welfare-evidence object.
 *
 * Takes NO caller client on purpose (RA-8 R2, migration 0164). The
 * `welfare-evidence` bucket has no anon/authenticated storage policy: the
 * previous one gated SELECT on "some welfare_reports row owns this path
 * prefix", which names no caller, so the RLS-filtered list endpoint let anyone
 * enumerate and download every cruelty-complaint evidence file in the country.
 * RLS cannot express the actual rule — "this anonymous reporter holds the
 * receipt code" — so signing runs as service role and the AUTHORIZATION LIVES
 * IN THE CALLER, which is where it already was: every call site is a server
 * component or action that has verified a receipt code, reporter identity,
 * jurisdiction fence, or admin role before asking for a URL.
 *
 * Consequence for new call sites: calling this function is equivalent to
 * handing out the file. Do not call it from a path that has not first decided
 * the viewer may see this report.
 *
 * Returns null on any failure (missing object, unconfigured service-role key),
 * matching the previous degradation — the UI renders "(no disponible)".
 */
export async function welfareAttachmentSignedUrl(
  storagePath: string,
  expiresIn: number = WELFARE_ATTACHMENT_URL_TTL_SECONDS,
): Promise<string | null> {
  try {
    const { createAdminClient } = await loadAdmin();
    const { data, error } = await createAdminClient()
      .storage.from("welfare-evidence")
      .createSignedUrl(storagePath, expiresIn);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}

/**
 * Batch-sign multiple event-attachment paths in a single Storage round-trip.
 * Returns a Map<storagePath, signedUrl> for each path that signed successfully.
 * Paths that fail (missing, permission error) are omitted from the map.
 */
export async function eventAttachmentSignedUrls(
  storagePaths: string[],
  expiresIn: number = EVENT_ATTACHMENT_URL_TTL_SECONDS,
): Promise<Map<string, string>> {
  if (storagePaths.length === 0) return new Map();
  const result = new Map<string, string>();
  // One round-trip PER BUCKET: a path's bucket comes from its prefix
  // (lib/infra/attachment-location.ts), and the map is keyed by the ROW path
  // the caller passed, not the bucket-relative key Storage echoes back.
  const byBucket = new Map<string, Map<string, string>>();
  for (const storagePath of storagePaths) {
    const { bucket, objectPath } = eventAttachmentLocation(storagePath);
    const keys = byBucket.get(bucket) ?? new Map<string, string>();
    keys.set(objectPath, storagePath);
    byBucket.set(bucket, keys);
  }
  try {
    const { createAdminClient } = await loadAdmin();
    const client = createAdminClient();
    for (const [bucket, keys] of byBucket) {
      const { data, error } = await client.storage
        .from(bucket)
        .createSignedUrls([...keys.keys()], expiresIn);
      if (error || !data) continue;
      for (const item of data) {
        const rowPath = item.path ? keys.get(item.path) : undefined;
        if (item.signedUrl && rowPath) result.set(rowPath, item.signedUrl);
      }
    }
  } catch {
    return new Map();
  }
  return result;
}

/**
 * Sign an avatar object — a user's own profile photo, in the private `avatars`
 * bucket.
 *
 * WHY THIS EXISTS AT ALL, and it is the second half of a fix whose first half
 * is `upload-avatar.ts`. `profiles.avatar_url` used to be handed a FABRICATED
 * string: `{SUPABASE_URL}/storage/v1/object/sign/avatars/{path}` with no
 * `?token=`. The `/object/sign/` endpoint REQUIRES that token, so the value was
 * neither a working URL nor a path — a third thing useful for nothing, which is
 * exactly why `storage-gc.ts` records the `avatars` bucket as having no
 * collector ("the column's contents cannot currently be trusted to say what an
 * object's path even is. Fix the writer first."). The writer now stores the
 * bucket-relative path and THIS signs it at render time, which is what the
 * original comment in `defaultStorageUpload` always claimed was happening.
 *
 * LEGACY VALUES ARE REFUSED, NOT GUESSED, AND THE TEST IS POSITIVE RATHER THAN
 * A BLOCKLIST. Migration 0219 rewrites every row it can parse with certainty
 * and deliberately leaves the rest untouched, so a legacy value may still
 * arrive here. The first version of this guard asked `storagePath.includes("://")`
 * — which is a list of one bad shape, and it was already too narrow: a row
 * written while `NEXT_PUBLIC_SUPABASE_URL` was set but EMPTY reads
 * `/storage/v1/object/sign/avatars/{uid}/{ts}.jpg`, has no `://`, and sailed
 * past it into `createSignedUrl`. That failed closed (Storage 404 → null →
 * initials), so nothing leaked — but it failed closed by luck, not by the
 * guard, and the next odd shape gets the same non-answer.
 *
 * So the question asked is the one that actually matters: IS THIS THE KEY SHAPE
 * THIS MODULE WRITES? `avatarObjectKey` emits `{uuid}/{digits}.{ext}` and
 * nothing else. Anything that is not that is refused, whatever it is. A
 * blocklist has to anticipate the next wrong value; an allowlist does not.
 *
 * The surface falls back to initials — the same thing the person saw before,
 * since the malformed URL never rendered either.
 *
 * SERVICE ROLE, like every other signer in this module, so the caller IS the
 * authorization. The avatar key is `{userId}/…`, so calling this with a path
 * that is not the viewer's own hands out somebody else's face. Both call sites
 * pass a path read from the viewer's OWN profile row.
 */
/**
 * The ONLY key shape `avatarObjectKey` produces: a uuid prefix, a `Date.now()`
 * leaf, a short extension. Declared here rather than inline so the refusal
 * above is a single named fact and not a condition someone edits in passing.
 *
 * The extension is deliberately NOT an allowlist of `jpg|png|webp`: for most of
 * this column's life the writer took it from the client filename, so real live
 * keys end in `.JPG`, `.jpeg` and `.img`. Those objects exist and are somebody's
 * avatar. See migration 0219.
 */
const AVATAR_KEY_SHAPE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/[0-9]+\.[A-Za-z0-9]{1,10}$/;

export async function avatarSignedUrl(
  storagePath: string | null | undefined,
  expiresIn: number = AVATAR_URL_TTL_SECONDS,
): Promise<string | null> {
  if (!storagePath) return null;
  if (!AVATAR_KEY_SHAPE.test(storagePath)) return null;
  try {
    const { createAdminClient } = await loadAdmin();
    const { data, error } = await createAdminClient()
      .storage.from("avatars")
      .createSignedUrl(storagePath, expiresIn);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}
