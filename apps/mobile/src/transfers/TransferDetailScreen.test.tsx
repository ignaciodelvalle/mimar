// `TransferDetailScreen` — the screen where an animal changes hands.
//
// WHAT THESE HAVE TO PROVE, beyond "it renders"
// ---------------------------------------------------------------------------
//   1. EVERY CONTROL COMES FROM `capabilities`, and the three are INDEPENDENT.
//      The combination that matters is an expired proposal: `canAccept` false,
//      `canReject` still true. A screen that reasoned from `status` or from
//      `expired` would take away the only control that can clear the row.
//   2. ACCEPTING TAKES TWO TAPS AND SAYS IT IS IRREVERSIBLE. The web reached
//      this by audit; a phone with a one-tap "Aceptar" would be worse.
//   3. NO COMMAND CARRIES AN IDEMPOTENCY KEY. `accept` appends to the spine, so
//      the reflex is right and the answer is still no — the endpoint does not
//      read the header, and sending one would claim a guarantee nobody made.
//   4. A FAILED COMMAND RE-READS. Without a key, a refusal after a timeout may
//      mean the first attempt landed; the list is the only thing that can say.
//   5. A TOKEN THIS CALLER IS NOT A PARTY TO IS NOT CALLED "NON-EXISTENT".

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

const mockFetch = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

jest.mock("../api/endpoints", () => ({
  fetchMyTransfers: (...args: unknown[]) => mockFetch(...args),
  sendTransferCommand: (...args: unknown[]) => mockSend(...args),
}));

const mockSignOut = jest.fn<(endedAt: string) => Promise<void>>();

jest.mock("../auth/session-store", () => ({
  sessionPort: {},
  signOut: (endedAt: string) => mockSignOut(endedAt),
}));

import type { MyTransferV1, MyTransfersV1 } from "@dim/contract/api";
import { TransferDetailScreen } from "./TransferDetailScreen";

const TOKEN = "PTR-ABCD-2345";

function aTransfer(over: Partial<MyTransferV1> = {}): MyTransferV1 {
  return {
    transferToken: TOKEN,
    status: "pending",
    direction: "incoming",
    pet: { publicToken: "DIM-PAMP-0001", name: "Pampa", species: "dog" },
    counterpartyName: "Vecina",
    toEmail: "yo@example.com",
    reason: "gift",
    note: null,
    rejectionReason: null,
    initiatedAt: "2026-08-20T10:00:00.000Z",
    respondedAt: null,
    expiresAt: "2026-08-27T10:00:00.000Z",
    expired: false,
    capabilities: { canAccept: true, canReject: true, canCancel: false },
    ...over,
  };
}

function hubWith(transfer: MyTransferV1): MyTransfersV1 {
  const incoming = transfer.direction === "incoming";
  return {
    payloadVersion: 1,
    issuedAt: "2026-08-26T00:00:00.000Z",
    staleAfter: "2026-08-26T00:01:00.000Z",
    incoming: {
      pending: incoming && transfer.status === "pending" ? [transfer] : [],
      history: incoming && transfer.status !== "pending" ? [transfer] : [],
    },
    outgoing: incoming ? [] : [transfer],
  };
}

function loads(transfer: MyTransferV1) {
  mockFetch.mockResolvedValue({ outcome: "ok", payload: hubWith(transfer) });
}

const noop = () => {};

beforeEach(() => {
  mockFetch.mockReset();
  mockSend.mockReset();
  mockSignOut.mockReset();
  mockSignOut.mockResolvedValue(undefined);
});

