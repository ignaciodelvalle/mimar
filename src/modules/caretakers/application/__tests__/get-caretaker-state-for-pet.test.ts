// Read model: "what is this pet's caretaker situation right now?"
//
// The owner cockpit, the caretaker's own list and the public credential all ask
// this. It is a READ, so it lives in the application layer and is imported
// DIRECTLY by the page — never routed through a `pets` use-case, because that
// import is exactly the edge that would invert the module fence (design H).

import { describe, expect, it, vi } from "vitest";

import { getCaretakerStateForPet } from "../get-caretaker-state-for-pet";
import { CARETAKER_ID, makeAcceptedGrant, makeFakeRepo, makeGrant } from "./_fake-repo";

const NOW = new Date("2026-08-25T12:00:00Z");

function deps(repo = makeFakeRepo()) {
  return { repo, now: () => NOW };
}

describe("getCaretakerStateForPet", () => {
  it("reports no arrangement when the pet has no open grant", async () => {
    const state = await getCaretakerStateForPet("pet-1", deps());

    expect(state).toEqual({ active: null, pending: null, recentlyEnded: null });
  });

  it("reports the active caretaker with their display name and end date", async () => {
    const repo = makeFakeRepo({
      findOpenGrantsForPet: vi.fn().mockResolvedValue([makeAcceptedGrant()]),
    });

    const state = await getCaretakerStateForPet("pet-1", deps(repo));

    expect(state.active).toMatchObject({
      grantPublicToken: "CG-abc123",
      caretakerUserId: CARETAKER_ID,
      caretakerName: "Ana Pérez",
      endsAt: new Date("2026-09-15T00:00:00Z"),
      publicContactConsentAt: null,
    });
  });

  it("reports a pending invitation separately from an active one", async () => {
    const repo = makeFakeRepo({
      findOpenGrantsForPet: vi.fn().mockResolvedValue([makeGrant({ status: "pending" })]),
    });

    const state = await getCaretakerStateForPet("pet-1", deps(repo));

    expect(state.active).toBeNull();
    expect(state.pending).toMatchObject({
      grantPublicToken: "CG-abc123",
      caretakerEmail: "ana@example.com",
    });
  });

  it("surfaces both when a pending invite coexists with an active arrangement", async () => {
    const repo = makeFakeRepo({
      findOpenGrantsForPet: vi
        .fn()
        .mockResolvedValue([makeGrant({ status: "pending" }), makeAcceptedGrant()]),
    });

    const state = await getCaretakerStateForPet("pet-1", deps(repo));

    expect(state.active).not.toBeNull();
    expect(state.pending).not.toBeNull();
  });

  it("treats an accepted grant whose period already passed as NOT active", async () => {
    // The cron closes these, but it runs once a day. Between `ends_at` and the
    // next 04:00 the row still says `accepted` — and if this read said "active"
    // the cockpit would keep promising access the RLS layer no longer grants.
    const repo = makeFakeRepo({
      findOpenGrantsForPet: vi
        .fn()
        .mockResolvedValue([makeAcceptedGrant({ endsAt: new Date("2026-08-01T00:00:00Z") })]),
    });

    const state = await getCaretakerStateForPet("pet-1", deps(repo));

    expect(state.active).toBeNull();
  });

  it("carries the caretaker's public-contact consent so the titular's toggle can gate on it", async () => {
    const consentedAt = new Date("2026-08-21T10:00:00Z");
    const repo = makeFakeRepo({
      findOpenGrantsForPet: vi
        .fn()
        .mockResolvedValue([makeAcceptedGrant({ publicContactConsentAt: consentedAt })]),
    });

    const state = await getCaretakerStateForPet("pet-1", deps(repo));

    expect(state.active?.publicContactConsentAt).toEqual(consentedAt);
  });

  it("falls back to a neutral label when the caretaker has no display name", async () => {
    const repo = makeFakeRepo({
      findOpenGrantsForPet: vi.fn().mockResolvedValue([makeAcceptedGrant()]),
      findDisplayName: vi.fn().mockResolvedValue(null),
    });

    const state = await getCaretakerStateForPet("pet-1", deps(repo));

    expect(state.active?.caretakerName).toBe("Tu cuidador/a");
  });
});

