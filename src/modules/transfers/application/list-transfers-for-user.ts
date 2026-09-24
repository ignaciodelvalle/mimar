// Use-case: every owner→owner transfer one person is on either side of.
//
// READ ONLY — no mutations, no notifications.
//
// WHY THIS EXISTS AT ALL, WHEN THE HUB PAGE ALREADY HAD THE QUERIES
// ---------------------------------------------------------------------------
// It had THREE of them, inline, and the addressee predicate — the one rule this
// feature's security rests on — was hand-written as raw Drizzle next to them:
//
//     or(eq(petTransfers.toOwnerId, user.id),
//        and(isNull(petTransfers.toOwnerId), eq(petTransfers.toOwnerEmail, callerEmail)))
//
// That is `validateRecipientMatch` (owner-transfer-rules.ts:124-134) re-expressed
// in a second language, in a file that never imports it. The two agreed on the
// day they were written. Nothing made them keep agreeing, and the direction of a
// disagreement is not symmetric: the SQL half decides which proposals a person
// is shown, the domain half decides which they may answer. A drift that widened
// the SQL would show somebody a proposal they cannot accept; one that narrowed
// it would hide a live seven-day window that then closes by itself.
//
// So the predicate moves into the repository, once, and the SECTIONING and the
// CAPABILITIES move here, where they can call the domain function directly. Both
// doors — the web hub and `GET /api/v1/me/transfers` — now read the same lists
// through the same rule.
//
// THE CAPABILITIES ARE NOT A TIDY FUNCTION OF STATUS, and the asymmetries below
// are the WEB'S, mirrored deliberately rather than smoothed:
//
//   · `accept` refuses an expired proposal (`accept-pet-transfer.ts:67-69`) and
//     refuses the sender accepting their own (`:81-83`).
//   · `reject` does NEITHER. It checks `status === "pending"` and the addressee
//     match, and nothing else (`reject-pet-transfer.ts:53-66`) — so a recipient
//     CAN still refuse a proposal that timed out but which the nightly cron has
//     not yet stamped `expired`. That is not an oversight to fix here: refusing
//     something dead is harmless, and taking the control away would leave a row
//     sitting in somebody's inbox with no way to clear it.
//   · `cancel` checks `fromOwnerId === caller` and `status === "pending"`
//     (`cancel-pet-transfer.ts:46-53`), with no expiry check either.
//
// A single `isActionable` flag would have collapsed three different rules into
// one wrong one.

import { validateRecipientMatch } from "../domain/owner-transfer-rules";
import type { TransfersRepository } from "../infrastructure/transfers-repository";

type Deps = {
  repo: typeof TransfersRepository;
  /** Injected so a test can pin the expiry boundary instead of racing it. */
  now?: () => Date;
};

export type TransferListItem = {
  transferToken: string;
  status: "pending" | "accepted" | "rejected" | "expired" | "cancelled";
  direction: "incoming" | "outgoing";
  petId: string;
  petName: string;
  petToken: string;
  petSpecies: string;
  /** The OTHER party's display name. Never an e-mail — see the api contract. */
  counterpartyName: string | null;
  toEmail: string;
  reason: "sale" | "gift" | "inheritance" | "other" | null;
  note: string | null;
  rejectionReason: string | null;
  initiatedAt: Date;
  respondedAt: Date | null;
  expiresAt: Date;
  /** By the SERVER'S clock, and not the same thing as `status === "expired"`. */
  expired: boolean;
  canAccept: boolean;
  canReject: boolean;
  canCancel: boolean;
};

export type TransfersForUser = {
  incoming: { pending: TransferListItem[]; history: TransferListItem[] };
  outgoing: TransferListItem[];
};

export type ListTransfersForUserInput = {
  userId: string;
  /** The caller's authenticated e-mail, from the session. May be empty. */
  callerEmail: string;
  /**
   * GoTrue's `email_confirmed_at` is non-null for this account (A09-1).
   *
   * THE LIST TAKES THE SAME TERM THE WRITERS DO, and it has to: this read is
   * what HANDS OUT `transferToken`. Leaving it out of the SQL predicate and
   * gating only `canAccept` would still show an unconfirmed account somebody
   * else's proposal, token included — and a token is the only thing the accept
   * door asks for besides the addressee match. Hiding the row is what keeps the
   * two halves of this feature saying the same thing.
   */
  callerEmailConfirmed: boolean;
};

