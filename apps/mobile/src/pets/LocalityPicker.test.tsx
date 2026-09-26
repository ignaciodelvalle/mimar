// The province → locality cascade (L3·0 of the locality plan, PO decision
// 2026-09-08: web and mobile converge on the web's cascade). The picker asks for
// the province first, scopes the typeahead to it, and never offers a locality
// field before a province exists.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { useState } from "react";

const mockSearchLocalities = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("../api/endpoints", () => ({
  searchLocalities: (...args: unknown[]) => mockSearchLocalities(...args),
}));

import { LocalityPicker, type LocalitySelection } from "./LocalityPicker";

function Harness({ initialProvince = "" }: { initialProvince?: string }) {
  const [sel, setSel] = useState({ provinceCode: initialProvince, localityName: "" });
  return (
    <LocalityPicker
      provinceCode={sel.provinceCode}
      localityName={sel.localityName}
      onSelect={(s: LocalitySelection) =>
        setSel({ provinceCode: s.provinceCode, localityName: s.localityName })
      }
    />
  );
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["nextTick"] });
  mockSearchLocalities.mockReset();
  mockSearchLocalities.mockResolvedValue({
    outcome: "ok",
    payload: {
      payloadVersion: 1,
      issuedAt: "2026-09-22T12:00:00.000Z",
      staleAfter: "2026-09-22T12:05:00.000Z",
      results: [
        {
          localityName: "El Bolsón",
          localitySlug: "el-bolson",
          provinceCode: "AR-R",
          provinceName: "Río Negro",
          departmentName: "Bariloche",
          indecId: "62007010",
        },
      ],
    },
  });
});

describe("LocalityPicker — province first (L3·0)", () => {
  it("offers the 24 jurisdictions and NO locality field until a province is chosen", () => {
    render(<Harness />);
    expect(screen.getAllByRole("radio")).toHaveLength(24);
    expect(screen.queryByLabelText("Ciudad, pueblo o barrio, obligatorio")).toBeNull();
  });

  it("scopes the search to the chosen province", async () => {
    render(<Harness />);
    fireEvent.press(screen.getByRole("radio", { name: "Río Negro" }));
    expect(screen.getByText("Provincia: Río Negro")).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText("Ciudad, pueblo o barrio, obligatorio"), "Bols");
    await waitFor(() => expect(mockSearchLocalities).toHaveBeenCalled());
    expect(mockSearchLocalities).toHaveBeenCalledWith({
      q: "Bols",
      province: "AR-R",
      aliases: true,
    });
  });

  it("goes back to the province step on «Cambiar provincia»", () => {
    render(<Harness />);
    fireEvent.press(screen.getByRole("radio", { name: "Río Negro" }));
    fireEvent.press(screen.getByLabelText("Provincia: Río Negro. Tocá para cambiarla."));
    expect(screen.getAllByRole("radio")).toHaveLength(24);
    expect(screen.queryByLabelText("Ciudad, pueblo o barrio, obligatorio")).toBeNull();
  });

  it("lands on the locality search when the draft already carries a province", () => {
    render(<Harness initialProvince="AR-R" />);
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByText("Provincia: Río Negro")).toBeTruthy();
    expect(screen.getByLabelText("Ciudad, pueblo o barrio, obligatorio")).toBeTruthy();
  });

  it("offers an alias by the name people use and hands back its catalogue row", async () => {
    const lomas = {
      localityName: "Lomas de Zamora",
      localitySlug: "lomas-de-zamora",
      provinceCode: "AR-B",
      provinceName: "Buenos Aires",
      departmentName: "Lomas de Zamora",
      indecId: "06490010",
    };
    mockSearchLocalities.mockResolvedValue({
      outcome: "ok",
      payload: {
        payloadVersion: 1,
        issuedAt: "2026-09-22T12:00:00.000Z",
        staleAfter: "2026-09-22T12:05:00.000Z",
        results: [{ ...lomas, aliasName: "Banfield" }, lomas],
      },
    });
    const onSelect = jest.fn<(s: LocalitySelection) => void>();
    function AliasHarness() {
      const [sel, setSel] = useState({ provinceCode: "AR-B", localityName: "" });
      return (
        <LocalityPicker
          provinceCode={sel.provinceCode}
          localityName={sel.localityName}
          onSelect={(s) => {
            onSelect(s);
            setSel({ provinceCode: s.provinceCode, localityName: s.localityName });
          }}
        />
      );
    }
    render(<AliasHarness />);
    fireEvent.changeText(screen.getByLabelText("Ciudad, pueblo o barrio, obligatorio"), "Banf");
    fireEvent.press(await screen.findByText("Banfield (Lomas de Zamora)", {}, { timeout: 3000 }));

    // The stored locality is the catalogue row — never the alias.
    expect(onSelect).toHaveBeenCalledWith({
      provinceCode: "AR-B",
      provinceName: "Buenos Aires",
      localityName: "Lomas de Zamora",
      localityIndecId: "06490010",
      departmentName: "Lomas de Zamora",
    });
    // The chip says it the way the person chose it, and which partido governs it.
    expect(screen.getByText("Banfield")).toBeTruthy();
    expect(screen.getByText("partido de Lomas de Zamora, Buenos Aires")).toBeTruthy();
  });

  it("keeps the province when the person changes the chosen locality", async () => {
    render(<Harness />);
    fireEvent.press(screen.getByRole("radio", { name: "Río Negro" }));
    fireEvent.changeText(screen.getByLabelText("Ciudad, pueblo o barrio, obligatorio"), "Bols");
    fireEvent.press(await screen.findByText("El Bolsón", {}, { timeout: 3000 }));
    fireEvent.press(screen.getByText("Cambiar"));
    expect(screen.getByText("Provincia: Río Negro")).toBeTruthy();
    expect(screen.getByLabelText("Ciudad, pueblo o barrio, obligatorio")).toBeTruthy();
  });
});