// ---------------------------------------------------------------------------
// THE POST-AUTO-END SLOT — the reason the termination design exists.
//
// When `ends_at` passes, the cron ends the grant, closes the ownership row and
// appends `caretaker_ended{outcome:'expired'}`. Access is gone. THE ANIMAL IS
// NOT NECESSARILY BACK. Nothing in the system knows where the dog physically
// is, and the titular's cockpit must not imply otherwise — it must tell them
// the arrangement lapsed and hand them the next move if it did not.
//
// This slot is deliberately NARROW. It surfaces the auto-expiry and nothing
// else, because the other three outcomes are not news to the titular:
// `revoked_by_owner` is their own act, `withdrawn_by_caretaker` and the
// account-deactivation path already send them a notification at the moment it
// happens. A banner for those would repeat, days later, something they were
// already told.
// ---------------------------------------------------------------------------
describe("getCaretakerStateForPet — after an arrangement auto-ended", () => {
  const ENDED_AT = new Date("2026-08-24T03:00:00Z"); // one day before NOW

  function endedGrant(overrides: Record<string, unknown> = {}) {
    return {
      id: "grant-1",
      publicToken: "CG-abc123",
      caretakerUserId: CARETAKER_ID,
      endsAt: new Date("2026-08-23T23:59:59.999-03:00"),
      endedAt: ENDED_AT,
      endedReason: "expired",
      ...overrides,
    };
  }

  it("surfaces the lapsed arrangement so the cockpit can explain the absence", async () => {
    const repo = makeFakeRepo({
      findLastEndedGrantForPet: vi.fn().mockResolvedValue(endedGrant()),
    });

    const state = await getCaretakerStateForPet("pet-1", deps(repo));

    expect(state.recentlyEnded).toMatchObject({
      caretakerName: "Ana Pérez",
      outcome: "expired",
    });
    expect(state.recentlyEnded?.endsAt).toEqual(new Date("2026-08-23T23:59:59.999-03:00"));
  });

  it("stays quiet when the titular ended it themselves", async () => {
    const repo = makeFakeRepo({
      findLastEndedGrantForPet: vi
        .fn()
        .mockResolvedValue(endedGrant({ endedReason: "revoked_by_owner" })),
    });

    expect((await getCaretakerStateForPet("pet-1", deps(repo))).recentlyEnded).toBeNull();
  });

  it("stays quiet when the caretaker withdrew — they were already notified", async () => {
    const repo = makeFakeRepo({
      findLastEndedGrantForPet: vi
        .fn()
        .mockResolvedValue(endedGrant({ endedReason: "withdrawn_by_caretaker" })),
    });

    expect((await getCaretakerStateForPet("pet-1", deps(repo))).recentlyEnded).toBeNull();
  });

  it("stops nagging after the window closes", async () => {
    // A banner that never expires becomes furniture, and furniture is not read.
    const repo = makeFakeRepo({
      findLastEndedGrantForPet: vi
        .fn()
        .mockResolvedValue(endedGrant({ endedAt: new Date("2026-06-01T03:00:00Z") })),
    });

    expect((await getCaretakerStateForPet("pet-1", deps(repo))).recentlyEnded).toBeNull();
  });

  it("yields to a LIVE arrangement — one caretaker story on screen at a time", async () => {
    // A pet whose old grant lapsed and who already has a new caretaker should
    // read as "al cuidado de X", not as an unresolved return plus a new one.
    const repo = makeFakeRepo({
      findOpenGrantsForPet: vi.fn().mockResolvedValue([makeAcceptedGrant()]),
      findLastEndedGrantForPet: vi.fn().mockResolvedValue(endedGrant()),
    });

    const state = await getCaretakerStateForPet("pet-1", deps(repo));

    expect(state.active).not.toBeNull();
    expect(state.recentlyEnded).toBeNull();
  });

  it("does not query the ended grant at all when one is already active", async () => {
    // Cheap read, but it runs on every profile load of every pet.
    const findLastEndedGrantForPet = vi.fn().mockResolvedValue(endedGrant());
    const repo = makeFakeRepo({
      findOpenGrantsForPet: vi.fn().mockResolvedValue([makeAcceptedGrant()]),
      findLastEndedGrantForPet,
    });

    await getCaretakerStateForPet("pet-1", deps(repo));

    expect(findLastEndedGrantForPet).not.toHaveBeenCalled();
  });
});
