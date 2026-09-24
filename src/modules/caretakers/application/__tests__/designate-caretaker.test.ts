// Use-case: the titular invites someone to be the pet's temporary caretaker.
//
// Auth (requireTitularAccess) is the ACTION's job — this layer is handed an
// already-authorized petId. What it owns is the concurrency rule the spec
// pins twice: at most one open invitation and at most one active arrangement
// per pet, each with its own es-AR refusal.

import { describe, expect, it, vi } from "vitest";

import { designateCaretaker } from "../designate-caretaker";
import { CARETAKER_ID, PET, TITULAR_ID, makeFakeRepo, makeGrant } from "./_fake-repo";

const NOW = new Date("2026-08-20T12:00:00Z");

function input(overrides: Record<string, unknown> = {}) {
  return {
    petId: PET.id,
    petName: PET.name,
    petPublicToken: PET.publicToken,
    titularUserId: TITULAR_ID,
    inviteeEmail: "ana@example.com",
    startsAt: new Date("2026-08-21T00:00:00Z"),
    endsAt: new Date("2026-09-15T00:00:00Z"),
    note: null as string | null,
    ...overrides,
  };
}

function deps(repo = makeFakeRepo()) {
  return { repo, now: () => NOW };
}

describe("designateCaretaker", () => {
  it("creates a pending grant and returns its token", async () => {
    const repo = makeFakeRepo();
    const result = await designateCaretaker(input(), deps(repo));

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.value.grantPublicToken).toBe("CG-abc123");
    expect(repo.insertGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        petId: PET.id,
        grantedByUserId: TITULAR_ID,
        caretakerEmail: "ana@example.com",
        caretakerUserId: null,
        note: null,
      }),
    );
  });

  it("resolves an existing account for the invitee email", async () => {
    const repo = makeFakeRepo({
      findUserIdByEmail: vi.fn().mockResolvedValue(CARETAKER_ID),
    });

    await designateCaretaker(input(), deps(repo));

    expect(repo.insertGrant).toHaveBeenCalledWith(
      expect.objectContaining({ caretakerUserId: CARETAKER_ID }),
    );
  });

  it("normalises the invitee email to lowercase and trims it", async () => {
    const repo = makeFakeRepo();
    await designateCaretaker(input({ inviteeEmail: "  Ana@Example.COM " }), deps(repo));

    expect(repo.findUserIdByEmail).toHaveBeenCalledWith("ana@example.com");
    expect(repo.insertGrant).toHaveBeenCalledWith(
      expect.objectContaining({ caretakerEmail: "ana@example.com" }),
    );
  });

  it("refuses when the invitee resolves to the titular's own account", async () => {
    const repo = makeFakeRepo({
      findUserIdByEmail: vi.fn().mockResolvedValue(TITULAR_ID),
    });

    const result = await designateCaretaker(input(), deps(repo));

    expect(result).toEqual({
      ok: false,
      error: "No podés designarte a vos mismo/a como cuidador/a.",
    });
    expect(repo.insertGrant).not.toHaveBeenCalled();
  });

  it("refuses a period over the 180-day maximum, with the spec's copy", async () => {
    const repo = makeFakeRepo();
    const result = await designateCaretaker(
      input({
        startsAt: new Date("2026-08-19T00:00:00Z"),
        endsAt: new Date("2027-03-01T00:00:00Z"),
      }),
      deps(repo),
    );

    expect(result).toEqual({ ok: false, error: "El período máximo de cuidado es de 180 días." });
    expect(repo.insertGrant).not.toHaveBeenCalled();
  });

  it("refuses a second designation while one is pending", async () => {
    const repo = makeFakeRepo({
      findOpenGrantsForPet: vi.fn().mockResolvedValue([makeGrant({ status: "pending" })]),
    });

    const result = await designateCaretaker(input(), deps(repo));

    expect(result).toEqual({
      ok: false,
      error: "Ya hay una invitación de cuidado pendiente para esta mascota.",
    });
    expect(repo.insertGrant).not.toHaveBeenCalled();
  });

  it("refuses a second designation while one is accepted, naming the pet", async () => {
    const repo = makeFakeRepo({
      findOpenGrantsForPet: vi.fn().mockResolvedValue([makeGrant({ status: "accepted" })]),
    });

    const result = await designateCaretaker(input(), deps(repo));

    expect(result).toEqual({
      ok: false,
      error: "Pampa ya tiene un cuidador/a temporal activo.",
    });
  });

  it("reports the ACCEPTED conflict first when both somehow exist", async () => {
    // The partial uniques permit one pending AND one accepted simultaneously
    // (different predicates), so this is a reachable state: an invite issued
    // just before the previous caretaker's grant was force-ended. "There is
    // already an active caretaker" is the more useful thing to say.
    const repo = makeFakeRepo({
      findOpenGrantsForPet: vi
        .fn()
        .mockResolvedValue([makeGrant({ status: "pending" }), makeGrant({ status: "accepted" })]),
    });

    const result = await designateCaretaker(input(), deps(repo));

    expect(result.ok === false && result.error).toContain("ya tiene un cuidador/a temporal activo");
  });

  it("notifies an invitee who already has an account, linking the grant page", async () => {
    const repo = makeFakeRepo({
      findUserIdByEmail: vi.fn().mockResolvedValue(CARETAKER_ID),
    });

    const result = await designateCaretaker(input(), deps(repo));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]).toMatchObject({
      userId: CARETAKER_ID,
      notificationType: "caretaker_invitation_received",
      ctaUrl: "/cuidado/CG-abc123",
      relatedPetId: PET.id,
      category: "custody",
      // The VALUE, not merely its presence: a `toBeDefined()` here would pass
      // against a hardcoded constant, which is the exact bug a dedupe key can
      // have — it would swallow every invitation after the first.
      dedupeKey: "caretaker:invitation_received:grant-1:caretaker-1",
    });
  });

  it("keys the invitation on the NEW grant id, so a re-invitation is not deduped away", async () => {
    // The failure this guards: keying on pet+invitee would make the second
    // invitation (after a cancel or an expiry) collapse into the first row and
    // the invitee would never be told. The grant id is what makes them distinct.
    const repo = makeFakeRepo({
      findUserIdByEmail: vi.fn().mockResolvedValue(CARETAKER_ID),
      insertGrant: vi.fn().mockResolvedValue({ id: "grant-2", publicToken: "CG-def456" }),
    });

    const result = await designateCaretaker(input(), deps(repo));

    expect(result.ok === true && result.notifications[0].dedupeKey).toBe(
      "caretaker:invitation_received:grant-2:caretaker-1",
    );
  });

  it("emits no in-app notification when the invitee has no account", async () => {
    // Nobody to notify in-app. The action's email invite is the only channel,
    // and inventing a notification row would need a userId we do not have.
    const result = await designateCaretaker(input(), deps());

    expect(result.ok === true && result.notifications).toEqual([]);
    expect(result.ok === true && result.value.inviteeNeedsAccount).toBe(true);
  });

  it("passes the injected clock through as `now`, never reading the wall clock", async () => {
    const repo = makeFakeRepo();
    await designateCaretaker(input(), deps(repo));

    expect(repo.insertGrant).toHaveBeenCalledWith(expect.objectContaining({ now: NOW }));
  });

  it("trims a blank note to null so the DB never stores whitespace", async () => {
    const repo = makeFakeRepo();
    await designateCaretaker(input({ note: "   " }), deps(repo));

    expect(repo.insertGrant).toHaveBeenCalledWith(expect.objectContaining({ note: null }));
  });
});
