// The daily sweep: three passes, in an order that is itself a requirement.
//
// PASS ORDER IS NOT AN IMPLEMENTATION DETAIL. Pass 2 ends arrangements whose
// `ends_at` has passed; pass 3 sends the T-3 "renew or let it end" nudge. Run
// pass 3 first and a grant expiring TODAY gets a reminder about a window that
// closed minutes later — the system asking someone to renew something it is
// about to take away. There is an explicit test for the ordering below, not
// just for each pass.
//
// `now` is a PARAMETER. A cron use-case that reads the wall clock has no
// testable boundaries, and every assertion here sits on one.

import { describe, expect, it, vi } from "vitest";

import { expireCaretakerGrants } from "../expire-caretaker-grants";
import {
  CARETAKER_ID,
  PET,
  TITULAR_ID,
  fakeTransaction,
  makeAcceptedGrant,
  makeFakeRepo,
  makeGrant,
} from "./_fake-repo";

const NOW = new Date("2026-09-12T04:00:00Z");

function deps(repo = makeFakeRepo()) {
  return { repo, now: () => NOW, transaction: fakeTransaction };
}

describe("expireCaretakerGrants — pass 1: unanswered invitations", () => {
  it("expires a pending invitation past its 7-day window", async () => {
    const stale = makeGrant({ id: "g-stale", status: "pending" });
    const repo = makeFakeRepo({
      findExpirableInvitations: vi.fn().mockResolvedValue([stale]),
    });

    const result = await expireCaretakerGrants(deps(repo));

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.value.invitationsExpired).toBe(1);
    expect(repo.updateGrantStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        grantId: "g-stale",
        status: "expired",
        expectedStatus: "pending",
      }),
    );
  });

  it("scans exactly 7 days back, not 'about a week'", async () => {
    const repo = makeFakeRepo();
    await expireCaretakerGrants(deps(repo));

    const cutoff = repo.findExpirableInvitations.mock.calls[0][0] as Date;
    expect(cutoff).toEqual(new Date("2026-09-05T04:00:00Z"));
  });

  it("writes NO spine event — a pending invitation is not a fact", async () => {
    const repo = makeFakeRepo({
      findExpirableInvitations: vi.fn().mockResolvedValue([makeGrant()]),
    });

    await expireCaretakerGrants(deps(repo));

    expect(repo.insertEndGrant).not.toHaveBeenCalled();
    expect(repo.insertAcceptGrant).not.toHaveBeenCalled();
  });

  it("skips silently when the row was already resolved (zero-row update)", async () => {
    // The scan is a stale read: an accept or a cancel may land between it and
    // this UPDATE. Without the expectedStatus predicate the blind write would
    // stomp an ACCEPTED grant back to `expired`.
    const repo = makeFakeRepo({
      findExpirableInvitations: vi.fn().mockResolvedValue([makeGrant()]),
      updateGrantStatus: vi.fn().mockResolvedValue(0),
    });

    const result = await expireCaretakerGrants(deps(repo));

    expect(result.ok === true && result.value.invitationsExpired).toBe(0);
    expect(result.ok === true && result.notifications).toHaveLength(0);
  });

  it("keys the expiry notice on the grant, with NO run date in it", async () => {
    // The silent duplicate this prevents: a key bucketed by day would let
    // tomorrow's sweep re-announce "nadie respondió" for the same invitation.
    // Proven by running the identical sweep under two different clocks and
    // demanding the same key, which a `toBeDefined()` assertion cannot do.
    const repo = () =>
      makeFakeRepo({
        findExpirableInvitations: vi.fn().mockResolvedValue([makeGrant({ id: "g-stale" })]),
      });

    const today = await expireCaretakerGrants(deps(repo()));
    const tomorrow = await expireCaretakerGrants({
      repo: repo(),
      now: () => new Date("2026-09-13T04:00:00Z"),
      transaction: fakeTransaction,
    });

    expect(today.ok === true && today.notifications[0].dedupeKey).toBe(
      "caretaker:invitation_expired:g-stale:titular-1",
    );
    expect(tomorrow.ok === true && tomorrow.notifications[0].dedupeKey).toBe(
      "caretaker:invitation_expired:g-stale:titular-1",
    );
  });

  it("keeps going after a per-row failure and counts it", async () => {
    const repo = makeFakeRepo({
      findExpirableInvitations: vi
        .fn()
        .mockResolvedValue([makeGrant({ id: "g-1" }), makeGrant({ id: "g-2" })]),
      updateGrantStatus: vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(1),
    });

    const result = await expireCaretakerGrants(deps(repo));

    expect(result.ok === true && result.value.errors).toBe(1);
    expect(result.ok === true && result.value.invitationsExpired).toBe(1);
  });
});

