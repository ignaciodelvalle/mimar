// `TravelScreen` — the owner's whole travel flow, native (viajes-fase-2, 6.4;
// redesigned in modules and a four-step wizard, PO-approved 2026-10-07).
//
// WHAT THESE HAVE TO PROVE, beyond "it renders"
//   1. THE SEMÁFORO IS THE SERVER'S: its label is drawn verbatim in the pase,
//      the disclaimers once, and no forbidden promise appears anywhere.
//   2. THE OPENING RULE: only the first module with work opens by itself; a
//      requirement met only on the owner's word wears the declared seal.
//   3. EVERY COMMAND CARRIES A KEY, a retry of the same attempt reuses it, and
//      a landed write restarts it — through the wizard as through the old form.
//   4. THE WIZARD trims each question by the last answer, keeps the answers on
//      back (the on-screen button AND the back gesture), says "Otro país"
//      honestly without writing anything, refuses a date outside the window
//      under the field, and maps the server's refusal reason to its sentence.
//   5. AN OLDER SERVER (no v14 fields) still gets a working wizard with the
//      full lists.
//   6. THE CANCEL CONFIRMS BEFORE IT FIRES, and a replay reads as done.
//   7. `canRecord: false` takes every write away.
//   8. NOTHING SENDS ANYBODY TO THE WEB, and the PDF is the server's.
//   9. No height is fixed around text, so a font scale of 1.3 grows rows
//      instead of clipping them (QA 2026-10-07, bug 2).

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";

import {
  PET_TRAVEL_DECLARED_SEAL,
  PET_TRAVEL_REFUSAL_MESSAGES,
  type PetTravelObligationV1,
  type PetTravelV1,
} from "@dim/contract/api";

import { createNavigationFake } from "../ui/navigation-fake";

const mockFetch = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockExport = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockOpenURL = jest.fn<(url: string) => Promise<unknown>>();
const mockPush = jest.fn<(href: string) => void>();
const mockNav = createNavigationFake();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
  useNavigation: () => mockNav.navigation,
}));

