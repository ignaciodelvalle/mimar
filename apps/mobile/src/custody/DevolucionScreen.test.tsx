// `DevolucionScreen` — the render tests for the screen that hands an animal back.
//
// WHAT THESE HAVE TO PROVE, beyond "it renders"
// ---------------------------------------------------------------------------
//   1. EVERY CONTROL COMES FROM `capabilities` AND NEVER FROM `state.kind`.
//      The case that matters is `awaiting_org` — a pending proposal that is the
//      CALLER'S OWN — where the web's page draws an "Aceptar" its own writer
//      refuses. Here the state is rendered and the buttons are not.
//   2. THE PAIRING IS ASSERTED IN BOTH DIRECTIONS. A capability true draws its
//      control; a capability false draws none, EVEN WHEN THE STATE LOOKS LIKE
//      IT SHOULD. The second half is what a screen reading `kind` would fail.
//   3. `autoCancelled` IS NOT A SUCCESS ON THE SCREEN EITHER. A 200 that
//      cancelled instead of transferring must not read as "listo".
//   4. THE READ IS RE-RUN AFTER EVERY WRITE, including after a REFUSAL — both
//      409s on this door mean the state moved, and leaving the old buttons up
//      invites the same refusal again.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

const mockFetch = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

jest.mock("../api/endpoints", () => ({
  fetchPetReturn: (...args: unknown[]) => mockFetch(...args),
  sendPetReturnCommand: (...args: unknown[]) => mockSend(...args),
}));

jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import type { PetReturnCapabilitiesV1, PetReturnStateV1, PetReturnV1 } from "@dim/contract/api";

import { DevolucionScreen } from "./DevolucionScreen";

const TOKEN = "DIM-PAMP-0001";

function payload(state: PetReturnStateV1, capabilities: PetReturnCapabilitiesV1): PetReturnV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-08-30T10:00:00.000Z",
    staleAfter: "2026-08-30T10:00:10.000Z",
    publicToken: TOKEN,
    petName: "Pampa",
    state,
    capabilities,
  } as PetReturnV1;
}

const INBOUND: PetReturnStateV1 = {
  kind: "inbound_pending",
  actorName: "Ana",
  proposedAt: "2026-08-20T12:00:00.000Z",
  notes: "La encontré en la plaza",
};

const CAN_ANSWER: PetReturnCapabilitiesV1 = {
  canAccept: true,
  canReject: true,
  canPropose: false,
};
const CAN_PROPOSE: PetReturnCapabilitiesV1 = {
  canAccept: false,
  canReject: false,
  canPropose: true,
};
const NOTHING: PetReturnCapabilitiesV1 = {
  canAccept: false,
  canReject: false,
  canPropose: false,
};

beforeEach(() => {
  mockFetch.mockReset();
  mockSend.mockReset();
  mockFetch.mockResolvedValue({ outcome: "ok", payload: payload(INBOUND, CAN_ANSWER) });
  mockSend.mockResolvedValue({
    outcome: "ok",
    payload: { command: "accept_return", autoCancelled: false, reason: null },
  });
});