describe("finding the proposal", () => {
  it("does not call a token it cannot find 'non-existent'", async () => {
    // The screen never learned who the addressee is, so "no existe" about a real
    // proposal would be a lie told with confidence. It says what it knows: this
    // is not in YOUR account.
    loads(aTransfer({ transferToken: "PTR-OTHER-0001" }));
    render(<TransferDetailScreen transferToken={TOKEN} onAccepted={noop} />);

    await waitFor(() => expect(screen.getByText(/no sea para vos/)).toBeTruthy());
    expect(screen.queryByText(/no existe/i)).toBeNull();
  });

  it("offers the account switch, not just a Reintentar that cannot help (A4-custodia-11)", async () => {
    // Two addresses, one link, and the wrong session. "Reintentar" re-reads the
    // same hub for the same account, so it is the one control in this app that
    // is guaranteed to produce what it already produced.
    loads(aTransfer({ transferToken: "PTR-OTHER-0001" }));
    render(<TransferDetailScreen transferToken={TOKEN} onAccepted={noop} />);

    await waitFor(() => expect(screen.getByText(/no sea para vos/)).toBeTruthy());
    expect(screen.getByText(/entrá con esa cuenta/)).toBeTruthy();

    fireEvent.press(screen.getByText("Entrar con otra cuenta"));

    // AND IT KEEPS THE DESTINATION. `signOut(pathname)` makes the gate drop
    // `next` for the screen it was pressed on, which is the one screen this
    // sign-out is trying to reach.
    await waitFor(() => expect(mockSignOut).toHaveBeenCalledWith(""));
  });

  it("names the RESOLVED cause too, and does not prescribe a sign-out for it (F9)", async () => {
    // The `missing` arm covers two situations and the screen can distinguish
    // neither — its own comment says so. The copy prescribed the account switch
    // for BOTH, and the commoner one by far is a proposal that was accepted,
    // cancelled or expired: for that person "Cerrá sesión y volvé a entrar con
    // esa cuenta" costs them their session to go looking for something no
    // account can show. The WEB may say it flatly because `relation ===
    // "outsider"` is a fact its reader resolved; this screen has no such fact.
    loads(aTransfer({ transferToken: "PTR-OTHER-0001" }));
    render(<TransferDetailScreen transferToken={TOKEN} onAccepted={noop} />);

    await waitFor(() => expect(screen.getByText(/no sea para vos/)).toBeTruthy());
    expect(screen.getByText(/no hay nada que hacer/)).toBeTruthy();
    // The remedy is CONDITIONAL, and the button names the case it belongs to
    // rather than telling whoever is reading to sign out.
    expect(screen.getByText(/Si en cambio tenés otra cuenta/)).toBeTruthy();
    expect(screen.queryByText("Cerrar sesión")).toBeNull();
  });

  it("shows the failure, not an absence, when the read itself failed", async () => {
    mockFetch.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    render(<TransferDetailScreen transferToken={TOKEN} onAccepted={noop} />);
    await waitFor(() => expect(screen.getByText(/No pudimos conectarnos/)).toBeTruthy());
  });
});

describe("the controls come from capabilities, and the three are independent", () => {
  it("offers accept and reject on an open incoming proposal, never cancel", async () => {
    loads(aTransfer());
    render(<TransferDetailScreen transferToken={TOKEN} onAccepted={noop} />);

    await waitFor(() => expect(screen.getByText("Aceptar la titularidad")).toBeTruthy());
    expect(screen.getByText("Rechazar la propuesta")).toBeTruthy();
    expect(screen.queryByText("Retirar la propuesta")).toBeNull();
  });

  it("keeps REJECT on an expired proposal while taking ACCEPT away", async () => {
    // THE COMBINATION THIS FILE EXISTS FOR. `acceptPetTransfer` checks expiry;
    // `rejectPetTransfer` deliberately does not. A screen that hid both would
    // leave a row nobody can clear.
    loads(
      aTransfer({
        expired: true,
        capabilities: { canAccept: false, canReject: true, canCancel: false },
      }),
    );
    render(<TransferDetailScreen transferToken={TOKEN} onAccepted={noop} />);

    await waitFor(() => expect(screen.getByText("Rechazar la propuesta")).toBeTruthy());
    expect(screen.queryByText("Aceptar la titularidad")).toBeNull();
    expect(screen.getByText("Venció el 27/08/2026")).toBeTruthy();
  });

  it("offers only cancel on a proposal this person SENT", async () => {
    loads(
      aTransfer({
        direction: "outgoing",
        counterpartyName: null,
        toEmail: "vecina@example.com",
        capabilities: { canAccept: false, canReject: false, canCancel: true },
      }),
    );
    render(<TransferDetailScreen transferToken={TOKEN} onAccepted={noop} />);

    await waitFor(() => expect(screen.getByText("Retirar la propuesta")).toBeTruthy());
    expect(screen.queryByText("Aceptar la titularidad")).toBeNull();
    expect(screen.getByText("Transferencia de Pampa")).toBeTruthy();
    expect(screen.getByText("Para: vecina@example.com")).toBeTruthy();
  });
});

