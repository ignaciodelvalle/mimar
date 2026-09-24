// `GET /api/v1/me/caretaker-grants` — every cuidador-temporal arrangement this
// person is on either side of.
//
// THE HUB THE WEB DOES NOT HAVE, AND WHY IT IS NOT A DIVERGENCE
// ---------------------------------------------------------------------------
// On the web a caretaker grant is reached from two places and never listed: the
// TITULAR sees it as a banner on `/mis-mascotas/{token}`, and the INVITEE gets a
// link to `/cuidado/{grantToken}` by e-mail or notification. Both doors are
// addressed by a token somebody else handed you.
//
// A phone cannot live on that. The titular's banner carries no grant token —
// `OwnerPetCaretakerBannerV1` deliberately carries a state and a name and
// nothing a command could take — so a native cockpit that only read the pet
// would show "Al cuidado de Ana" beside two controls it has no handle for. The
// invitee's door is a deep link that may arrive on a device that has never
// opened it. So the read is person-shaped, exactly as `/me/transfers` is, and it
// answers the same question in one round trip: qué está en curso, de los dos
// lados.
//
// It is a NEW ARRANGEMENT OF FACTS THE WEB ALREADY SHOWS, not new facts. Every
// row here is one the caller can already see on one of those two web pages; the
// addressee predicate is the same id-or-email pair the accept and reject writers
// run, and the capabilities are the writers' own rules, decided server-side.
//
// OPEN ONLY — `pending` AND `accepted`, NOTHING ELSE
// ---------------------------------------------------------------------------
// No history section, unlike `/me/transfers`, and that is a decision rather than
// an omission. A transfer's history is the only record a person has of one; a
// caretaker arrangement's history is IN THE SPINE — `caretaker_designated` and
// `caretaker_ended` with its `outcome` — which `GET /api/v1/pets/{token}/libreta`
// already renders as the animal's own record. A second, worse copy of it here
// would be the hub answering a question the ledger answers better.
//
// The consequence a client must handle: a grant token that resolves to nothing
// in this payload is not necessarily a bad token. It may be an invitation that
// was answered, withdrawn or swept. "Esta invitación ya no está disponible" is
// the honest sentence; "no existe" is not.
//
// WHAT A CLIENT MUST NOT DO WITH THIS PAYLOAD
// ---------------------------------------------------------------------------
// DO NOT RECOMPUTE `capabilities`. Whether an invitation can still be accepted
// folds in an id-or-email match the client never learns the inputs of, the
// server's clock against `endsAt`, and a self-designation guard. A screen that
// offered "Aceptar" on a row it judged pending would offer it to the titular.
//
// DO NOT TREAT AN EMPTY LIST AS "NOTHING PENDING" AFTER A FAILED READ. What is
// being missed is somebody waiting for an answer about an animal.
//
// PII: WHAT THIS CARRIES, AND WHAT IT NEVER WILL
// ---------------------------------------------------------------------------
// `caretakerEmail` rides every row and is NOT a leak in either direction, for
// the reason `my-transfers.ts` spells out for `toEmail`:
//
//   · to the TITULAR it is the address they typed into the form themselves;
//   · to the INVITEE it is their own address, which is how the invitation
//     reached them and is the only thing that matched them to the row.
//
// There is no third party. The web renders it in both places for the same
// reason — the titular's cockpit falls back to it while the invitee has no
// account and therefore no display name.
//
// NO DNI, IN ANY FORM. This feature is addressed by e-mail end to end
// (`findUserIdByEmail`); `lib/utils/dni-hash.ts` has no part in it and a hashed
// identifier here would be a second PII field invented for a wire.
//
// NO PHONE, AND THAT ONE IS LOAD-BEARING. A caretaker's contact can reach an
// unauthenticated page — the public credential's `caretakerContact` — but only
// behind BOTH keys of the two-key model (the titular's
// `discloseCaretakerContactWhenLost` and the caretaker's own consent at accept).
// This payload is not a third door onto that number. It does not carry the
// consent flag either: whether the disclosure row renders is
// `OwnerPetCaretakerBannerV1.publicContactName`'s job, on the pet face, where
// key 1 lives.