describe("LocalityPicker — the home-locality chip (PO, 2026-09-26)", () => {
  const BOLSON = {
    provinceCode: "AR-R",
    provinceName: "Río Negro",
    localityName: "El Bolsón",
    localityIndecId: "62007010",
    departmentName: "Bariloche",
  };
  const CHIP = "Usar El Bolsón, donde vive Pampa";

  function ChipHarness({
    onSelect,
    withSuggestion = true,
  }: {
    onSelect: (s: LocalitySelection) => void;
    withSuggestion?: boolean;
  }) {
    const [sel, setSel] = useState({ provinceCode: "", localityName: "" });
    return (
      <LocalityPicker
        required={false}
        provinceCode={sel.provinceCode}
        localityName={sel.localityName}
        suggestion={withSuggestion ? { locality: BOLSON, petName: "Pampa" } : null}
        onSelect={(s) => {
          onSelect(s);
          setSel({ provinceCode: s.provinceCode, localityName: s.localityName });
        }}
      />
    );
  }

  it("shows no chip without a suggestion", () => {
    render(<ChipHarness onSelect={jest.fn()} withSuggestion={false} />);
    expect(screen.queryByLabelText(/donde vive/)).toBeNull();
  });

  it("offers the chip as a button and selects nothing until it is tapped", () => {
    const onSelect = jest.fn<(s: LocalitySelection) => void>();
    render(<ChipHarness onSelect={onSelect} />);
    expect(screen.getByRole("button", { name: CHIP })).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
    // Still the province step: nothing chosen for the person.
    expect(screen.getAllByRole("radio")).toHaveLength(24);
  });

  it("a tap hands back exactly what tapping the same row in the list does", async () => {
    const viaChip = jest.fn<(s: LocalitySelection) => void>();
    const first = render(<ChipHarness onSelect={viaChip} />);
    fireEvent.press(screen.getByRole("button", { name: CHIP }));
    // Collapsed to the chosen row, with its department, like a list pick.
    expect(screen.getByText("El Bolsón")).toBeTruthy();
    expect(screen.getByText("departamento Bariloche, Río Negro")).toBeTruthy();
    first.unmount();

    const viaList = jest.fn<(s: LocalitySelection) => void>();
    render(<ChipHarness onSelect={viaList} withSuggestion={false} />);
    fireEvent.press(screen.getByRole("radio", { name: "Río Negro" }));
    fireEvent.changeText(screen.getByLabelText("Ciudad, pueblo o barrio"), "Bols");
    fireEvent.press(await screen.findByText("El Bolsón", {}, { timeout: 3000 }));

    expect(viaChip).toHaveBeenCalledTimes(1);
    expect(viaChip.mock.calls[0]?.[0]).toEqual(viaList.mock.calls[0]?.[0]);
  });
});
