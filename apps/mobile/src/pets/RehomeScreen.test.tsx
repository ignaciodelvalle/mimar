// `RehomeScreen` — the render tests for the screen that closes the rehome
// half of `check-owner-surface-parity.ts`'s list.
//
// WHAT THESE HAVE TO PROVE, beyond "it renders"
// ---------------------------------------------------------------------------
//   1. A SCREEN ACTUALLY CALLS THE DOOR — the ask posts `request_sponsorship`
//      with the org's public token and NO key; each exit posts its command
//      WITH a key, and the SAME key on a retry of the same act.
//   2. THE LEVERS COME FROM `capabilities`, never from `state.kind`.
//   3. THE EXITS CONFIRM BEFORE THEY FIRE; the ask does not.
//   4. A REPLAY IS RENDERED AS DONE, and the screen re-reads after every write.
//   5. THE EMPTY STATE WITH A DOOR OPENS IT (no province → editar).
//   6. A RE-READ THAT FAILS KEEPS THE SCREEN — the ack, the callout, the lever —
//      under a stale banner with the read on offer; only the FIRST read blanks.
//   7. THE ASK'S REPLAY (`rehome_already_open`, since the ask carries no key)
//      re-reads and lands on the pending callout, not on a red sentence; an
//      ordinary refusal stays a refusal and does not re-read.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

import type { PetRehomeV1 } from "@dim/contract/api";

const mockPush = jest.fn();
const mockFetch = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
}));

jest.mock("../api/endpoints", () => ({
  fetchPetRehome: (...args: unknown[]) => mockFetch(...args),
  sendRehomeCommand: (...args: unknown[]) => mockSend(...args),
}));

jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

// `expo-crypto` has no native module under jest; the attempt session is what
// is under test, not the UUID. Two distinct keys, so "the same key on a retry"
// is an assertion about REUSE and not about a generator that always answers
// one value.
const mockKeys = [
  "aaaaaaaa-1111-4222-8333-444444444444",
  "bbbbbbbb-1111-4222-8333-444444444444",
] as const;
let mockKeyIndex = 0;
jest.mock("./idempotency", () => ({
  createAttemptSession: () => {
    let current: string | null = null;
    return {
      key: () => {
        // The modulo cannot miss; the fallback only satisfies
        // `noUncheckedIndexedAccess`, which cannot see that.
        if (current === null) current = mockKeys[mockKeyIndex++ % mockKeys.length] ?? mockKeys[0];
        return current;
      },
      restart: () => {
        current = null;
      },
    };
  },
}));

import { RehomeScreen } from "./RehomeScreen";

const TOKEN = "DIM-PAMP-0001";
const ORG = {
  publicToken: "DIM-ORG-0001",
  displayName: "Refugio Padrino",
  orgType: "shelter",
  locality: "La Plata",
};

function payload(over: Partial<PetRehomeV1> = {}): PetRehomeV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-09-10T10:00:00.000Z",
    staleAfter: "2026-09-10T10:00:10.000Z",
    publicToken: TOKEN,
    petName: "Pampa",
    zone: { province: "Buenos Aires", locality: "La Plata" },
    state: { kind: "none" },
    orgs: [ORG],
    capabilities: { canRequest: true, canWithdrawRequest: false, canWithdrawSponsorship: false },
    ...over,
  };
}

const PENDING = payload({
  state: { kind: "pending", orgDisplayName: "Refugio Padrino", requestCasePublicCode: "CAS-0001" },
  capabilities: { canRequest: false, canWithdrawRequest: true, canWithdrawSponsorship: false },
});

const ACTIVE = payload({
  state: { kind: "active", orgDisplayName: "Refugio Padrino", listingCasePublicCode: "CAS-0002" },
  capabilities: { canRequest: false, canWithdrawRequest: false, canWithdrawSponsorship: true },
});

beforeEach(() => {
  mockKeyIndex = 0;
  mockPush.mockReset();
  mockFetch.mockReset();
  mockSend.mockReset();
  mockFetch.mockResolvedValue({ outcome: "ok", payload: payload() });
  mockSend.mockResolvedValue({
    outcome: "ok",
    payload: { command: "withdraw_request", requestCasePublicCode: "CAS-0001", replayed: false },
  });
});

