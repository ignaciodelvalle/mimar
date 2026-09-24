// `caretakers-view-model` — the words, and the wire shapes.
//
// WHAT THESE HAVE TO PROVE, beyond "it formats"
// ---------------------------------------------------------------------------
//   1. NOTHING RECOMPUTES `expired`. The period label reads the server's flag,
//      and the case that matters is `accepted` + `expired` at once — the daily
//      sweep has not reached the row and the database has already stopped
//      honouring it.
//   2. THE CONSENT FLAG TRAVELS ONLY WHEN IT IS `true`. Absence is what the
//      contract reads as "not consented", and sending `false` would say the same
//      thing in a way a reader has to go and check.
//   3. AN IMPOSSIBLE DAY IS REFUSED LOCALLY, before the network. `2026-02-31`
//      would otherwise reach a server whose boundary parser rolls it over to the
//      3rd of March.
//   4. THE INCOMING SIDE NEVER PRINTS AN ADDRESS. The only address on a row is
//      the invitee's own, and showing a person their own e-mail as "Para: …" is
//      noise at best.
//   5. `grantForPet` PREFERS THE LIVE ARRANGEMENT. "Quién está cuidando a este
//      animal" is the question the cockpit answers first.

import { describe, expect, it } from "@jest/globals";

import type { MyCaretakerGrantV1, MyCaretakerGrantsV1 } from "@dim/contract/api";

import {
  buildAcceptCaretakerGrant,
  buildDesignateCaretaker,
  buildRejectCaretakerGrant,
  buildRevokeCaretakerGrant,
  caretakerCounterpartyLabel,
  caretakerHeadline,
  caretakerPeriodLabel,
  caretakerStatusLabel,
  findCaretakerGrant,
  grantForPet,
  todayInAr,
} from "./caretakers-view-model";

const TOKEN = "CG-0123456789abcdef0123456789abcdef";

function aGrant(over: Partial<MyCaretakerGrantV1> = {}): MyCaretakerGrantV1 {
  return {
    grantToken: TOKEN,
    status: "pending",
    direction: "incoming",
    pet: { publicToken: "DIM-PAMP-0001", name: "Pampa", species: "dog" },
    counterpartyName: "Vecina",
    caretakerEmail: "yo@example.com",
    startsAt: "2026-09-01T03:00:00.000Z",
    endsAt: "2026-09-16T02:59:59.999Z",
    note: null,
    expired: false,
    scopeSentence: "Podés cargar eventos médicos, notas y marcar perdido/encontrado.",
    capabilities: { canAccept: true, canReject: true, canCancel: false, canRevoke: false },
    ...over,
  };
}

function hub(over: Partial<MyCaretakerGrantsV1> = {}): MyCaretakerGrantsV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-08-26T00:00:00.000Z",
    staleAfter: "2026-08-26T00:01:00.000Z",
    incoming: [],
    outgoing: [],
    ...over,
  };
}

describe("the period label", () => {
  it("prints both Argentine days", () => {
    // The boundary instants are 00:00:00-03:00 and 23:59:59.999-03:00, so a
    // formatter that is not AR-pinned prints the 16th for a period that ends on
    // the 15th.
    expect(caretakerPeriodLabel(aGrant())).toBe("Del 01/09/2026 al 15/09/2026");
  });

  it("says the period is over when the SERVER says so, whatever the status", () => {
    // `accepted` + `expired` is a real state: the daily sweep has not reached the
    // row and `has_titular_write_access` already stopped honouring it. A label
    // derived from `status` would call that arrangement live.
    const label = caretakerPeriodLabel(aGrant({ status: "accepted", expired: true }));
    expect(label).toContain("el período ya terminó");
  });
});

describe("the two open states", () => {
  it("calls an accepted grant ACTIVE, not 'aceptado'", () => {
    // The status says how the row got here; what a person needs to read is
    // whether somebody is looking after the animal right now.
    expect(caretakerStatusLabel("accepted")).toBe("Activo");
    expect(caretakerStatusLabel("pending")).toBe("Pendiente");
  });
});

describe("the counterparty line", () => {
  it("never prints an address on an INCOMING row", () => {
    // The only address on the row is the invitee's own.
    expect(caretakerCounterpartyLabel(aGrant())).toBe("De: Vecina");
    expect(caretakerCounterpartyLabel(aGrant({ counterpartyName: null }))).toBeNull();
  });

  it("falls back to the address on an OUTGOING row, which is the one they typed", () => {
    const sent = aGrant({ direction: "outgoing", counterpartyName: null });
    expect(caretakerCounterpartyLabel(sent)).toBe("Para: yo@example.com");
    expect(caretakerCounterpartyLabel({ ...sent, counterpartyName: "Ana" })).toBe("Para: Ana");
  });
});

