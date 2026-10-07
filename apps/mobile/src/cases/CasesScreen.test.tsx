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
import { caseDateLabel } from "./cases-view-model";

// The thumbs and severity tiles are hidden from the accessibility tree on
// purpose (the row label already says it all), so they are found only with
// hidden elements included. Without this a `queryBy…` asserting absence would
// pass vacuously.
const HIDDEN = { includeHiddenElements: true };

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

    // The history is collapsed until asked for.
    expect(screen.getByText("Historial")).toBeTruthy();
    expect(screen.queryByText("Denuncia de bienestar cerrada")).toBeNull();
    fireEvent.press(screen.getByRole("button", { name: /^Historial, 1 cerrado/ }));

    fireEvent.press(screen.getByText("Denuncia de bienestar cerrada"));
    expect(onOpenRoute).toHaveBeenCalledTimes(1);

    expect(screen.getByText(/Los anteriores se ven desde la web/)).toBeTruthy();
  });

  it("puts the owner's turn first, the earliest deadline on top", async () => {
    mockFetch.mockResolvedValue(
      ok({
        open: [
          aRow({ title: "Denuncia de bienestar animal", kind: "welfare_report_open" }),
          aRow({ title: "Sin plazo", needsAction: true, since: "2026-10-05T12:00:00.000Z" }),
          aRow({ title: "Plazo corto", needsAction: true, dueAt: "2026-10-09T15:00:00.000Z" }),
        ],
      }),
    );
    render(<CasesScreen onOpenRoute={jest.fn()} />);
    await screen.findByText("Te toca a vos");

    const order = [
      "Te toca a vos",
      "Plazo corto",
      "Sin plazo",
      "En curso",
      "Denuncia de bienestar animal",
    ];
    const texts = screen
      .getAllByText(/^(Te toca a vos|Plazo corto|Sin plazo|En curso|Denuncia de bienestar animal)$/)
      .map((n) => n.props.children);
    expect(texts).toEqual(order);
    expect(screen.getByText(/^Vence el /)).toBeTruthy();
  });

  it("gathers one pet's cases under the pet, with its photo and a count", async () => {
    const pampa = {
      petId: "DIM-PAMP-0001",
      petName: "Pampa",
      petPhotoUrl: "https://storage.test/pets/pampa.jpg",
      needsAction: true,
    };
    mockFetch.mockResolvedValue(
      ok({
        open: [
          aRow({ title: "Pampa está reportada como perdida", severity: "urgent", ...pampa }),
          aRow({ title: "Atestá la raza de Pampa", severity: "warning", ...pampa, route: null }),
        ],
      }),
    );
    const onOpenRoute = jest.fn();
    render(<CasesScreen onOpenRoute={onOpenRoute} />);

    expect(await screen.findByLabelText("Pampa, 2 casos")).toBeTruthy();
    // Named once, at the head — not again on each of her rows.
    expect(screen.getAllByText("Pampa")).toHaveLength(1);
    expect(screen.getAllByTestId("pet-thumb", HIDDEN)).toHaveLength(1);
    // The severity is drawn on every row, in its own tone.
    expect(screen.getByTestId("case-severity-urgent", HIDDEN)).toBeTruthy();
    expect(screen.getByTestId("case-severity-warning", HIDDEN)).toBeTruthy();
    // An inert row stays inert inside a cluster.
    fireEvent.press(screen.getByText("Atestá la raza de Pampa"));
    expect(onOpenRoute).not.toHaveBeenCalled();
  });

  it("draws an account-level row with no pet, and a single pet row with its pet inline", async () => {
    mockFetch.mockResolvedValue(
      ok({
        open: [
          aRow({ title: "Denuncia de bienestar animal", kind: "welfare_report_open" }),
          aRow({
            title: "Tu postulación para Luna",
            petId: "DIM-LUNA-0003",
            petName: "Luna",
            petPhotoUrl: null,
          }),
        ],
      }),
    );
    render(<CasesScreen onOpenRoute={jest.fn()} />);
    await screen.findByText("Denuncia de bienestar animal");
    expect(screen.getByText("Luna")).toBeTruthy();
    // The pet is part of what a screen reader hears for the row that shows it.
    expect(
      screen.getByRole("button", { name: /^Tu postulación para Luna\. .*Luna\./ }),
    ).toBeTruthy();
    // Luna has no photo: the paw stands in. The denuncia has no pet at all.
    expect(screen.getAllByTestId("pet-thumb-fallback", HIDDEN)).toHaveLength(1);
    expect(screen.queryByTestId("pet-thumb", HIDDEN)).toBeNull();
    expect(screen.getByText(/Nada pendiente de tu parte/)).toBeTruthy();
    expect(screen.getAllByTestId("case-severity-info", HIDDEN)).toHaveLength(2);
  });

  it("still draws a payload from a server that predates the grouping", async () => {
    const legacy = {
      kind: "pet_lost",
      title: "Pampa está reportada como perdida",
      subtitle: "Avisanos cuando aparezca",
      severity: "urgent",
      since: "2026-09-01T12:00:00.000Z",
      route: "/mascotas/DIM-PAMP-0001",
    } as unknown as MyCaseRowV1;
    mockFetch.mockResolvedValue(ok({ open: [legacy] }));
    render(<CasesScreen onOpenRoute={jest.fn()} />);
    expect(await screen.findByText("Pampa está reportada como perdida")).toBeTruthy();
    // The turn comes from the contract's table: a lost pet is the owner's.
    expect(screen.getByText("Te toca a vos")).toBeTruthy();
    expect(screen.queryByText("En curso")).toBeNull();
    expect(screen.queryByTestId("pet-thumb", HIDDEN)).toBeNull();
  });

  it("puts the date on the pet's line, not in a column of its own", async () => {
    // A right-hand date column took its width from the text and, at font scale
    // 1.3, squeezed the title into six lines. It now shares the meta line.
    mockFetch.mockResolvedValue(
      ok({
        open: [
          aRow({
            title: "Tu postulación para Luna",
            petId: "DIM-LUNA-0003",
            petName: "Luna",
          }),
        ],
      }),
    );
    render(<CasesScreen onOpenRoute={jest.fn()} />);
    await screen.findByText("Tu postulación para Luna");
    const date = screen.getByText(caseDateLabel("2026-09-01T12:00:00.000Z"));
    // The nearest host View above each text: the one meta line, for both.
    const lineOf = (node: typeof date) => {
      let at = node.parent;
      while (at !== null && (at.type as unknown) !== "View") at = at.parent;
      return at;
    };
    expect(lineOf(date)).not.toBeNull();
    expect(lineOf(date)).toBe(lineOf(screen.getByText("Luna")));
  });

  it("does not repeat 'Mis casos' in the body — the header says it", async () => {
    mockFetch.mockResolvedValue(ok());
    render(<CasesScreen onOpenRoute={jest.fn()} />);
    await screen.findByText("Sin casos abiertos");
    expect(screen.queryByText("Mis casos")).toBeNull();
  });
});
