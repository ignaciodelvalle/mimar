// The wire shapes of the `/api/v1` PET surface — `POST /api/v1/pets` and
// `GET /api/v1/me/pets` (native-readiness WU-B).
//
// TYPES ONLY plus two frozen literals, like every other file in this entry
// point. The REQUEST side of the write lives in `@dim/contract/input`
// (`register-pet.ts`), which carries zod.

import type { PublicPetStatus } from "./public-credential.ts";

// ---------------------------------------------------------------------------
// POST /api/v1/pets
// ---------------------------------------------------------------------------

/**
 * `Idempotency-Key` MUST be a UUID in canonical hyphenated form.
 *
 * THE FORMAT WAS DOCUMENTED NOWHERE A CLIENT COULD READ IT, and the endpoint
 * accepted any non-blank string — while `pet_events.client_idempotency_key` is
 * a Postgres `uuid` column. A client sending a ULID or a nanoid (both perfectly
 * reasonable idempotency keys, both what a native app might already have on
 * hand) got the header accepted, the transaction started, and a `22P02`
 * invalid-input-syntax error raised INSIDE it. That surfaces as
 * `pet_registration_failed`, whose contract explicitly tells the caller to
 * retry with the SAME key — which reproduces the identical 500 forever, one
 * failed registration at a time, until the per-user budget runs out and turns
 * into a 429. A permanent client bug wearing a retryable server error's clothes.
 *
 * So the requirement is stated here, in the package the client imports, and
 * enforced at the parse site before any database work.
 *
 * ANY version, not just v4. The column stores what Postgres accepts and a v7
 * key (increasingly the default for exactly this job — time-ordered, still
 * unique) is as good a retry token as a v4. What is refused is anything that
 * would not survive the cast.
 */
export const IDEMPOTENCY_KEY_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Whether a string may be sent as `Idempotency-Key`.
 *
 * Exported so a client can check BEFORE the round trip. The server checks too,
 * and the server's check is the one that matters — this is a courtesy that
 * turns a 400 into a caught bug at the call site.
 */
export function isValidIdempotencyKey(value: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(value.trim());
}

/**
 * A successful registration (HTTP 201).
 *
 * NO INTERNAL IDs. `registerPet` hands its caller a `petId` and an `eventId` and
 * neither appears here, for the same reason `GET /api/v1/me` carries no email:
 * this is the payload a stolen access token buys, and a database primary key on
 * a wire a device caches to disk is reach a client never needs. The
 * `publicToken` IS the pet's identity everywhere a client operates — it is what
 * `/api/v1/pets/{publicToken}/credential` takes and what the QR encodes.
 *
 * WHY THE REPLY TO A REPLAY IS THIS SAME SHAPE, STATUS INCLUDED
 * -------------------------------------------------------------------------
 * A second POST carrying an `Idempotency-Key` the server has already seen
 * answers 201 with this body and `wasDuplicate: true` — not 200, not 409. The
 * caller asked for a pet to exist and a pet exists; the request SUCCEEDED, and
 * the retry a flaky subway connection forces is not an error state to render.
 * `wasDuplicate` is there so a client can tell the difference when it matters —
 * skip the "¡registrada!" confetti on a retry, do not re-fire analytics — and
 * for nothing else. A client that ignores the field entirely still behaves
 * correctly, which is the property that makes this safe.
 */
export type PetRegisteredV1 = {
  /** The pet's public credential token (`DIM-XXXX-XXXX`). */
  publicToken: string;
  /**
   * True when this request's `Idempotency-Key` matched a registration the
   * server had already committed. NO second animal was created, and
   * `publicToken` is the FIRST attempt's token.
   */
  wasDuplicate: boolean;
};

// ---------------------------------------------------------------------------
// GET /api/v1/me/pets
// ---------------------------------------------------------------------------

/** Bump when a field is removed or changes meaning. Adding one is additive. */
export const MY_PETS_PAYLOAD_VERSION = 1;

/**
 * How long a cached pet list may be presented as current. Five minutes, the
 * same as `/me` and the public credential: a pet's status changes through
 * actions the holder did not perform (an owner reports it lost from another
 * device, a vet records a death, a transfer completes), so a list rendered from
 * a stale copy can show an animal as `active` that the registry knows is lost.
 */
export const MY_PETS_STALE_AFTER_MS = 5 * 60_000;

/**
 * One row of the caller's pet list — a LIST-SCREEN projection, not a summary of
 * the animal.
 *
 * Exactly enough to draw a row and navigate from it. What is deliberately
 * absent, because a list screen does not render it and a credential read is one
 * tap away:
 *   · no internal id — `publicToken` is the identity a client uses (above);
 *   · no microchip number, no DNI, no owner contact details;
 *   · no breed, weight, birth date or medical state — those live on the
 *     credential, which has its own endpoint, its own payload version and its
 *     own per-section degraded contract;
 *   · no compliance or vaccination status. The web list derives a freshness chip
 *     from a separate bounded fan-out, and shipping a HALF-derived one here
 *     (present when the fan-out succeeded, absent when it did not) is the exact
 *     "blank section reads as no findings" defect RN-8 #6 closed;
 *   · no ownership role, so a pet held in tránsito is currently indistinguishable
 *     from one held as owner. Stated rather than discovered — WU-D's list screen
 *     will want it, and adding a field is additive.
 */
export type MyPetsV1Item = {
  /** `DIM-XXXX-XXXX`. The identity a client navigates and shares with. */
  publicToken: string;
  name: string;
  /** `dog` | `cat` | `rabbit` | `guinea_pig` | `ferret` | `other`. */
  species: string;
  status: PublicPetStatus;
  /**
   * Absolute URL of the primary photo, or null when the pet has none.
   *
   * A URL and not a storage path: the `pet-photos` bucket is public-read, the
   * server already knows its layout, and handing a client a path would make
   * every consumer re-derive the same base URL — one of which will eventually
   * get it wrong for a self-hosted deployment.
   */
  photoUrl: string | null;
};

/**
 * The caller's own pets (HTTP 200).
 *
 * `total` and `truncated` exist together because a list that silently stops at a
 * cap is a lie a rescue network would find in production: the web index caps at
 * 200 rows and says so on screen, and a native client that shows 200 of 340 pets
 * with no notice is worse than one that shows a notice. `truncated` is
 * `pets.length < total`, precomputed so a client does not have to know the cap.
 */
export type MyPetsV1 = {
  payloadVersion: typeof MY_PETS_PAYLOAD_VERSION;
  /** ISO-8601 — when the server built this snapshot. */
  issuedAt: string;
  /** ISO-8601 — after this, the snapshot must not be shown as current. */
  staleAfter: string;
  pets: MyPetsV1Item[];
  /** How many pets the caller owns in total, ignoring the cap. */
  total: number;
  /** True when the server returned fewer rows than `total`. */
  truncated: boolean;
};