describe("the headline", () => {
  it("distinguishes being asked from already caring", () => {
    expect(caretakerHeadline(aGrant())).toBe("Te proponen cuidar a Pampa");
    expect(caretakerHeadline(aGrant({ status: "accepted" }))).toBe("Estás cuidando a Pampa");
    expect(caretakerHeadline(aGrant({ direction: "outgoing" }))).toBe("Cuidado de Pampa");
  });
});

describe("finding a row", () => {
  it("searches both sides, because a person can be on either", () => {
    const mine = aGrant({ direction: "outgoing", grantToken: "CG-mine" });
    const payload = hub({ incoming: [aGrant()], outgoing: [mine] });
    expect(findCaretakerGrant(payload, TOKEN)?.direction).toBe("incoming");
    expect(findCaretakerGrant(payload, "CG-mine")?.direction).toBe("outgoing");
    expect(findCaretakerGrant(payload, "CG-nope")).toBeNull();
  });

  it("prefers the LIVE arrangement over a pending invitation on the same pet", () => {
    // Both can exist for a moment — the two partial unique indexes have different
    // predicates — and "quién está cuidando a este animal" is the first question.
    const pending = aGrant({ direction: "outgoing", grantToken: "CG-pending" });
    const active = aGrant({
      direction: "outgoing",
      grantToken: "CG-active",
      status: "accepted",
    });
    expect(grantForPet(hub({ outgoing: [pending, active] }), "DIM-PAMP-0001")?.grantToken).toBe(
      "CG-active",
    );
  });

  it("never returns somebody else's grant for this pet", () => {
    // `incoming` rows are invitations addressed to the caller; the cockpit is
    // about what THEY granted. A row that leaked across would offer the titular's
    // controls over an arrangement they do not own.
    expect(grantForPet(hub({ incoming: [aGrant()] }), "DIM-PAMP-0001")).toBeNull();
  });
});

describe("the command builders", () => {
  const today = todayInAr(new Date("2026-08-26T15:00:00Z"));

  it("builds a designation from the form's four fields", () => {
    const built = buildDesignateCaretaker({
      petPublicToken: "DIM-PAMP-0001",
      inviteeEmail: "  Vecina@Example.com ",
      startsAt: today,
      endsAt: "2026-09-15",
      note: "  ",
    });
    expect(built.ok).toBe(true);
    expect(built.ok && built.input).toMatchObject({
      command: "designate",
      inviteeEmail: "vecina@example.com",
      note: null,
    });
  });

  it("refuses a day that does not exist BEFORE the network", () => {
    // `2026-02-31` looks fine and the server's own boundary parser rolls it over
    // to the 3rd of March. The contract's `isRealArDay` is what stops it, and a
    // local refusal is a field sentence instead of a round trip.
    const built = buildDesignateCaretaker({
      petPublicToken: "DIM-PAMP-0001",
      inviteeEmail: "vecina@example.com",
      startsAt: today,
      endsAt: "2026-02-31",
      note: "",
    });
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.code).toBe("DATE_INVALID");
    expect(built.ok === false && built.message).toContain("días reales");
  });

  it("refuses a malformed address with a field sentence", () => {
    const built = buildDesignateCaretaker({
      petPublicToken: "DIM-PAMP-0001",
      inviteeEmail: "vecina",
      startsAt: today,
      endsAt: "2026-09-15",
      note: "",
    });
    expect(built.ok === false && built.code).toBe("EMAIL_INVALID");
  });

  it("sends the consent flag ONLY when it is true", () => {
    // Absence is what the contract reads as "not consented". Sending `false`
    // explicitly would say the same thing in a way a reader has to check.
    const withConsent = buildAcceptCaretakerGrant(TOKEN, true);
    expect(withConsent.ok && withConsent.input).toEqual({
      command: "accept",
      grantToken: TOKEN,
      publicContactConsent: true,
    });

    const without = buildAcceptCaretakerGrant(TOKEN, false);
    expect(without.ok && without.input).toEqual({ command: "accept", grantToken: TOKEN });
  });

  it("carries the pet token on the titular's commands and on neither of the invitee's", () => {
    // The asymmetry IS the security shape: the titular's three are guarded
    // against the ANIMAL, the invitee's two against the grant ROW.
    const revoke = buildRevokeCaretakerGrant("DIM-PAMP-0001", TOKEN);
    expect(revoke.ok && revoke.input).toEqual({
      command: "revoke",
      petPublicToken: "DIM-PAMP-0001",
      grantToken: TOKEN,
    });

    const reject = buildRejectCaretakerGrant(TOKEN);
    expect(reject.ok && reject.input).toEqual({ command: "reject", grantToken: TOKEN });
  });
});

describe("today, in Argentine time", () => {
  it("does not roll over at UTC midnight", () => {
    // A phone that travels with its owner would otherwise offer "yesterday" from
    // a plane over the Atlantic, and the server would refuse a day nobody chose.
    expect(todayInAr(new Date("2026-08-26T01:30:00Z"))).toBe("2026-08-25");
    expect(todayInAr(new Date("2026-08-26T03:00:00Z"))).toBe("2026-08-26");
  });
});