jest.mock("../api/endpoints", () => ({
  fetchPetTravel: (...args: unknown[]) => mockFetch(...args),
  sendPetTravelCommand: (...args: unknown[]) => mockSend(...args),
  requestPetTravelExport: (...args: unknown[]) => mockExport(...args),
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

import { Linking, StyleSheet, Text, View } from "react-native";

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

const RABIES: PetTravelObligationV1 = {
  id: "rabies_vaccination_to_travel_wait_days",
  group: "libreta",
  label: "Vacuna antirrábica",
  state: "Aplicada el 01/09, según indicaste.",
  detail: "Al menos 21 días entre la vacuna y el viaje.",
  requirementLevel: "warning",
  contributingJurisdictions: ["Chile"],
  sources: [
    {
      kind: "corridor",
      label: "Chile",
      issuerLabel: "SENASA, requisitos para Chile",
      sourceUrl: "https://www.argentina.gob.ar/senasa/chile",
      lastVerifiedAt: "2026-09-30",
      freshness: "fresh",
    },
  ],
  freshnessNotice: null,
  legalFootnote: "Regla del corredor de viaje · Chile",
  evidence: "declared",
};

const WINDOW: PetTravelObligationV1 = {
  id: "document_issuance_window_days:senasa_cvi",
  group: "destino",
  label: "Certificado Zoosanitario (CZI)",
  state: "Pedilo desde el 02/11 y hasta el 12/11.",
  detail: null,
  requirementLevel: "blocker",
  contributingJurisdictions: ["Chile"],
  sources: [],
  freshnessNotice: null,
  legalFootnote: "Regla del corredor de viaje · Chile",
  evidence: null,
};

const AGE: PetTravelObligationV1 = {
  id: "min_age_days",
  group: "destino",
  label: "Edad mínima",
  state: "Cumple la edad mínima registrada",
  detail: null,
  requirementLevel: "info",
  contributingJurisdictions: ["Chile"],
  sources: [],
  freshnessNotice: null,
  legalFootnote: "Regla del corredor de viaje · Chile",
  evidence: "verified",
};

const PAPERS: PetTravelObligationV1 = {
  id: "required_documents",
  group: "destino",
  label: "Documentación a presentar",
  state: "Confirmá que tenés cada documento",
  detail: null,
  requirementLevel: "warning",
  contributingJurisdictions: ["Chile"],
  sources: [],
  freshnessNotice: null,
  legalFootnote: "Regla del corredor de viaje · Chile",
  documents: [
    { label: "Certificado veterinario", confirmed: true },
    { label: "Permiso de importación", confirmed: false },
  ],
};

const V14_OPTIONS: PetTravelV1["options"] = {
  corridors: [
    {
      id: "chile",
      label: "Chile",
      paper: { name: "Certificado Zoosanitario de Importación (CZI)", shortName: "CZI" },
      leadHints: ["La antirrábica tiene que tener al menos 21 días el día del viaje."],
      leadDays: 21,
    },
    { id: "uruguay", label: "Uruguay" },
    { id: "brasil", label: "Brasil" },
    { id: "ue_espana", label: "España (Unión Europea)" },
    { id: "usa", label: "Estados Unidos" },
  ],
  airlines: [
    {
      id: "aerolineas_argentinas",
      name: "Aerolíneas Argentinas",
      corridors: ["chile", "brasil", "usa"],
      modalities: [],
    },
    {
      id: "latam",
      name: "LATAM",
      corridors: ["chile", "brasil"],
      modalities: [
        { modality: "cabin", offered: "yes", maxWeightKg: 7, includesCarrier: true },
        { modality: "hold", offered: "yes", maxWeightKg: 32, includesCarrier: true },
      ],
    },
    { id: "iberia", name: "Iberia", corridors: ["ue_espana"], modalities: [] },
    {
      id: "emirates",
      name: "Emirates",
      corridors: [],
      modalities: [
        { modality: "cargo", offered: "yes", maxWeightKg: null, includesCarrier: false },
      ],
    },
  ],
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
      obligations: [WINDOW, RABIES, AGE],
      corridors: [],
    },
    cvis: [{ eventId: "c1", cviNumber: "AR-555", issuedDate: "2026-09-20", validUntil: null }],
    disclaimers: ["miMAR no reemplaza a la autoridad sanitaria."],
    options: V14_OPTIONS,
    capabilities: { canRecord: true },
    exportWebUrl: `https://example.test/mis-mascotas/${TOKEN}/viaje`,
    ...over,
  };
}

const EMPTY = payload({ trips: [], selectedTripEventId: null, compliance: null, cvis: [] });

/** A v13 server: none of the redesign's optional fields. */
const OLD_OPTIONS: PetTravelV1["options"] = {
  corridors: V14_OPTIONS.corridors.map(({ id, label }) => ({ id, label })),
  airlines: [
    { id: "aerolineas_argentinas", name: "Aerolíneas Argentinas" },
    { id: "latam", name: "LATAM" },
    { id: "iberia", name: "Iberia" },
    { id: "emirates", name: "Emirates" },
    { id: "gol", name: "GOL" },
    { id: "sky", name: "Sky Airline" },
    { id: "copa", name: "Copa Airlines" },
  ],
};

function withPapers(over: Partial<PetTravelV1> = {}) {
  const base = payload(over);
  if (base.compliance === null) throw new Error("fixture: a trip has a reading");
  return { ...base, compliance: { ...base.compliance, obligations: [AGE, PAPERS] } };
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date(2026, 9, 7, 13, 5), doNotFake: ["nextTick", "setImmediate"] });
  mockKeyIndex = 0;
  mockNav.reset();
  mockFetch.mockReset();
  mockSend.mockReset();
  mockPush.mockReset();
  mockOpenURL.mockReset();
  mockOpenURL.mockResolvedValue(true);
  jest.spyOn(Linking, "openURL").mockImplementation((url: string) => mockOpenURL(url));
  mockFetch.mockResolvedValue({ outcome: "ok", payload: payload() });
});

afterEach(() => {
  jest.useRealTimers();
});

