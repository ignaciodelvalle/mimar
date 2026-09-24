// Grant state machine — the (status, action) transition table, in one place.
//
// Pure. No DB, no clock, no I/O. Every write path in this module consults it
// before touching a row, which is what lets one exhaustive test walk the whole
// cartesian product of statuses × actions. Scattering the same question across
// seven `if (status !== 'pending')` checks would leave most of that product
// untested and let a new status ship with undecided semantics.
//
// THE DISTINCTION THIS TABLE ENCODES: a `pending` invitation is workflow state,
// not a fact about the animal. It can be rejected, cancelled or expired, and
// none of those produce a spine event. Only an `accepted` grant can be ENDED,
// and every way of ending one emits `caretaker_ended` with an outcome. The
// database says the same thing from the other side, via the biconditional
// accept CHECK on pet_caretaker_grants.

import type { GrantEndOutcome, GrantStatus } from "./types";

export const GRANT_ACTIONS = [
  /** The invitee accepted. Writes the ownership row + caretaker_designated. */
  "accept",
  /** The invitee declined. No event. */
  "reject",
  /** The titular withdrew the invitation before it was answered. No event. */
  "cancel",
  /** Cron pass 1: nobody answered within the invitation window. No event. */
  "expire_invitation",
  /** The titular ended an active arrangement unilaterally. */
  "revoke",
  /** The caretaker stepped down, or their account was deactivated/erased. */
  "withdraw",
  /** The arrangement ended with the animal handed back. */
  "return",
  /** Cron pass 2: `ends_at` passed on an active arrangement. */
  "expire_grant",
] as const;

export type GrantAction = (typeof GRANT_ACTIONS)[number];

/**
 * The complete transition table. A `(from, action)` pair absent from this map
 * is ILLEGAL — the machine returns null rather than inventing a next state.
 */
const TRANSITIONS: Readonly<Record<GrantStatus, Partial<Record<GrantAction, GrantStatus>>>> = {
  pending: {
    accept: "accepted",
    reject: "rejected",
    cancel: "cancelled",
    expire_invitation: "expired",
  },
  accepted: {
    revoke: "ended",
    withdraw: "ended",
    return: "ended",
    expire_grant: "ended",
  },
  // Terminal. Corrections are new grants, never a resurrected row — the same
  // discipline the event spine follows.
  rejected: {},
  cancelled: {},
  expired: {},
  ended: {},
};

/**
 * The `caretaker_ended.outcome` an action produces, or null when the action
 * does not end an ACCEPTED grant.
 *
 * `expire_invitation` maps to null on purpose, even though "expired" is a
 * perfectly good English word for what happened to it: an unanswered invitation
 * never became an arrangement, so writing `caretaker_ended{outcome:'expired'}`
 * for it would put an arrangement that never existed into an append-only log.
 */
const END_OUTCOMES: Partial<Record<GrantAction, GrantEndOutcome>> = {
  revoke: "revoked_by_owner",
  withdraw: "withdrawn_by_caretaker",
  return: "returned",
  expire_grant: "expired",
};

export function canApply(from: GrantStatus, action: GrantAction): boolean {
  return TRANSITIONS[from][action] !== undefined;
}

export function nextStatusFor(from: GrantStatus, action: GrantAction): GrantStatus | null {
  return TRANSITIONS[from][action] ?? null;
}

export function endedReasonFor(action: GrantAction): GrantEndOutcome | null {
  return END_OUTCOMES[action] ?? null;
}
