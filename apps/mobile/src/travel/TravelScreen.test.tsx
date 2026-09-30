// `TravelScreen` — the owner's whole travel flow, native (viajes-fase-2, 6.4).
//
// WHAT THESE HAVE TO PROVE, beyond "it renders"
//   1. THE SEMÁFORO IS THE SERVER'S: its label is drawn verbatim, the
//      disclaimers with it, and no forbidden promise appears anywhere.
//   2. EVERY COMMAND CARRIES A KEY, and a retry of the same attempt reuses it;
//      a landed write restarts it.
//   3. THE CANCEL CONFIRMS BEFORE IT FIRES, and a replay reads as done.
//   4. The read is re-done after a write — selecting the new trip — and a
//      re-read that fails keeps the screen under a stale banner.
//   5. `canRecord: false` takes the forms and the cancel away.
//   6. NOTHING SENDS ANYBODY TO THE WEB (PO rule: owner flows are native).

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

import type { PetTravelV1 } from "@dim/contract/api";

import { createNavigationFake } from "../ui/navigation-fake";

const mockFetch = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockOpenURL = jest.fn<(url: string) => Promise<unknown>>();
const mockNav = createNavigationFake();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useNavigation: () => mockNav.navigation,
}));

jest.mock("../api/endpoints", () => ({
  fetchPetTravel: (...args: unknown[]) => mockFetch(...args),
  sendPetTravelCommand: (...args: unknown[]) => mockSend(...args),
}));

jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

// Distinct keys, so "the same key on a retry" is an assertion about REUSE.
const mockKeys = [
  "aaaaaaaa-1111-4222-8333-444444444444",
  "bbbbbbbb-1111-4222-8333-444444444444",
  "cccccccc-1111-4222-8333-444444444444",
] as const;
let mockKeyIndex = 0;
jest.mock("../pets/idempotency", () => ({
  createAttemptSession: () => {
    let current: string | null = null;
    return {
      key: () => {
        if (current === null) current = mockKeys[mockKeyIndex++ % mockKeys.length] ?? mockKeys[0];
        return current;
      },
      restart: () => {
        current = null;
      },
    };
  },
}));

import { Linking } from "react-native";

import { TravelScreen } from "./TravelScreen";

const TOKEN = "DIM-PAMP-0001";
const TRIP_A = "11111111-1111-4111-8111-111111111111";
const TRIP_B = "22222222-2222-4222-8222-222222222222";
const NEW_TRIP = "33333333-3333-4333-8333-333333333333";

const TRIP_CHILE = {
  tripEventId: TRIP_A,
  corridorId: "chile",
  corridorLabel: "Chile",
  travelDate: "2026-11-12",
  mode: "air" as const,
  airlineId: "latam",
  airlineName: "LATAM",
  intendedModality: "cabin" as const,
};

const TRIP_URUGUAY = {
  tripEventId: TRIP_B,
  corridorId: "uruguay",
  corridorLabel: "Uruguay",
  travelDate: "2026-12-20",
  mode: "land" as const,
  airlineId: null,
  airlineName: null,
  intendedModality: null,
};

function payload(over: Partial<PetTravelV1> = {}): PetTravelV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-09-30T10:00:00.000Z",
    staleAfter: "2026-09-30T10:01:00.000Z",
    publicToken: TOKEN,
    petName: "Pampa",
    trips: [TRIP_CHILE],
    selectedTripEventId: TRIP_A,
    compliance: {
      semaforo: "amarillo",
      semaforoLabel: "Revisar pendientes",
      obligations: [
        {
          id: "rabies",
          group: "destino",
          label: "Vacuna antirrábica",
          state: "Registrada en la libreta",
          detail: null,
          requirementLevel: "blocker",
          contributingJurisdictions: ["Chile"],
          sources: [
            {
              kind: "corridor",
              label: "SAG Chile",
              sourceUrl: "https://www.sag.gob.cl/mascotas",
              lastVerifiedAt: "2026-09-01",
              freshness: "fresh",
            },
          ],
          freshnessNotice: null,
          legalFootnote: "Res. SAG 1234",
        },
        {
          id: "weight",
          group: "aerolinea",
          label: "Peso máximo en cabina",
          state: "Sin peso registrado",
          detail: null,
          requirementLevel: "warning",
          contributingJurisdictions: [],
          sources: [],
          freshnessNotice: "Verificá — dato sin confirmar con la fuente",
          legalFootnote: "Política publicada por la aerolínea",
        },
      ],
      corridors: [],
    },
    cvis: [{ eventId: "c1", cviNumber: "AR-555", issuedDate: "2026-09-20", validUntil: null }],
    disclaimers: ["miMAR no reemplaza a SENASA.", "Verificá con tu aerolínea antes de reservar."],
    options: {
      corridors: [
        { id: "chile", label: "Chile" },
        { id: "uruguay", label: "Uruguay" },
      ],
      airlines: [{ id: "latam", name: "LATAM" }],
    },
    capabilities: { canRecord: true },
    exportWebUrl: `https://example.test/mis-mascotas/${TOKEN}/viaje`,
    ...over,
  };
}

