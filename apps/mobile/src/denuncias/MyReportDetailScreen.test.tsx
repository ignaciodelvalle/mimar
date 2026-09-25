import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";

import type { MyWelfareReportDetailV1 } from "@dim/contract/api";

const mockFetch = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("../api/endpoints", () => ({
  fetchMyWelfareReport: (...args: unknown[]) => mockFetch(...args),
}));

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: { addEventListener: () => () => undefined },
}));
jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import { MyReportDetailScreen } from "./MyReportDetailScreen";

function detail(over: Partial<MyWelfareReportDetailV1> = {}): MyWelfareReportDetailV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-09-25T00:00:00.000Z",
    staleAfter: "2026-09-25T00:01:00.000Z",
    referenceCode: "DEN-AAAA-0001",
    kindLabel: "Animal encadenado o sin movilidad",
    severity: "high",
    severityLabel: "Urgente",
    status: "in_progress",
    statusLabel: "En curso",
    notice: { tone: "info", text: "En revisión por la autoridad." },
    filedAt: "2026-09-20T12:00:00.000Z",
    occurredAt: null,
    description: "Perro encadenado sin agua desde hace días.",
    subject: { label: "Animal sin dueño identificado", pet: null, description: null },
    place: { address: "Calle 1 234", jurisdiction: "Tandil, Buenos Aires", point: null },
    contact: { email: "yo@example.test", phone: null },
    evidence: [],
    comments: [{ text: "Sigue atado en el patio", at: "2026-09-21T12:00:00.000Z" }],
    case: { publicCode: "CAS-AAAA-0001", route: "/casos/CAS-AAAA-0001" },
    constanciaUrl: "https://example.test/denuncias/codigo/DEN-AAAA-0001",
    ...over,
  };
}

describe("MyReportDetailScreen", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("asks for the denuncia it was given and draws it in the server's words", async () => {
    const onOpenRoute = jest.fn();
    mockFetch.mockResolvedValue({ outcome: "ok", payload: detail() });
    render(<MyReportDetailScreen referenceCode="DEN-AAAA-0001" onOpenRoute={onOpenRoute} />);

    expect(await screen.findByText("Animal encadenado o sin movilidad")).toBeTruthy();
    expect(mockFetch.mock.calls[0]?.[0]).toBe("DEN-AAAA-0001");
    expect(screen.getByText("En curso")).toBeTruthy();
    expect(screen.getByText("En revisión por la autoridad.")).toBeTruthy();
    expect(screen.getByText("Perro encadenado sin agua desde hace días.")).toBeTruthy();
    expect(screen.getByText("Sigue atado en el patio")).toBeTruthy();
    expect(screen.getByText("Tandil, Buenos Aires")).toBeTruthy();

    fireEvent.press(screen.getByText("Ver caso CAS-AAAA-0001"));
    expect(onOpenRoute).toHaveBeenCalledWith("/casos/CAS-AAAA-0001");
  });

  it("draws no banner for a closed denuncia", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: detail({ status: "closed", statusLabel: "Cerrada", notice: null }),
    });
    render(<MyReportDetailScreen referenceCode="DEN-AAAA-0001" onOpenRoute={jest.fn()} />);
    expect(await screen.findByText("Cerrada")).toBeTruthy();
    expect(screen.queryByText("En revisión por la autoridad.")).toBeNull();
  });

  it("says not found in ONE sentence, and names the anonymous case in it", async () => {
    mockFetch.mockResolvedValue({
      outcome: "api-error",
      code: "not_found",
      retryAfterSeconds: null,
    });
    render(<MyReportDetailScreen referenceCode="DEN-NONE-0000" onOpenRoute={jest.fn()} />);
    expect(
      await screen.findByText(/No encontramos esta denuncia en tu cuenta\. Las denuncias anónimas/),
    ).toBeTruthy();
  });
});