describe("RehomeScreen — the ask", () => {
  it("posts request_sponsorship with the org's PUBLIC token and no key, without confirming", async () => {
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: {
        command: "request_sponsorship",
        requestCasePublicCode: "CAS-0001",
        orgDisplayName: "Refugio Padrino",
      },
    });
    render(<RehomeScreen publicToken={TOKEN} />);
    await screen.findByText("Refugio Padrino");
    fireEvent.press(screen.getByText("Pedir acompañamiento"));
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith(
      {},
      TOKEN,
      { command: "request_sponsorship", orgPublicToken: "DIM-ORG-0001" },
      null,
    );
    // The next state is the server's: re-read, not patched.
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });

  // Withholding the ask must SAY SO. The first version of this test asserted
  // only that the button was gone, which locked in a dead end: a card headed
  // "Organizaciones", the shelters listed, and no button, no footnote and no
  // sentence anywhere. Asserting an absence is how a silent screen passes.
  it("says why when the server withholds the ask, instead of listing orgs with no button", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        capabilities: {
          canRequest: false,
          canWithdrawRequest: false,
          canWithdrawSponsorship: false,
        },
      }),
    });
    render(<RehomeScreen publicToken={TOKEN} />);
    await screen.findByText(/Ahora no se puede pedir acompañamiento para Pampa/);
    // The two causes are named, because the payload does not say which one.
    expect(screen.getByText(/reporte de extravío abierto/)).toBeTruthy();
    expect(screen.getByText(/fallecimiento registrado/)).toBeTruthy();
    expect(screen.queryByText("Pedir acompañamiento")).toBeNull();
    // And no unusable list behind it.
    expect(screen.queryByText("Refugio Padrino")).toBeNull();
  });

  it("opens editar from the no-province empty state", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ orgs: [], zone: { province: null, locality: null } }),
    });
    render(<RehomeScreen publicToken={TOKEN} />);
    await screen.findByText(/no tiene provincia registrada/);
    fireEvent.press(screen.getByText("Editar mascota"));
    expect(mockPush).toHaveBeenCalledWith(`/mascotas/${TOKEN}/editar`);
  });

  it("renders the server's refusal as its sentence, not as a form", async () => {
    mockFetch.mockResolvedValue({ outcome: "api-error", code: "rehome_forbidden" });
    render(<RehomeScreen publicToken={TOKEN} />);
    expect(await screen.findByText(/Solo el titular de la mascota/)).toBeOnTheScreen();
    expect(screen.queryByText("Pedir acompañamiento")).toBeNull();
  });

  it("re-reads on the ask's replay and lands on the pending callout, not on a refusal", async () => {
    // The ask carries no key: a second tap, or a retry after a lost response,
    // answers `rehome_already_open`. The first attempt LANDED — the re-read
    // says so — and the pending callout is the ask's success notice.
    mockFetch.mockResolvedValueOnce({ outcome: "ok", payload: payload() });
    mockFetch.mockResolvedValueOnce({ outcome: "ok", payload: PENDING });
    mockSend.mockResolvedValue({ outcome: "api-error", code: "rehome_already_open" });
    render(<RehomeScreen publicToken={TOKEN} />);
    await screen.findByText("Refugio Padrino");
    fireEvent.press(screen.getByText("Pedir acompañamiento"));
    expect(await screen.findByText("Pedido enviado a Refugio Padrino")).toBeOnTheScreen();
    expect(screen.queryByText(/Ya hay un pedido/)).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps the look-again sentence when the re-read it triggers does not land", async () => {
    mockFetch.mockResolvedValueOnce({ outcome: "ok", payload: payload() });
    mockFetch.mockResolvedValueOnce({ outcome: "unreachable", detail: "offline" });
    mockSend.mockResolvedValue({ outcome: "api-error", code: "rehome_already_open" });
    render(<RehomeScreen publicToken={TOKEN} />);
    await screen.findByText("Refugio Padrino");
    fireEvent.press(screen.getByText("Pedir acompañamiento"));
    expect(await screen.findByText(/Ya hay un pedido/)).toBeOnTheScreen();
    // The sentence says "actualizá la pantalla", and the banner is where that
    // now happens — over the picker, which is still on screen.
    expect(screen.getByText("No pudimos actualizar")).toBeOnTheScreen();
    expect(screen.getByText("Refugio Padrino")).toBeOnTheScreen();
  });

  it("leaves an ordinary refusal as a refusal, and does not re-read for it", async () => {
    mockSend.mockResolvedValue({ outcome: "api-error", code: "rehome_org_invalid" });
    render(<RehomeScreen publicToken={TOKEN} />);
    await screen.findByText("Refugio Padrino");
    fireEvent.press(screen.getByText("Pedir acompañamiento"));
    expect(await screen.findByText(/Elegí otra de la lista/)).toBeOnTheScreen();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Pedir acompañamiento")).toBeOnTheScreen();
  });
});