import type { CaretakerCommand } from "../input/caretaker.ts";

export const MY_CARETAKER_GRANTS_PAYLOAD_VERSION = 1;

/**
 * ONE MINUTE, the window `/me/transfers`, `/shares` and `/lost` take.
 *
 * Short for the reason specific to this screen: the facts on it move without the
 * caller doing anything. The invitee accepts or declines, the titular withdraws,
 * or the nightly sweep expires an invitation nobody answered — three ways a row
 * changes while the phone is in a pocket.
 */
export const MY_CARETAKER_GRANTS_STALE_AFTER_MS = 60_000;

/**
 * The two OPEN states. `pet_caretaker_grants.status` has six
 * (`GRANT_STATUSES`); the other four are terminal and never reach this payload —
 * see the header on why there is no history section.
 */
export const CARETAKER_GRANT_STATUSES_V1 = ["pending", "accepted"] as const;
export type CaretakerGrantStatusV1 = (typeof CARETAKER_GRANT_STATUSES_V1)[number];

/**
 * Which answers this caller may give to THIS row.
 *
 * ALL FOUR ARE DECIDED BY THE SERVER and none is re-derivable on a phone. They
 * are affordance hints and NOT the rules: every one is enforced again in the
 * use-case, under a row lock, because all four can go stale in the time it takes
 * to read the screen.
 *
 * TWO OF THEM CAN STILL BE OPTIMISTIC, and it is better to say so than to hide
 * it. `canCancel` and `canRevoke` say only that the caller granted this row and
 * that it is in the right state — but the command ALSO runs the web's own pet guard
 * (`requireTitularAccess`, mirrored as a DENY over `resolvePetHolderAccess`), so
 * a granter who has since stopped being a holder of that animal, or who is now
 * merely its caretaker, is refused at the door with `caretaker_forbidden`. This
 * read does not re-implement that rule: a second copy of the titular gate,
 * living in a list query, is exactly the drift `list-transfers-for-user.ts` was
 * written to end.
 */
export type CaretakerGrantCapabilitiesV1 = {
  canAccept: boolean;
  canReject: boolean;
  canCancel: boolean;
  canRevoke: boolean;
};

/** The animal, named the way both web doors name it. */
export type CaretakerGrantPetV1 = {
  publicToken: string;
  name: string;
  /**
   * Open vocabulary (`dog`, `cat`, …) — `pets.species` is `text NOT NULL` with
   * no CHECK, so this is a `string` and not a closed union, exactly as every
   * sibling payload on this surface types it.
   */
  species: string;
};

