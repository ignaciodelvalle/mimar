// `POST /api/v1/me/pet-claims` — what the two claim commands answer.
//
// RECLAMAR IS THE MOST CONSEQUENTIAL ACT A CITIZEN CAN ASK FOR ON THIS SURFACE.
// It says "this animal is mine" about a row in the national registry, and when
// it succeeds it opens an ownership, appends `ownership_claimed` to an
// append-only spine and hands over a credential. So the shapes here are written
// against one rule: THE PHONE MAY NOT GRANT WHAT THE BROWSER REFUSES, and it may
// not refuse what the browser grants for a reason it cannot state.
//
// WHERE THE RULES LIVE, AND WHY NONE OF THEM IS RESTATED HERE
// ---------------------------------------------------------------------------
// `lookupForClaimForUser` and `submitFreeClaimForUser` are the SAME two
// use-cases `app/(app)/mis-mascotas/reclamar` drives through its server actions.
// The endpoint is an adapter over them; it re-derives no guard, and this file
// copies no predicate. What it does is name the answers on the wire so a native
// client can render them without inventing a second vocabulary.
//
// THE EVIDENCE IS THE PRIVATE IDENTIFIER, AND IT IS NEVER A PET TOKEN
// ---------------------------------------------------------------------------
// Both commands take the 15-digit microchip or the tattoo code and resolve the
// animal FROM it. `submit-free-claim.ts` states the reason at length: the public
// token `DIM-XXXX-XXXX` is printed on the physical tag, resolvable by anyone who
// scans the QR and listed for every lost animal on `/perdidas` with no login, so
// it is NOT evidence of anything. A caller who does not know the private
// identifier cannot reach a pet at all — the lookup returns nothing.
//
// That is why no request shape in `@dim/contract/input`'s `pet-claim.ts` carries
// a pet token, and why the one this file returns is deliberately narrow (see
// `petToken` below).
//
// THE DISPUTE IS ON THIS SURFACE SINCE D6 (2026-09-25)
// ---------------------------------------------------------------------------
// When the animal already has an active custody, the web offers a THIRD step:
// `submitClaimDisputeAction`, which raises a `custody_dispute` against whoever
// holds it. That writer requires at least one evidence FILE — the gate is
// server-side and absolute (PO decision 2026-07-30), because a dispute notifies
// the holder that a stranger claims their animal, appends an uneditable row to
// its spine, flips `pets.in_custody_dispute` — which strips the owner's contact
// channel off the public credential — and opens a case a local authority must
// adjudicate.
//
// This surface used to refuse the step, because the app could not attach a
// file and a dispute without one is refused 100% of the time. The app now has
// an image picker, so the step is here, as TWO commands: `request_evidence_ticket`
// stages one photo in the private staging bucket, and `dispute` names the staged
// keys. The server runs the SAME use-case the web does, over the SAME evidence
// gate, EXIF/GPS strip included.
//
// PII: WHAT THIS CARRIES, AND THE ONE THING IT DOES NOT
// ---------------------------------------------------------------------------
// `ownerInitials` — up to two initials of the registered owner's display name,
// exactly what `deriveInitials` hands the web's own wizard and exactly what that
// wizard prints. It is there so a person can tell "somebody else has it" from
// "*I* already have it" without the endpoint naming anybody.
//
// NO CHIP AND NO TATTOO CODE EVER COME BACK. The caller supplied one; echoing it
// would be free, and it is refused for the reason `confirm-chip-match-vecino.ts`
// gives for the same decision — an endpoint that returns the canonical code is a
// chip oracle, and this one answers to any signed-up account.

