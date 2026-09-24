import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";

import type { MyCaseCaretakerOnlyV1, MyCaseReadableV1 } from "@dim/contract/api";

const mockFetch = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("../api/endpoints", () => ({
  fetchMyCase: (...args: unknown[]) => mockFetch(...args),
}));

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: { addEventListener: () => () => undefined },
}));
jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import { CaseDetailScreen, caseFailureMessage } from "./CaseDetailScreen";

const ENVELOPE = {
  payloadVersion: 1 as const,
  issuedAt: "2026-09-24T00:00:00.000Z",
  staleAfter: "2026-09-24T00:01:00.000Z",
};

function readable(over: Partial<MyCaseReadableV1> = {}): MyCaseReadableV1 {
  return {
    ...ENVELOPE,
    access: "full",
    publicCode: "CAS-TEST-0001",
    kindLabel: "Mordedura",
    status: "open",
    statusLabel: "Abierto",
    openedAt: "2026-09-01T12:00:00.000Z",
    closedAt: null,
    openedReason: "Mordedura denunciada en la vía pública",
    jurisdiction: "Tandil, Buenos Aires",
    subject: {
      kind: "pet",
      name: "Pampa",
      speciesLine: "Perro · Hembra",
      photoUrl: null,
      route: "/mascotas/DIM-PAMP-0001",
    },
    parties: [{ role: "opener", roleLabel: "Abrió", name: "Operadora Municipal" }],
    normatives: [],
    timeline: [
      {
        label: "Nota",
        occurredAt: "2026-09-02T12:00:00.000Z",
        summary: null,
        notes: "Se citó a la titular.",
      },
    ],
    ...over,
  };
}

describe("CaseDetailScreen", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("asks for the case it was given", async () => {
    mockFetch.mockResolvedValue({ outcome: "ok", payload: readable() });
    render(<CaseDetailScreen publicCode="CAS-TEST-0001" onOpenRoute={jest.fn()} />);
    await screen.findByText("Mordedura");
    expect(mockFetch.mock.calls[0]?.[0]).toBe("CAS-TEST-0001");
  });

  it("draws the case the server sent, in its words", async () => {
    const onOpenRoute = jest.fn();
    mockFetch.mockResolvedValue({ outcome: "ok", payload: readable() });
    render(<CaseDetailScreen publicCode="CAS-TEST-0001" onOpenRoute={onOpenRoute} />);

    expect(await screen.findByText("Mordedura")).toBeTruthy();
    expect(screen.getByText("CAS-TEST-0001 · Abierto")).toBeTruthy();
    expect(screen.getByText("Tandil, Buenos Aires")).toBeTruthy();
    expect(screen.getByText("Operadora Municipal")).toBeTruthy();
    expect(screen.getByText("Mordedura denunciada en la vía pública")).toBeTruthy();
    expect(screen.getByText("Se citó a la titular.")).toBeTruthy();

    fireEvent.press(screen.getByText("Ver mascota"));
    expect(onOpenRoute).toHaveBeenCalledWith("/mascotas/DIM-PAMP-0001");
  });

  it("tells a caretaker the case is the titular's — not that it does not exist", async () => {
    const caretaker: MyCaseCaretakerOnlyV1 = {
      ...ENVELOPE,
      access: "caretaker_only",
      pet: { name: "Pampa", route: "/mascotas/DIM-PAMP-0001" },
    };
    mockFetch.mockResolvedValue({ outcome: "ok", payload: caretaker });
    render(<CaseDetailScreen publicCode="CAS-TEST-0001" onOpenRoute={jest.fn()} />);
    expect(await screen.findByText("Caso no disponible para cuidadores")).toBeTruthy();
    expect(screen.queryByText("Línea de tiempo")).toBeNull();
  });

  it("says a case that is not theirs is not found, in a sentence about a case", async () => {
    mockFetch.mockResolvedValue({
      outcome: "api-error",
      code: "not_found",
      retryAfterSeconds: null,
    });
    render(<CaseDetailScreen publicCode="CAS-NONE-0000" onOpenRoute={jest.fn()} />);
    expect(
      await screen.findByText("No encontramos este caso, o no está en tu cuenta."),
    ).toBeTruthy();
  });

  it("hands every other failure to the shared copy", () => {
    const rateLimited = caseFailureMessage({
      outcome: "api-error",
      code: "rate_limited",
      retryAfterSeconds: 30,
    });
    expect(rateLimited).toContain("30 segundos");
  });
});
