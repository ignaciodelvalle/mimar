// The wire shape of `GET /api/v1/pets/{publicToken}/events/{eventId}` — one
// asiento, in full.
//
// TYPES ONLY plus four frozen literals, like every other file in this entry
// point. There is no request body; the WRITE that lives beside this endpoint
// (`.../amend`) has its schema in `@dim/contract/input`.
//
// WHAT THIS IS FOR. A client taps a row in the libreta and lands here: the full
// curated field set, when it happened and when it was written, who signed it,
// the correction history, and the files. It is `/mis-mascotas/{token}/eventos/
// {eventId}` on the web, over a bearer token.
//
// THE CORRECTION HISTORY IS THE PART WORTH READING TWICE. `facts` is the
// CORRECTED record — what is true about the animal now. `amendments` is how it
// got there, oldest first, each step naming the curated fields it moved. The
// original is never presented as current and it is never hidden either; that is
// what an append-only ledger with corrections means, and a client that rendered
// only one of the two would be telling half of it.
//
// NO INTERNAL IDs BEYOND WHAT A CTA NEEDS, the same rule the owner face states.
// `eventId` addresses this screen and the amend endpoint; `attachmentId` keys a
// list and lets a client remember which image it opened. No pet id, no case id,
// no `recorded_by_user_id` — WHO recorded an asiento reaches a citizen as a
// ROLE, never as an operator's name (the repo's privacy convention, the same one
// `AuthorChip` enforces on the web).

import type { CredentialSection } from "./public-credential.ts";

/**
 * Bumped when a field changes meaning or leaves. A client compares this against
 * the version it was built for BEFORE trusting any field.
 */
export const PET_EVENT_DETAIL_PAYLOAD_VERSION = 1;

/** How long a client may present a cached copy as current. */
export const PET_EVENT_DETAIL_STALE_AFTER_MS = 5 * 60_000;

/**
 * How long an attachment link stays redeemable, in seconds.
 *
 * A QUARTER of the web's hour, and the difference is the transport rather than a
 * different opinion about the risk. The web mints a fresh URL on every render,
 * so its links die of navigation; a phone holds this payload for the life of a
 * screen and could hold it much longer. Fifteen minutes is three times the
 * payload's own `staleAfter`, which is enough headroom for someone who opens the
 * screen and taps the photo after reading the rest, and short enough that a
 * payload recovered from a device days later carries nothing redeemable.
 *
 * IT IS EXPORTED SO THE EXPIRY ON THE WIRE CANNOT DRIFT FROM THE SIGNATURE.
 * `expiresAt` on each attachment is computed from this same number that was
 * handed to the signer — a client rendering "el enlace vence a las 15:42" must
 * be reading the real expiry, not a second constant that agreed with it once.
 */
export const EVENT_ATTACHMENT_LINK_TTL_SECONDS = 900;

/**
 * One row of the curated (whitelisted) payload view.
 *
 * `field` is the PAYLOAD KEY behind the row, and it is here for exactly one
 * reason: the correction form. A client that wants to offer "corregir este
 * dato" has to name the field the server will change, and the alternative was a
 * second copy of the whitelist on the client deciding which keys are safe to
 * show — which is how the two drift.
 *
 * Emitting these keys is safe in a way emitting a raw payload is not: every one
 * of them is a key the curated projection ALREADY decided to render. A hash, an
 * internal id or `matched_chip_number` never produces a row, so it never
 * produces a `field` either, and a form built from this list can only ever
 * correct what the ledger already shows.
 */
export type EventFactV1 = {
  field: string;
  label: string;
  value: string;
};

/**
 * WHO recorded the asiento, as a ROLE and a verification mark.
 *
 * Never a person's name. An operator's PII is not shown to the citizen reading
 * their own animal's ledger — the web enforces the same rule in `AuthorChip`,
 * and the LABEL is composed server-side so a client does not carry a second copy
 * of the role vocabulary that could fall out of step.
 *
 * `orgDisplayName` is the exception the convention allows: an ORGANIZATION's
 * identity is not a person's, and naming the clinic that signed a dose is what
 * keeps "Registrado por …" from reading as an anonymous claim.
 */
export type EventAuthorV1 = {
  roleLabel: string;
  verified: boolean;
  orgDisplayName: string | null;
};

/**
 * One file on the record, with a link that EXPIRES and says when.
 *
 * `url` is null when the object could not be signed — a missing object, or a
 * misconfigured signer. A record that carries NO files is a different fact and
 * has a different shape: an empty list. A client must render the difference;
 * the web prints "Adjunto no disponible" for exactly this case.
 *
 * `kind` is derived from the MIME type server-side because the branch is a
 * product decision, not a string test: an image renders inline, and anything
 * else opens in the browser, because this app has no PDF viewer and pretending
 * otherwise would be a dead tap.
 *
 * DO NOT CACHE `url` PAST `expiresAt`. It is a bearer capability over a private
 * object: whoever holds the string holds the file until it expires, which is why
 * it must not reach a log, a crash report, or a disk cache that outlives it.
 */
export type EventAttachmentV1 = {
  attachmentId: string;
  kind: "image" | "file";
  mimeType: string;
  url: string | null;
  /** ISO instant. Null exactly when `url` is null. */
  expiresAt: string | null;
};

