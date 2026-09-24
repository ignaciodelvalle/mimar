// @vitest-environment jsdom
//
// LibroFilterFields — combined Provincia/Localidad + Desde/Hasta control for
// /admin/libro (ON-CHANGE follow-up, 2026-07-21: "¿por qué en libro tenemos
// que aplicar y en el resto no?"). These tests pin: no "Aplicar" button
// anywhere, EACH control commits on its own real change signal (province
// <select> onChange, locality onSelect/full-clear, DateInputAr's
// onValueChange), every commit preserves the OTHER three controls' current
// values, a province change clears any previously-picked locality in the
// SAME commit, and resetParamsOnChange (keyset cursor) is dropped.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalitySearchResult } from "@/lib/infra/ar-localidades";

const mockAssign = vi.fn();
const originalLocation = window.location;
const searchMock = vi.fn();

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

// LocalityPickerAcross (via JurisdictionFilter) imports this "use server"
// module, which transitively pulls in @/db — unavailable in unit tests.
vi.mock("@/app/actions/localities", () => ({
  searchLocalitiesAction: (input: { provinceCode?: string; query: string }) => searchMock(input),
  searchLocalitiesPublicAction: (input: { provinceCode?: string; query: string }) =>
    searchMock(input),
}));

import { LibroFilterFields } from "./LibroFilterFields";

function makeResult(
  localityName: string,
  provinceCode: string,
  provinceName: string,
  indecId: string,
): LocalitySearchResult {
  return {
    id: `id-${indecId}`,
    indecId,
    provinceCode: provinceCode as LocalitySearchResult["provinceCode"],
    departmentName: null,
    departmentCode: null,
    localityName,
    localitySlug: localityName.toLowerCase().replace(/\s+/g, "-"),
    category: "localidad",
    provinceName,
    matchKind: "exact",
  };
}

function setUrl(url: string) {
  window.history.replaceState(null, "", url);
  const current = new URL(url, "http://localhost");
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...originalLocation, ...current, assign: mockAssign },
  });
}

function committedUrl(basePath: string, callIndex = 0): URL {
  return new URL(mockAssign.mock.calls[callIndex][0] as string, `http://localhost${basePath}`);
}

