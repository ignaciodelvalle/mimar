// The pure half of Acompañamiento de adopción: what a person reads, and what a
// tap becomes.
//
// WHAT THIS FILE HAS TO PROVE
//   1. THE COPY IS THE WEB'S. The three states' sentences and the two exits'
//      confirmations are `TitularRehomePanel.tsx`'s, and the two empty states
//      are `buscar-hogar/page.tsx`'s — with the one substitution the phone
//      forces (a case CODE where the web has a link).
//   2. A TAP BECOMES THE CONTRACT'S COMMAND, validated locally by the same
//      schema the server runs.
//   3. A REPLAY IS RENDERED AS DONE, in the past perfect — never as a refusal.
//   4. THE ASK HAS NO SUCCESS SENTENCE, because the next state's callout is it.

import { describe, expect, it } from "@jest/globals";

import type { PetRehomeV1 } from "@dim/contract/api";

import {
  ackMessage,
  activeCopy,
  buildRequestSponsorship,
  buildWithdrawRequest,
  buildWithdrawSponsorship,
  cancelExitCopy,
  emptyPickerReason,
  isLookAgainRefusal,
  orgRowCaption,
  pendingCopy,
  rehomeInputCodeMessage,
  withdrawExitCopy,
} from "./rehome-view-model";

const ORG = {
  publicToken: "DIM-ORG-0001",
  displayName: "Refugio Padrino",
  orgType: "shelter",
  locality: "La Plata",
};

function view(over: Partial<PetRehomeV1> = {}): PetRehomeV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-09-10T10:00:00.000Z",
    staleAfter: "2026-09-10T10:00:10.000Z",
    publicToken: "DIM-PAMP-0001",
    petName: "Pampa",
    zone: { province: "Buenos Aires", locality: "La Plata" },
    state: { kind: "none" },
    orgs: [ORG],
    capabilities: { canRequest: true, canWithdrawRequest: false, canWithdrawSponsorship: false },
    ...over,
  };
}

describe("the picker", () => {
  it("captions an org with its kind and the locality that matched, in the web's words", () => {
    expect(orgRowCaption(ORG)).toBe("Refugio · La Plata");
    expect(orgRowCaption({ ...ORG, orgType: "rescue_network", locality: null })).toBe(
      "Red de rescate",
    );
  });

  it("says nothing about emptiness while orgs are listed or something is running", () => {
    expect(emptyPickerReason(view())).toBeNull();
    expect(
      emptyPickerReason(
        view({
          orgs: [],
          state: { kind: "pending", orgDisplayName: "X", requestCasePublicCode: "CAS-1" },
        }),
      ),
    ).toBeNull();
  });

  it("names the missing province as the fix when there is none — the one empty state with a door", () => {
    const reason = emptyPickerReason(view({ orgs: [], zone: { province: null, locality: null } }));
    expect(reason?.kind).toBe("no_province");
    expect(reason?.message).toContain("no tiene provincia registrada");
    expect(reason?.message).toContain("Editá el perfil");
  });

  it("names the zone nobody covers, locality first and province when there is none", () => {
    expect(emptyPickerReason(view({ orgs: [] }))?.message).toContain("verificados en La Plata");
    const provinceOnly = emptyPickerReason(
      view({ orgs: [], zone: { province: "Buenos Aires", locality: null } }),
    );
    expect(provinceOnly?.kind).toBe("nobody_covers");
    expect(provinceOnly?.message).toContain("verificados en Buenos Aires");
  });
});

describe("the two running states read as the web's callouts", () => {
  it("pending: who was asked, that nothing changed, and the request code where the web links", () => {
    const copy = pendingCopy(
      { kind: "pending", orgDisplayName: "Refugio Padrino", requestCasePublicCode: "CAS-0001" },
      "Pampa",
    );
    expect(copy.title).toBe("Pedido enviado a Refugio Padrino");
    expect(copy.body).toContain("Pampa sigue con vos");
    expect(copy.reference).toBe("Solicitud CAS-0001");
  });

  it("active: who accompanies, what that means, and the expediente only when one is open", () => {
    const copy = activeCopy(
      { kind: "active", orgDisplayName: "Refugio Padrino", listingCasePublicCode: "CAS-0002" },
      "Pampa",
    );
    expect(copy.title).toBe("Refugio Padrino acompaña la adopción de Pampa");
    expect(copy.body).toContain("sigue viviendo con vos");
    expect(copy.reference).toBe("Expediente CAS-0002");
    expect(
      activeCopy(
        { kind: "active", orgDisplayName: "Refugio Padrino", listingCasePublicCode: null },
        "Pampa",
      ).reference,
    ).toBeNull();
  });

  it("the two exits confirm with the web's own explanation of what each does", () => {
    const cancel = cancelExitCopy("Refugio Padrino");
    expect(cancel.trigger).toBe("Cancelar el pedido");
    expect(cancel.confirm).toBe("Confirmar la cancelación");
    expect(cancel.explanation).toContain("no se pierde nada");
    const withdraw = withdrawExitCopy("Refugio Padrino", "Pampa");
    expect(withdraw.trigger).toBe("Dar de baja el acompañamiento");
    expect(withdraw.confirm).toBe("Confirmar la baja");
    expect(withdraw.explanation).toContain("deja de tener custodia registral");
    expect(withdraw.explanation).toContain("Las postulaciones que haya quedan cerradas");
  });
});

