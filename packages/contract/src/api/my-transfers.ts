// `GET /api/v1/me/transfers` — every ownership transfer this person is part of.
//
// THE HUB, NOT A PET FACE. Every other authenticated read on this surface hangs
// off ONE animal: `/pets/{token}` is its chrome, `/libreta` its ledger, `/lost`
// its search, `/shares` its exposure. This one hangs off the PERSON, and it has
// to, because half of what it lists is about animals the caller does not own —
// a proposal is precisely an offer from somebody else's pet to you. There is no
// pet whose token would name this read.
//
// It mirrors the web's `/transferencias` hub, which is the one page where the
// three lists appear together, and it answers that page's question in one round
// trip: what is coming to me, what did I send, and what already resolved.
//
// WHAT A CLIENT MUST NOT DO WITH THIS PAYLOAD
// ---------------------------------------------------------------------------
// DO NOT RECOMPUTE `capabilities`. Whether a proposal can still be accepted is a
// function of its status, the server's clock against `expiresAt`, and which side
// of it the caller is on — and the last of those is decided by an id-or-email
// match a client cannot perform, because it never learns the addressee. A screen
// that offered "Aceptar" on a row it judged pending would offer it to the sender.
//
// DO NOT TREAT AN EMPTY LIST AS "NOTHING PENDING" AFTER A FAILED READ. The
// distinction matters more here than on most screens: the thing being missed is
// a seven-day window that closes by itself.
//
// PII: WHAT THIS CARRIES, AND THE ONE THING IT NEVER WILL
// ---------------------------------------------------------------------------
// `toEmail` is carried on every row and that is NOT a leak in either direction,
// which is worth spelling out because it looks like one:
//
//   · to the SENDER it is the address they typed into the form themselves;
//   · to the RECIPIENT it is their own address, which is how the proposal
//     reached them.
//
// There is no third party. The web renders it unconditionally for the same
// reason (`/transferencias/[transferToken]/page.tsx:103-104`, ungated by
// `isSender`), and the hub falls back to it when the recipient has no display
// name yet (`/transferencias/page.tsx:206-209`) — an open invitation to somebody
// with no account has nothing else to show.
//
// THE SENDER'S EMAIL IS NEVER CARRIED, and it is not merely withheld: it is
// unreachable from here. `profiles` has no email column, so the only way to
// obtain one is the Supabase admin API, which this read does not touch and must
// not. `counterpartyName` — `profiles.display_name` — is what the web shows a
// recipient instead ("{fromDisplayName} te quiere transferir esta mascota"), and
// it is `null` for a profile that has not set one.
//
// NO DNI, in any form. Transfers are addressed by e-mail end to end; the
// hashed-DNI path (`lib/utils/dni-hash.ts`) has no part in this feature and
// adding one here would invent an identifier the web has never asked for.

import type { OwnerTransferReason, TransferCommand } from "../input/transfer.ts";

export const MY_TRANSFERS_PAYLOAD_VERSION = 1;

/**
 * ONE MINUTE, the same window `/shares` and `/lost` take.
 *
 * Short for a reason specific to this screen: the facts on it move without the
 * caller doing anything. The other party accepts, the sender withdraws, or the
 * nightly cron expires a proposal nobody answered — three ways a row changes
 * while the phone is in a pocket. A five-minute window is five minutes of
 * offering "Aceptar" on something already gone.
 */
export const MY_TRANSFERS_STALE_AFTER_MS = 60_000;

/**
 * The five states a proposal can be in — `PET_TRANSFER_STATUSES`, mirrored from
 * `db/schema.ts` where a CHECK constraint enforces the same five.
 *
 * `expired` is written by a nightly cron, not by either party, which is why a
 * client must never derive it: a proposal past `expiresAt` that the cron has not
 * reached yet is still `pending` in the database, and `accept` on it is refused
 * by the use-case's own expiry check rather than by its status. The `expired`
 * FLAG below is what a screen should read; this is what the row says.
 */
export const PET_TRANSFER_STATUSES_V1 = [
  "pending",
  "accepted",
  "rejected",
  "expired",
  "cancelled",
] as const;
export type PetTransferStatusV1 = (typeof PET_TRANSFER_STATUSES_V1)[number];

/**
 * Which of the three answers this caller may give to THIS row.
 *
 * ALL THREE ARE DECIDED BY THE SERVER and none is re-derivable on a phone. They
 * are not a tidy function of status: `canAccept` folds in the addressee match
 * (`validateRecipientMatch`), the server's clock against `expiresAt`, and the
 * "you cannot accept your own" guard; `canCancel` is `fromOwnerId === caller`,
 * which is NARROWER than "this is my pet" — a co-owner may not withdraw a
 * proposal they did not send.
 *
 * They are affordance hints and NOT the rules. Every one of them is enforced
 * again in the use-case, under a row lock, because all three can go stale in the
 * time it takes to read the screen.
 */
export type TransferCapabilitiesV1 = {
  canAccept: boolean;
  canReject: boolean;
  canCancel: boolean;
};

/** The animal, named the way both the hub and the detail page name it. */
export type TransferPetV1 = {
  publicToken: string;
  name: string;
  /**
   * Open vocabulary (`dog`, `cat`, …) — `pets.species` is `text NOT NULL` with
   * no CHECK, so this is a `string` and not the `PetSpecies` union, exactly as
   * every sibling payload on this surface types it (`pets.ts:122`,
   * `public-credential.ts:125`). A closed union here would be this file
   * asserting a constraint the column does not have, and the first row seeded
   * outside the registration form would make it a lie.
   */
  species: string;
};