beforeEach(() => {
  searchMock.mockReset();
  searchMock.mockResolvedValue({ results: [] });
  mockAssign.mockClear();
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

describe("<LibroFilterFields>", () => {
  it("renders no 'Aplicar' button — every control commits on change", () => {
    setUrl("/admin/libro");
    render(<LibroFilterFields />);
    expect(screen.queryByRole("button", { name: "Aplicar" })).toBeNull();
  });

  it("commits Provincia on change alone, preserving nothing else set", () => {
    setUrl("/admin/libro");
    render(<LibroFilterFields />);

    fireEvent.change(screen.getByLabelText("Provincia"), { target: { value: "Buenos Aires" } });

    expect(mockAssign).toHaveBeenCalledTimes(1);
    const url = committedUrl("/admin/libro");
    expect(url.searchParams.get("provincia")).toBe("Buenos Aires");
    expect(url.searchParams.get("localidad")).toBeNull();
  });

  it("changing Provincia clears an already-picked Localidad in the SAME commit", async () => {
    searchMock.mockResolvedValue({
      results: [makeResult("La Plata", "AR-B", "Buenos Aires", "06000010")],
    });
    setUrl("/admin/libro?provincia=Buenos+Aires&localidad=La+Plata");
    render(<LibroFilterFields provinceValue="Buenos Aires" localityValue="La Plata" />);

    fireEvent.change(screen.getByLabelText("Provincia"), { target: { value: "Córdoba" } });

    expect(mockAssign).toHaveBeenCalledTimes(1);
    const url = committedUrl("/admin/libro");
    expect(url.searchParams.get("provincia")).toBe("Córdoba");
    expect(url.searchParams.get("localidad")).toBeNull();
  });

  it("commits Localidad only once a real pick is made, preserving Provincia", async () => {
    searchMock.mockResolvedValue({
      results: [makeResult("La Plata", "AR-B", "Buenos Aires", "06000010")],
    });
    setUrl("/admin/libro?provincia=Buenos+Aires");
    render(<LibroFilterFields provinceValue="Buenos Aires" />);

    const locality = screen.getByLabelText(/Localidad/);
    fireEvent.change(locality, { target: { value: "La Pl" } });
    expect(mockAssign).not.toHaveBeenCalled();

    const option = await screen.findByText("La Plata");
    fireEvent.mouseDown(option);

    expect(mockAssign).toHaveBeenCalledTimes(1);
    const url = committedUrl("/admin/libro");
    expect(url.searchParams.get("provincia")).toBe("Buenos Aires");
    expect(url.searchParams.get("localidad")).toBe("La Plata");
  });

  it("clearing Localidad to empty commits the clear, preserving Provincia", async () => {
    setUrl("/admin/libro?provincia=Buenos+Aires&localidad=La+Plata");
    render(<LibroFilterFields provinceValue="Buenos Aires" localityValue="La Plata" />);

    const locality = screen.getByLabelText(/Localidad/);
    fireEvent.change(locality, { target: { value: "" } });

    expect(mockAssign).toHaveBeenCalledTimes(1);
    const url = committedUrl("/admin/libro");
    expect(url.searchParams.get("provincia")).toBe("Buenos Aires");
    expect(url.searchParams.get("localidad")).toBeNull();
  });

  it("does NOT commit while Localidad is only partially typed", () => {
    setUrl("/admin/libro?provincia=Buenos+Aires");
    render(<LibroFilterFields provinceValue="Buenos Aires" />);

    fireEvent.change(screen.getByLabelText(/Localidad/), { target: { value: "La Pl" } });

    expect(mockAssign).not.toHaveBeenCalled();
  });

  it("commits Desde on change, preserving Provincia/Localidad and Hasta", () => {
    setUrl("/admin/libro?provincia=Buenos+Aires&localidad=La+Plata");
    render(<LibroFilterFields provinceValue="Buenos Aires" localityValue="La Plata" />);

    fireEvent.change(screen.getByLabelText("Desde"), { target: { value: "01072026" } });

    expect(mockAssign).toHaveBeenCalledTimes(1);
    const url = committedUrl("/admin/libro");
    expect(url.searchParams.get("provincia")).toBe("Buenos Aires");
    expect(url.searchParams.get("localidad")).toBe("La Plata");
    expect(url.searchParams.get("desde")).toBe("2026-07-01");
    expect(url.searchParams.get("hasta")).toBeNull();
  });

  it("commits Hasta on change, preserving Desde's already-committed value", () => {
    setUrl("/admin/libro?desde=2026-07-01");
    render(<LibroFilterFields fromValue="2026-07-01" />);

    fireEvent.change(screen.getByLabelText("Hasta"), { target: { value: "15072026" } });

    const url = committedUrl("/admin/libro");
    expect(url.searchParams.get("desde")).toBe("2026-07-01");
    expect(url.searchParams.get("hasta")).toBe("2026-07-15");
  });

  it("does NOT commit while a date is only partially typed", () => {
    setUrl("/admin/libro");
    render(<LibroFilterFields />);
    fireEvent.change(screen.getByLabelText("Desde"), { target: { value: "1507" } });
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it("drops resetParamsOnChange keys (e.g. keyset cursor) on any commit", () => {
    setUrl("/admin/libro?cursor=abc123");
    render(<LibroFilterFields resetParamsOnChange={["cursor"]} />);

    fireEvent.change(screen.getByLabelText("Provincia"), { target: { value: "Buenos Aires" } });

    const url = committedUrl("/admin/libro");
    expect(url.searchParams.get("cursor")).toBeNull();
  });
});
