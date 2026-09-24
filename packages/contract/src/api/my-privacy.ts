// `GET /api/v1/me/privacy` — derecho de ACCESO (Ley 25.326 art. 14), and
// `POST /api/v1/me/privacy` — derecho de SUPRESIÓN (art. 16).
//
// ONE URL FOR TWO RIGHTS, WHICH IS NOT THE SHAPE THIS REPO PREDICTED
// ---------------------------------------------------------------------------
// `apps/mobile/src/config/api.ts` has said since the Play submission that what
// would upgrade the browser link is "a `DELETE /api/v1/me` over the same RPC".
// That names one of the two rights and cannot carry the other: a DELETE has no
// response body worth the name and there is no verb on `/me` that means
// "hand me my file". Splitting them into `DELETE /me` and
// `GET /me/subject-data` would be two URLs, two bearer checks, two limiter
// pairs and two liveness guards kept in agreement by hand — the same argument
// `pets/{token}/profile` makes for putting `edit_identity` and
// `set_emergency_contacts` behind one path.
//
// So it is one surface, named after what the person came to do rather than
// after either operation: the Ley 25.326 rights page. The web agrees — both
// live on `/cuenta/privacidad`, in one component.
//
// THE READ IS A SNAPSHOT WITH NO SHELF LIFE, AND THE ENVELOPE SAYS SO
// ---------------------------------------------------------------------------
// Every other read on this surface carries a `staleAfter` a client uses to
// decide whether to re-fetch. This one carries `MY_PRIVACY_STALE_AFTER_MS = 0`,
// so `staleAfter` equals `issuedAt` and the answer to "may I reuse this?" is
// never. That is deliberate and it is the honest value rather than a disabled
// feature: the payload is the subject's whole PII record, and a client holding a
// cached copy of it "because it was still fresh" is the one caching decision
// this endpoint must never invite. A phone shows it, offers to share it, and
// forgets it.
//
// WHAT THE EXPORT CONTAINS IS NOT DESCRIBED HERE, ON PURPOSE
// ---------------------------------------------------------------------------
// `subject` is `Record<string, unknown>` and not a modelled tree. The shape is
// whatever `export_subject_data` returns, it is versioned by the RPC's own
// `schema_version` (5 since migration 0208), and it grows every time a fence
// finds another table holding the subject's data. A mirror of it in TypeScript
// would be a second declaration of "everything we hold about a person" that
// nothing checks — and the first table added to the RPC and forgotten here would
// make the contract quietly wrong about a legal guarantee. The RPC is the
// authority; this type says so by refusing to compete with it.

export const MY_PRIVACY_PAYLOAD_VERSION = 1;

/**
 * ZERO, and it is a value rather than an omission — see the header.
 *
 * `staleAfter` then equals `issuedAt`, which every client on this surface
 * already reads as "already stale". No new rule, no special case: the existing
 * freshness check answers "re-fetch" for this payload the first time it is
 * asked, which is exactly the caching policy a PII dump deserves.
 */
export const MY_PRIVACY_STALE_AFTER_MS = 0;

/** The subject's own file, as `export_subject_data` returns it. */
export type MySubjectDataExportV1 = {
  payloadVersion: typeof MY_PRIVACY_PAYLOAD_VERSION;
  /** The three envelope fields §6 requires on every read. Built by `apiV1Envelope`. */
  issuedAt: string;
  staleAfter: string;
  /**
   * The RPC's JSON, verbatim and unremodelled. Carries its own `schema_version`
   * — read THAT, not `payloadVersion`, to know which export you are holding:
   * this one versions the envelope around it, that one versions the file.
   */
  subject: Record<string, unknown>;
};

/**
 * The bare write payload for a completed supresión, per §2 (a write is not a
 * snapshot, so no envelope fields).
 *
 * `erased: true` and nothing else — no counts of what was removed, no list of
 * pets. The subject's record is gone by the time this is serialized, and a
 * response that itemised it would be handing back a last copy of the thing they
 * just asked us to destroy.
 *
 * WHAT A CLIENT MUST DO WITH IT: drop its own session. `auth.users` is deleted
 * by then, so the bearer token in its hand is already dead and every later call
 * answers 401 — but it must NOT get there by REFRESHING, because the refresh
 * will fail too and its failure reads as "your session expired", which looks
 * like a bug instead of like the thing the person just asked for. Same rule, and
 * the same reason, as `POST /me/revoke-sessions`.
 */
export type SubjectDataErasedV1 = { erased: true };