describe("DevolucionScreen — the controls are the server's", () => {
  it("draws both answers for an inbound proposal, and the note it carried", async () => {
    render(<DevolucionScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Ana tiene a Pampa y quiere devolvértela.")).toBeOnTheScreen();
    expect(screen.getByText("Ya tengo a Pampa")).toBeOnTheScreen();
    expect(screen.getByText("Rechazar")).toBeOnTheScreen();
    expect(screen.getByText("La encontré en la plaza")).toBeOnTheScreen();
    expect(screen.queryByText("Proponer la devolución")).toBeNull();
  });

  it("draws NOTHING for the caller's own outgoing proposal, and says why", async () => {
    // THE CASE THE WEB'S PAGE GETS WRONG. It renders the acceptance card here
    // and `ownerAcceptReturnUseCase` refuses with "Esta propuesta no está
    // dirigida a vos."
    // MUTATION APPLIED: render the accept card on
    // `view.state.kind === "inbound_pending" || view.state.kind === "awaiting_org"`
    // instead of on `canAccept`. Red.
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ kind: "awaiting_org" }, NOTHING),
    });
    render(<DevolucionScreen publicToken={TOKEN} />);
    expect(
      await screen.findByText(
        "Ya propusiste devolver a Pampa. La organización todavía no respondió.",
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText("Ya tengo a Pampa")).toBeNull();
    expect(screen.queryByText("Rechazar")).toBeNull();
  });

  it("REFUSES to draw the answers when the state looks inbound but the capability is false", async () => {
    // THE OTHER DIRECTION, and the one a screen reading `state.kind` fails. The
    // server can report an inbound proposal whose answer this caller may not
    // give — a race, a clock, a rule that moved between the two reads.
    // MUTATION APPLIED: `{view.state.kind === "inbound_pending" ? ... }` on both
    // answer cards. Red HERE and green on every other case in this file.
    mockFetch.mockResolvedValue({ outcome: "ok", payload: payload(INBOUND, NOTHING) });
    render(<DevolucionScreen publicToken={TOKEN} />);
    expect(await screen.findByText(/quiere devolvértela/)).toBeOnTheScreen();
    expect(screen.queryByText("Ya tengo a Pampa")).toBeNull();
    expect(screen.queryByText("Rechazar")).toBeNull();
  });

  it("draws the proposal form when the server says so, with the four motives", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload(
        { kind: "can_propose", callerRole: "owner", orgDisplayName: "Refugio Sur" },
        CAN_PROPOSE,
      ),
    });
    render(<DevolucionScreen publicToken={TOKEN} />);
    expect(
      await screen.findByText("Podés proponer devolver a Pampa a Refugio Sur."),
    ).toBeOnTheScreen();
    expect(screen.getByText("Limitaciones de espacio o vivienda")).toBeOnTheScreen();
    expect(screen.getByText("Proponer la devolución")).toBeOnTheScreen();
    expect(screen.queryByText("Ya tengo a Pampa")).toBeNull();
  });

  it.each([
    [{ kind: "not_titular", holderRole: "co_owner" } as PetReturnStateV1, /co-dueño/],
    [{ kind: "no_source_org", callerRole: "owner" } as PetReturnStateV1, /adopción/],
    [{ kind: "not_the_adopter" } as PetReturnStateV1, /otra persona/],
  ])("explains %j and offers no control", async (state, sentence) => {
    mockFetch.mockResolvedValue({ outcome: "ok", payload: payload(state, NOTHING) });
    render(<DevolucionScreen publicToken={TOKEN} />);
    expect(await screen.findByText(sentence)).toBeOnTheScreen();
    expect(screen.queryByText("Ya tengo a Pampa")).toBeNull();
    expect(screen.queryByText("Proponer la devolución")).toBeNull();
  });

  it("offers a retry when the read fails outright", async () => {
    mockFetch.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    render(<DevolucionScreen publicToken={TOKEN} />);
    expect(await screen.findByText(/No pudimos conectarnos/)).toBeOnTheScreen();
    expect(screen.getByText("Reintentar")).toBeOnTheScreen();
  });
});