describe("a tap becomes the contract's command", () => {
  it("asks by the org's PUBLIC token", () => {
    const built = buildRequestSponsorship("DIM-ORG-0001");
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.input).toEqual({
        command: "request_sponsorship",
        orgPublicToken: "DIM-ORG-0001",
      });
    }
  });

  it("refuses a blank org locally, with the field's sentence", () => {
    const built = buildRequestSponsorship("   ");
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.code).toBe("ORG_REQUIRED");
      // The LITERAL, not rehomeInputCodeMessage("ORG_REQUIRED"). That helper is
      // what builds the message under test, so comparing against it would pass
      // even if the sentence were emptied or swapped for the wrong one.
      expect(built.message).toBe("Elegí una organización de la lista.");
    }
  });

  // Pinned against literals, and exhaustively, because this is the only place
  // the copy itself is asserted. Every other test compares a built message to a
  // literal; nothing else would notice a sentence going blank or an es-AR accent
  // being dropped.
  it("every input code has its own es-AR sentence, and null has a fallback", () => {
    expect(rehomeInputCodeMessage("ORG_REQUIRED")).toBe("Elegí una organización de la lista.");
    expect(rehomeInputCodeMessage("COMMAND_REQUIRED")).toBe(
      "La app no pudo armar la acción. Volvé a intentar.",
    );
    expect(rehomeInputCodeMessage(null)).toBe(
      "Revisá los datos: hay un campo que la app no pudo interpretar.",
    );
  });

  it("the two exits carry no fields — the key travels in the header, not the body", () => {
    expect(buildWithdrawRequest()).toEqual({ ok: true, input: { command: "withdraw_request" } });
    expect(buildWithdrawSponsorship()).toEqual({
      ok: true,
      input: { command: "withdraw_sponsorship" },
    });
  });
});

describe("what the screen says after a command landed", () => {
  it("says nothing for the ask — the pending callout IS the notice, as on the web", () => {
    expect(
      ackMessage({
        command: "request_sponsorship",
        requestCasePublicCode: "CAS-0001",
        orgDisplayName: "Refugio Padrino",
      }),
    ).toBeNull();
  });

  it("renders a REPLAY as done, in the past perfect — never as a refusal", () => {
    // MUTATION APPLIED: ignore `replayed` and always say "quedó cancelado".
    // Red — a person whose first tap landed and whose second was recognised
    // would be told the cancel happened just now, twice.
    expect(
      ackMessage({
        command: "withdraw_request",
        requestCasePublicCode: "CAS-0001",
        replayed: false,
      }),
    ).toBe("El pedido quedó cancelado.");
    expect(
      ackMessage({
        command: "withdraw_request",
        requestCasePublicCode: "CAS-0001",
        replayed: true,
      }),
    ).toBe("El pedido ya estaba cancelado.");
    expect(
      ackMessage({
        command: "withdraw_sponsorship",
        listingCasePublicCode: null,
        orgPublicToken: null,
        replayed: true,
      }),
    ).toBe("El acompañamiento ya estaba dado de baja.");
  });

  it("names the two refusals that only say 'look again' — the ask's replay among them", () => {
    expect(isLookAgainRefusal("rehome_already_open")).toBe(true);
    expect(isLookAgainRefusal("rehome_nothing_to_withdraw")).toBe(true);
    // About THIS tap, not about the state: a re-read changes nothing.
    expect(isLookAgainRefusal("rehome_forbidden")).toBe(false);
    expect(isLookAgainRefusal("rehome_org_invalid")).toBe(false);
    expect(isLookAgainRefusal("rehome_not_allowed")).toBe(false);
  });
});