describe("withdrawing a proposal this person sent (A4-R-02)", () => {
  function outgoing() {
    return aTransfer({
      direction: "outgoing",
      counterpartyName: "Vecina",
      toEmail: "vecina@example.com",
      capabilities: { canAccept: false, canReject: false, canCancel: true },
    });
  }

  it("asks a second time instead of cancelling on ONE tap", async () => {
    // The thumb lands on it while scrolling to read the deadline and the
    // proposal is gone for good, with the recipient notified. Accept takes two
    // taps on this very screen; so does the web's own cancel.
    loads(outgoing());
    render(<TransferDetailScreen transferToken={TOKEN} onAccepted={noop} />);

    await waitFor(() => expect(screen.getByText("Retirar la propuesta")).toBeTruthy());
    fireEvent.press(screen.getByText("Retirar la propuesta"));

    expect(screen.getByText(/tenés que iniciar otra propuesta/)).toBeTruthy();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sends the cancel on the SECOND tap", async () => {
    loads(outgoing());
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: {
        command: "cancel",
        changed: true,
        transferToken: TOKEN,
        petPublicToken: null,
        recipientNeedsInvite: null,
      },
    });
    render(<TransferDetailScreen transferToken={TOKEN} onAccepted={noop} />);

    await waitFor(() => expect(screen.getByText("Retirar la propuesta")).toBeTruthy());
    fireEvent.press(screen.getByText("Retirar la propuesta"));
    fireEvent.press(screen.getByText("Confirmar cancelación"));

    await waitFor(() =>
      expect(mockSend.mock.calls[0]?.[1]).toEqual({ command: "cancel", transferToken: TOKEN }),
    );
  });

  it("backs out without sending anything", async () => {
    loads(outgoing());
    render(<TransferDetailScreen transferToken={TOKEN} onAccepted={noop} />);

    await waitFor(() => expect(screen.getByText("Retirar la propuesta")).toBeTruthy());
    fireEvent.press(screen.getByText("Retirar la propuesta"));
    fireEvent.press(screen.getByText("Atrás"));

    expect(screen.getByText("Retirar la propuesta")).toBeTruthy();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("offers nothing on a resolved proposal", async () => {
    loads(
      aTransfer({
        status: "rejected",
        rejectionReason: "no puedo",
        capabilities: { canAccept: false, canReject: false, canCancel: false },
      }),
    );
    render(<TransferDetailScreen transferToken={TOKEN} onAccepted={noop} />);

    await waitFor(() => expect(screen.getByText("Rechazada")).toBeTruthy());
    expect(screen.queryByText("Aceptar la titularidad")).toBeNull();
    expect(screen.queryByText("Rechazar la propuesta")).toBeNull();
    expect(screen.queryByText("Retirar la propuesta")).toBeNull();
    expect(screen.getByText("no puedo")).toBeTruthy();
  });
});