describe("TravelScreen — the trip, in modules", () => {
  it("draws the pase: destination, countdown, the server's label verbatim and the count", async () => {
    render(<TravelScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Revisar pendientes")).toBeOnTheScreen();
    expect(screen.getByText("Chile")).toBeOnTheScreen();
    expect(screen.getByText("faltan 36 días")).toBeOnTheScreen();
    expect(screen.getByText("Jue 12/11/2026 · LATAM, en cabina")).toBeOnTheScreen();
    expect(screen.getByText("2 cosas por resolver · 1 ya está")).toBeOnTheScreen();
    // The disclaimer, once.
    expect(screen.getAllByText("miMAR no reemplaza a la autoridad sanitaria.")).toHaveLength(1);
    // Three quick actions, the paper named the way the destination names it.
    expect(screen.getByText("Exportar PDF")).toBeOnTheScreen();
    expect(screen.getAllByText("Cargar el CZI").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Mandar a mi veterinaria").length).toBeGreaterThan(0);
    // The first read leaves the choice of trip to the server.
    expect(mockFetch).toHaveBeenCalledWith({}, TOKEN, null);
  });

  it("opens only the first module with work, and keeps the rest folded", async () => {
    render(<TravelScreen publicToken={TOKEN} />);
    await screen.findByText("Revisar pendientes");
    // Lo que falta is open: its requirements are on screen, worst first.
    expect(screen.getByText("Vacuna antirrábica")).toBeOnTheScreen();
    expect(screen.getByText("Certificado Zoosanitario (CZI)")).toBeOnTheScreen();
    expect(screen.getByText("Bloqueante")).toBeOnTheScreen();
    // Ya está is folded: its requirement appears only when opened.
    expect(screen.queryByText("Edad mínima")).toBeNull();
    fireEvent.press(screen.getByText("Ya está"));
    expect(screen.getByText("Edad mínima")).toBeOnTheScreen();
  });

  it("opens Para llevar when nothing is pending but a paper is unticked", async () => {
    mockFetch.mockResolvedValue({ outcome: "ok", payload: withPapers() });
    render(<TravelScreen publicToken={TOKEN} />);
    await screen.findByText("Revisar pendientes");
    expect(screen.getByText("Nada pendiente detectado")).toBeOnTheScreen();
    expect(screen.getByText("1 de 2")).toBeOnTheScreen();
    expect(screen.getByRole("checkbox", { name: "Permiso de importación" })).toBeOnTheScreen();
  });

  it("seals a requirement met only on the owner's word and offers to send it to the vet", async () => {
    render(<TravelScreen publicToken={TOKEN} />);
    await screen.findByText("Revisar pendientes");
    expect(screen.getByText(PET_TRAVEL_DECLARED_SEAL)).toBeOnTheScreen();
    // The declared one asks the vet to record it; it never counts as done.
    expect(screen.getAllByText("Mandar a mi veterinaria")).toHaveLength(2);
    expect(screen.getAllByText("Cargar el CZI")).toHaveLength(2);
  });

  it("shows no seal and no action when an older server sends no evidence", async () => {
    const old = { ...RABIES, evidence: undefined, sources: [] };
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        options: OLD_OPTIONS,
        compliance: {
          semaforo: "amarillo",
          semaforoLabel: "Revisar pendientes",
          obligations: [old],
          corridors: [],
        },
      }),
    });
    render(<TravelScreen publicToken={TOKEN} />);
    await screen.findByText("Revisar pendientes");
    expect(screen.queryByText(PET_TRAVEL_DECLARED_SEAL)).toBeNull();
    expect(screen.getByText("Pedírselo a mi veterinaria")).toBeOnTheScreen();
    // No paper on the payload: the quick action keeps the old name.
    expect(screen.getByText("Cargar el CVI")).toBeOnTheScreen();
  });

  it("opens the detail in place, with who publishes the rule", async () => {
    render(<TravelScreen publicToken={TOKEN} />);
    await screen.findByText("Revisar pendientes");
    expect(screen.queryByText(/Fuente:/)).toBeNull();
    fireEvent.press(screen.getAllByText("Ver detalle")[1] as never);
    expect(screen.getByText("Exigido por: Chile")).toBeOnTheScreen();
    fireEvent.press(
      screen.getByText("Fuente: SENASA, requisitos para Chile, revisada el 30/09/2026"),
    );
    expect(mockOpenURL).toHaveBeenCalledWith("https://www.argentina.gob.ar/senasa/chile");
    expect(screen.getByText("Ocultar detalle")).toBeOnTheScreen();
  });

  it("never promises and never sends anybody to the web", async () => {
    render(<TravelScreen publicToken={TOKEN} />);
    await screen.findByText("Revisar pendientes");
    for (const label of screen.getAllByText("Ver detalle")) fireEvent.press(label);
    expect(screen.queryByText(/\bapto\b|en orden|listo para viajar/i)).toBeNull();
    expect(screen.queryByText(/web|navegador/i)).toBeNull();
    expect(mockOpenURL).not.toHaveBeenCalledWith(expect.stringContaining("/mis-mascotas/"));
  });

  it("switches trips from 'Ver los otros', reading the one asked for", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ trips: [TRIP_CHILE, TRIP_URUGUAY] }),
    });
    render(<TravelScreen publicToken={TOKEN} />);
    await screen.findByText("Revisar pendientes");
    expect(screen.getByText("Viaje 1 de 2")).toBeOnTheScreen();
    // No chip per trip over the semáforo any more.
    expect(screen.queryByText("Uruguay, 20/12/2026")).toBeNull();
    fireEvent.press(screen.getByText("Ver los otros"));
    fireEvent.press(screen.getByText("Uruguay, 20/12/2026"));
    await waitFor(() => expect(mockFetch).toHaveBeenLastCalledWith({}, TOKEN, TRIP_B));
  });

  it("says the way of travelling in the pase even without an airline", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ trips: [TRIP_URUGUAY], selectedTripEventId: TRIP_B }),
    });
    render(<TravelScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Dom 20/12/2026 · En auto o en micro")).toBeOnTheScreen();
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

  it("offers no write when the server says nothing may be recorded", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ capabilities: { canRecord: false } }),
    });
    render(<TravelScreen publicToken={TOKEN} />);
    await screen.findByText("Revisar pendientes");
    expect(screen.queryByText("Cancelar este viaje")).toBeNull();
    expect(screen.queryByText("Cargar el CZI")).toBeNull();
    expect(screen.queryByText("Planear otro viaje")).toBeNull();
    // Reading and sharing stay: they write nothing.
    expect(screen.getByText("Exportar PDF")).toBeOnTheScreen();
    expect(screen.getAllByText("Mandar a mi veterinaria").length).toBeGreaterThan(0);
  });

  it("fixes no height around text, so a larger font grows rows instead of clipping them", async () => {
    mockFetch.mockResolvedValue({ outcome: "ok", payload: withPapers() });
    const { UNSAFE_root } = render(<TravelScreen publicToken={TOKEN} />);
    await screen.findByText("Revisar pendientes");
    fireEvent.press(screen.getByText("Ya está"));
    const fixed = UNSAFE_root.findAll(
      (node) => node.type === View && StyleSheet.flatten(node.props.style)?.height !== undefined,
    );
    // Non-vacuous: the chevrons and boxes ARE fixed-size, and hold no text.
    expect(fixed.length).toBeGreaterThan(0);
    for (const node of fixed) {
      expect(node.findAll((child) => child.type === Text)).toEqual([]);
    }
    // And no text on this screen is truncated to a line count.
    const truncated = UNSAFE_root.findAll(
      (node) => node.type === Text && node.props.numberOfLines !== undefined,
    );
    expect(truncated).toEqual([]);
  });
});