/** One proposal, from the caller's side of it. */
export type MyTransferV1 = {
  /** `PTR-XXXX-XXXX`. The handle every command takes. */
  transferToken: string;
  status: PetTransferStatusV1;
  /**
   * Which side of it the caller is on.
   *
   * A ROW CAN ONLY BE ONE, and the server refuses to let it be both: a
   * self-transfer is blocked at initiate (`validateSelfTransfer`), so the
   * sender and the addressee are never the same account. A client may switch on
   * this to pick a sentence ("Recibiste a Firu" vs "Transferencia de Firu")
   * exactly as the detail page does.
   */
  direction: "incoming" | "outgoing";
  pet: TransferPetV1;
  /**
   * The OTHER party's display name, or `null`.
   *
   * For an incoming row this is the sender (`profiles.display_name` of
   * `from_owner_id`); for an outgoing one, the recipient, which is `null` until
   * they have an account with a name set. Never an e-mail — see the header.
   */
  counterpartyName: string | null;
  /**
   * The addressee's e-mail. Always present, never a third party's — see the
   * header for why that is true in both directions.
   */
  toEmail: string;
  reason: OwnerTransferReason | null;
  /** The sender's note to the recipient. */
  note: string | null;
  /** What the recipient said when refusing, when they said anything. */
  rejectionReason: string | null;
  initiatedAt: string;
  /** When it was answered — `null` while pending, and for anything the cron expired. */
  respondedAt: string | null;
  expiresAt: string;
  /**
   * Whether `expiresAt` has passed, by the SERVER'S clock.
   *
   * Carried for the reason `LibretaShareV1.expired` is: a phone's clock can be
   * days wrong, and the flattering error is the dangerous one. A screen that
   * called a live proposal expired would have somebody stop waiting for an
   * animal that is still theirs to take.
   *
   * IT IS NOT THE SAME AS `status === "expired"`. That status is written by the
   * nightly cron; this flag is true the instant the deadline passes. Between the
   * two there is a window in which a row reads `pending` and cannot be accepted,
   * and this is the field that says so.
   */
  expired: boolean;
  capabilities: TransferCapabilitiesV1;
};

/**
 * The hub, in the web's own three sections.
 *
 * SPLIT SERVER-SIDE rather than handed over as one array with a status field,
 * because the split is not a filter a client should own: "Recibidas ·
 * Pendientes" is `status = 'pending' AND addressed to me`, and the addressee
 * half of that predicate is the id-or-email match a client cannot evaluate. A
 * flat list would force every consumer to re-implement the one rule this
 * feature's security rests on.
 *
 * OUTGOING IS NOT SPLIT, exactly as on the web: a person looking at what they
 * sent wants the pending ones and the resolved ones in one column, ordered by
 * when they sent them.
 */
export type MyTransfersV1 = {
  payloadVersion: typeof MY_TRANSFERS_PAYLOAD_VERSION;
  /** The three envelope fields §6 requires on every read. Built by `apiV1Envelope`. */
  issuedAt: string;
  staleAfter: string;
  incoming: {
    /** Open proposals addressed to the caller, newest first. */
    pending: MyTransferV1[];
    /** Resolved ones — accepted, rejected, expired, cancelled. Newest answer first. */
    history: MyTransferV1[];
  };
  /** Everything the caller sent, any status, newest first. */
  outgoing: MyTransferV1[];
};

/**
 * What `POST /api/v1/me/transfers` answers.
 *
 * `changed` IS ALWAYS TRUE HERE, and the field is carried anyway — deliberately,
 * and the reason is the opposite of the one `ShareCommandAckV1.changed` has.
 * There, three of four commands can recognise a replay and report it as a
 * no-op success. Here NONE can: every one of the four guards on
 * `expectedStatus: "pending"` (or, for `initiate`, on a partial unique index),
 * so a replay is REFUSED rather than absorbed. The field exists so that a client
 * written against the surface's shared shape does not need a special case, and
 * so the day a writer learns to absorb a replay it has somewhere to say so
 * without a payload version bump.
 *
 * `petPublicToken` comes back on `accept` and is `null` otherwise: after a
 * successful accept the animal is the caller's, and the natural next screen is
 * its credential. The web navigates to exactly that (`AcceptTransferActions.tsx`
 * → `/mis-mascotas/{petToken}`).
 */
export type TransferCommandAckV1 = {
  command: TransferCommand;
  changed: boolean;
  /** The proposal that was acted on. For `initiate`, the one just created. */
  transferToken: string;
  /** Where to go next after an accept. `null` for the other three. */
  petPublicToken: string | null;
  /**
   * `initiate` only: whether the address had no MiMAR account, so an invitation
   * e-mail was sent instead of an in-app notification.
   *
   * A CLIENT SHOULD SAY SO. "Le mandamos una invitación por mail a X" and "X ya
   * tiene la propuesta en su cuenta" are different waits, and a screen that said
   * the second about the first leaves somebody refreshing a list that will never
   * change. `null` for the other three commands.
   */
  recipientNeedsInvite: boolean | null;
};
