// The "Casos abiertos" block on Mis mascotas (M11), rendered through the REAL
// screen, because the risk it carries is not the block — it is the screen's
// `ListHeaderComponent`, which already held two banners and returned `null` when
// neither was set. The block must appear there, beside the bite-draft banner
// rather than instead of it, and must never appear when nothing is open.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { fireEvent, render, screen } from "@testing-library/react-native";

import type { MyCaseRowV1, MyCasesV1 } from "@dim/contract/api";

const mockPush = jest.fn<(path: string) => void>();
const mockFetchMyPets = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockFetchMyCases = jest.fn<(...args: unknown[]) => Promise<unknown>>();

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
  fetchMyCases: (...args: unknown[]) => mockFetchMyCases(...args),
}));

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: { addEventListener: () => () => undefined },
}));

jest.mock("../auth/useGate", () => ({ useGate: () => ({ allowed: true }) }));

const OWNER = "11111111-1111-4111-8111-111111111111";
jest.mock("../auth/session-store", () => ({
  sessionPort: {},
  getSessionState: () => ({ phase: "signed-in", user: { id: OWNER } }),
}));

import MisMascotasScreen from "../../app/mascotas/index";
import { eventDraftKey, writeEventDraft } from "../pets/event-draft-store";
import { emptyDraft } from "../pets/record-event-view-model";

function aRow(over: Partial<MyCaseRowV1> = {}): MyCaseRowV1 {
  return {
    kind: "case_generic_open",
    title: "Caso CAS-TEST-0001 · Pampa",
    subtitle: "Episodio de custodia",
    severity: "info",
    since: "2026-09-01T12:00:00.000Z",
    route: "/casos/CAS-TEST-0001",
    ...over,
  };
}

function cases(open: MyCaseRowV1[]): { outcome: "ok"; payload: MyCasesV1 } {
  return {
    outcome: "ok",
    payload: {
      payloadVersion: 1,
      issuedAt: "2026-09-24T00:00:00.000Z",
      staleAfter: "2026-09-24T00:01:00.000Z",
      open,
      history: { rows: [], hasMore: false },
    },
  };
}

function onePet() {
  return {
    outcome: "ok" as const,
    payload: {
      version: 1,
      pets: [
        {
          publicToken: "DIM-PAMP-0001",
          name: "Pampa",
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

describe("Casos abiertos on Mis mascotas", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    mockPush.mockClear();
    mockFetchMyPets.mockReset();
    mockFetchMyPets.mockResolvedValue(onePet());
    mockFetchMyCases.mockReset();
  });

  it("is not drawn at all when nothing is open", async () => {
    mockFetchMyCases.mockResolvedValue(cases([]));
    render(<MisMascotasScreen />);
    await screen.findByText("Pampa");
    expect(screen.queryByText("Casos abiertos")).toBeNull();
  });

  it("is not drawn, and the pets stay, when the casos read fails", async () => {
    mockFetchMyCases.mockResolvedValue({ outcome: "unreachable" });
    render(<MisMascotasScreen />);
    await screen.findByText("Pampa");
    expect(screen.queryByText("Casos abiertos")).toBeNull();
    expect(screen.queryByText("No se pudo")).toBeNull();
  });

  it("lists the open cases above the pets and opens the one tapped", async () => {
    mockFetchMyCases.mockResolvedValue(cases([aRow()]));
    render(<MisMascotasScreen />);
    expect(await screen.findByText("Casos abiertos")).toBeTruthy();
    expect(screen.getByText("1 caso")).toBeTruthy();
    expect(screen.getByText("Pampa")).toBeTruthy();

    fireEvent.press(screen.getByText("Caso CAS-TEST-0001 · Pampa"));
    expect(mockPush).toHaveBeenCalledWith("/casos/CAS-TEST-0001");

    fireEvent.press(screen.getByText("Ver todos mis casos"));
    expect(mockPush).toHaveBeenCalledWith("/casos");
  });

  it("sits beside the bite-draft banner instead of replacing it", async () => {
    const key = eventDraftKey({
      ownerId: OWNER,
      publicToken: "DIM-PAMP-0001",
      kind: "bite",
      sourceEventId: null,
    });
    await writeEventDraft(key, emptyDraft(new Date()), Date.now());
    mockFetchMyCases.mockResolvedValue(cases([aRow()]));
    render(<MisMascotasScreen />);
    expect(await screen.findByText("Tenés una mordedura sin enviar")).toBeTruthy();
    expect(await screen.findByText("Casos abiertos")).toBeTruthy();
  });

  it("draws a row the app cannot open as text, not as a dead button", async () => {
    mockFetchMyCases.mockResolvedValue(
      cases([
        aRow({ title: "Solicitud pendiente", route: null, kind: "approval_request_pending" }),
      ]),
    );
    render(<MisMascotasScreen />);
    await screen.findByText("Solicitud pendiente");
    expect(screen.queryByRole("button", { name: /Solicitud pendiente/ })).toBeNull();
    fireEvent.press(screen.getByText("Solicitud pendiente"));
    expect(mockPush).not.toHaveBeenCalled();
  });
});