const HISTORY_STATUSES = new Set(["accepted", "rejected", "expired", "cancelled"]);

export async function listTransfersForUser(
  input: ListTransfersForUserInput,
  deps: Deps,
): Promise<TransfersForUser> {
  const now = (deps.now ?? (() => new Date()))();
  // Lowercased ONCE, here, because the repository predicate compares it to a
  // column that `initiatePetTransfer` lowercases before insert, and because
  // `validateRecipientMatch` lowercases both sides again below. Normalising at
  // the boundary is what keeps those two from disagreeing about a capital A.
  //
  // AN UNCONFIRMED ADDRESS IS DEGRADED TO NO ADDRESS, which is exactly what the
  // repository's own docblock already describes for an empty string: the
  // predicate falls back to `to_owner_id = me`, an open e-mail invitation can no
  // longer match, and the row never leaves the database. Done here rather than
  // in the repository because "is this address proved" is a rule about the
  // caller, not about how the query is written.
  const callerEmail = input.callerEmailConfirmed ? input.callerEmail.trim().toLowerCase() : "";

  const rows = await deps.repo.listTransfersForUser({ userId: input.userId, callerEmail });

  const incomingPending: TransferListItem[] = [];
  const incomingHistory: TransferListItem[] = [];
  const outgoing: TransferListItem[] = [];

  for (const row of rows) {
    const { transfer } = row;
    const isSender = transfer.fromOwnerId === input.userId;
    // THE SAME FUNCTION the accept and reject writers will run. Not a second
    // comparison that happens to agree today.
    const isRecipient = validateRecipientMatch({
      toOwnerId: transfer.toOwnerId,
      toOwnerEmail: transfer.toOwnerEmail,
      callerId: input.userId,
      callerEmail,
      callerEmailConfirmed: input.callerEmailConfirmed,
    });

    // A row can be BOTH only if a self-transfer slipped past
    // `validateSelfTransfer` — reachable in principle when the recipient lookup
    // failed and the address happens to be the sender's own. The sender's view
    // wins, because that is the person who can still cancel it, and `canAccept`
    // stays false through the same guard the writer applies.
    const direction: "incoming" | "outgoing" = isSender ? "outgoing" : "incoming";
    const expired = transfer.expiresAt.getTime() <= now.getTime();
    const isPending = transfer.status === "pending";

    const item: TransferListItem = {
      transferToken: transfer.publicToken,
      status: transfer.status,
      direction,
      petId: transfer.petId,
      petName: row.petName,
      petToken: row.petToken,
      petSpecies: row.petSpecies,
      counterpartyName: isSender ? row.toDisplayName : row.fromDisplayName,
      toEmail: transfer.toOwnerEmail,
      reason: transfer.reason,
      note: transfer.note,
      rejectionReason: transfer.rejectionReason,
      initiatedAt: transfer.initiatedAt,
      respondedAt: transfer.respondedAt,
      expiresAt: transfer.expiresAt,
      expired,
      canAccept: isRecipient && !isSender && isPending && !expired,
      // No expiry term, no self term — see the header. This mirrors
      // `rejectPetTransfer`, which has neither.
      canReject: isRecipient && isPending,
      canCancel: isSender && isPending,
    };

    if (direction === "outgoing") {
      outgoing.push(item);
    } else if (isPending) {
      incomingPending.push(item);
    } else if (HISTORY_STATUSES.has(transfer.status)) {
      incomingHistory.push(item);
    }
  }

  // The repository orders by `initiated_at DESC`, which is right for the two
  // lists a person reads as "what arrived / what I sent". The received HISTORY
  // is re-sorted by when it was ANSWERED, and that order is INHERITED rather
  // than invented: the hub's own history query used to end
  // `.orderBy(desc(petTransfers.respondedAt))`, and this use-case absorbed it
  // along with the query. It is also the more useful one — a proposal sent in
  // March and refused yesterday belongs at the top.
  //
  // NO CITATION TO THAT QUERY, because it no longer exists to point at: the
  // three selects it lived among were replaced by the single repository read
  // above, in the same change that wrote this file. A line number for deleted
  // code is worse than none.
  incomingHistory.sort((a, b) => (b.respondedAt?.getTime() ?? 0) - (a.respondedAt?.getTime() ?? 0));

  return { incoming: { pending: incomingPending, history: incomingHistory }, outgoing };
}