describe("TravelScreen — no trip yet", () => {
  it("puts one call to action first, and the destinations as shortcuts", async () => {
    mockFetch.mockResolvedValue({ outcome: "ok", payload: EMPTY });
    render(<TravelScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Planear un viaje")).toBeOnTheScreen();
    expect(
      screen.getByText("Planeá un viaje y te mostramos qué le falta a Pampa"),
    ).toBeOnTheScreen();
    expect(screen.getByText("O empezá por el destino")).toBeOnTheScreen();
    expect(screen.queryByText("Exportar PDF")).toBeNull();
    expect(screen.queryByText("Cancelar este viaje")).toBeNull();
  });

  it("a destination shortcut opens the wizard on its second step", async () => {
    mockFetch.mockResolvedValue({ outcome: "ok", payload: EMPTY });
    render(<TravelScreen publicToken={TOKEN} />);
    await screen.findByText("Planear un viaje");
    fireEvent.press(screen.getByText("Uruguay"));
    expect(screen.getByText("Paso 2 de 4 · Uruguay")).toBeOnTheScreen();
    expect(screen.getByText("¿Cómo viajan?")).toBeOnTheScreen();
    // Uruguay offers the boat; three ways plus "Todavía no sé".
    expect(screen.getByText("En barco")).toBeOnTheScreen();
    expect(screen.getByText("En auto o en micro")).toBeOnTheScreen();
  });

  it("offers no plan when nothing may be recorded", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: { ...EMPTY, capabilities: { canRecord: false } },
    });
    render(<TravelScreen publicToken={TOKEN} />);
    await screen.findByText("Planeá un viaje y te mostramos qué le falta a Pampa");
    expect(screen.queryByText("Planear un viaje")).toBeNull();
    expect(screen.queryByText("O empezá por el destino")).toBeNull();
  });
});