/**
 * What the animal's situation is, as the lookup found it.
 *
 * THE FIVE ARE `ClaimLookupVariant`'S OWN FIVE (`src/modules/pets/application/
 * claim/types.ts`), named on the wire rather than collapsed into a boolean,
 * because each one sends the person somewhere different: `free` claims,
 * `active_owner` is a dispute on the web, `lost` is an avistaje, `deceased` is
 * support, and `not_found` is a registration.
 *
 * `not_found` IS A VARIANT AND NOT AN ERROR. The lookup succeeded; the answer is
 * "nothing matches". Answering 404 would make a client that retries on 404 retry
 * a question that has been answered, and would make "erased" and "never existed"
 * indistinguishable from a transport failure rather than from each other (which
 * is what Ley 25.326 art. 16 actually asks for, and the use-case already does).
 *
 * `active_owner` DOES NOT MEAN "HAS AN OWNER", AND THE NAME IS THE WEB'S. The
 * use-case files a pet here whenever ANY active custody row exists — owner,
 * shelter_custody, foster — because a refugio's animal must not be direct-
 * claimable either. `ownerInitials` is therefore `null` in the shelter case, and
 * a client must not print "already has an owner" over a null.
 */
export const PET_CLAIM_VARIANTS_V1 = [
  "not_found",
  "free",
  "active_owner",
  "lost",
  "deceased",
] as const;
export type PetClaimVariantV1 = (typeof PET_CLAIM_VARIANTS_V1)[number];

/**
 * What `command: "lookup"` answers.
 *
 * `canClaim` IS THE SERVER'S AND MUST NOT BE DERIVED FROM `variant`.
 *
 * It looks derivable — today it is exactly `variant === "free"` — and deriving
 * it is still wrong, for the reason `MyAppointmentV1.capabilities` is on the
 * wire: the rule behind it is an AUTHORIZATION rule and it lives in the
 * use-case. "Free" there means no active custody row of ANY role, re-checked
 * inside the claiming transaction under `SELECT … FOR UPDATE`, plus three status
 * gates (deceased, lost, `in_custody_dispute`) that the lookup's variant does not
 * carry one-to-one. A client that computed the affordance from the variant would
 * be maintaining a second copy of a rule it cannot see, and the failure mode is
 * drawing a button the server refuses on an act this consequential.
 *
 * IT IS A HINT, NOT THE GATE. `submitFreeClaimForUser` re-resolves the animal
 * from the identifier and re-runs every check inside its transaction, so a client
 * that ignores this field entirely is refused rather than obeyed.
 */
export type PetClaimLookupAckV1 = {
  command: "lookup";
  variant: PetClaimVariantV1;
  /**
   * The animal's name, or `null` when there is nothing to name (`not_found`).
   *
   * A NAME AND NOT A PROFILE. The use-case returns "ONLY a minimal projection;
   * never the full pet record", and this wire keeps that promise: no species, no
   * breed, no jurisdiction, no photo. Somebody holding a chip number they did
   * not get honestly learns a first name and nothing that would help them find
   * the animal.
   */
  petName: string | null;
  /**
   * The public token — ONLY on `lost`, `null` on every other variant.
   *
   * THE ASYMMETRY IS THE POINT AND IT IS ONE STEP TIGHTER THAN THE WEB'S ACTION,
   * which returns a token for `free` and `active_owner` too. A token is a
   * navigable capability (it opens `/p/{token}`), so it travels only where this
   * client has a destination for it, and there is exactly one: a lost animal
   * routes to the avistaje form instead of to a claim, and that form is
   * addressed by token.
   *
   * `free` DOES NOT NEED IT, which is the case worth spelling out. The claim's
   * own ack carries the token the writer RESOLVED, and that is the token a client
   * must navigate with — using the lookup's would be navigating to a pet on the
   * strength of a read that the write may since have refused.
   *
   * It discloses nothing new: `/perdidas` lists every lost animal's token with no
   * login at all, so the mapping this hands over is chip → token for an animal
   * whose token is already public.
   */
  petToken: string | null;
  /**
   * Up to two initials of the registered owner (`"L.F."`), or `null`.
   *
   * `null` MEANS "NOBODY TO NAME", NOT "NO CUSTODY" — see `active_owner` above.
   * The web prints it in parentheses after the name and prints nothing when it is
   * null; a client must do the same rather than substituting a word.
   */
  ownerInitials: string | null;
  /** Whether `command: "claim_free"` would be accepted. See the type's docblock. */
  canClaim: boolean;
  /**
   * Whether this client should offer `command: "dispute"` — true exactly where
   * the web wizard offers "Iniciar disputa" (its variant-B panel). THE SERVER'S,
   * for `canClaim`'s reason: a HINT, not the gate. The writer re-resolves the
   * animal and refuses a caller who already holds it, an animal already in
   * dispute and a deceased one, whatever this said.
   */
  canDispute: boolean;
};

