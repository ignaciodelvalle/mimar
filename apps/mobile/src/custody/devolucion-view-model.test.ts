// `devolucion-view-model` — the pure half of DEVOLUCIÓN.
//
// WHAT THIS FILE HAS TO PROVE
// ---------------------------------------------------------------------------
//   1. THE SIX STATES EACH SAY SOMETHING DIFFERENT, and specifically that
//      `awaiting_org` does NOT read like an invitation to answer. That arm is
//      the one the web's page collapses into "somebody wants to give you this
//      animal back", and the sentence is what a person sees before the buttons
//      are (correctly) absent.
//   2. `accept_return`'s TWO OUTCOMES ARE NOT ONE. A 200 with
//      `autoCancelled: true` means the animal did NOT come back, and it must
//      not be rendered in the success tone.
//   3. THE VALIDATION IS THE CONTRACT'S, run locally so a person gets a field
//      sentence instead of a round trip that answers `invalid_request` with no
//      field detail — and the two "reason" fields get DIFFERENT sentences,
//      because one is a text box and the other is a picker.

import { describe, expect, it } from "@jest/globals";

import type { PetReturnStateV1 } from "@dim/contract/api";

import {
  RETURN_REASON_CHOICES,
  acceptedMessage,
  buildAcceptReturn,
  buildProposeReturn,
  buildRejectReturn,
  holderRoleLabel,
  returnStateHeadline,
} from "./devolucion-view-model";

describe("buildRejectReturn / buildProposeReturn — the contract's schema, locally", () => {
  it("accepts a rejection with a motive, trimmed", () => {
    expect(buildRejectReturn("  Ya la tengo  ")).toEqual({
      ok: true,
      input: { command: "reject_return", reason: "Ya la tengo" },
    });
  });

  it("refuses a blank rejection motive with the WRITING sentence", () => {
    // A free-text box, so the message names writing. `RETURN_REASON_REQUIRED`'s
    // sentence names choosing, and the two must not be swapped — "escribí un
    // motivo" over a picker sends somebody looking for a text field.
    // MUTATION APPLIED: return `returnInputCodeMessage("RETURN_REASON_REQUIRED")`
    // for both. Red here and in the propose case below.
    const built = buildRejectReturn("   ");
    expect(built).toEqual({
      ok: false,
      code: "REJECT_REASON_REQUIRED",
      message: "Escribí por qué no la aceptás. Quien la tiene va a leerlo.",
    });
  });

  it("refuses a rejection motive past the cap rather than truncating it", () => {
    expect(buildRejectReturn("x".repeat(501))).toMatchObject({
      ok: false,
      code: "REJECT_REASON_TOO_LONG",
    });
  });

  it("accepts a proposal with one of the four motives and blank notes as null", () => {
    expect(buildProposeReturn("space_constraint", "   ")).toEqual({
      ok: true,
      input: { command: "propose_return", reason: "space_constraint", notes: null },
    });
  });

  it("refuses a motive the web's own select does not offer", () => {
    // `custody_transfer_proposed` accepts more `reason` values than this flow
    // does — they belong to an ORG-initiated proposal — and
    // `ownerProposeReturnToOrgFormAction` narrows to exactly these four with its
    // own set. Mirroring a server narrowing is parity; a phone that could post
    // one of the others would be writing a payload the browser cannot.
    // MUTATION APPLIED: `z.string()` in place of the enum. Red.
    expect(buildProposeReturn("adoption_reversed", "")).toMatchObject({
      ok: false,
      code: "RETURN_REASON_REQUIRED",
      message: "Elegí un motivo para la devolución.",
    });
  });

  it("refuses a blank motive with the CHOOSING sentence", () => {
    expect(buildProposeReturn("", "")).toMatchObject({
      code: "RETURN_REASON_REQUIRED",
      message: "Elegí un motivo para la devolución.",
    });
  });

  it("offers exactly the four motives the contract admits", () => {
    // The LABELS are the web's, transcribed; the VALUES come from the contract.
    // A fifth choice here would be a control whose write the schema refuses.
    // MUTATION APPLIED: add a fifth `{ reason: "adoption_reversed" }` choice.
    // Red — every value is round-tripped through `buildProposeReturn`.
    for (const choice of RETURN_REASON_CHOICES) {
      expect(buildProposeReturn(choice.reason, "")).toMatchObject({ ok: true });
    }
    expect(RETURN_REASON_CHOICES).toHaveLength(4);
  });

  it("builds an accept with no fields at all", () => {
    expect(buildAcceptReturn()).toEqual({ ok: true, input: { command: "accept_return" } });
  });
});

