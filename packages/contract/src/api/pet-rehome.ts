// The wire shape of `GET|POST /api/v1/pets/{publicToken}/rehome` —
// ACOMPAÑAMIENTO DE ADOPCIÓN, the titular's surface.
//
// ONE READ, THREE STATES, and the state is the SERVER'S. The web page
// (`buscar-hogar/page.tsx`) derives none / pending / active from the spine —
// an unmatched `rehome_sponsorship_started` is "active", an open
// `rehome_request` case is "pending", and active wins if both ever coexist
// (`get-rehome-state-for-pet.ts`). A client that re-derived the state from the
// face's banner would be reading a cache to decide a lever; this payload hands
// it the same three states the page renders, from the same reader.
//
// THE ORG LIST TRAVELS WITH EVERY STATE, not only with `none`. The web passes
// the picker only when nothing is running, and this payload carries it always:
// a client holding the list can draw "pedile a otra" the moment a cancel lands,
// without a second round trip, and a list of verified orgs covering a zone is
// not a secret. `orgs` is empty when the pet has no province — `zone.province`
// says so, and the screen's empty state names the fix (edit the profile).
//
// `capabilities` IS THE SERVER'S AND MUST NOT BE RECOMPUTED FROM `state`. The
// three levers are gated on WHO IS READING as much as on what is running: a
// co-owner sees the same `pending` a titular sees and may cancel nothing
// (spec REQ-14 — consent is the legal owner's alone). The three booleans are
// derived once, in the route's `payload.ts`, and the write refuses on the same
// derivation, so a screen can never be offered a control that answers 403.
//
// NO INTERNAL IDs. Orgs are named by `publicToken` (the same handle the
// adoption catalogue uses), cases by `publicCode`. An id is what a stolen
// access token buys.

export const PET_REHOME_PAYLOAD_VERSION = 1;

/**
 * How long a client may present a cached copy as current.
 *
 * TEN SECONDS — `pet-return.ts`'s window, for the same reason: the subject is
 * a request another party can answer at any moment, and "pending" turning into
 * "active" is precisely the transition the person is waiting to see.
 */
export const PET_REHOME_STALE_AFTER_MS = 10_000;

/** One verified org the titular may ask, as the picker draws it. */
export type PetRehomeOrgV1 = {
  publicToken: string;
  displayName: string;
  /** `shelter` or `rescue_network` — the two the rule admits. */
  orgType: string;
  /** The locality (or province) of the coverage row that reached the pet's zone. */
  locality: string | null;
};

export type PetRehomeStateV1 =
  | { kind: "none" }
  | {
      kind: "pending";
      orgDisplayName: string;
      /**
       * The consent case (`rehome_request`) — `/casos/{code}` on the web.
       * NAMED FOR WHICH CASE IT IS, because this payload carries two: the
       * request case here and the listing case on `active`, and a bare
       * `casePublicCode` beside `listingCasePublicCode` would make a reader
       * guess which expediente the pending one is.
       */
      requestCasePublicCode: string;
    }
  | {
      kind: "active";
      orgDisplayName: string;
      /** The sponsorship's expediente (`adoption_listing` case), or null if none is open. */
      listingCasePublicCode: string | null;
    };

export type PetRehomeCapabilitiesV1 = {
  /** The legal owner, with nothing pending or running, on an active animal. */
  canRequest: boolean;
  /** The legal owner, while a request is pending. */
  canWithdrawRequest: boolean;
  /** The legal owner, while a sponsorship is running. */
  canWithdrawSponsorship: boolean;
};

export type PetRehomeV1 = {
  payloadVersion: typeof PET_REHOME_PAYLOAD_VERSION;
  issuedAt: string;
  staleAfter: string;
  publicToken: string;
  petName: string;
  /** The zone the picker was filtered by. `province: null` means the list is empty for that reason. */
  zone: { province: string | null; locality: string | null };
  state: PetRehomeStateV1;
  orgs: PetRehomeOrgV1[];
  capabilities: PetRehomeCapabilitiesV1;
};

/**
 * What `POST /api/v1/pets/{publicToken}/rehome` answers.
 *
 * A BARE ACK, no envelope — the split every write on this surface makes.
 *
 * `replayed` ONLY APPEARS ON THE TWO WITHDRAWS, and its presence there is the
 * contract's promise about the `Idempotency-Key` it requires for them: `true`
 * means the ledger recognised the key — this exact withdraw had already
 * landed, nothing was written, nobody was told twice — and the case code it
 * carries is the one the first attempt closed. A client renders both arms as
 * done. The request carries no such flag because it takes no key (see
 * `@dim/contract/input`'s `rehome.ts`).
 */
export type RehomeCommandAckV1 =
  | {
      command: "request_sponsorship";
      /** The consent case the org now holds in its inbox. */
      requestCasePublicCode: string;
      orgDisplayName: string;
    }
  | {
      command: "withdraw_request";
      /** The consent case this closed — the one the first attempt closed, on a replay. */
      requestCasePublicCode: string;
      replayed: boolean;
    }
  | {
      command: "withdraw_sponsorship";
      /** The expediente this closed — null when none was open, and on a replay. */
      listingCasePublicCode: string | null;
      /** The org whose custody ended, or null if its row could not be re-read on a replay. */
      orgPublicToken: string | null;
      replayed: boolean;
    };