const EMPTY = payload({ trips: [], selectedTripEventId: null, compliance: null, cvis: [] });

beforeEach(() => {
  mockKeyIndex = 0;
  mockFetch.mockReset();
  mockSend.mockReset();
  mockOpenURL.mockReset();
  mockOpenURL.mockResolvedValue(true);
  jest.spyOn(Linking, "openURL").mockImplementation((url: string) => mockOpenURL(url));
  mockFetch.mockResolvedValue({ outcome: "ok", payload: payload() });
});

describe("TravelScreen — the reading", () => {
  it("draws the server's semáforo label verbatim, the groups, the CVIs and the disclaimers", async () => {
    render(<TravelScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Revisar pendientes")).toBeOnTheScreen();
    expect(screen.getByText("Chile, 12/11/2026 · LATAM, en cabina")).toBeOnTheScreen();
    expect(screen.getByText("Destino")).toBeOnTheScreen();
    expect(screen.getByText("Aerolínea")).toBeOnTheScreen();
    expect(screen.getByText("Verificá con tu aerolínea: LATAM")).toBeOnTheScreen();
    expect(screen.getByText("Verificá — dato sin confirmar con la fuente")).toBeOnTheScreen();
    expect(screen.getByText("AR-555: emitido el 20/09/2026")).toBeOnTheScreen();
    expect(screen.getByText("miMAR no reemplaza a SENASA.")).toBeOnTheScreen();
    // The first read leaves the choice of trip to the server.
    expect(mockFetch).toHaveBeenCalledWith({}, TOKEN, null);
  });

  it("never promises and never sends anybody to the web", async () => {
    render(<TravelScreen publicToken={TOKEN} />);
    await screen.findByText("Revisar pendientes");
    expect(screen.queryByText(/\bapto\b|\bcumple\b|en orden|listo para viajar/i)).toBeNull();
    expect(screen.queryByText(/web|navegador/i)).toBeNull();
    // The only outbound link is a published SOURCE, a citation — not the flow.
    fireEvent.press(screen.getByText("Fuente: SAG Chile, revisada el 01/09/2026"));
    expect(mockOpenURL).toHaveBeenCalledWith("https://www.sag.gob.cl/mascotas");
    expect(mockOpenURL).not.toHaveBeenCalledWith(expect.stringContaining("/mis-mascotas/"));
  });

  it("switches trips by reading the one asked for", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ trips: [TRIP_CHILE, TRIP_URUGUAY] }),
    });
    render(<TravelScreen publicToken={TOKEN} />);
    await screen.findByText("Revisar pendientes");
    fireEvent.press(screen.getByText("Uruguay, 20/12/2026"));
    await waitFor(() => expect(mockFetch).toHaveBeenLastCalledWith({}, TOKEN, TRIP_B));
  });

  it("says there is no trip yet and opens the trip form", async () => {
    mockFetch.mockResolvedValue({ outcome: "ok", payload: EMPTY });
    render(<TravelScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Todavía no hay un viaje registrado")).toBeOnTheScreen();
    expect(screen.getByText("Registrar viaje")).toBeOnTheScreen();
    expect(screen.queryByText("Cancelar este viaje")).toBeNull();
  });

  it("renders a refusal on the first read as its sentence, with a retry", async () => {
    mockFetch.mockResolvedValue({
      outcome: "api-error",
      code: "travel_forbidden",
      retryAfterSeconds: null,
    });
    render(<TravelScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Reintentar")).toBeOnTheScreen();
    expect(screen.queryByText("Revisar pendientes")).toBeNull();
  });

  it("offers no form and no cancel when the server says nothing may be recorded", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ capabilities: { canRecord: false } }),
    });
    render(<TravelScreen publicToken={TOKEN} />);
    await screen.findByText("Revisar pendientes");
    expect(screen.queryByText("Cancelar este viaje")).toBeNull();
    expect(screen.queryByText("Registrar un CVI")).toBeNull();
    expect(screen.queryByText("Registrar otro viaje")).toBeNull();
  });
});