/**
 * One correction, as a citizen reads it.
 *
 * `changes` names the CURATED fields that moved — derived by running the same
 * whitelist over the record before and after this step, never by echoing the
 * raw `changes` array from the spine. The amend form lets an owner edit any
 * payload key, so echoing it would put un-curated key names (and their values)
 * on a citizen surface, which is exactly what the whitelist exists to prevent.
 * A step that moved nothing curated therefore carries an empty list and still
 * appears: the correction happened, and hiding it would be worse than not being
 * able to say what it touched.
 */
export type EventAmendmentV1 = {
  amendmentId: string;
  occurredAt: string;
  reason: string | null;
  /** Who corrected it, as a label — same rule as `EventAuthorV1.roleLabel`. */
  actorRoleLabel: string;
  changes: Array<{ label: string; from: string | null; to: string | null }>;
};

/** Where the event happened, when the record carries a point. */
export type EventLocationV1 = { lat: number; lng: number };

/**
 * Whether this viewer may correct this record, and the sentence to show when
 * they may not.
 *
 * `refusal` is es-AR copy rather than a code because it is the SCREEN's
 * sentence, not an error channel — the endpoint that refuses a correction has
 * the three-code envelope for that. The two exist together on purpose: a client
 * that only knew `canAmend: false` would have to invent a reason, and "no se
 * puede" with no explanation reads as a bug.
 */
export type EventAmendAffordanceV1 = {
  canAmend: boolean;
  refusal: string | null;
};

/**
 * `POST /api/v1/pets/{publicToken}/events/{eventId}/amend` — HTTP 201.
 *
 * 201 BECAUSE A CORRECTION CREATES SOMETHING. It does not edit the record it
 * names — nothing in this product edits a `pet_events` row, a database trigger
 * refuses it — it appends a NEW event that references the original. The status
 * says which of the two happened.
 *
 * A REPLAY ANSWERS 201 WITH THE SAME BODY, exactly as `POST /api/v1/pets` does:
 * the caller asked for a correction to exist and a correction exists.
 * `wasDuplicate` is there so a client can skip a success animation it already
 * played; a client that ignores it still behaves correctly.
 *
 * `amendmentEventId` addresses the correction itself, which IS a row in the
 * ledger — a client can open it like any other asiento. It is the same class of
 * identifier as `eventId` and it earns its place the same way.
 */
export type EventAmendedV1 = {
  amendmentEventId: string;
  wasDuplicate: boolean;
};

/**
 * `POST /api/v1/pets/{publicToken}/events` — HTTP 201.
 *
 * The answer to every one of the six daily writers (vacuna, peso,
 * antiparasitario, the medication pair, nota). One shape for all six because
 * the caller's next move is the same for all six: the asiento now exists, here
 * is how to address it, go read the libreta again.
 *
 * `wasDuplicate` carries the same fact `EventAmendedV1` does and is there for
 * the same client: a phone whose first attempt timed out after committing.
 * `true` means the `Idempotency-Key` resolved to an event that was ALREADY on
 * the spine — nothing was appended, no reminder was scheduled twice, no cache
 * was re-derived. A client that ignores it still behaves correctly; one that
 * reads it can skip a success animation it already played.
 *
 * NOTHING ELSE IS ON THIS BODY, and that is deliberate. The endpoint could
 * echo the composed asiento back, and then two projections of one event would
 * exist — this one and `GET .../events/{eventId}` — with a way to disagree. The
 * client refetches; the ledger has one voice.
 */
export type EventRecordedV1 = {
  /** The appended `pet_events` row. Addressable at `GET .../events/{eventId}`. */
  eventId: string;
  /** True when the key resolved to an event that already existed. */
  wasDuplicate: boolean;
};

/**
 * `GET /api/v1/pets/{publicToken}/events/{eventId}` — HTTP 200.
 *
 * The sections that can fail on their own are wrapped in `CredentialSection`:
 * signing runs against Storage and the chain is its own query, so either can be
 * unavailable while the record itself reads fine. `unavailable` means the server
 * could not load it, NOT that it is empty — an event with no files is
 * `{status:"ok", data:{items:[]}}`.
 *
 * The record's own identity is NOT wrapped: if that could not be read there is
 * no 200 to put it in.
 */
export type PetEventDetailV1 = {
  payloadVersion: typeof PET_EVENT_DETAIL_PAYLOAD_VERSION;
  issuedAt: string;
  staleAfter: string;
  publicToken: string;
  eventId: string;
  /** From `@dim/contract/events` — the shared vocabulary. */
  eventType: string;
  /** Mono uppercase eyebrow — the event type's es-AR name. */
  kind: string;
  /** The record's headline, e.g. the vaccine's name. */
  title: string;
  /** The secondary line under it, when the record has one. */
  subtitle: string | null;
  /** When it HAPPENED. */
  occurredAt: string;
  /** When it was WRITTEN. Different from `occurredAt`, and often by years. */
  recordedAt: string;
  notes: string | null;
  location: EventLocationV1 | null;
  author: EventAuthorV1;
  /** The CORRECTED record — the curated whitelist, never a raw payload dump. */
  facts: EventFactV1[];
  amendments: CredentialSection<{ items: EventAmendmentV1[] }>;
  attachments: CredentialSection<{ items: EventAttachmentV1[] }>;
  amend: EventAmendAffordanceV1;
};