describe("returnStateHeadline — six states, six different sentences", () => {
  const named = (state: PetReturnStateV1) => returnStateHeadline(state, "Pampa");

  it("names the person holding the animal on an inbound proposal", () => {
    expect(
      named({
        kind: "inbound_pending",
        actorName: "Ana",
        proposedAt: "2026-08-20T12:00:00.000Z",
        notes: null,
      }),
    ).toBe("Ana tiene a Pampa y quiere devolvértela.");
  });

  it("does NOT read like an invitation to answer on awaiting_org", () => {
    // THE ARM THE WEB'S PAGE COLLAPSES. It renders the acceptance card here and
    // its own writer refuses. The sentence must say the proposal is the reader's
    // OWN and that it is waiting — not that somebody wants to hand them a pet.
    // MUTATION APPLIED: return the `inbound_pending` sentence for this arm. Red.
    const sentence = named({ kind: "awaiting_org" });
    expect(sentence).toBe("Ya propusiste devolver a Pampa. La organización todavía no respondió.");
    expect(sentence).not.toContain("quiere devolvértela");
  });

  it("names the organisation when it has one, and stays honest when it does not", () => {
    expect(named({ kind: "can_propose", callerRole: "owner", orgDisplayName: "Refugio Sur" })).toBe(
      "Podés proponer devolver a Pampa a Refugio Sur.",
    );
    // MUTATION APPLIED: `orgDisplayName ?? "el refugio"`. Red — "devolver a
    // Pampa a el refugio" is bad grammar AND a name nobody chose; the honest
    // form names the relationship instead.
    expect(named({ kind: "can_propose", callerRole: "foster", orgDisplayName: null })).toBe(
      "Podés proponer devolver a Pampa a la organización de origen.",
    );
  });

  it("names the caller's actual link to the animal on not_titular", () => {
    // The web's own page does this rather than 404ing, for the reason
    // `PetAccessFailureReason` gives about `not-titular`.
    expect(named({ kind: "not_titular", holderRole: "co_owner" })).toContain("co-dueño");
  });

  it("names the role it is talking about 'titular' — the product's own word (CA-5)", () => {
    // It said "dueño legal", a second name for the role every other surface
    // calls `titular` — in the one sentence whose whole job is to tell somebody
    // which role they are not.
    const sentence = named({ kind: "not_titular", holderRole: "co_owner" });
    expect(sentence).toContain("acción del titular");
    expect(sentence).not.toContain("dueño legal");
  });

  it("says something DIFFERENT to a foster and to an owner with no source org", () => {
    // MUTATION APPLIED: one sentence for both roles. Red — a foster is told to
    // contact the shelter of a transit that exists, an owner is told no adoption
    // is on record. The two send a person to different places.
    const foster = named({ kind: "no_source_org", callerRole: "foster" });
    const owner = named({ kind: "no_source_org", callerRole: "owner" });
    expect(foster).not.toBe(owner);
    expect(foster).toContain("tránsito");
    expect(owner).toContain("adopción");
  });

  it("says the adoption names somebody else, without naming them", () => {
    const sentence = named({ kind: "not_the_adopter" });
    expect(sentence).toContain("otra persona");
  });
});

describe("holderRoleLabel — the web's own labels", () => {
  it.each([
    ["shelter_custody", "custodia temporal (tránsito)"],
    ["foster", "tránsito formal"],
    ["co_owner", "co-dueño"],
    ["caretaker", "cuidador"],
  ])("labels %s as %s", (role, label) => {
    expect(holderRoleLabel(role)).toBe(label);
  });

  it("falls back to the raw role rather than to a blank", () => {
    expect(holderRoleLabel("some_new_role")).toBe("some_new_role");
  });
});

describe("acceptedMessage — a 200 that is not always good news", () => {
  it("celebrates only when the animal actually came back", () => {
    expect(acceptedMessage({ autoCancelled: false, reason: null }, "Pampa")).toEqual({
      tone: "ok",
      message: "Listo. Pampa vuelve a figurar a tu nombre.",
    });
  });

  it("renders an auto-cancel in the ERROR tone with the server's own reason", () => {
    // THE CASE THIS FUNCTION EXISTS FOR. `ownerAcceptReturnUseCase` answers
    // `{ ok: true, autoCancelled: true, reason }` when the proposal's
    // preconditions no longer hold — it cancels instead of transferring — and a
    // green "Listo" over that would tell somebody their animal is home.
    // MUTATION APPLIED: `tone: "ok"` for both branches. Red.
    // MUTATION APPLIED: ignore `ack.reason` and use a fixed sentence. Red — the
    // reason is the only thing that says WHICH precondition failed.
    expect(
      acceptedMessage(
        {
          autoCancelled: true,
          reason: "La propuesta se canceló automáticamente porque Pampa ya no figura como perdida.",
        },
        "Pampa",
      ),
    ).toEqual({
      tone: "err",
      message: "La propuesta se canceló automáticamente porque Pampa ya no figura como perdida.",
    });
  });

  it("still refuses the success tone when the server sent no reason", () => {
    // The contract types `reason` as nullable, so a cancellation with no
    // sentence is representable. The fallback says the animal did not come back
    // rather than falling through to "Listo".
    const result = acceptedMessage({ autoCancelled: true, reason: null }, "Pampa");
    expect(result.tone).toBe("err");
    expect(result.message).toContain("no volvió a tu nombre");
  });
});
