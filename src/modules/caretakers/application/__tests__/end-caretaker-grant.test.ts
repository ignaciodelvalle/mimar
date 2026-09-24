// Use-case: an ACCEPTED arrangement stops.
//
// Four doors lead here and the spec gives each its own outcome: the titular
// revokes, the caretaker withdraws (or their account is erased), the animal
// goes back, or the period runs out. All four write `caretaker_ended` and close
// the ownership row in ONE transaction — the mirror image of accept.
//
// The outcome is NOT cosmetic. "expired" must never be presented as "the animal
// came back": the arrangement ended, the possession question is open. That is
// the difference the titular reads on their profile the next morning.

import { describe, expect, it, vi } from "vitest";

import { endCaretakerGrant } from "../end-caretaker-grant";
import {
  CARETAKER_ID,
  PET,
  TITULAR_ID,
  fakeTransaction,
  makeAcceptedGrant,
  makeFakeRepo,
  makeGrant,
} from "./_fake-repo";

const NOW = new Date("2026-09-16T04:00:00Z");

function deps(repo = makeFakeRepo()) {
  return { repo, now: () => NOW, transaction: fakeTransaction };
}

function repoWithAccepted(overrides: Record<string, unknown> = {}) {
  const accepted = makeAcceptedGrant();
  return makeFakeRepo({
    findGrantByToken: vi.fn().mockResolvedValue(accepted),
    findGrantByIdForUpdate: vi.fn().mockResolvedValue(accepted),
    ...overrides,
  });
}

