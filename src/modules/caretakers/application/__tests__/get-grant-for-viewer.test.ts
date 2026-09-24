// The read behind `/cuidado/{grantToken}` — the page an invitee opens from an
// email before they hold anything at all.
//
// Two properties matter more than the field list:
//
//   1. IT WRITES NOTHING. The spec is explicit: "no ownership row exists yet"
//      when the invitee is looking at the scope. A read model that quietly
//      created the grant on view would make the accept button decorative and
//      the consent meaningless.
//   2. IT DOES NOT LEAK. The token is unguessable but shareable, and the page
//      shows a pet's name, photo and the titular's display name. Anyone who is
//      neither party gets `relation: "outsider"` and no identifying payload.

import { describe, expect, it } from "vitest";

import { getGrantForViewer } from "../get-grant-for-viewer";
import { CARETAKER_ID, PET, TITULAR_ID, makeFakeRepo, makeGrant } from "./_fake-repo";

const NOW = new Date("2026-08-25T12:00:00Z");
const deps = (repo: ReturnType<typeof makeFakeRepo>) => ({ repo, now: () => NOW });

describe("getGrantForViewer — unknown token", () => {
  it("returns null rather than a shell the page has to interpret", async () => {
    const repo = makeFakeRepo({ findGrantByToken: async () => null });
    expect(
      await getGrantForViewer(
        "CG-nope",
        { userId: "u", email: "u@x", emailConfirmed: true },
        deps(repo),
      ),
    ).toBeNull();
  });
});

describe("getGrantForViewer — the invitee, pending invitation", () => {
  it("resolves the invitee by account id", async () => {
    const repo = makeFakeRepo({
      findGrantByToken: async () => makeGrant({ caretakerUserId: CARETAKER_ID }),
    });
    const view = await getGrantForViewer(
      "CG-abc123",
      { userId: CARETAKER_ID, email: "other@example.com", emailConfirmed: true },
      deps(repo),
    );
    expect(view?.relation).toBe("invitee");
  });

  it("resolves the invitee by EMAIL when the invitation predates their account", async () => {
    // The whole point of inviting a non-user: `caretaker_user_id` is NULL until
    // accept, so an id match is impossible on the first visit.
    const repo = makeFakeRepo({
      findGrantByToken: async () => makeGrant({ caretakerUserId: null }),
    });
    const view = await getGrantForViewer(
      "CG-abc123",
      { userId: "fresh-signup", email: "ANA@example.com", emailConfirmed: true },
      deps(repo),
    );
    expect(view?.relation).toBe("invitee");
  });

  it("shows the pet, the titular and the period", async () => {
    const repo = makeFakeRepo({
      findGrantByToken: async () => makeGrant({ caretakerUserId: CARETAKER_ID, note: "Viaje" }),
    });
    const view = await getGrantForViewer(
      "CG-abc123",
      { userId: CARETAKER_ID, email: "ana@example.com", emailConfirmed: true },
      deps(repo),
    );
    expect(view?.pet).toEqual({
      name: "Pampa",
      publicToken: PET.publicToken,
      photoStoragePath: null,
    });
    expect(view?.titularName).toBe("Ana Pérez");
    expect(view?.endsAt).toEqual(new Date("2026-09-15T00:00:00Z"));
    expect(view?.note).toBe("Viaje");
  });

  it("states BOTH halves of the scope before there is anything to accept", async () => {
    const repo = makeFakeRepo({
      findGrantByToken: async () => makeGrant({ caretakerUserId: CARETAKER_ID }),
    });
    const view = await getGrantForViewer(
      "CG-abc123",
      { userId: CARETAKER_ID, email: "ana@example.com", emailConfirmed: true },
      deps(repo),
    );
    expect(view?.scopeSentence).toContain("Podés cargar eventos médicos");
    expect(view?.scopeSentence).toContain("No podés transferir");
  });

  it("offers the response and creates NOTHING", async () => {
    const repo = makeFakeRepo({
      findGrantByToken: async () => makeGrant({ caretakerUserId: CARETAKER_ID }),
    });
    const view = await getGrantForViewer(
      "CG-abc123",
      { userId: CARETAKER_ID, email: "ana@example.com", emailConfirmed: true },
      deps(repo),
    );
    expect(view?.canRespond).toBe(true);
    // The spec scenario, asserted as an absence: viewing is not accepting.
    expect(repo.insertAcceptGrant).not.toHaveBeenCalled();
    expect(repo.insertGrant).not.toHaveBeenCalled();
    expect(repo.updateGrantStatus).not.toHaveBeenCalled();
  });
});

describe("getGrantForViewer — the titular", () => {
  it("is recognised, and is never offered the invitee's response", async () => {
    const repo = makeFakeRepo({
      findGrantByToken: async () => makeGrant({ caretakerUserId: CARETAKER_ID }),
    });
    const view = await getGrantForViewer(
      "CG-abc123",
      { userId: TITULAR_ID, email: "titular@example.com", emailConfirmed: true },
      deps(repo),
    );
    expect(view?.relation).toBe("titular");
    expect(view?.canRespond).toBe(false);
  });
});