describe("TravelScreen — recording a trip", () => {
  it("refuses locally, with the field's sentence, before any round trip", async () => {
    mockFetch.mockResolvedValue({ outcome: "ok", payload: EMPTY });
    render(<TravelScreen publicToken={TOKEN} />);
    await screen.findByText("Registrar viaje");
    fireEvent.press(screen.getByText("Registrar viaje"));
    expect(await screen.findByText("Elegí el país de destino.")).toBeOnTheScreen();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("posts record_trip with a key, reuses it on a retry, and reads the new trip", async () => {
    mockFetch.mockResolvedValue({ outcome: "ok", payload: EMPTY });
    mockSend.mockResolvedValueOnce({
      outcome: "api-error",
      code: "travel_failed",
      retryAfterSeconds: null,
    });
    mockSend.mockResolvedValueOnce({
      outcome: "ok",
      payload: { command: "record_trip", eventId: NEW_TRIP, replayed: true },
    });
    render(<TravelScreen publicToken={TOKEN} />);
    await screen.findByText("Registrar viaje");
    fireEvent.press(screen.getByText("Uruguay"));
    fireEvent.changeText(screen.getByLabelText("Fecha de salida, obligatorio"), "20/12/2026");
    fireEvent.press(screen.getByText("Registrar viaje"));
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    expect(mockSend).toHaveBeenLastCalledWith(
      {},
      TOKEN,
      {
        command: "record_trip",
        corridorId: "uruguay",
        travelDate: "2026-12-20",
        mode: null,
        airlineId: null,
        intendedModality: null,
      },
      mockKeys[0],
    );

    // The retry of the SAME attempt carries the SAME key.
    await screen.findByText("Registrar viaje");
    fireEvent.press(screen.getByText("Registrar viaje"));
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2));
    expect(mockSend.mock.calls[1]?.[3]).toBe(mockKeys[0]);

    // A replay reads as done, and the new trip is the one read next.
    expect(await screen.findByText("Ese viaje ya estaba registrado.")).toBeOnTheScreen();
    await waitFor(() => expect(mockFetch).toHaveBeenLastCalledWith({}, TOKEN, NEW_TRIP));
  });

  it("keeps the screen under a stale banner when the re-read after a write fails", async () => {
    mockFetch.mockResolvedValueOnce({ outcome: "ok", payload: payload() });
    mockFetch.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: { command: "record_cvi", eventId: "c2", replayed: false },
    });
    render(<TravelScreen publicToken={TOKEN} />);
    await screen.findByText("Revisar pendientes");
    fireEvent.press(screen.getByText("Registrar un CVI"));
    fireEvent.changeText(screen.getByLabelText("Número de CVI, obligatorio"), "AR-777");
    fireEvent.changeText(screen.getByLabelText("Fecha de emisión, obligatorio"), "25/09/2026");
    fireEvent.press(screen.getByText("Registrar CVI"));
    expect(await screen.findByText("CVI registrado.")).toBeOnTheScreen();
    expect(await screen.findByText("No pudimos actualizar")).toBeOnTheScreen();
    expect(screen.getByText("Revisar pendientes")).toBeOnTheScreen();
    expect(mockSend).toHaveBeenCalledWith(
      {},
      TOKEN,
      { command: "record_cvi", cviNumber: "AR-777", issuedDate: "2026-09-25", validUntil: null },
      mockKeys[0],
    );
  });
});

describe("TravelScreen — cancelling a trip", () => {
  it("asks first, then posts cancel_trip with a key, and reads a replay as done", async () => {
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: { command: "cancel_trip", tripEventId: TRIP_A, changed: false },
    });
    render(<TravelScreen publicToken={TOKEN} />);
    await screen.findByText("Revisar pendientes");
    fireEvent.press(screen.getByText("Cancelar este viaje"));
    expect(mockSend).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "¿Cancelar el viaje a Chile, 12/11/2026? Deja de figurar en esta pantalla y en el semáforo.",
      ),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByText("Confirmar cancelación"));
    await waitFor(() =>
      expect(mockSend).toHaveBeenCalledWith(
        {},
        TOKEN,
        { command: "cancel_trip", tripEventId: TRIP_A },
        mockKeys[0],
      ),
    );
    expect(await screen.findByText("Ese viaje ya estaba cancelado.")).toBeOnTheScreen();
    // The cancelled trip was the one being read: the server picks the next.
    await waitFor(() => expect(mockFetch).toHaveBeenLastCalledWith({}, TOKEN, null));
  });

  it("goes back without sending anything", async () => {
    render(<TravelScreen publicToken={TOKEN} />);
    await screen.findByText("Revisar pendientes");
    fireEvent.press(screen.getByText("Cancelar este viaje"));
    fireEvent.press(screen.getByText("Volver"));
    expect(screen.getByText("Cancelar este viaje")).toBeOnTheScreen();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