describe("DevolucionScreen — answering", () => {
  it("posts accept_return with no fields and re-reads afterwards", async () => {
    render(<DevolucionScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Ya tengo a Pampa"));
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith({}, TOKEN, { command: "accept_return" });
    // THE ACK IS NOT THE NEW STATE. An accept ends the pending proposal, and the
    // ack says nothing about what is there now.
    // MUTATION APPLIED: drop the `await load()` after a successful write. Red.
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });

  it("says the animal came back only when it did", async () => {
    render(<DevolucionScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Ya tengo a Pampa"));
    expect(await screen.findByText("Listo. Pampa vuelve a figurar a tu nombre.")).toBeOnTheScreen();
  });

  it("renders an AUTO-CANCELLED accept as the server's own reason, not as success", async () => {
    // A 200 in which the animal did NOT come back. The writer cancels instead of
    // transferring when the proposer lost custody or the pet is no longer lost.
    // MUTATION APPLIED: always `setNotice({ tone: "ok", message: "Listo…" })`.
    // Red.
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: {
        command: "accept_return",
        autoCancelled: true,
        reason: "La propuesta se canceló automáticamente porque Pampa ya no figura como perdida.",
      },
    });
    render(<DevolucionScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Ya tengo a Pampa"));
    expect(
      await screen.findByText(
        "La propuesta se canceló automáticamente porque Pampa ya no figura como perdida.",
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText("Listo. Pampa vuelve a figurar a tu nombre.")).toBeNull();
  });

  it("refuses a blank rejection motive LOCALLY and posts nothing", async () => {
    // The button is live — a rejection is always available on an inbound
    // proposal — so this reaches `run` and `buildRejectReturn` is what refuses.
    // MUTATION APPLIED: delete the `if (!built.ok) { …; return; }` guard in
    // `run`. Red — `sendPetReturnCommand` is then called with `undefined`.
    render(<DevolucionScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Rechazar"));
    expect(
      await screen.findByText("Escribí por qué no la aceptás. Quien la tiene va a leerlo."),
    ).toBeOnTheScreen();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("posts the rejection motive once it has one", async () => {
    render(<DevolucionScreen publicToken={TOKEN} />);
    fireEvent.changeText(await screen.findByLabelText(/^Motivo/), "No puedo recibirla ahora");
    fireEvent.press(screen.getByText("Rechazar"));
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith({}, TOKEN, {
      command: "reject_return",
      reason: "No puedo recibirla ahora",
    });
  });

  it("RE-READS after a refusal, not only after a success", async () => {
    // Both 409s on this door mean the state moved under the screen. Leaving the
    // old buttons up would invite the identical refusal on the next tap.
    // MUTATION APPLIED: `return` before the `await load()` in the failure arm.
    // Red.
    mockSend.mockResolvedValue({ outcome: "api-error", code: "return_no_proposal" });
    render(<DevolucionScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Ya tengo a Pampa"));
    expect(
      await screen.findByText(/Ya no hay una propuesta de devolución pendiente/),
    ).toBeOnTheScreen();
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });
});

describe("DevolucionScreen — proposing", () => {
  beforeEach(() => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload(
        { kind: "can_propose", callerRole: "foster", orgDisplayName: "Refugio Sur" },
        CAN_PROPOSE,
      ),
    });
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: { command: "propose_return", autoCancelled: false, reason: null },
    });
  });

  it("refuses to post without a motive chosen", async () => {
    // Nothing is preselected — `Choice`'s own rule, "on a form that hands over
    // an animal, a default is a choice somebody did not make" — so the first tap
    // on the button meets the schema.
    render(<DevolucionScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Proponer la devolución"));
    expect(await screen.findByText("Elegí un motivo para la devolución.")).toBeOnTheScreen();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("posts the chosen motive and a blank comment as null", async () => {
    render(<DevolucionScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Limitaciones de espacio o vivienda"));
    fireEvent.press(screen.getByText("Proponer la devolución"));
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith({}, TOKEN, {
      command: "propose_return",
      reason: "space_constraint",
      notes: null,
    });
  });

  it("carries a comment through when there is one", async () => {
    render(<DevolucionScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Otro motivo"));
    fireEvent.changeText(screen.getByLabelText(/^Comentario/), "  Me mudo al exterior  ");
    fireEvent.press(screen.getByText("Proponer la devolución"));
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith({}, TOKEN, {
      command: "propose_return",
      reason: "other",
      notes: "Me mudo al exterior",
    });
  });
});