describe("expireCaretakerGrants — pass 2: arrangements past ends_at", () => {
  it("ends the grant with outcome `expired` and closes the ownership row", async () => {
    const repo = makeFakeRepo({
      findExpirableGrants: vi
        .fn()
        .mockResolvedValue([makeAcceptedGrant({ endsAt: new Date("2026-09-11T00:00:00Z") })]),
    });

    const result = await expireCaretakerGrants(deps(repo));

    expect(result.ok === true && result.value.grantsEnded).toBe(1);
    expect(repo.insertEndGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        grantId: "grant-1",
        ownershipId: "own-1",
        outcome: "expired",
        actorUserId: null,
        now: NOW,
      }),
      expect.anything(),
    );
  });

  it("uses ONE transaction per grant, not one for the whole batch", async () => {
    // A batch-wide transaction means one bad row rolls back every good one, and
    // a long batch holds locks on `ownerships` for the whole sweep.
    const repo = makeFakeRepo({
      findExpirableGrants: vi
        .fn()
        .mockResolvedValue([
          makeAcceptedGrant({ id: "g-1", ownershipId: "own-1" }),
          makeAcceptedGrant({ id: "g-2", ownershipId: "own-2" }),
        ]),
    });
    // Counted by hand rather than with vi.fn(): wrapping the generic
    // `transaction` in a Mock erases its type parameter and the deps signature
    // stops matching.
    let opened = 0;
    const transaction = async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => {
      opened += 1;
      return cb({ __tx: true });
    };

    await expireCaretakerGrants({ repo, now: () => NOW, transaction });

    expect(opened).toBe(2);
  });

  it("notifies both parties, never claiming the animal came back", async () => {
    const repo = makeFakeRepo({
      findExpirableGrants: vi.fn().mockResolvedValue([makeAcceptedGrant()]),
    });

    const result = await expireCaretakerGrants(deps(repo));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const users = result.notifications.map((n) => n.userId).sort();
    expect(users).toEqual([CARETAKER_ID, TITULAR_ID].sort());
    const titularNote = result.notifications.find((n) => n.userId === TITULAR_ID);
    expect(titularNote?.body).toContain("coordiná la devolución");
    expect(titularNote?.relatedPetId).toBe(PET.id);

    // One key per RECIPIENT. Keyed on the grant alone, the caretaker's row
    // would collapse into the titular's and only one of them would learn the
    // arrangement is over. These are the same two keys end-caretaker-grant.ts
    // emits for the manual path, on purpose — a grant ends exactly once.
    const byUser = Object.fromEntries(result.notifications.map((n) => [n.userId, n.dedupeKey]));
    expect(byUser[TITULAR_ID]).toBe("caretaker:grant_ended:grant-1:titular-1");
    expect(byUser[CARETAKER_ID]).toBe("caretaker:grant_ended:grant-1:caretaker-1");
  });

  it("survives one grant failing and still processes the next", async () => {
    const repo = makeFakeRepo({
      findExpirableGrants: vi
        .fn()
        .mockResolvedValue([
          makeAcceptedGrant({ id: "g-1", ownershipId: "own-1" }),
          makeAcceptedGrant({ id: "g-2", ownershipId: "own-2" }),
        ]),
      insertEndGrant: vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue({
        ended: true,
      }),
    });

    const result = await expireCaretakerGrants(deps(repo));

    expect(result.ok === true && result.value.grantsEnded).toBe(1);
    expect(result.ok === true && result.value.errors).toBe(1);
  });
});

