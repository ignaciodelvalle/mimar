import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";

import type { MyWelfareReportRowV1, MyWelfareReportsV1 } from "@dim/contract/api";

const mockFetch = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("expo-router", () => ({
  useFocusEffect: (callback: () => void) => {
    const { useEffect } = require("react");
    useEffect(() => {
      callback();
    }, [callback]);
  },
}));

jest.mock("../api/endpoints", () => ({
  fetchMyWelfareReports: (...args: unknown[]) => mockFetch(...args),
}));

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: { addEventListener: () => () => undefined },
}));
jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import { MyReportsScreen } from "./MyReportsScreen";

function aRow(over: Partial<MyWelfareReportRowV1> = {}): MyWelfareReportRowV1 {
  return {
    referenceCode: "DEN-AAAA-0001",
    kindLabel: "Animal encadenado o sin movilidad",
    severityLabel: "Urgente",
    status: "in_progress",
    statusLabel: "En curso",
    excerpt: "Perro encadenado sin agua.",
    filedAt: "2026-09-20T12:00:00.000Z",
    place: "Tandil, Buenos Aires",
    ...over,
  };
}

function ok(over: Partial<MyWelfareReportsV1> = {}) {
  return {
    outcome: "ok" as const,
    payload: {
      payloadVersion: 1,
      issuedAt: "2026-09-25T00:00:00.000Z",
      staleAfter: "2026-09-25T00:01:00.000Z",
      reports: [],
      nextCursor: null,
      ...over,
    },
  };
}

function renderScreen() {
  const onOpenReport = jest.fn();
  const onNewReport = jest.fn();
  render(<MyReportsScreen onOpenReport={onOpenReport} onNewReport={onNewReport} />);
  return { onOpenReport, onNewReport };
}

describe("MyReportsScreen", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("lists each denuncia with the status the server named", async () => {
    mockFetch.mockResolvedValue(ok({ reports: [aRow()] }));
    const { onOpenReport } = renderScreen();

    expect(await screen.findByText("Animal encadenado o sin movilidad")).toBeTruthy();
    expect(screen.getByText("En curso")).toBeTruthy();
    expect(screen.getByText("1 denuncia enviada.")).toBeTruthy();

    fireEvent.press(screen.getByText("Perro encadenado sin agua."));
    expect(onOpenReport).toHaveBeenCalledWith("DEN-AAAA-0001");
  });

  it("says why an anonymous denuncia is not in the list", async () => {
    mockFetch.mockResolvedValue(ok());
    renderScreen();
    expect(await screen.findByText("Aún no enviaste denuncias.")).toBeTruthy();
    expect(screen.getByText("¿Enviaste una denuncia anónima?")).toBeTruthy();
  });

  it("never draws a failed read as an empty list", async () => {
    mockFetch.mockResolvedValue({
      outcome: "api-error",
      code: "temporarily_unavailable",
      retryAfterSeconds: 5,
    });
    renderScreen();
    expect(await screen.findByText("Reintentar")).toBeTruthy();
    expect(screen.queryByText("Aún no enviaste denuncias.")).toBeNull();
  });

  it("appends the next page with the server's own cursor", async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ reports: [aRow()], nextCursor: "CURSOR-1" }))
      .mockResolvedValueOnce(
        ok({ reports: [aRow({ referenceCode: "DEN-AAAA-0002", excerpt: "Segunda." })] }),
      );
    renderScreen();

    fireEvent.press(await screen.findByText("Mostrar más"));
    expect(await screen.findByText("Segunda.")).toBeTruthy();
    // Appended, not replaced.
    expect(screen.getByText("Perro encadenado sin agua.")).toBeTruthy();
    expect(mockFetch.mock.calls[1]?.[1]).toBe("CURSOR-1");
    expect(screen.queryByText("Mostrar más")).toBeNull();
  });
});