describe("RehomeScreen — a read that fails after the first", () => {
  it("keeps the landed exit, the last state and its lever under a banner — never a blank", async () => {
    mockFetch.mockResolvedValueOnce({ outcome: "ok", payload: PENDING });
    // The re-read behind the landed cancel dies; the banner's retry lands.
    mockFetch.mockResolvedValueOnce({ outcome: "unreachable", detail: "offline" });
    mockFetch.mockResolvedValueOnce({ outcome: "ok", payload: payload() });
    render(<RehomeScreen publicToken={TOKEN} />);
    await screen.findByText("Pedido enviado a Refugio Padrino");

    fireEvent.press(screen.getByText("Cancelar el pedido"));
    fireEvent.press(await screen.findByText("Confirmar la cancelación"));
    expect(await screen.findByText("El pedido quedó cancelado.")).toBeOnTheScreen();
    expect(await screen.findByText("No pudimos actualizar")).toBeOnTheScreen();

    // MUTATION APPLIED: blank the screen on ANY failed read. Red — the ack,
    // the callout and the lever are gone, and "Reintentar" is all that is
    // left: a person whose cancel landed is told it did not, on a screen that
    // can no longer show them otherwise.
    expect(screen.getByText("El pedido quedó cancelado.")).toBeOnTheScreen();
    expect(screen.getByText("Pedido enviado a Refugio Padrino")).toBeOnTheScreen();
    expect(screen.getByText("Cancelar el pedido")).toBeOnTheScreen();
    expect(screen.queryByText("Reintentar")).toBeNull();

    fireEvent.press(screen.getByText("Volver a intentar"));
    // The retry lands on the server's next state — the picker — and the
    // banner goes with it.
    await screen.findByText("Pedir acompañamiento");
    expect(screen.queryByText("No pudimos actualizar")).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("empties the screen on a REFUSAL, which is not a hiccup — access is what changed", async () => {
    mockFetch.mockResolvedValueOnce({ outcome: "ok", payload: PENDING });
    mockFetch.mockResolvedValueOnce({ outcome: "api-error", code: "rehome_forbidden" });
    render(<RehomeScreen publicToken={TOKEN} />);
    await screen.findByText("Pedido enviado a Refugio Padrino");
    fireEvent.press(screen.getByText("Cancelar el pedido"));
    fireEvent.press(await screen.findByText("Confirmar la cancelación"));
    expect(await screen.findByText(/Solo el titular de la mascota/)).toBeOnTheScreen();
    expect(screen.queryByText("Cancelar el pedido")).toBeNull();
    expect(screen.queryByText("No pudimos actualizar")).toBeNull();
  });
});

describe("RehomeScreen — the two exits", () => {
  it("cancels only after confirming, posting withdraw_request WITH a key", async () => {
    mockFetch.mockResolvedValue({ outcome: "ok", payload: PENDING });
    render(<RehomeScreen publicToken={TOKEN} />);
    await screen.findByText("Pedido enviado a Refugio Padrino");
    expect(screen.getByText("Solicitud CAS-0001")).toBeOnTheScreen();

    fireEvent.press(screen.getByText("Cancelar el pedido"));
    expect(mockSend).not.toHaveBeenCalled();
    expect(await screen.findByText(/no se pierde nada/)).toBeOnTheScreen();

    fireEvent.press(screen.getByText("Confirmar la cancelación"));
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith({}, TOKEN, { command: "withdraw_request" }, mockKeys[0]);
    expect(await screen.findByText("El pedido quedó cancelado.")).toBeOnTheScreen();
  });

  it("retries a refused exit with the SAME key, and a later new exit with a NEW one", async () => {
    mockFetch.mockResolvedValue({ outcome: "ok", payload: PENDING });
    mockSend.mockResolvedValueOnce({ outcome: "unreachable", detail: "offline" });
    render(<RehomeScreen publicToken={TOKEN} />);
    await screen.findByText("Pedido enviado a Refugio Padrino");

    fireEvent.press(screen.getByText("Cancelar el pedido"));
    fireEvent.press(await screen.findByText("Confirmar la cancelación"));
    expect(await screen.findByText(/No pudimos conectarnos/)).toBeOnTheScreen();
    expect(mockSend).toHaveBeenLastCalledWith(
      {},
      TOKEN,
      { command: "withdraw_request" },
      mockKeys[0],
    );

    // MUTATION APPLIED: mint a fresh key per tap. Red — the retry would carry
    // a key the ledger has never seen, and a lost response would then be
    // refused with "nada que dar de baja" forever.
    fireEvent.press(screen.getByText("Cancelar el pedido"));
    fireEvent.press(await screen.findByText("Confirmar la cancelación"));
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2));
    expect(mockSend).toHaveBeenLastCalledWith(
      {},
      TOKEN,
      { command: "withdraw_request" },
      mockKeys[0],
    );

    // The landed exit ends the attempt; the state re-read still says pending
    // in this fake, so a THIRD cancel is a genuinely new act with a new key.
    await screen.findByText("El pedido quedó cancelado.");
    fireEvent.press(screen.getByText("Cancelar el pedido"));
    fireEvent.press(await screen.findByText("Confirmar la cancelación"));
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(3));
    expect(mockSend).toHaveBeenLastCalledWith(
      {},
      TOKEN,
      { command: "withdraw_request" },
      mockKeys[1],
    );
  });

  it("withdraws the sponsorship after confirming, and renders a REPLAY as done", async () => {
    mockFetch.mockResolvedValue({ outcome: "ok", payload: ACTIVE });
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: {
        command: "withdraw_sponsorship",
        listingCasePublicCode: null,
        orgPublicToken: "DIM-ORG-0001",
        replayed: true,
      },
    });
    render(<RehomeScreen publicToken={TOKEN} />);
    await screen.findByText("Refugio Padrino acompaña la adopción de Pampa");
    expect(screen.getByText("Expediente CAS-0002")).toBeOnTheScreen();

    fireEvent.press(screen.getByText("Dar de baja el acompañamiento"));
    expect(await screen.findByText(/deja de tener custodia registral/)).toBeOnTheScreen();
    fireEvent.press(screen.getByText("Confirmar la baja"));
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(mockSend).toHaveBeenCalledWith(
      {},
      TOKEN,
      { command: "withdraw_sponsorship" },
      mockKeys[0],
    );
    // A replay is a success, said in the past perfect — never a refusal.
    expect(await screen.findByText("El acompañamiento ya estaba dado de baja.")).toBeOnTheScreen();
  });

  it("draws no exit when the server withholds it, whatever the state says", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        state: ACTIVE.state,
        capabilities: {
          canRequest: false,
          canWithdrawRequest: false,
          canWithdrawSponsorship: false,
        },
      }),
    });
    render(<RehomeScreen publicToken={TOKEN} />);
    await screen.findByText("Refugio Padrino acompaña la adopción de Pampa");
    expect(screen.queryByText("Dar de baja el acompañamiento")).toBeNull();
  });
});
