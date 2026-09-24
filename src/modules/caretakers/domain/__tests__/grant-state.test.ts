// The grant state machine — pure transition table, no DB, no clock.
//
// Every write path in this module asks the same question before it touches a
// row: "is this action legal from the status the row is in RIGHT NOW?". Keeping
// that in one table (instead of an `if (status !== 'pending')` per use-case) is
// what makes the answer testable exhaustively — the table test below walks the
// whole cartesian product, so a new status or a new action cannot be added
// without deciding what it means from every other state.

import { describe, expect, it } from "vitest";

import {
  GRANT_ACTIONS,
  type GrantAction,
  canApply,
  endedReasonFor,
  nextStatusFor,
} from "../grant-state";
import { GRANT_END_OUTCOMES, GRANT_STATUSES, type GrantStatus } from "../types";

// The full legal set, written out by hand. If the implementation and this table
// ever disagree, one of them is a bug — and the exhaustive test below is what
// forces that disagreement to surface instead of hiding in an untested corner.
const LEGAL: Array<[GrantStatus, GrantAction, GrantStatus]> = [
  ["pending", "accept", "accepted"],
  ["pending", "reject", "rejected"],
  ["pending", "cancel", "cancelled"],
  ["pending", "expire_invitation", "expired"],
  ["accepted", "revoke", "ended"],
  ["accepted", "withdraw", "ended"],
  ["accepted", "return", "ended"],
  ["accepted", "expire_grant", "ended"],
];

describe("grant state machine", () => {
  it("allows exactly the transitions in the table", () => {
    const legalKeys = new Set(LEGAL.map(([from, action]) => `${from}:${action}`));

    for (const from of GRANT_STATUSES) {
      for (const action of GRANT_ACTIONS) {
        const expected = legalKeys.has(`${from}:${action}`);
        expect(
          canApply(from, action),
          `canApply("${from}", "${action}") should be ${expected}`,
        ).toBe(expected);
      }
    }
  });

  it("maps every legal transition to the right next status", () => {
    for (const [from, action, to] of LEGAL) {
      expect(nextStatusFor(from, action), `${from} --${action}--> ${to}`).toBe(to);
    }
  });

  it("returns null for an illegal transition rather than guessing", () => {
    expect(nextStatusFor("accepted", "accept")).toBeNull();
    expect(nextStatusFor("expired", "accept")).toBeNull();
    expect(nextStatusFor("ended", "revoke")).toBeNull();
    expect(nextStatusFor("rejected", "cancel")).toBeNull();
  });

  it("treats every terminal status as terminal", () => {
    for (const terminal of ["rejected", "cancelled", "expired", "ended"] as const) {
      for (const action of GRANT_ACTIONS) {
        expect(canApply(terminal, action), `${terminal} must accept no action`).toBe(false);
      }
    }
  });

  it("never lets a pending grant be ended by a grant-lifecycle action", () => {
    // The distinction that the CHECK constraint enforces in the DB: a pending
    // invitation has no ownership row, so "revoking" it is a CANCEL, not an END,
    // and it must not emit caretaker_ended.
    for (const action of ["revoke", "withdraw", "return", "expire_grant"] as const) {
      expect(canApply("pending", action)).toBe(false);
    }
  });

  it("maps each ending action to its caretaker_ended outcome", () => {
    expect(endedReasonFor("revoke")).toBe("revoked_by_owner");
    expect(endedReasonFor("withdraw")).toBe("withdrawn_by_caretaker");
    expect(endedReasonFor("return")).toBe("returned");
    expect(endedReasonFor("expire_grant")).toBe("expired");
  });

  it("has no outcome for actions that do not end an ACCEPTED grant", () => {
    // expire_invitation resolves a pending invite. It emits NO event at all —
    // a pending invitation is not a fact about the animal — so asking for an
    // outcome must return null, not "expired". Conflating the two is how the
    // spine would end up claiming an arrangement that never happened.
    expect(endedReasonFor("expire_invitation")).toBeNull();
    expect(endedReasonFor("accept")).toBeNull();
    expect(endedReasonFor("reject")).toBeNull();
    expect(endedReasonFor("cancel")).toBeNull();
  });

  it("only ever produces outcomes the caretaker_ended schema accepts", () => {
    for (const action of GRANT_ACTIONS) {
      const outcome = endedReasonFor(action);
      if (outcome === null) continue;
      expect(GRANT_END_OUTCOMES).toContain(outcome);
    }
  });

  it("produces an outcome for exactly the actions that land on 'ended'", () => {
    for (const action of GRANT_ACTIONS) {
      const endsAnAcceptedGrant = nextStatusFor("accepted", action) === "ended";
      expect(
        endedReasonFor(action) !== null,
        `${action}: outcome presence must match whether it ends an accepted grant`,
      ).toBe(endsAnAcceptedGrant);
    }
  });
});
