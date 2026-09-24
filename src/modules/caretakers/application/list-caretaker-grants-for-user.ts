// Use-case: every OPEN cuidador-temporal arrangement one person is a party to.
//
// READ ONLY — no mutations, no notifications.
//
// WHY IT EXISTS, WHEN THE WEB HAS NO SUCH PAGE
// ---------------------------------------------------------------------------
// The web reaches a grant from two doors and lists it from neither: the titular
// sees a banner on `/mis-mascotas/{token}`, the invitee follows a link to
// `/cuidado/{grantToken}`. Both are addressed by something somebody else handed
// you, and neither shape survives a phone — the pet payload's caretaker banner
// deliberately carries no grant token, and a deep link may land on a device that
// has never opened one.
//
// So this is a new ARRANGEMENT of facts the caller can already see, not new
// facts, and the two rules it must not re-invent while doing it are:
//
//   1. THE ADDRESSEE PREDICATE, which lives in the repository (see the port),
//      once, for the reason `list-transfers-for-user.ts` records after the
//      alternative had already drifted: the SQL half decides who is SHOWN an
//      invitation and the writers decide who may ANSWER it.
//   2. THE CAPABILITIES, which are the WRITERS' rules, mirrored here rather than
//      smoothed into a tidy function of status. They are not uniform, and the
//      asymmetries below are the use-cases' own:
//
//        · `accept` refuses an expired period (`accept-caretaker-grant.ts`,
//          `grant.endsAt <= now`) and refuses the granter accepting their own.
//        · `reject` does NEITHER. It checks the addressee match and
//          `canApply(status, "reject")`, nothing else — so an invitee CAN still
//          decline an invitation whose period lapsed before the nightly sweep
//          reached it. Not an oversight to fix here: refusing something dead is
//          harmless, and taking the control away would leave a row nobody can
//          clear.
//        · `cancel` needs `pending`; `revoke` needs `accepted`. The state
//          machine draws that line and refuses to blur it, because cancelling
//          touches a row with no ownership and no spine event while revoking
//          ends a real arrangement.
//
// WHAT THIS DELIBERATELY DOES NOT DECIDE
// ---------------------------------------------------------------------------
// THE TITULAR GATE. `canCancel` and `canRevoke` say the caller GRANTED the row
// and it is in the right state. They do NOT say the caller still holds the
// animal — the command re-runs the web's own pet guard for that, and a second
// copy of `requireTitularAccess` living in a list query is precisely the drift
// this file's transfers sibling was written to end. The consequence is stated on
// the wire (`CaretakerGrantCapabilitiesV1`): a control may be offered and then
// refused with `caretaker_forbidden`, which is the safe direction.
//
// THE H4 GUARD. Whether the granter is still titular is re-read INSIDE the
// accept transaction, under the row lock, because every pre-transaction read of
// it is stale by construction. `canAccept` cannot and must not anticipate it.

import { caretakerScopeSentence } from "../domain/grant-copy";
import { canApply } from "../domain/grant-state";
import type { CaretakersRepositoryPort, UserGrantRow } from "./ports";

type Deps = {
  repo: Pick<CaretakersRepositoryPort, "listGrantsForUser">;
  /** Injected so a test can pin the period boundary instead of racing it. */
  now?: () => Date;
};

export type CaretakerGrantListItem = {
  grantToken: string;
  status: "pending" | "accepted";
  direction: "incoming" | "outgoing";
  petId: string;
  petName: string;
  petToken: string;
  petSpecies: string;
  /** The OTHER party's display name. Never an e-mail — see the api contract. */
  counterpartyName: string | null;
  caretakerEmail: string;
  startsAt: Date;
  endsAt: Date;
  note: string | null;
  /** By the SERVER'S clock, and not the same thing as a terminal status. */
  expired: boolean;
  /** Both halves of what an active caretaker may and may not do. */
  scopeSentence: string;
  canAccept: boolean;
  canReject: boolean;
  canCancel: boolean;
  canRevoke: boolean;
};

export type CaretakerGrantsForUser = {
  incoming: CaretakerGrantListItem[];
  outgoing: CaretakerGrantListItem[];
};

export type ListCaretakerGrantsForUserInput = {
  userId: string;
  /** The caller's authenticated e-mail, from the session. May be empty. */
  callerEmail: string;
  /**
   * GoTrue's `email_confirmed_at` is non-null for this account (A09-1).
   *
   * The hub read is what HANDS OUT `grantToken`, so it takes the same term the
   * writers do. Gating only `canAccept` would still show an unconfirmed account
   * somebody else's invitation with its token attached.
   */
  callerEmailConfirmed: boolean;
};