describe("getGrantForViewer — an outsider holding the link", () => {
  it("gets no pet name, no titular name and no response", async () => {
    const repo = makeFakeRepo({
      findGrantByToken: async () => makeGrant({ caretakerUserId: CARETAKER_ID }),
    });
    const view = await getGrantForViewer(
      "CG-abc123",
      { userId: "stranger", email: "stranger@example.com", emailConfirmed: true },
      deps(repo),
    );
    expect(view?.relation).toBe("outsider");
    expect(view?.canRespond).toBe(false);
    expect(view?.pet).toBeNull();
    expect(view?.titularName).toBeNull();
  });
});

describe("getGrantForViewer — the invited address, never proved", () => {
  // A09-1, and the ONE case every other viewer in this file — all of them
  // `emailConfirmed: true` until this one — cannot see. Until 2026-09-03
  // `viewer.emailConfirmed &&` had no test in either direction, so deleting it
  // from `resolveRelation` broke nothing visible.
  //
  // The e-mail arm of `resolveRelation` is an ADDRESSEE proof and an
  // unconfirmed address proves nothing: anybody who KNOWS an invited address can
  // register it, and without this term the page would render "Aceptar el
  // cuidado" over an accept use-case that answers "confirmá tu correo".
  //
  // NON-VACUITY, stated because it is the whole value of this case: delete
  // `viewer.emailConfirmed &&` from get-grant-for-viewer.ts's `resolveRelation`
  // and this test goes red — the viewer resolves to `invitee` and every
  // assertion below flips. Its twin at "resolves the invitee by EMAIL" is the
  // control: same row, same address, confirmed, and it still resolves.
  it("folds an UNCONFIRMED invitee into the outsider shape, payload and all", async () => {
    const repo = makeFakeRepo({
      findGrantByToken: async () => makeGrant({ caretakerUserId: null }),
    });
    const view = await getGrantForViewer(
      "CG-abc123",
      { userId: "fresh-signup", email: "ana@example.com", emailConfirmed: false },
      deps(repo),
    );
    expect(view?.relation).toBe("outsider");
    expect(view?.canRespond).toBe(false);
    // The outsider shape is not cosmetic: it is what keeps the pet's name and
    // the titular's from reaching an account that only claimed the address.
    expect(view?.pet).toBeNull();
    expect(view?.titularName).toBeNull();
  });
});

describe("getGrantForViewer — a resolved invitation", () => {
  it("does not offer a second response on an accepted grant", async () => {
    const repo = makeFakeRepo({
      findGrantByToken: async () =>
        makeGrant({ status: "accepted", caretakerUserId: CARETAKER_ID, ownershipId: "own-1" }),
    });
    const view = await getGrantForViewer(
      "CG-abc123",
      { userId: CARETAKER_ID, email: "ana@example.com", emailConfirmed: true },
      deps(repo),
    );
    expect(view?.status).toBe("accepted");
    expect(view?.canRespond).toBe(false);
    expect(view?.endedNotice).toBeNull();
  });

  it("an ENDED grant tells the caretaker their access is gone — never a blank page", async () => {
    const repo = makeFakeRepo({
      findGrantByToken: async () =>
        makeGrant({
          status: "ended",
          caretakerUserId: CARETAKER_ID,
          ownershipId: "own-1",
          // The instant the designation action actually stores: the LAST
          // moment of the Argentine 15th (parseArDateEndOfDay). A bare
          // midnight-UTC value would read back as "14/09" in every AR-pinned
          // formatter — the off-by-one this fixture is pinned against.
          endsAt: new Date("2026-09-15T23:59:59.999-03:00"),
        }),
    });
    const view = await getGrantForViewer(
      "CG-abc123",
      { userId: CARETAKER_ID, email: "ana@example.com", emailConfirmed: true },
      { repo, now: () => new Date("2026-09-20T12:00:00Z") },
    );
    expect(view?.endedNotice).toBe(
      "Tu período de cuidado de Pampa terminó el 15/09. Ya no tenés acceso para cargar eventos.",
    );
  });

  it("an EXPIRED invitation says so, and is not treated as an ended arrangement", async () => {
    // An unanswered invitation never became an arrangement — telling the
    // invitee "tu período de cuidado terminó" would describe access they never
    // had. Same distinction the state machine draws (no caretaker_ended event).
    const repo = makeFakeRepo({
      findGrantByToken: async () => makeGrant({ status: "expired", caretakerUserId: CARETAKER_ID }),
    });
    const view = await getGrantForViewer(
      "CG-abc123",
      { userId: CARETAKER_ID, email: "ana@example.com", emailConfirmed: true },
      deps(repo),
    );
    expect(view?.status).toBe("expired");
    expect(view?.canRespond).toBe(false);
    expect(view?.endedNotice).toBeNull();
  });
});