describe("expireCaretakerGrants — pass 3: the T-3 reminder", () => {
  it("scans exactly the 3-day window ahead", async () => {
    const repo = makeFakeRepo();
    await expireCaretakerGrants(deps(repo));

    const [from, to] = repo.findGrantsNeedingReminder.mock.calls[0] as [Date, Date];
    expect(from).toEqual(NOW);
    expect(to).toEqual(new Date("2026-09-15T04:00:00Z"));
  });

  it("reminds both parties and stamps the witness", async () => {
    const repo = makeFakeRepo({
      findGrantsNeedingReminder: vi
        .fn()
        .mockResolvedValue([makeAcceptedGrant({ endsAt: new Date("2026-09-15T00:00:00Z") })]),
    });

    const result = await expireCaretakerGrants(deps(repo));

    expect(result.ok === true && result.value.remindersSent).toBe(1);
    expect(repo.markReminderSent).toHaveBeenCalledWith("grant-1", NOW);
    expect(result.ok === true && result.notifications).toHaveLength(2);
    expect(result.ok === true && result.notifications[0].body).toContain("Renová");

    const byUser = Object.fromEntries(
      result.ok === true ? result.notifications.map((n) => [n.userId, n.dedupeKey]) : [],
    );
    expect(byUser[TITULAR_ID]).toBe("caretaker:grant_ending_soon:grant-1:titular-1");
    expect(byUser[CARETAKER_ID]).toBe("caretaker:grant_ending_soon:grant-1:caretaker-1");
  });

  it("keys the T-3 nudge WITHOUT the run date, so the stored witness stays the gate", async () => {
    // A date bucket in this key would silently defeat `reminder_sent_at`: a
    // grant that sits in the 3-day window across two sweeps would be nudged
    // twice, once per bucket. The nudge fires once per grant, full stop.
    const repo = () =>
      makeFakeRepo({
        findGrantsNeedingReminder: vi.fn().mockResolvedValue([makeAcceptedGrant()]),
      });

    const first = await expireCaretakerGrants(deps(repo()));
    const second = await expireCaretakerGrants({
      repo: repo(),
      now: () => new Date("2026-09-13T04:00:00Z"),
      transaction: fakeTransaction,
    });

    const keys = (r: typeof first) =>
      r.ok === true ? r.notifications.map((n) => n.dedupeKey).sort() : [];
    expect(keys(first)).toEqual(keys(second));
    expect(keys(first)).toEqual([
      "caretaker:grant_ending_soon:grant-1:caretaker-1",
      "caretaker:grant_ending_soon:grant-1:titular-1",
    ]);
  });

  it("sends nothing when the witness was already stamped by a re-run", async () => {
    // Idempotency is a STORED witness, not a date computation. The daily
    // dispatcher can legitimately be re-invoked at 04:05; `markReminderSent`
    // returns zero rows the second time and no notification is produced.
    const repo = makeFakeRepo({
      findGrantsNeedingReminder: vi.fn().mockResolvedValue([makeAcceptedGrant()]),
      markReminderSent: vi.fn().mockResolvedValue(0),
    });

    const result = await expireCaretakerGrants(deps(repo));

    expect(result.ok === true && result.value.remindersSent).toBe(0);
    expect(result.ok === true && result.notifications).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// THE ORDERING
// ---------------------------------------------------------------------------

describe("expireCaretakerGrants — pass ordering", () => {
  it("runs pass 2 (end expired grants) BEFORE pass 3 (T-3 reminders)", async () => {
    const order: string[] = [];
    const repo = makeFakeRepo({
      findExpirableInvitations: vi.fn(async () => {
        order.push("pass1:scan");
        return [];
      }),
      findExpirableGrants: vi.fn(async () => {
        order.push("pass2:scan");
        return [];
      }),
      findGrantsNeedingReminder: vi.fn(async () => {
        order.push("pass3:scan");
        return [];
      }),
    });

    await expireCaretakerGrants(deps(repo));

    expect(order).toEqual(["pass1:scan", "pass2:scan", "pass3:scan"]);
  });

  it("does not remind about a grant it just ended in the same run", async () => {
    // The failure the ordering exists to prevent, stated as behaviour rather
    // than as call order: a grant whose `ends_at` is TODAY is inside both the
    // pass-2 scan and the pass-3 window. Pass 2 must claim it first, so the
    // caretaker is told "your period ended" and never "renew it or let it end
    // on the 12th" about a window that is already closed.
    const today = makeAcceptedGrant({ id: "g-today", endsAt: NOW });
    const repo = makeFakeRepo({
      findExpirableGrants: vi.fn().mockResolvedValue([today]),
      // A repository that (wrongly) still returns the row for the reminder
      // scan — the use-case must not act on it.
      findGrantsNeedingReminder: vi.fn().mockResolvedValue([today]),
    });

    const result = await expireCaretakerGrants(deps(repo));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.grantsEnded).toBe(1);
    expect(result.value.remindersSent).toBe(0);
    expect(repo.markReminderSent).not.toHaveBeenCalled();
    expect(result.notifications.some((n) => n.body.includes("Renová"))).toBe(false);
  });
});

describe("expireCaretakerGrants — the clock", () => {
  it("never reads the wall clock: every window derives from the injected now", async () => {
    const repo = makeFakeRepo();
    const other = new Date("2027-01-05T04:00:00Z");

    await expireCaretakerGrants({ repo, now: () => other, transaction: fakeTransaction });

    expect(repo.findExpirableInvitations.mock.calls[0][0]).toEqual(
      new Date("2026-12-29T04:00:00Z"),
    );
    expect(repo.findExpirableGrants.mock.calls[0][0]).toEqual(other);
    expect(repo.findGrantsNeedingReminder.mock.calls[0][1]).toEqual(
      new Date("2027-01-08T04:00:00Z"),
    );
  });
});