/**
 * What `command: "claim_free"` answers on success.
 *
 * `changed` IS ALWAYS TRUE, for `AppointmentCommandAckV1.changed`'s reason and
 * not `ShareCommandAckV1`'s: this writer REFUSES a replay rather than absorbing
 * one. A second call after a successful claim finds the caller's own ownership
 * row as an active custody and answers `claim_not_claimable` — which a client
 * must NOT read as "somebody else took it". The remedy after any timeout is to
 * re-run `lookup`: the fresh variant is `active_owner` with the caller's OWN
 * initials, and the animal is in `GET /api/v1/me/pets`.
 *
 * The field is carried so a client written against this surface's shared ack
 * shape needs no special case, and so the day this command learns to absorb a
 * replay it has somewhere to say so without a version bump.
 */
export type PetClaimFreeAckV1 = {
  command: "claim_free";
  changed: boolean;
  /**
   * The token the WRITER resolved from the identifier — never a caller's.
   *
   * This is the one a client navigates with. `app/actions/pet-claim.ts`
   * revalidates on exactly this value and says why in the same words.
   */
  petToken: string;
  petName: string;
};

/**
 * What `command: "request_evidence_ticket"` answers — a one-shot URL to PUT ONE
 * evidence photo to.
 *
 * The denuncia's ticket shape (`WelfareEvidenceTicketV1`), field for field,
 * because it is the same capability over the same private staging bucket; the
 * key is `welfare/{uuid}.{ext}` and names nobody. `stagedPath` is what
 * `dispute` names in `evidence`.
 */
export type PetClaimEvidenceTicketV1 = {
  command: "request_evidence_ticket";
  uploadUrl: string;
  token: string;
  stagedPath: string;
  bucket: string;
  validForSeconds: number;
};

/**
 * What `command: "dispute"` answers on success.
 *
 * `disputeToken` IS THE WEB'S "Referencia" — the wizard prints it on its
 * "Reclamo enviado" receipt, and the phone prints the same line. It names the
 * dispute, not the animal: the claimant is a party to it.
 *
 * NO PET TOKEN, and that is one step tighter than the web's action, which hands
 * its own page the resolved token for a `revalidatePath`. A phone has nothing to
 * revalidate and no page for an animal the caller does not hold — the same rule
 * `PetClaimLookupAckV1.petToken` applies to `active_owner`.
 *
 * `changed` IS ALWAYS TRUE, for `PetClaimFreeAckV1.changed`'s reason: a replay
 * is refused, not absorbed. A retry naming the same staged keys finds them
 * already used and answers `claim_evidence_refused`; one with fresh photos finds
 * the animal already in dispute and answers `claim_not_disputable`. Neither
 * files a second dispute.
 */
export type PetClaimDisputeAckV1 = {
  command: "dispute";
  changed: boolean;
  disputeToken: string;
};

/** Every command's answer, discriminated by the command that produced it. */
export type PetClaimCommandAckV1 =
  | PetClaimLookupAckV1
  | PetClaimFreeAckV1
  | PetClaimEvidenceTicketV1
  | PetClaimDisputeAckV1;
