// The open casos on Mis mascotas (M11), rendered through the REAL screen,
// because the risk it carries is not the block — it is the screen's
// `ListHeaderComponent`, which holds several banners and returns `null` when
// none is set. The block must appear there, beside the bite-draft banner rather
// than instead of it, and must never appear when nothing is open.
//
// RESHAPED BY inicio-app-rediseno (PO 2026-10-07): "Te toca a vos" stays open
// above the pets; "En curso" folds into one closed `CollapsibleModule` row with
// its count as the badge, and "Ver todos mis casos" lives inside it.

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
    petId: null,
    petName: null,
    petPhotoUrl: null,
    needsAction: false,
    dueAt: null,
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
    expect(screen.queryByText("Te toca a vos")).toBeNull();
    expect(screen.queryByText("En curso")).toBeNull();
  });

  it("is not drawn, and the pets stay, when the casos read fails", async () => {
    mockFetchMyCases.mockResolvedValue({ outcome: "unreachable" });
    render(<MisMascotasScreen />);
    await screen.findByText("Pampa");
    expect(screen.queryByText("Te toca a vos")).toBeNull();
    expect(screen.queryByText("En curso")).toBeNull();
    expect(screen.queryByText("No se pudo")).toBeNull();
  });

  it("lists the owner's turn open above the pets and opens the one tapped", async () => {
    mockFetchMyCases.mockResolvedValue(cases([aRow({ needsAction: true })]));
    render(<MisMascotasScreen />);
    expect(await screen.findByText("Te toca a vos")).toBeTruthy();
    expect(screen.getByText("1 caso")).toBeTruthy();
    expect(screen.getByText("Pampa")).toBeTruthy();

    fireEvent.press(screen.getByText("Caso CAS-TEST-0001 · Pampa"));
    expect(mockPush).toHaveBeenCalledWith("/casos/CAS-TEST-0001");

    // Nothing in course: the link to every caso sits under the owner's turn.
    fireEvent.press(screen.getByText("Ver todos mis casos"));
    expect(mockPush).toHaveBeenCalledWith("/casos");
  });

  it("folds 'En curso' into one closed row with its count, and opens it on a tap", async () => {
    mockFetchMyCases.mockResolvedValue(
      cases([aRow(), aRow({ title: "Observación por mordedura · Satito" })]),
    );
    render(<MisMascotasScreen />);
    const fold = await screen.findByRole("button", { expanded: false, name: /En curso/ });
    expect(screen.getByText("2")).toBeTruthy();
    // Closed: its rows and the link are not drawn.
    expect(screen.queryByText("Caso CAS-TEST-0001 · Pampa")).toBeNull();
    expect(screen.queryByText("Ver todos mis casos")).toBeNull();
    // Nothing waits on the owner, so that group is not drawn at all.
    expect(screen.queryByText("Te toca a vos")).toBeNull();

    fireEvent.press(fold);
    expect(screen.getByRole("button", { expanded: true, name: /En curso/ })).toBeTruthy();
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
    expect(await screen.findByText("En curso")).toBeTruthy();
  });

  it("groups the block like the web: the owner's turn first, one pet's cases under the pet", async () => {
    const pampa = { petId: "DIM-PAMP-0001", petName: "Pampa", petPhotoUrl: null };
    mockFetchMyCases.mockResolvedValue(
      cases([
        aRow({ title: "Postulación pendiente", kind: "adoption_application_pending" }),
        aRow({ title: "Pampa está perdida", needsAction: true, ...pampa }),
        aRow({ title: "Atestá la raza de Pampa", needsAction: true, ...pampa }),
      ]),
    );
    render(<MisMascotasScreen />);
    expect(await screen.findByText("Te toca a vos")).toBeTruthy();
    expect(screen.getByText("En curso")).toBeTruthy();
    expect(screen.getByLabelText("Pampa, 2 casos")).toBeTruthy();
    // The owner's turn counts its own two; the fold carries the third as a badge.
    expect(screen.getAllByText("2 casos").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { expanded: false, name: /En curso/ })).toBeTruthy();
  });

  it("draws a row the app cannot open as text, not as a dead button", async () => {
    mockFetchMyCases.mockResolvedValue(
      cases([
        aRow({
          title: "Solicitud pendiente",
          route: null,
          kind: "approval_request_pending",
          needsAction: true,
        }),
      ]),
    );
    render(<MisMascotasScreen />);
    await screen.findByText("Solicitud pendiente");
    expect(screen.queryByRole("button", { name: /Solicitud pendiente/ })).toBeNull();
    fireEvent.press(screen.getByText("Solicitud pendiente"));
    expect(mockPush).not.toHaveBeenCalled();
  });
});
