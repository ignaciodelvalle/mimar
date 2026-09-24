// `GET /api/v1/me/foster` — a volunteer's own tránsito inbox: proposals
// awaiting an answer, and the fosters (active or ended) that came of one.
//
// THE WEB HAS TWO PAGES; THIS IS ONE READ, AND THAT IS NOT A DIVERGENCE
// ---------------------------------------------------------------------------
// `/cuenta/transitos/propuestas` lists pending proposals, `/cuenta/transitos/activos`
// lists live fosters — two SSR pages, each its own query. A phone reaching
// this feature needs one round trip that answers both questions ("¿tengo algo
// para responder?" and "¿qué estoy cuidando hoy, y desde cuándo?"), so the two
// web queries are folded into one payload the way `/me/caretaker-grants` folds
// its two web doors into one hub. Every row here is one the caller can already
// see on one of those two pages; nothing new is disclosed.
//
// ONLY THE VOLUNTEER'S SIDE. There is no "outgoing" half the way
// `MyCaretakerGrantsV1` has one: a citizen never PROPOSES a foster — that is
// `foster.assign`, an org capability with no bearer door here (see
// `@dim/contract/input`'s `foster.ts`). Every row this payload carries is
// addressed to the caller.
//
// WHAT A CLIENT MUST NOT DO WITH THIS PAYLOAD
// ---------------------------------------------------------------------------
// DO NOT INFER "can I still accept this" FROM `expired` ALONE.
// `acceptFosterProposal` does not check `expiresAt` — only `status === "pending"`
// — because the nightly sweep is what actually closes a stale proposal
// (`expireFosterProposalsAction`), exactly the asymmetry
// `MyCaretakerGrantV1.expired` documents for its own surface. `expired` is
// informational: a screen may grey the "expira hace 2 días" caption, and must
// still send the command and let the server answer `foster_already_resolved`
// if the sweep won.
//
// DO NOT TREAT AN EMPTY `proposals` LIST AS "NOTHING PENDING" AFTER A FAILED
// READ. What is being missed is an animal waiting for a home.
//
// PII: THE SAME SHAPE `owner-pet-detail.ts` ALREADY SHOWS THE CALLER. A pet's
// name, species and the proposing org's display name are exactly what
// `/cuenta/transitos/propuestas` renders to this same person today. No third
// party's contact detail crosses this boundary: the proposer's own name lives
// on the web's detail page and is deliberately left off this list payload, the
// same omission `MyCaretakerGrantV1` makes for fields a client does not need
// to answer accept/decline.

export const MY_FOSTER_PAYLOAD_VERSION = 1;

/**
 * ONE MINUTE — the window every sibling `/me` hub takes
 * (`MY_CARETAKER_GRANTS_STALE_AFTER_MS`, `MY_TRANSFERS_STALE_AFTER_MS`). The
 * facts on this screen move without the caller doing anything: the org can
 * cancel a proposal, another volunteer's accept can trigger the D18 cascade
 * that auto-cancels this one, or the nightly sweep can expire it.
 */
export const MY_FOSTER_STALE_AFTER_MS = 60_000;

/** The animal, named the way both web pages name it. */
export type MyFosterPetV1 = {
  publicToken: string;
  name: string;
  /**
   * Open vocabulary (`dog`, `cat`, …) — `pets.species` is `text NOT NULL`
   * with no CHECK, so this is a `string` and not a closed union, exactly as
   * every sibling payload on this surface types it.
   */
  species: string;
};

/** One proposal awaiting the volunteer's answer. Always `status: "pending"" — see the header. */
export type MyFosterProposalV1 = {
  /** The handle both commands take. */
  proposalToken: string;
  pet: MyFosterPetV1;
  /** The org proposing the tránsito. */
  organizationName: string;
  /** `null` when the org did not estimate a duration. */
  proposedDurationWeeks: number | null;
  proposedNotes: string | null;
  proposedAt: string;
  expiresAt: string;
  /**
   * Whether `expiresAt` has passed, by the SERVER'S clock. NOT the same as
   * "cannot be answered" — see the header's first note. Carried for the
   * reason `MyCaretakerGrantV1.expired` is: a phone's clock can be wrong, and
   * the flattering error is the dangerous one.
   */
  expired: boolean;
};

/** One foster arrangement, active or ended, from the volunteer's own side of it. */
export type MyFosterOwnershipV1 = {
  fosterOwnershipId: string;
  pet: MyFosterPetV1;
  /**
   * The org that holds `shelter_custody` of the animal, or `null`. Can be
   * null in the rare case a custody row does not resolve (e.g. the org
   * released custody after handing the animal to this foster) — the same
   * defensive `null` `activos/page.tsx` already tolerates.
   */
  organizationName: string | null;
  startedAt: string;
  /** `null` while the foster is active. */
  endedAt: string | null;
  active: boolean;
  /** The org's original estimate, carried through from the resolved proposal. */
  proposedDurationWeeks: number | null;
};

export type MyFosterV1 = {
  payloadVersion: typeof MY_FOSTER_PAYLOAD_VERSION;
  /** The three envelope fields §6 requires on every read. Built by `apiV1Envelope`. */
  issuedAt: string;
  staleAfter: string;
  /** Newest first. Only `status: "pending"` rows — see the header. */
  proposals: MyFosterProposalV1[];
  /** Newest first (`startedAt` desc): the active foster, if any, plus recent history. */
  fosters: MyFosterOwnershipV1[];
};

/**
 * What `POST /api/v1/me/foster` answers.
 *
 * `changed` IS ALWAYS TRUE HERE, for the reason `CaretakerCommandAckV1.changed`
 * is: neither command can recognise a replay and report it as a no-op — both
 * REFUSE a replay instead (see `@dim/contract/input`'s `foster.ts`). Carried
 * anyway so a client built against the shared `/me` hub shape needs no
 * special case.
 */
export type FosterCommandAckV1 = {
  command: "accept" | "reject";
  changed: boolean;
  proposalToken: string;
  /** Set on a successful `accept`; `null` for `reject`. */
  fosterOwnershipId: string | null;
};
