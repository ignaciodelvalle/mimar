// "Esperan tu respuesta" on Mis mascotas, rendered through the REAL screen —
// the risk is the wiring, not the card: the screen's `ListHeaderComponent`
// returned `null` unless a banner or a case was set, so a card that never
// reached it would have passed its own unit test and still been invisible.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { fireEvent, render, screen } from "@testing-library/react-native";

import type { MyCaretakerGrantV1 } from "@dim/contract/api";

const mockPush = jest.fn<(path: string) => void>();
const mockFetchMyPets = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockFetchTransfers = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockFetchGrants = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
  useFocusEffect: (callback: () => void) => {
    const { useEffect } = require("react");
    useEffect(() => {
      callback();
    }, [callback]);
  },
}));

jest.mock("../api/endpoints", () => ({
  fetchMyPets: (...args: unknown[]) => mockFetchMyPets(...args),
  fetchMyCases: async () => ({
    outcome: "ok",
    payload: {
      payloadVersion: 1,
      issuedAt: "2026-10-06T00:00:00.000Z",
      staleAfter: "2026-10-06T00:01:00.000Z",
      open: [],
      history: { rows: [], hasMore: false },
    },
  }),
  fetchMyTransfers: (...args: unknown[]) => mockFetchTransfers(...args),
  fetchMyCaretakerGrants: (...args: unknown[]) => mockFetchGrants(...args),
}));

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: { addEventListener: () => () => undefined },
}));

jest.mock("../auth/useGate", () => ({ useGate: () => ({ allowed: true }) }));

jest.mock("../auth/session-store", () => ({
  sessionPort: {},
  getSessionState: () => ({ phase: "signed-in", user: { id: "owner-1" } }),
}));

import MisMascotasScreen from "../../app/mascotas/index";

const INVITATION: MyCaretakerGrantV1 = {
  grantToken: "CG-pamp0001",
  status: "pending",
  direction: "incoming",
  pet: { publicToken: "DIM-PAMP-0001", name: "Pampita", species: "ferret" },
  counterpartyName: "Graciela",
  caretakerEmail: "yo@example.com",
  startsAt: "2026-10-07T15:00:00.000Z",
  endsAt: "2026-10-14T15:00:00.000Z",
  note: null,
  expired: false,
  scopeSentence: "Podés cargar eventos. No podés transferir la titularidad.",
  capabilities: { canAccept: true, canReject: true, canCancel: false, canRevoke: false },
};

const HUB_META = {
  payloadVersion: 1,
  issuedAt: "2026-10-06T00:00:00.000Z",
  staleAfter: "2026-10-06T00:01:00.000Z",
};

function onePet() {
  return {
    outcome: "ok" as const,
    payload: {
      version: 1,
      pets: [
        {
          publicToken: "DIM-LUNA-0001",
          name: "Luna",
          species: "dog",
          status: "registered",
          photoUrl: null,
          role: "owner",
        },
      ],
      total: 1,
      truncated: false,
    },
  };
}

describe("Esperan tu respuesta on Mis mascotas", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    mockPush.mockClear();
    mockFetchMyPets.mockReset().mockResolvedValue(onePet());
    mockFetchTransfers.mockReset().mockResolvedValue({
      outcome: "ok",
      payload: { ...HUB_META, incoming: { pending: [], history: [] }, outgoing: [] },
    });
    mockFetchGrants.mockReset();
  });

  it("draws the invitation above the pets and opens the invitation screen", async () => {
    mockFetchGrants.mockResolvedValue({
      outcome: "ok",
      payload: { ...HUB_META, incoming: [INVITATION], outgoing: [] },
    });
    render(<MisMascotasScreen />);

    await screen.findByText("Luna");
    expect(
      await screen.findByText("Graciela te pidió que cuides a Pampita (Hurón) del 07/10 al 14/10."),
    ).toBeTruthy();

    fireEvent.press(screen.getByRole("button", { name: "Ver invitación" }));
    expect(mockPush).toHaveBeenCalledWith("/cuidado/CG-pamp0001");
  });

  it("draws nothing, and the pets stay, when the read fails", async () => {
    mockFetchGrants.mockResolvedValue({ outcome: "unreachable" });
    render(<MisMascotasScreen />);

    await screen.findByText("Luna");
    expect(screen.queryByText(/Esperan tu respuesta/)).toBeNull();
  });

  it("draws nothing when nothing waits on an answer", async () => {
    mockFetchGrants.mockResolvedValue({
      outcome: "ok",
      payload: { ...HUB_META, incoming: [], outgoing: [] },
    });
    render(<MisMascotasScreen />);

    await screen.findByText("Luna");
    expect(screen.queryByText(/Esperan tu respuesta/)).toBeNull();
  });
});
