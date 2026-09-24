import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";

import type { MyCaseRowV1, MyCasesV1 } from "@dim/contract/api";

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
  fetchMyCases: (...args: unknown[]) => mockFetch(...args),
}));

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: { addEventListener: () => () => undefined },
}));
jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import { CasesScreen } from "./CasesScreen";

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

function ok(over: Partial<MyCasesV1> = {}) {
  return {
    outcome: "ok" as const,
    payload: {
      payloadVersion: 1,
      issuedAt: "2026-09-24T00:00:00.000Z",
      staleAfter: "2026-09-24T00:01:00.000Z",
      open: [],
      history: { rows: [], hasMore: false },
      ...over,
    } satisfies MyCasesV1,
  };
}

describe("CasesScreen", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("says a failed read failed — never that nothing is open", async () => {
    mockFetch.mockResolvedValue({ outcome: "unreachable" });
    render(<CasesScreen onOpenRoute={jest.fn()} />);
    expect(await screen.findByText("Reintentar")).toBeTruthy();
    expect(screen.queryByText("Sin casos abiertos")).toBeNull();
  });

  it("states an empty account as empty, and hides an empty history", async () => {
    mockFetch.mockResolvedValue(ok());
    render(<CasesScreen onOpenRoute={jest.fn()} />);
    expect(await screen.findByText("Sin casos abiertos")).toBeTruthy();
    expect(screen.queryByText("Historial")).toBeNull();
  });

  it("opens a row through the route the server resolved, and only that", async () => {
    const onOpenRoute = jest.fn();
    mockFetch.mockResolvedValue(
      ok({
        open: [aRow()],
        history: {
          rows: [aRow({ title: "Denuncia de bienestar cerrada", route: null })],
          hasMore: true,
        },
      }),
    );
    render(<CasesScreen onOpenRoute={onOpenRoute} />);

    fireEvent.press(await screen.findByText("Caso CAS-TEST-0001 · Pampa"));
    expect(onOpenRoute).toHaveBeenCalledWith("/casos/CAS-TEST-0001");

    fireEvent.press(screen.getByText("Denuncia de bienestar cerrada"));
    expect(onOpenRoute).toHaveBeenCalledTimes(1);

    expect(screen.getByText("Historial")).toBeTruthy();
    expect(screen.getByText(/Los anteriores se ven desde la web/)).toBeTruthy();
  });
});
