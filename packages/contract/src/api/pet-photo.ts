// `POST /api/v1/pets/{publicToken}/photo` — the two answers.
//
// `PetPhotoTicketV1` is the reply to `request_ticket`; `PetPhotoUpdatedV1` is
// the reply to `confirm`. Both are WRITE replies and therefore carry no
// `payloadVersion` / `issuedAt` / `staleAfter` envelope — that envelope belongs
// to reads, and `check-api-v1-envelope` is the fence that keeps the two apart.
//
// THE TICKET IS A BEARER CAPABILITY. SAY SO WHERE IT IS DEFINED.
// ---------------------------------------------------------------------------
// `uploadUrl` and `token` together let whoever holds them write ONE object, at
// ONE key, into a private staging bucket, until the URL expires. That is less
// than it sounds — the key is unguessable, nothing can read the bucket but the
// server, and a staged object becomes a photo only if a re-authorized `confirm`
// accepts its bytes — but it is still a credential, and it gets the rule
// `pet-shares.ts` states for its share tokens:
//
//   DO NOT PERSIST THIS PAYLOAD. Not to a disk cache, not to a log line, not
//   into a crash report. It belongs in the upload call and it dies with it.
//
// THE TTL IS NOT OURS TO CHOOSE, AND PRETENDING OTHERWISE WOULD BE A LIE
// ---------------------------------------------------------------------------
// `createSignedUploadUrl` in `@supabase/storage-js` takes a path and an optional
// `{ upsert }` and NOTHING ELSE; its own docblock says the URLs "are valid for 2
// hours". There is no `expiresIn` to pass, so `validForSeconds` below reports
// the window that exists rather than one we picked, and it is reported at all so
// a client can decide to re-ticket instead of retrying a dead URL.
//
// Two hours is longer than this flow needs and the mitigations are structural
// rather than temporal: the capability is scoped to one exact object key (not a
// prefix), the key is a UUID under another UUID, the bucket is private and
// deny-all to caller roles, the object store caps the size and the declared
// type, and nothing about the staged object is believed until `confirm` fetches
// the bytes and validates them. If Supabase ever exposes the expiry, this field
// is where the shorter number lands.

/**
 * A minted upload ticket. Every field is server-chosen.
 *
 * `stagedPath` is echoed back because `confirm` must name the object the ticket
 * created — and NOT because the server trusts what comes back. The confirm step
 * re-derives the prefix this key must have had for this pet and refuses
 * anything else; see `packages/contract/src/input/pet-photo.ts`.
 */
export type PetPhotoTicketV1 = {
  /** The full signed URL to PUT the bytes to. Includes `?token=`. */
  readonly uploadUrl: string;
  /**
   * The same token, on its own, for a client using
   * `supabase.storage.from(bucket).uploadToSignedUrl(path, token, body)` rather
   * than a raw PUT. Both doors are the same capability; a client picks one.
   */
  readonly token: string;
  /** The object key inside the staging bucket, `{petId}/{uuid}.{ext}`. */
  readonly stagedPath: string;
  /** The staging bucket's name, so a client need not hard-code it. */
  readonly bucket: string;
  /**
   * How long the capability lives — REPORTED, NOT SET.
   *
   * It was called `expiresInSeconds` first, and that name was wrong in the one
   * way that matters: it reads like a knob this API turned. It is not. Supabase
   * fixes the window at two hours and exposes no way to ask for another, so
   * this field is a measurement of somebody else's behaviour that a client is
   * told so it can re-ticket instead of retrying a dead URL. If the SDK ever
   * accepts an expiry, `SUPABASE_SIGNED_UPLOAD_VALIDITY_SECONDS` in
   * lib/infra/pet-photo-upload.ts is the one line that changes.
   */
  readonly validForSeconds: number;
};

/**
 * The pet's photo, after `confirm` accepted it.
 *
 * `photoUrl` is a PUBLIC url, built the same way every other surface builds it
 * (`petPhotoUrl` → `/storage/v1/object/public/pet-photos/{path}`), so a client
 * can put it straight into an `<Image>` — the same decision `/me/pets` made and
 * for the same reason.
 *
 * `replacedPrevious` says whether this call displaced an earlier photo. A client
 * that shows "listo" either way would be hiding the one outcome an owner might
 * want to think about.
 */
export type PetPhotoUpdatedV1 = {
  readonly photoUrl: string;
  readonly replacedPrevious: boolean;
};