export async function listCaretakerGrantsForUser(
  input: ListCaretakerGrantsForUserInput,
  deps: Deps,
): Promise<CaretakerGrantsForUser> {
  const now = (deps.now ?? (() => new Date()))();
  // Lowercased ONCE, here, because the repository predicate compares it to a
  // column `designateCaretaker` lowercases before insert, and because the match
  // below lowercases both sides again. Normalising at the boundary is what keeps
  // those two from disagreeing about a capital A.
  //
  // AN UNCONFIRMED ADDRESS IS DEGRADED TO NO ADDRESS, which the repository
  // already handles for an empty string: the predicate falls back to
  // `caretaker_user_id = me`, so an open e-mail invitation cannot match and the
  // row never leaves the database. Done here rather than in SQL because "is this
  // address proved" is a fact about the caller, not about the query.
  const callerEmail = input.callerEmailConfirmed ? input.callerEmail.trim().toLowerCase() : "";

  const rows = await deps.repo.listGrantsForUser({ userId: input.userId, callerEmail });

  const incoming: CaretakerGrantListItem[] = [];
  const outgoing: CaretakerGrantListItem[] = [];
  const scopeSentence = caretakerScopeSentence();

  for (const row of rows) {
    const item = toItem(row, { userId: input.userId, callerEmail, now, scopeSentence });
    if (item.direction === "outgoing") outgoing.push(item);
    else incoming.push(item);
  }

  return { incoming, outgoing };
}

/**
 * The addressee match, in the SAME shape the accept and reject writers apply:
 * an id once `caretaker_user_id` resolved, an e-mail only while it has not.
 *
 * NOT A SECOND COPY OF THE SQL. The repository already narrowed the rows to ones
 * this person is a party to; this decides which SIDE of each row they are on,
 * which SQL did not answer and which the capabilities depend on.
 */
function isAddressee(
  grant: { caretakerUserId: string | null; caretakerEmail: string },
  viewer: { userId: string; callerEmail: string },
): boolean {
  if (grant.caretakerUserId !== null) return grant.caretakerUserId === viewer.userId;
  return (
    viewer.callerEmail.length > 0 &&
    grant.caretakerEmail.toLowerCase() === viewer.callerEmail.toLowerCase()
  );
}

function toItem(
  row: UserGrantRow,
  ctx: { userId: string; callerEmail: string; now: Date; scopeSentence: string },
): CaretakerGrantListItem {
  const { grant } = row;
  const isGranter = grant.grantedByUserId === ctx.userId;
  const addressee = isAddressee(grant, ctx);

  // A row can be BOTH only if a self-designation slipped past
  // `validateDesignation` — reachable when the address is one of the granter's
  // that resolved to no account. The GRANTER's view wins, because that is the
  // person who can still withdraw it, and `canAccept` stays false through the
  // same guard the writer applies.
  const direction: "incoming" | "outgoing" = isGranter ? "outgoing" : "incoming";
  const isPending = grant.status === "pending";
  const expired = grant.endsAt.getTime() <= ctx.now.getTime();

  return {
    grantToken: grant.publicToken,
    // Narrowed by the repository's own predicate; the cast is what makes the
    // wire's two-state union honest instead of restating six.
    status: grant.status as "pending" | "accepted",
    direction,
    petId: grant.petId,
    petName: row.petName,
    petToken: row.petToken,
    petSpecies: row.petSpecies,
    counterpartyName: isGranter ? row.caretakerDisplayName : row.grantedByDisplayName,
    caretakerEmail: grant.caretakerEmail,
    startsAt: grant.startsAt,
    endsAt: grant.endsAt,
    note: grant.note,
    expired,
    scopeSentence: ctx.scopeSentence,
    // The accept writer's three terms, in its order: the addressee match, the
    // "not your own invitation" guard, and the period. It does NOT include the
    // H4 granter-still-titular check — that one is read under the row lock and
    // no list can anticipate it.
    canAccept: addressee && !isGranter && isPending && !expired,
    // No expiry term and no self term, mirroring `rejectCaretakerGrant`, which
    // has neither. See the header for why that is deliberate.
    canReject: addressee && !isGranter && canApply(grant.status, "reject"),
    canCancel: isGranter && canApply(grant.status, "cancel"),
    canRevoke: isGranter && canApply(grant.status, "revoke"),
  };
}
