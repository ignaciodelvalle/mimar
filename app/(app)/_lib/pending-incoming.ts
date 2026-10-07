// Pending INCOMING items — what somebody else is waiting for this person to
// answer: an invitation to look after their animal, or an offer of its
// titularidad.
//
// WHY THIS EXISTS (staging, 2026-10): a titular invited the PO to look after her
// ferret. The grant was there, pending and linked to his account, and the
// notification was there, unread — and he "did not see it", because a pending
// invitation surfaced ONLY in the bell and on /transferencias. Neither is where
// an invitee looks. /mis-mascotas is, and /inicio is the door that leads there.
//
// THE SAME READ /transferencias DOES, NOT A THIRD COPY OF IT. Both use-cases
// below own their addressee predicate (in the repository, once) and their
// capabilities (the writers' own rules). This file only CHOOSES from what they
// return: the rows whose `canAccept` is true — the server's answer to "can this
// person still say yes", which already folds in the addressee match, the
// self-guard, the status and the clock. A row the person can no longer accept
// is history, and history lives on /transferencias.
//
// BOUNDED, AND SILENT WHEN IT FAILS. This is a banner on top of pages that have
// their own job. A slow or failed read returns `null` and the page renders as if
// there were nothing pending — `loadWithTimeout` reports the failure with a
// correlation id, and the bell and /transferencias still carry every row.

import { loadWithTimeout } from "@/lib/analytics/analytics-load";
import {
  type CaretakerGrantsForUser,
  listCaretakerGrantsForUser,
} from "@/src/modules/caretakers/application/list-caretaker-grants-for-user";
import { CaretakersRepository } from "@/src/modules/caretakers/infrastructure/caretakers-repository";
import {
  type TransfersForUser,
  listTransfersForUser,
} from "@/src/modules/transfers/application/list-transfers-for-user";
import { TransfersRepository } from "@/src/modules/transfers/infrastructure/transfers-repository";

/**
 * The budget for the banner's read. Short on purpose: the pages that carry the
 * banner start this read BESIDE their own, so on a healthy pooler it costs no
 * wall time, and on a degraded one the page must not wait on a banner.
 */
export const PENDING_INCOMING_BUDGET_MS = 2_500;

export type PendingIncomingCaller = {
  userId: string;
  /** The caller's session e-mail. Empty means "match by account id only". */
  callerEmail: string;
  /** GoTrue's `email_confirmed_at` is non-null (A09-1) — same term the hub takes. */
  callerEmailConfirmed: boolean;
};

export type PendingCaretakerInvitation = {
  kind: "caretaker";
  token: string;
  href: string;
  petName: string;
  petSpecies: string;
  /** The titular's display name, exactly as /transferencias shows it. Never an e-mail. */
  counterpartyName: string | null;
  startsAt: Date;
  endsAt: Date;
};

export type PendingIncomingTransfer = {
  kind: "transfer";
  token: string;
  href: string;
  petName: string;
  petSpecies: string;
  /** The sender's display name, exactly as /transferencias shows it. Never an e-mail. */
  counterpartyName: string | null;
  expiresAt: Date;
};

export type PendingIncomingItem = PendingCaretakerInvitation | PendingIncomingTransfer;

export type PendingIncoming = {
  /** Caretaker invitations first (soonest start), then transfers (soonest expiry). */
  items: PendingIncomingItem[];
};

/**
 * Pick, from the two hub reads, the rows that are waiting on THIS person's yes.
 *
 * Pure — the unit tests drive it with the use-cases' own output shapes.
 */
export function selectPendingIncoming(
  transfers: TransfersForUser,
  caretakerGrants: CaretakerGrantsForUser,
): PendingIncoming {
  const invitations: PendingCaretakerInvitation[] = caretakerGrants.incoming
    .filter((g) => g.status === "pending" && g.canAccept)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .map((g) => ({
      kind: "caretaker",
      token: g.grantToken,
      href: `/cuidado/${g.grantToken}`,
      petName: g.petName,
      petSpecies: g.petSpecies,
      counterpartyName: g.counterpartyName,
      startsAt: g.startsAt,
      endsAt: g.endsAt,
    }));

  const offers: PendingIncomingTransfer[] = transfers.incoming.pending
    .filter((t) => t.canAccept)
    .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
    .map((t) => ({
      kind: "transfer",
      token: t.transferToken,
      href: `/transferencias/${t.transferToken}`,
      petName: t.petName,
      petSpecies: t.petSpecies,
      counterpartyName: t.counterpartyName,
      expiresAt: t.expiresAt,
    }));

  return { items: [...invitations, ...offers] };
}

type Deps = {
  transfersRepo: Parameters<typeof listTransfersForUser>[1]["repo"];
  caretakersRepo: Parameters<typeof listCaretakerGrantsForUser>[1]["repo"];
};

const DEFAULT_DEPS: Deps = {
  transfersRepo: TransfersRepository,
  caretakersRepo: CaretakersRepository,
};

/**
 * The bounded read. Resolves `null` on timeout or failure — NEVER rejects, so a
 * caller may start it before its own reads and await it after them.
 */
export async function loadPendingIncoming(
  caller: PendingIncomingCaller,
  deps: Deps = DEFAULT_DEPS,
  ms: number = PENDING_INCOMING_BUDGET_MS,
): Promise<PendingIncoming | null> {
  const load = await loadWithTimeout(
    Promise.all([
      listTransfersForUser(caller, { repo: deps.transfersRepo }),
      listCaretakerGrantsForUser(caller, { repo: deps.caretakersRepo }),
    ]),
    ms,
  );
  if (!load.ok) return null;
  const [transfers, caretakerGrants] = load.value;
  return selectPendingIncoming(transfers, caretakerGrants);
}