describe("accepting", () => {
  it("asks a second time and says it cannot be undone", async () => {
    loads(aTransfer());
    render(<TransferDetailScreen transferToken={TOKEN} onAccepted={noop} />);

    await waitFor(() => expect(screen.getByText("Aceptar la titularidad")).toBeTruthy());
    fireEvent.press(screen.getByText("Aceptar la titularidad"));

    expect(screen.getByText(/no se puede deshacer/)).toBeTruthy();
    // Nothing was sent on the first tap.
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sends the command with NO idempotency key, and lands on the pet", async () => {
    const onAccepted = jest.fn();
    loads(aTransfer());
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: {
        command: "accept",
        changed: true,
        transferToken: TOKEN,
        petPublicToken: "DIM-PAMP-0001",
        recipientNeedsInvite: null,
      },
    });
    render(<TransferDetailScreen transferToken={TOKEN} onAccepted={onAccepted} />);

    await waitFor(() => expect(screen.getByText("Aceptar la titularidad")).toBeTruthy());
    fireEvent.press(screen.getByText("Aceptar la titularidad"));
    fireEvent.press(screen.getByText("Sí, aceptar la titularidad"));

    await waitFor(() => expect(onAccepted).toHaveBeenCalledWith("DIM-PAMP-0001"));
    // TWO arguments: the session port and the command. A third would be a key
    // this endpoint does not read.
    expect(mockSend.mock.calls[0]).toHaveLength(2);
    expect(mockSend.mock.calls[0]?.[1]).toEqual({ command: "accept", transferToken: TOKEN });
  });

  it("backs out without sending anything", async () => {
    loads(aTransfer());
    render(<TransferDetailScreen transferToken={TOKEN} onAccepted={noop} />);

    await waitFor(() => expect(screen.getByText("Aceptar la titularidad")).toBeTruthy());
    fireEvent.press(screen.getByText("Aceptar la titularidad"));
    fireEvent.press(screen.getByText("No, volver"));

    expect(screen.getByText("Aceptar la titularidad")).toBeTruthy();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("RE-READS after a refusal, because the refusal may mean it already landed", async () => {
    loads(aTransfer());
    mockSend.mockResolvedValue({ outcome: "api-error", code: "transfer_already_resolved" });
    render(<TransferDetailScreen transferToken={TOKEN} onAccepted={noop} />);

    await waitFor(() => expect(screen.getByText("Aceptar la titularidad")).toBeTruthy());
    expect(mockFetch).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByText("Aceptar la titularidad"));
    fireEvent.press(screen.getByText("Sí, aceptar la titularidad"));

    await waitFor(() => expect(screen.getByText(/ya fue respondida o cancelada/)).toBeTruthy());
    // The copy says "actualizá", never "volvé a intentar" — and the screen does.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("rejecting", () => {
  it("asks for an optional reason and sends it", async () => {
    loads(aTransfer());
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: {
        command: "reject",
        changed: true,
        transferToken: TOKEN,
        petPublicToken: null,
        recipientNeedsInvite: null,
      },
    });
    render(<TransferDetailScreen transferToken={TOKEN} onAccepted={noop} />);

    await waitFor(() => expect(screen.getByText("Rechazar la propuesta")).toBeTruthy());
    fireEvent.press(screen.getByText("Rechazar la propuesta"));
    fireEvent.changeText(screen.getByLabelText("Motivo del rechazo"), "no puedo cuidarla");
    fireEvent.press(screen.getByText("Confirmar el rechazo"));

    await waitFor(() =>
      expect(mockSend.mock.calls[0]?.[1]).toEqual({
        command: "reject",
        transferToken: TOKEN,
        reason: "no puedo cuidarla",
      }),
    );
  });

  it("sends null rather than an empty string when no reason is given", async () => {
    loads(aTransfer());
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: {
        command: "reject",
        changed: true,
        transferToken: TOKEN,
        petPublicToken: null,
        recipientNeedsInvite: null,
      },
    });
    render(<TransferDetailScreen transferToken={TOKEN} onAccepted={noop} />);

    await waitFor(() => expect(screen.getByText("Rechazar la propuesta")).toBeTruthy());
    fireEvent.press(screen.getByText("Rechazar la propuesta"));
    fireEvent.press(screen.getByText("Confirmar el rechazo"));

    await waitFor(() =>
      expect(mockSend.mock.calls[0]?.[1]).toMatchObject({ command: "reject", reason: null }),
    );
  });
});

describe("what is on screen", () => {
  it("shows the sender and the reason, and NOT the reader's own address (A4-R-04)", async () => {
    // `toEmail` on an INCOMING proposal is the address of the person holding the
    // phone. Printing it under "Email del receptor" beneath "Recibiste a Pampa"
    // is the noise the view-model's own header calls out; the sender's address
    // is not in the payload and cannot be (`profiles` has no email column).
    loads(aTransfer({ note: "se muda a otra provincia" }));
    render(<TransferDetailScreen transferToken={TOKEN} onAccepted={noop} />);

    await waitFor(() => expect(screen.getByText("Recibiste a Pampa")).toBeTruthy());
    expect(screen.getByText("De: Vecina")).toBeTruthy();
    expect(screen.getByText("Regalo")).toBeTruthy();
    expect(screen.getByText("se muda a otra provincia")).toBeTruthy();
    expect(screen.queryByText("Email del receptor")).toBeNull();
    expect(screen.queryByText("yo@example.com")).toBeNull();
  });

  it("still shows the recipient's address on an OUTGOING proposal", async () => {
    // The non-vacuity half: with a display name, `transferCounterpartyLabel`
    // renders "Para: Vecina" and this row is the only place the address the
    // sender typed appears at all.
    loads(
      aTransfer({
        direction: "outgoing",
        counterpartyName: "Vecina",
        toEmail: "vecina@example.com",
        capabilities: { canAccept: false, canReject: false, canCancel: true },
      }),
    );
    render(<TransferDetailScreen transferToken={TOKEN} onAccepted={noop} />);

    await waitFor(() => expect(screen.getByText("Transferencia de Pampa")).toBeTruthy());
    expect(screen.getByText("Email del receptor")).toBeTruthy();
    expect(screen.getByText("vecina@example.com")).toBeTruthy();
  });
});
