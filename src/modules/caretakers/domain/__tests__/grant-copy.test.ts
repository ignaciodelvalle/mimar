// The caretaker copy that carries a PROMISE — pinned by test, not by review.
//
// Three of these sentences are the whole reason the termination design exists,
// so they are asserted verbatim rather than "contains the word terminó":
//
//   1. The scope sentence the invitee reads BEFORE accepting. It is the only
//      place a person is told what they are agreeing to; if it drifts from the
//      deny-list the product is lying at the moment of consent.
//   2. The titular's post-auto-end notice. Expiry ends ACCESS, not POSSESSION.
//      Any wording that implies the animal came home is a lie told to a worried
//      owner, and the reason the whole ending path was built.
//   3. The caretaker's own post-auto-end notice — the pet leaving their list
//      must never be a silent disappearance (PO decision 3, 2026-08-19).

import { describe, expect, it } from "vitest";

import {
  CARETAKER_SCOPE_ALLOWED,
  CARETAKER_SCOPE_DENIED,
  activeCaretakerSummary,
  caretakerAutoEndNotice,
  caretakerScopeSentence,
  ownerAutoEndNotice,
} from "../grant-copy";

// Pinned "now" so the DD/MM formatter never appends a year mid-test-run.
// (formatDateArOmitCurrentYear adds /YYYY only when the year differs.)
const NOW = new Date("2026-09-20T12:00:00Z");
const ENDS_AT = new Date("2026-09-15T15:00:00Z");

describe("caretakerScopeSentence — what the invitee is told BEFORE accepting", () => {
  it("states the allowed actions verbatim", () => {
    expect(CARETAKER_SCOPE_ALLOWED).toBe(
      "Podés cargar eventos médicos, notas y marcar perdido/encontrado.",
    );
  });

  it("states the denied actions verbatim", () => {
    expect(CARETAKER_SCOPE_DENIED).toBe(
      "No podés transferir, publicar en adopción ni cambiar datos de identidad.",
    );
  });

  it("joins both halves — never only the permissions", () => {
    const sentence = caretakerScopeSentence();
    expect(sentence).toContain(CARETAKER_SCOPE_ALLOWED);
    expect(sentence).toContain(CARETAKER_SCOPE_DENIED);
  });
});

describe("activeCaretakerSummary — the titular's cockpit line", () => {
  it("names the caretaker and the end date in DD/MM", () => {
    expect(activeCaretakerSummary({ caretakerName: "Ana", endsAt: ENDS_AT, now: NOW })).toBe(
      "Al cuidado de Ana hasta el 15/09",
    );
  });

  it("appends the year when the arrangement ends in a different year", () => {
    expect(
      activeCaretakerSummary({
        caretakerName: "Ana",
        endsAt: new Date("2027-01-10T15:00:00Z"),
        now: NOW,
      }),
    ).toBe("Al cuidado de Ana hasta el 10/01/2027");
  });
});

describe("ownerAutoEndNotice — THE sentence that must not claim the pet is back", () => {
  it("reads exactly as specified", () => {
    expect(
      ownerAutoEndNotice({
        caretakerName: "Ana",
        petName: "Pampa",
        endedAt: ENDS_AT,
        now: NOW,
      }),
    ).toBe(
      "El cuidado temporal de Ana terminó el 15/09. Si Pampa sigue con Ana, coordiná la devolución o iniciá un reclamo.",
    );
  });

  // NON-VACUITY WITH TEETH. The assertion above pins one string; this one pins
  // the PROPERTY, so a future rewrite cannot satisfy the letter and break the
  // point. "volvió" / "está de vuelta" / "regresó" / "recuperaste" are the
  // spellings a well-meaning editor reaches for; the subject being banned is
  // any claim about the animal's WHEREABOUTS, which the fence below states as
  // "the notice must remain conditional".
  it("never asserts the animal is home — the claim stays conditional", () => {
    const notice = ownerAutoEndNotice({
      caretakerName: "Ana",
      petName: "Pampa",
      endedAt: ENDS_AT,
      now: NOW,
    });
    for (const claim of ["volvió", "de vuelta", "regresó", "recuperaste", "ya está con vos"]) {
      expect(notice.toLowerCase()).not.toContain(claim);
    }
    // The conditional is what makes it honest: it must offer the owner an
    // action for the case where the animal did NOT come back.
    expect(notice).toContain("Si Pampa sigue");
    expect(notice).toContain("coordiná la devolución");
    expect(notice).toContain("iniciá un reclamo");
  });
});

describe("caretakerAutoEndNotice — the caretaker's own end-of-period copy", () => {
  it("reads exactly as specified", () => {
    expect(caretakerAutoEndNotice({ petName: "Pampa", endedAt: ENDS_AT, now: NOW })).toBe(
      "Tu período de cuidado de Pampa terminó el 15/09. Ya no tenés acceso para cargar eventos.",
    );
  });

  it("says the access ended — never that the animal was handed back", () => {
    const notice = caretakerAutoEndNotice({ petName: "Pampa", endedAt: ENDS_AT, now: NOW });
    expect(notice).toContain("Ya no tenés acceso");
    for (const claim of ["devolviste", "entregaste", "la devolución quedó"]) {
      expect(notice.toLowerCase()).not.toContain(claim);
    }
  });
});