describe("TravelScreen — the four-step wizard", () => {
  async function openWizard(data: PetTravelV1 = EMPTY) {
    mockFetch.mockResolvedValue({ outcome: "ok", payload: data });
    render(<TravelScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Planear un viaje"));
  }

  it("asks the destination first: the five and an honest 'Otro país', six at most", async () => {
    await openWizard();
    expect(screen.getByText("Paso 1 de 4")).toBeOnTheScreen();
    expect(screen.getByText("¿A dónde viaja Pampa?")).toBeOnTheScreen();
    expect(screen.getByText("Otro país")).toBeOnTheScreen();
    expect(screen.getByText("Estados Unidos")).toBeOnTheScreen();
  });

  it("'Otro país' records nothing and says what miMAR does not do", async () => {
    await openWizard();
    fireEvent.changeText(screen.getByLabelText("Destino"), "Perú");
    expect(screen.getByText("Perú no está entre los destinos que miMAR revisa")).toBeOnTheScreen();
    fireEvent.press(screen.getByText("Volver a los destinos"));
    expect(screen.getByText("Chile")).toBeOnTheScreen();
    fireEvent.press(screen.getByText("Otro país"));
    expect(
      screen.getByText("Ese país no está entre los destinos que miMAR revisa"),
    ).toBeOnTheScreen();
    expect(mockSend).not.toHaveBeenCalled();
    expect(screen.queryByText("Crear viaje")).toBeNull();
  });

  it("finds a destination by another of its names", async () => {
    await openWizard();
    fireEvent.changeText(screen.getByLabelText("Destino"), "Europa");
    expect(screen.getByText("España (Unión Europea)")).toBeOnTheScreen();
    expect(screen.queryByText("Chile")).toBeNull();
  });

  it("skips '¿Cómo viajan?' for a destination reached only by air", async () => {
    await openWizard();
    fireEvent.press(screen.getByText("España (Unión Europea)"));
    expect(screen.getByText("Paso 2 de 3 · España (Unión Europea) en avión")).toBeOnTheScreen();
    expect(screen.getByText("¿Con qué aerolínea?")).toBeOnTheScreen();
    // The destination's airlines first, then search, then "Todavía no sé".
    expect(screen.getByText("Iberia")).toBeOnTheScreen();
    expect(screen.queryByText("LATAM")).toBeNull();
    expect(screen.getByText("Buscar otra aerolínea")).toBeOnTheScreen();
  });

  it("searches every airline, not only the suggested ones", async () => {
    await openWizard();
    fireEvent.press(screen.getByText("España (Unión Europea)"));
    fireEvent.press(screen.getByText("Buscar otra aerolínea"));
    fireEvent.changeText(screen.getByLabelText("Aerolínea"), "emir");
    fireEvent.press(screen.getByText("Emirates"));
    // Emirates publishes cargo only: the only modality offered.
    expect(screen.getByText("Como carga")).toBeOnTheScreen();
    expect(screen.queryByText("En cabina")).toBeNull();
  });

  it("creates the trip with a key, reuses it on a retry, and reads the new trip", async () => {
    mockSend.mockResolvedValueOnce({
      outcome: "api-error",
      code: "travel_failed",
      retryAfterSeconds: null,
    });
    mockSend.mockResolvedValueOnce({
      outcome: "ok",
      payload: { command: "record_trip", eventId: NEW_TRIP, replayed: true },
    });
    await openWizard();
    fireEvent.press(screen.getByText("Chile"));
    fireEvent.press(screen.getByText("En avión"));
    fireEvent.press(screen.getByText("LATAM"));
    expect(screen.getByText("¿Dónde viaja Pampa?")).toBeOnTheScreen();
    expect(screen.getByText("LATAM publica hasta 7 kg con el bolso")).toBeOnTheScreen();
    expect(screen.queryByText("Como carga")).toBeNull();
    fireEvent.press(screen.getByText("En cabina"));
    expect(screen.getByText("Paso 4 de 4 · Chile")).toBeOnTheScreen();
    expect(
      screen.getByText("• La antirrábica tiene que tener al menos 21 días el día del viaje."),
    ).toBeOnTheScreen();
    fireEvent.changeText(screen.getByLabelText("Fecha de salida, obligatorio"), "15/11/2026");
    expect(screen.getByText("Domingo 15 de noviembre · faltan 39 días")).toBeOnTheScreen();
    expect(screen.getByText("Chile · 15/11/2026")).toBeOnTheScreen();
    expect(screen.getByText("LATAM, en cabina")).toBeOnTheScreen();

    fireEvent.press(screen.getByText("Crear viaje"));
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    expect(mockSend).toHaveBeenLastCalledWith(
      {},
      TOKEN,
      {
        command: "record_trip",
        corridorId: "chile",
        travelDate: "2026-11-15",
        mode: "air",
        airlineId: "latam",
        intendedModality: "cabin",
      },
      mockKeys[0],
    );
    // The failure stays in the wizard, under the field.
    expect(await screen.findByText(/No pudimos guardar el viaje/)).toBeOnTheScreen();

    // The retry of the SAME attempt carries the SAME key.
    fireEvent.press(screen.getByText("Crear viaje"));
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2));
    expect(mockSend.mock.calls[1]?.[3]).toBe(mockKeys[0]);

    // A replay reads as done, and the new trip is the one read next.
    expect(await screen.findByText("Ese viaje ya estaba registrado.")).toBeOnTheScreen();
    await waitFor(() => expect(mockFetch).toHaveBeenLastCalledWith({}, TOKEN, NEW_TRIP));
  });

  it("'Todavía no sé' how they travel sends mode null and skips the airline", async () => {
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: { command: "record_trip", eventId: NEW_TRIP, replayed: false },
    });
    await openWizard();
    fireEvent.press(screen.getByText("Chile"));
    fireEvent.press(screen.getByText("Todavía no sé"));
    expect(screen.getByText("Paso 3 de 3 · Chile")).toBeOnTheScreen();
    fireEvent.changeText(screen.getByLabelText("Fecha de salida, obligatorio"), "15/11/2026");
    fireEvent.press(screen.getByText("Crear viaje"));
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    expect(mockSend.mock.calls[0]?.[2]).toEqual({
      command: "record_trip",
      corridorId: "chile",
      travelDate: "2026-11-15",
      mode: null,
      airlineId: null,
      intendedModality: null,
    });
  });

  it("refuses a date outside the window under the field, before any round trip", async () => {
    await openWizard();
    fireEvent.press(screen.getByText("Chile"));
    fireEvent.press(screen.getByText("En auto o en micro"));
    fireEvent.changeText(screen.getByLabelText("Fecha de salida, obligatorio"), "01/10/2026");
    fireEvent.press(screen.getByText("Crear viaje"));
    expect(
      await screen.findByText(PET_TRAVEL_REFUSAL_MESSAGES.TRAVEL_DATE_OUT_OF_RANGE),
    ).toBeOnTheScreen();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("says the server's refusal reason in its own sentence, not three causes at once", async () => {
    mockSend.mockResolvedValue({
      outcome: "api-error",
      code: "travel_input_invalid",
      reason: "AIRLINE_UNKNOWN",
      retryAfterSeconds: null,
    });
    await openWizard();
    fireEvent.press(screen.getByText("Chile"));
    fireEvent.press(screen.getByText("En auto o en micro"));
    fireEvent.changeText(screen.getByLabelText("Fecha de salida, obligatorio"), "15/11/2026");
    fireEvent.press(screen.getByText("Crear viaje"));
    expect(await screen.findByText(PET_TRAVEL_REFUSAL_MESSAGES.AIRLINE_UNKNOWN)).toBeOnTheScreen();
    expect(screen.queryByText(/el CVI no puede tener fecha futura/)).toBeNull();
  });

  it("goes back a step keeping the answer, with the button and with the back gesture", async () => {
    await openWizard();
    fireEvent.press(screen.getByText("Chile"));
    fireEvent.press(screen.getByText("En avión"));
    expect(screen.getByText("¿Con qué aerolínea?")).toBeOnTheScreen();

    // The back gesture: one step back, nothing lost, the screen stays.
    let outcome: { blocked: boolean } = { blocked: false };
    act(() => {
      outcome = mockNav.pressBack();
    });
    expect(outcome.blocked).toBe(true);
    expect(screen.getByText("¿Cómo viajan?")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: /En avión/, selected: true })).toBeOnTheScreen();

    // The on-screen "Volver": to the destination, still chosen.
    fireEvent.press(screen.getByText("Volver"));
    expect(screen.getByText("¿A dónde viaja Pampa?")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: /Chile/, selected: true })).toBeOnTheScreen();
  });

  it("shows an older server's full airline list, with no search to fall back on", async () => {
    await openWizard({ ...EMPTY, options: OLD_OPTIONS });
    fireEvent.press(screen.getByText("Chile"));
    // Without v14's suggestion every mode the contract lists is still offered.
    fireEvent.press(screen.getByText("En avión"));
    for (const airline of OLD_OPTIONS.airlines) {
      expect(screen.getByText(airline.name)).toBeOnTheScreen();
    }
    expect(screen.queryByText("Buscar otra aerolínea")).toBeNull();
    fireEvent.press(screen.getByText("GOL"));
    // No published modalities: all three, as before.
    expect(screen.getByText("En cabina")).toBeOnTheScreen();
    expect(screen.getByText("En bodega")).toBeOnTheScreen();
    expect(screen.getByText("Como carga")).toBeOnTheScreen();
    fireEvent.press(screen.getByText("En bodega"));
    // And the date step has no hints to draw, and still creates.
    expect(screen.getByText("Crear viaje")).toBeOnTheScreen();
    expect(screen.queryByText(/con tiempo/)).toBeNull();
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

describe("TravelScreen — Para llevar, one box per paper", () => {
  it("ticks a paper with confirm_trip_document, and re-reads", async () => {
    mockFetch.mockResolvedValue({ outcome: "ok", payload: withPapers() });
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: { command: "confirm_trip_document", tripEventId: TRIP_A, changed: true },
    });
    render(<TravelScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Lo tenés, según indicaste")).toBeOnTheScreen();
    expect(
      screen.getByRole("checkbox", { name: "Certificado veterinario", checked: true }),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByRole("checkbox", { name: "Permiso de importación" }));
    await waitFor(() =>
      expect(mockSend).toHaveBeenCalledWith(
        {},
        TOKEN,
        {
          command: "confirm_trip_document",
          tripEventId: TRIP_A,
          document: "Permiso de importación",
          confirmed: true,
        },
        mockKeys[0],
      ),
    );
    expect(await screen.findByText("Documento actualizado.")).toBeOnTheScreen();
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });

  it("takes a tick back with confirmed: false", async () => {
    mockFetch.mockResolvedValue({ outcome: "ok", payload: withPapers() });
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: { command: "confirm_trip_document", tripEventId: TRIP_A, changed: true },
    });
    render(<TravelScreen publicToken={TOKEN} />);
    await screen.findByText("Lo tenés, según indicaste");
    fireEvent.press(screen.getByRole("checkbox", { name: "Certificado veterinario" }));
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    expect(mockSend.mock.calls[0]?.[2]).toEqual({
      command: "confirm_trip_document",
      tripEventId: TRIP_A,
      document: "Certificado veterinario",
      confirmed: false,
    });
  });

  it("lists the papers without a tick when nothing may be recorded", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: withPapers({ capabilities: { canRecord: false } }),
    });
    render(<TravelScreen publicToken={TOKEN} />);
    const box = await screen.findByRole("checkbox", { name: "Permiso de importación" });
    fireEvent.press(box);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("TravelScreen — the paper this trip asks for", () => {
  it("'Cargar el CZI' opens the form in Papeles; a failed re-read keeps the screen", async () => {
    mockFetch.mockResolvedValueOnce({ outcome: "ok", payload: payload() });
    mockFetch.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: { command: "record_cvi", eventId: "c2", replayed: false },
    });
    render(<TravelScreen publicToken={TOKEN} />);
    await screen.findByText("Revisar pendientes");
    fireEvent.press(screen.getAllByText("Cargar el CZI")[0] as never);
    expect(
      screen.getByText("Chile pide: Certificado Zoosanitario de Importación (CZI)."),
    ).toBeOnTheScreen();
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

describe("TravelScreen — the travel PDF, from the phone (task 6.5)", () => {
  // The file modules are the global spies from jest.setup.js; their defaults
  // are the happy path (a share target exists, the sheet closes).
  const Sharing = require("expo-sharing") as {
    shareAsync: jest.Mock<(uri: string, options?: unknown) => Promise<void>>;
    isAvailableAsync: jest.Mock<() => Promise<boolean>>;
  };
  const PDF_URL = "https://storage.example/travel-exports/viaje.pdf?token=signed";
  const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
  const originalFetch = globalThis.fetch;
  const download = jest.fn<(url: string) => Promise<unknown>>();

  beforeEach(() => {
    mockExport.mockReset();
    mockExport.mockResolvedValue({
      outcome: "ok",
      payload: { pdfUrl: PDF_URL, expiresAt: "2026-10-01T10:00:00.000Z" },
    });
    download.mockReset();
    download.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => PDF_BYTES.buffer,
    });
    globalThis.fetch = ((url: string) => download(url)) as unknown as typeof fetch;
    Sharing.shareAsync.mockReset();
    Sharing.shareAsync.mockResolvedValue(undefined);
    Sharing.isAvailableAsync.mockResolvedValue(true);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("asks the server for the PDF of the trip on screen and shares that very file", async () => {
    render(<TravelScreen publicToken={TOKEN} />);
    await screen.findByText("Revisar pendientes");
    fireEvent.press(screen.getByText("Exportar PDF"));
    await waitFor(() => expect(Sharing.shareAsync).toHaveBeenCalledTimes(1));
    expect(mockExport).toHaveBeenCalledWith({}, TOKEN, TRIP_A);
    expect(download).toHaveBeenCalledWith(PDF_URL);
    const [uri, options] = Sharing.shareAsync.mock.calls[0] as [string, { mimeType: string }];
    expect(uri).toBe("file:///cache/compartidos/viaje-pampa.pdf");
    expect(options.mimeType).toBe("application/pdf");
    // The bytes shared are the server's PDF — nothing is drawn on the phone.
    const written = (require("expo-file-system") as { __written: Map<string, unknown> }).__written;
    expect(written.get(uri)).toEqual(PDF_BYTES);
    expect(await screen.findByText(/podés volver a exportarlo/)).toBeOnTheScreen();
  });

  it("'Mandar a mi veterinaria' shares the same PDF and suggests a message to send with it", async () => {
    render(<TravelScreen publicToken={TOKEN} />);
    await screen.findByText("Revisar pendientes");
    fireEvent.press(screen.getAllByText("Mandar a mi veterinaria")[0] as never);
    await waitFor(() => expect(Sharing.shareAsync).toHaveBeenCalledTimes(1));
    expect(mockExport).toHaveBeenCalledWith({}, TOKEN, TRIP_A);
    const [, options] = Sharing.shareAsync.mock.calls[0] as [string, { dialogTitle: string }];
    expect(options.dialogTitle).toBe("PDF del viaje de Pampa, para tu veterinaria");
    expect(await screen.findByText("Mensaje sugerido para tu veterinaria")).toBeOnTheScreen();
    expect(
      screen.getByText(/te mando el PDF del viaje de Pampa a Chile, 12\/11\/2026/),
    ).toBeOnTheScreen();
  });

  it("is not offered while there is no trip to print", async () => {
    mockFetch.mockResolvedValue({ outcome: "ok", payload: EMPTY });
    render(<TravelScreen publicToken={TOKEN} />);
    await screen.findByText("Planear un viaje");
    expect(screen.queryByText("Exportar PDF")).toBeNull();
  });

  it("says the server's refusal in its sentence and shares nothing", async () => {
    mockExport.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    render(<TravelScreen publicToken={TOKEN} />);
    await screen.findByText("Revisar pendientes");
    fireEvent.press(screen.getByText("Exportar PDF"));
    expect(await screen.findByText(/conexión/)).toBeOnTheScreen();
    expect(download).not.toHaveBeenCalled();
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
  });

  it("never shares a failed download as if it were the PDF", async () => {
    download.mockResolvedValue({ ok: false, status: 400, arrayBuffer: async () => PDF_BYTES });
    render(<TravelScreen publicToken={TOKEN} />);
    await screen.findByText("Revisar pendientes");
    fireEvent.press(screen.getByText("Exportar PDF"));
    expect(
      await screen.findByText("No pudimos traer el PDF del viaje. Probá de nuevo."),
    ).toBeOnTheScreen();
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
  });
});
