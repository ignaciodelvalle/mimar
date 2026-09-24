// `GET|POST /api/v1/pets/{publicToken}/return` — DEVOLUCIÓN.
//
// WHAT THE READ IS FOR, AND WHY A CLIENT MAY NOT DERIVE IT
// ---------------------------------------------------------------------------
// This is the one feature in the custody cycle where a phone holding the whole
// pet payload still cannot tell what it may do. The three writers behind it do
// not agree about whom they serve, and none of the disagreements is visible from
// anything else on the wire:
//
//   · accepting and rejecting need an ACTIVE `role = 'owner'` row AND a pending
//     proposal whose `to_user_id` is the caller — so a CO-OWNER is refused, and
//     so is an owner whose pending proposal is their own outgoing one;
//   · proposing admits an `owner` OR a `foster`, and the organisation it
//     addresses is derived from an `adoption_finalized` payload or from the
//     animal's open custody row, neither of which any client holds.
//
// So the server answers with a STATE and a capabilities block, and a client
// renders them. `state.kind` says what is going on; `capabilities` says which of
// the three commands this caller may send. THEY ARE NOT THE SAME QUESTION and a
// client must read the second: a state can be `inbound_pending` while the
// clock, the animal's status or a race has already taken the answer away.
//
// THE WEB'S OWN PAGE GETS THIS WRONG IN ONE PLACE AND THIS PAYLOAD DELIBERATELY
// DOES NOT COPY IT. `.../devolucion/page.tsx` renders the acceptance card
// whenever a proposal is pending, without checking it is addressed to the
// viewer — so an owner whose OWN outgoing proposal to a shelter is in flight is
// offered "Aceptar", and the writer refuses with "Esta propuesta no está
// dirigida a vos." Here that case is its own state (`awaiting_org`) with all
// three capabilities false. Reported rather than fixed on the web: that page is
// a browser-facing surface with its own e2e gate.
//
// WHAT IS NOT HERE, AND WHY EACH ONE IS ABSENT RATHER THAN FORGOTTEN
// ---------------------------------------------------------------------------
//   · THE ORGANISATION'S SIDE. Accepting or rejecting an owner-initiated return
//     is `custody.transfer` behind `/org/{token}`, and this app has no
//     organisation surfaces at all. A citizen wallet that could run one would be
//     doing something the owner's browser cannot.
//   · CANCELLING YOUR OWN OUTGOING PROPOSAL. `actorCancelProposalAction` exists
//     and is reachable from the web's org side; the owner's own page offers no
//     such control, so this door does not invent one. It is the reason
//     `awaiting_org` carries no capability rather than a `canCancel: false` that
//     would read like a rule.
//   · THE PROPOSER'S CONTACT DETAILS. `actorName` is a first name or an
//     organisation's display name and nothing else — the web's own line on the
//     same card. Somebody holding your animal and asking to return it is
//     somebody you are entitled to have named; their phone number is not part of
//     the decision.

/** How long a client may treat this read as current. */
export const PET_RETURN_PAYLOAD_VERSION = 1;

/**
 * Ten seconds.
 *
 * SHORTER THAN EVERY OTHER PET-SCOPED READ ON THIS SURFACE, and the reason is
 * what the state describes: a proposal somebody else can cancel, accept or
 * supersede at any moment, on an animal that is physically in another person's
 * house. A stale "Aceptar" is a button that answers 409; a stale "esperando" is
 * somebody not being told their animal is on its way back.
 */
export const PET_RETURN_STALE_AFTER_MS = 10_000;

/** Who the caller is to this animal, on the person path. */
export type ReturnCallerRoleV1 = "owner" | "foster";

/**
 * What is going on with this animal's return, from the caller's side.
 *
 * A DISCRIMINATED UNION AND NOT A BAG OF NULLABLE FIELDS, because the arms are
 * mutually exclusive and a client's switch should stay exhaustive when a new one
 * lands.
 */
export type PetReturnStateV1 =
  /** Somebody is holding this animal and wants to hand it back. */
  | {
      kind: "inbound_pending";
      /** A first name, an organisation's display name, or "Alguien". */
      actorName: string;
      /** ISO-8601. What the proposer said, or when the event landed. */
      proposedAt: string;
      notes: string | null;
    }
  /**
   * The caller's OWN outgoing proposal is in flight and the organisation has
   * not answered. NOT an acceptance — see the header.
   */
  | { kind: "awaiting_org" }
  /** The caller may propose handing this animal back. */
  | {
      kind: "can_propose";
      callerRole: ReturnCallerRoleV1;
      /**
       * `null` when the organisation id resolves to no row — a dangling
       * `previous_owner_organization_id`, which carries no foreign key. A client
       * MUST render the absence rather than inventing a name: the proposal still
       * goes to that organisation, and naming it wrongly is worse than not
       * naming it.
       */
      orgDisplayName: string | null;
    }
  /**
   * The caller holds this animal in a role this feature does not serve — a
   * co-owner or a cuidador temporal. NOT a 404: the web answers this population
   * with an explanatory page for the reason `PetAccessFailureReason` gives about
   * `not-titular`, and pretending the animal does not exist to somebody
   * legitimately caring for it is a lie a UI cannot recover from.
   */
  | { kind: "not_titular"; holderRole: string }
  /** Nothing names an organisation to return this animal to. */
  | { kind: "no_source_org"; callerRole: ReturnCallerRoleV1 }
  /** An adoption is on record and it names somebody else as the adopter. */
  | { kind: "not_the_adopter" };

/**
 * WHICH COMMANDS THIS CALLER MAY SEND — the server's, never derived.
 *
 * They are not a function of `state.kind` that a client could reproduce, and the
 * asymmetry is the point: `canAccept` and `canReject` both require the pending
 * proposal to be ADDRESSED to the caller, which no other field on this payload
 * says. A client that drew its buttons from the state alone would be keeping a
 * second copy of an authorization rule on the most consequential act in this
 * feature — one that hands an animal back.
 */
export type PetReturnCapabilitiesV1 = {
  canAccept: boolean;
  canReject: boolean;
  canPropose: boolean;
};

export type PetReturnV1 = {
  payloadVersion: typeof PET_RETURN_PAYLOAD_VERSION;
  issuedAt: string;
  staleAfter: string;
  publicToken: string;
  /** The animal's name, for the copy. */
  petName: string;
  state: PetReturnStateV1;
  capabilities: PetReturnCapabilitiesV1;
};

/**
 * What `POST /api/v1/pets/{publicToken}/return` answers.
 *
 * A BARE ACK, no envelope — the split every write on this surface makes.
 *
 * `autoCancelled` IS THE ONE FIELD THAT MATTERS AND IT IS ONLY EVER TRUE ON
 * `accept_return`. `ownerAcceptReturnUseCase` has a success arm in which nothing
 * was transferred: if the proposer no longer holds custody, or the animal is no
 * longer `lost`, it appends `custody_transfer_cancelled` instead, notifies the
 * proposer and reports success. That is the RIGHT behaviour — the proposal is
 * dead and saying so is not a failure — and it is the one outcome a client must
 * NOT render as "listo, la tenés": the animal did not come back. `reason` is the
 * server's own es-AR sentence explaining which precondition failed, and it is
 * the single place on this surface where a sentence crosses the wire, because
 * the four `autoCancelBody` messages are already user-facing copy the web
 * renders verbatim.
 */
export type PetReturnCommandAckV1 = {
  command: "accept_return" | "reject_return" | "propose_return";
  autoCancelled: boolean;
  /** Present only when `autoCancelled` is true. */
  reason: string | null;
};