describe("endCaretakerGrant", () => {
  it("revocation by the titular ends the grant with outcome revoked_by_owner", async () => {
    const repo = repoWithAccepted();
    const result = await endCaretakerGrant(
      { grantPublicToken: "CG-abc123", action: "revoke", actorUserId: TITULAR_ID },
      deps(repo),
    );

    expect(result.ok).toBe(true);
    expect(repo.insertEndGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        grantId: "grant-1",
        ownershipId: "own-1",
        outcome: "revoked_by_owner",
        actorUserId: TITULAR_ID,
        now: NOW,
      }),
      expect.anything(),
    );
  });

  it("withdrawal by the caretaker ends it with outcome withdrawn_by_caretaker", async () => {
    const repo = repoWithAccepted();
    await endCaretakerGrant(
      { grantPublicToken: "CG-abc123", action: "withdraw", actorUserId: CARETAKER_ID },
      deps(repo),
    );

    expect(repo.insertEndGrant).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "withdrawn_by_caretaker" }),
      expect.anything(),
    );
  });

  it("expiry by the cron ends it with outcome expired and no human actor", async () => {
    const repo = repoWithAccepted();
    await endCaretakerGrant(
      { grantPublicToken: "CG-abc123", action: "expire_grant", actorUserId: null },
      deps(repo),
    );

    expect(repo.insertEndGrant).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "expired", actorUserId: null }),
      expect.anything(),
    );
  });

  it("only the titular may revoke", async () => {
    const repo = repoWithAccepted();
    const result = await endCaretakerGrant(
      { grantPublicToken: "CG-abc123", action: "revoke", actorUserId: CARETAKER_ID },
      deps(repo),
    );

    expect(result.ok).toBe(false);
    expect(repo.insertEndGrant).not.toHaveBeenCalled();
  });

  it("only the caretaker may withdraw", async () => {
    const repo = repoWithAccepted();
    const result = await endCaretakerGrant(
      { grantPublicToken: "CG-abc123", action: "withdraw", actorUserId: TITULAR_ID },
      deps(repo),
    );

    expect(result.ok).toBe(false);
    expect(repo.insertEndGrant).not.toHaveBeenCalled();
  });

  it("refuses to end a grant that was never accepted", async () => {
    const repo = repoWithAccepted({
      findGrantByToken: vi.fn().mockResolvedValue(makeGrant({ status: "pending" })),
    });

    const result = await endCaretakerGrant(
      { grantPublicToken: "CG-abc123", action: "revoke", actorUserId: TITULAR_ID },
      deps(repo),
    );

    expect(result.ok).toBe(false);
    expect(repo.insertEndGrant).not.toHaveBeenCalled();
  });

  it("re-reads under the lock and aborts when the grant already ended", async () => {
    const repo = repoWithAccepted({
      findGrantByIdForUpdate: vi.fn().mockResolvedValue(makeGrant({ status: "ended" })),
    });

    const result = await endCaretakerGrant(
      { grantPublicToken: "CG-abc123", action: "revoke", actorUserId: TITULAR_ID },
      deps(repo),
    );

    expect(result.ok).toBe(false);
    expect(repo.insertEndGrant).not.toHaveBeenCalled();
  });

  it("closes the ownership row and writes the event in the SAME transaction", async () => {
    const repo = repoWithAccepted();
    const calls: string[] = [];
    // A plain generic function, not vi.fn(): wrapping a generic in a Mock
    // erases the type parameter and the deps signature stops matching.
    const transaction = async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => {
      calls.push("tx:start");
      const out = await cb({});
      calls.push("tx:end");
      return out;
    };
    repo.insertEndGrant.mockImplementation(async () => {
      calls.push("insertEndGrant");
      return { ended: true };
    });

    await endCaretakerGrant(
      { grantPublicToken: "CG-abc123", action: "revoke", actorUserId: TITULAR_ID },
      { repo, now: () => NOW, transaction },
    );

    expect(calls).toEqual(["tx:start", "insertEndGrant", "tx:end"]);
  });

  it("notifies BOTH parties, and never claims the animal came back", async () => {
    const repo = repoWithAccepted();
    const result = await endCaretakerGrant(
      { grantPublicToken: "CG-abc123", action: "expire_grant", actorUserId: null },
      deps(repo),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byUser = Object.fromEntries(result.notifications.map((n) => [n.userId, n]));
    expect(Object.keys(byUser).sort()).toEqual([CARETAKER_ID, TITULAR_ID].sort());

    // Spec, verbatim intent: the titular is told to coordinate the return, not
    // that the return happened.
    expect(byUser[TITULAR_ID].body).toContain("coordiná la devolución");
    expect(byUser[TITULAR_ID].body).not.toContain("volvió");
    expect(byUser[CARETAKER_ID].body).toContain("Ya no tenés acceso");
    expect(byUser[TITULAR_ID].relatedPetId).toBe(PET.id);

    // THE DEDUPE KEYS MUST DIFFER. Both rows go through ON CONFLICT
    // (dedupe_key) DO NOTHING, so a key that omitted the recipient would let
    // the second insert collapse into the first and ONE OF THE TWO PARTIES
    // WOULD NEVER BE TOLD the arrangement ended. Asserted as exact values, not
    // just "not equal", because the manual and cron paths have to agree on them.
    expect(byUser[TITULAR_ID].dedupeKey).toBe("caretaker:grant_ended:grant-1:titular-1");
    expect(byUser[CARETAKER_ID].dedupeKey).toBe("caretaker:grant_ended:grant-1:caretaker-1");
  });

  it("uses the SAME dedupe key whether the titular revokes or the clock expires it", async () => {
    // A grant ends once. The manual path and the cron sweep are mutually
    // exclusive by the `accepted` row lock, but if both ever produced a payload
    // the titular must read "el cuidado terminó" once, not twice in two
    // wordings — so the key deliberately carries no outcome and no actor.
    const revoked = await endCaretakerGrant(
      { grantPublicToken: "CG-abc123", action: "revoke", actorUserId: TITULAR_ID },
      deps(repoWithAccepted()),
    );
    const expired = await endCaretakerGrant(
      { grantPublicToken: "CG-abc123", action: "expire_grant", actorUserId: null },
      deps(repoWithAccepted()),
    );

    const keyFor = (r: typeof revoked, userId: string) =>
      r.ok === true && r.notifications.find((n) => n.userId === userId)?.dedupeKey;

    expect(keyFor(revoked, TITULAR_ID)).toBe(keyFor(expired, TITULAR_ID));
    expect(keyFor(revoked, CARETAKER_ID)).toBe(keyFor(expired, CARETAKER_ID));
  });

  it("uses revocation copy, not expiry copy, when the titular ends it early", async () => {
    const repo = repoWithAccepted();
    const result = await endCaretakerGrant(
      { grantPublicToken: "CG-abc123", action: "revoke", actorUserId: TITULAR_ID },
      deps(repo),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const caretakerNote = result.notifications.find((n) => n.userId === CARETAKER_ID);
    expect(caretakerNote?.title).toContain("terminó");
    expect(caretakerNote?.notificationType).toBe("caretaker_grant_ended");
  });

  it("returns a failure and no notifications when the transaction throws", async () => {
    const repo = repoWithAccepted({
      insertEndGrant: vi.fn().mockRejectedValue(new Error("boom")),
    });

    const result = await endCaretakerGrant(
      { grantPublicToken: "CG-abc123", action: "revoke", actorUserId: TITULAR_ID },
      deps(repo),
    );

    expect(result.ok).toBe(false);
  });
});