/** One arrangement, from the caller's side of it. */
export type MyCaretakerGrantV1 = {
  /** `CG-…`. The handle four of the five commands take. */
  grantToken: string;
  status: CaretakerGrantStatusV1;
  /**
   * Which side of it the caller is on.
   *
   * `outgoing` — the caller granted it. `incoming` — the caller is the person
   * invited. A row is only ever one: self-designation is refused by
   * `validateDesignation` when the address resolves to the granter's own
   * account, and in the one residual case where it does not (an address of the
   * granter's that resolves to no account), the GRANTER's view wins, because
   * that is the person who can still withdraw it.
   */
  direction: "incoming" | "outgoing";
  /**
   * The animal.
   *
   * CARRIED FOR AN INCOMING ROW TOO, though the invitee holds no ownership on it
   * yet. That is exact parity and not a widening: `/cuidado/{grantToken}` shows
   * an invitee the pet's name and photo, and hides them only from an OUTSIDER —
   * somebody the token was forwarded to. An invitation to care for an animal you
   * cannot see is a form, not a decision.
   */
  pet: CaretakerGrantPetV1;
  /**
   * The OTHER party's display name, or `null`.
   *
   * For an incoming row this is the titular; for an outgoing one, the person
   * invited, which is `null` until they have an account with a name set. Never
   * an e-mail — see the header.
   */
  counterpartyName: string | null;
  /** The invited address. Never a third party's — see the header. */
  caretakerEmail: string;
  /**
   * The period, as INSTANTS, computed by the server from the two Argentine
   * calendar days the titular picked.
   *
   * `endsAt` is the LAST instant of its last Argentine day (23:59:59.999-03:00),
   * because "hasta el 15/09" promises the whole 15th. A client renders both in
   * `America/Argentina/Buenos_Aires` and must not re-derive either from a
   * calendar day: the boundary is the server's, and a phone in another zone
   * would compute a different one for the same picked date.
   */
  startsAt: string;
  endsAt: string;
  /** The titular's note to the person who will be looking after the animal. */
  note: string | null;
  /**
   * Whether `endsAt` has passed, by the SERVER'S clock.
   *
   * Carried for the reason `MyTransferV1.expired` is: a phone's clock can be
   * days wrong and the flattering error is the dangerous one.
   *
   * IT IS NOT `status`. A daily cron closes an `accepted` row whose period ran
   * out; between `endsAt` and the next sweep the row still reads `accepted` and
   * the database has ALREADY stopped honouring it (`has_titular_write_access`).
   * This flag is what says so. On a `pending` row it means the invitation can no
   * longer be accepted at all — the period it offers is over.
   */
  expired: boolean;
  /**
   * WHAT AN ACTIVE CARETAKER MAY AND MAY NOT DO, in the domain's own words.
   *
   * Both halves, always, in one string — `caretakerScopeSentence()`. It is the
   * copy the invitee reads at the moment of consent, and a client that rendered
   * only the permissions would be recruiting caretakers on a half-truth. It
   * rides the wire rather than being retyped in an app because it is a PROMISE
   * about what the deny-list (`lib/domain/titular-only.ts`) actually enforces:
   * when a row is added there, this sentence changes with it, and a copy on a
   * phone would not.
   */
  scopeSentence: string;
  capabilities: CaretakerGrantCapabilitiesV1;
};

/**
 * The hub, split by which side of the arrangement the caller is on.
 *
 * SPLIT SERVER-SIDE rather than handed over as one array with a flag, for the
 * reason `MyTransfersV1` gives: the split is the addressee predicate, and the
 * addressee half of it is an id-or-email match a client cannot evaluate.
 */
export type MyCaretakerGrantsV1 = {
  payloadVersion: typeof MY_CARETAKER_GRANTS_PAYLOAD_VERSION;
  /** The three envelope fields §6 requires on every read. Built by `apiV1Envelope`. */
  issuedAt: string;
  staleAfter: string;
  /** Invitations addressed to the caller, plus the arrangement they accepted. */
  incoming: MyCaretakerGrantV1[];
  /** Everything the caller granted and has not yet ended, newest first. */
  outgoing: MyCaretakerGrantV1[];
};

/**
 * What `POST /api/v1/me/caretaker-grants` answers.
 *
 * `changed` IS ALWAYS TRUE HERE and the field is carried anyway, for the reason
 * `TransferCommandAckV1.changed` is: none of the five commands can recognise a
 * replay and report it as a no-op, because every one of them REFUSES a replay
 * instead (see `@dim/contract/input`'s `caretaker.ts`). The field exists so a
 * client written against this surface's shared shape needs no special case, and
 * so the day a writer learns to absorb a replay it has somewhere to say so.
 */
export type CaretakerCommandAckV1 = {
  command: CaretakerCommand;
  changed: boolean;
  /** The grant that was acted on. For `designate`, the one just created. */
  grantToken: string;
  /**
   * Where to go next after an ACCEPT: the animal is now readable by the caller,
   * and its cockpit is the natural next screen. `null` for the other four, and
   * it can also be null on a successful accept when the use-case could not read
   * the pet back — a client that treats null as "go to the list" matches what
   * the web does.
   */
  petPublicToken: string | null;
  /**
   * `designate` only: whether the address had no MiMAR account.
   *
   * A CLIENT SHOULD SAY SO, and here it matters more than it does for a
   * transfer. NO INVITATION E-MAIL IS SENT FROM THIS ENDPOINT — see the note in
   * the route's command file — so for an address with no account, `true` means
   * the person has been told NOTHING and the titular has to reach them some
   * other way. A screen that said "le avisamos" over this would leave somebody
   * waiting for a message nobody sent. `null` for the other four commands.
   */
  inviteeNeedsAccount: boolean | null;
};
