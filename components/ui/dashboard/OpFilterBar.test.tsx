// @vitest-environment jsdom
//
// OpFilterBar — the unified dashboard filter bar. These tests assert the three
// KEY deliverables of the shared component (the pilots — /gob/perdidas and
// /gob/maltrato — are thin wiring over it):
//   1. Domain axes commit their searchParam (species; kind/severity/status).
//   2. Active-filter chips render for active non-default filters and remove them.
//   3. "Limpiar todo" resets every owned param to its default.
// Every mutation must go through the sanctioned full-document navigation
// (window.location.assign) — never a client-router method (router-drop defect,
// engram #621/#622). Same mock harness as PeriodPicker.test.tsx.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routerPush = vi.fn();
const routerReplace = vi.fn();
const routerRefresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace, refresh: routerRefresh }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

import { type OpFilterAxis, OpFilterBar } from "./OpFilterBar";

const mockAssign = vi.fn();
const originalLocation = window.location;

function setUrl(url: string) {
  window.history.replaceState(null, "", url);
  const current = new URL(url, "http://localhost");
  // jsdom's real location.assign isn't spy-able — replace the whole object with
  // a stub exposing the fields the component + useSearchParams mock read.
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...originalLocation, ...current, assign: mockAssign },
  });
}

function committedUrl(): URL {
  return new URL(mockAssign.mock.calls[0][0] as string, "http://localhost/gob/perdidas");
}

const SPECIES_AXIS: OpFilterAxis = {
  id: "species",
  label: "Especie",
  paramKey: "species",
  options: [
    { value: "dog", label: "Perro" },
    { value: "cat", label: "Gato" },
    { value: "other", label: "Otra" },
  ],
  current: null,
};

const PROVINCES = [{ code: "AR-B", name: "Buenos Aires" }];

beforeEach(() => {
  routerPush.mockClear();
  routerReplace.mockClear();
  routerRefresh.mockClear();
  mockAssign.mockClear();
  setUrl("/gob/perdidas");
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

describe("OpFilterBar — domain axis (perdidas: species)", () => {
  it("renders the species select and its options", () => {
    render(<OpFilterBar axes={[SPECIES_AXIS]} />);
    const select = screen.getByLabelText("Especie");
    expect(select).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Perro" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Gato" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Otra" })).toBeInTheDocument();
  });

  it("selecting a species commits ?species= via full navigation", () => {
    render(<OpFilterBar axes={[SPECIES_AXIS]} />);
    fireEvent.change(screen.getByLabelText("Especie"), { target: { value: "dog" } });

    expect(mockAssign).toHaveBeenCalledTimes(1);
    expect(committedUrl().searchParams.get("species")).toBe("dog");
    // Never a client-router transition.
    expect(routerReplace).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it("selecting the 'all' option removes the species param", () => {
    setUrl("/gob/perdidas?species=dog");
    render(<OpFilterBar axes={[{ ...SPECIES_AXIS, current: "dog" }]} />);
    fireEvent.change(screen.getByLabelText("Especie"), { target: { value: "" } });

    expect(committedUrl().searchParams.has("species")).toBe(false);
  });
});

describe("OpFilterBar — domain axes (maltrato: kind / severity / status)", () => {
  const axes: OpFilterAxis[] = [
    {
      id: "kind",
      label: "Tipo",
      paramKey: "kind",
      options: [{ value: "abandonment", label: "Abandono" }],
      current: null,
      allLabel: "Todos",
    },
    {
      id: "severity",
      label: "Severidad",
      paramKey: "severity",
      options: [{ value: "critical", label: "Crítica" }],
      current: null,
      allLabel: "Todas",
    },
    {
      id: "status",
      label: "Estado",
      paramKey: "status",
      options: [{ value: "open", label: "Abierta" }],
      current: null,
      allLabel: "Todos",
    },
  ];

  it("each axis commits its own param", () => {
    setUrl("/gob/maltrato");
    render(<OpFilterBar axes={axes} resetParamsOnChange={["cursor"]} />);

    fireEvent.change(screen.getByLabelText("Tipo"), { target: { value: "abandonment" } });
    expect(committedUrl().searchParams.get("kind")).toBe("abandonment");
    mockAssign.mockClear();

    fireEvent.change(screen.getByLabelText("Severidad"), { target: { value: "critical" } });
    expect(
      new URL(mockAssign.mock.calls[0][0] as string, "http://localhost").searchParams.get(
        "severity",
      ),
    ).toBe("critical");
    mockAssign.mockClear();

    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "open" } });
    expect(
      new URL(mockAssign.mock.calls[0][0] as string, "http://localhost").searchParams.get("status"),
    ).toBe("open");
  });

  it("a filter change drops the keyset cursor (resetParamsOnChange)", () => {
    setUrl("/gob/maltrato?cursor=abc123");
    render(<OpFilterBar axes={axes} resetParamsOnChange={["cursor"]} />);

    fireEvent.change(screen.getByLabelText("Tipo"), { target: { value: "abandonment" } });
    const url = new URL(mockAssign.mock.calls[0][0] as string, "http://localhost");
    expect(url.searchParams.get("kind")).toBe("abandonment");
    expect(url.searchParams.has("cursor")).toBe(false);
  });
});

describe("OpFilterBar — active-filter chips + Limpiar todo", () => {
  it("renders a chip per active non-default filter (period, jurisdiction, axis)", () => {
    setUrl("/gob/perdidas?period=90d&province=AR-B&species=dog");
    render(
      <OpFilterBar
        period={{ defaultPreset: "30d" }}
        jurisdiction={{ allowedProvinces: PROVINCES }}
        axes={[{ ...SPECIES_AXIS, current: "dog" }]}
      />,
    );

    expect(screen.getByRole("button", { name: /Quitar filtro: Período: 90 días/ })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Quitar filtro: Provincia: Buenos Aires/ }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Quitar filtro: Especie: Perro/ })).toBeTruthy();
  });

  it("does NOT render a chip when the period equals its default", () => {
    setUrl("/gob/perdidas?period=30d");
    render(<OpFilterBar period={{ defaultPreset: "30d" }} axes={[SPECIES_AXIS]} />);
    expect(screen.queryByText(/Filtros activos/)).toBeNull();
  });

  it("removing a chip clears just that param", () => {
    setUrl("/gob/perdidas?period=90d&species=dog");
    render(
      <OpFilterBar
        period={{ defaultPreset: "30d" }}
        axes={[{ ...SPECIES_AXIS, current: "dog" }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Quitar filtro: Especie: Perro/ }));
    const url = committedUrl();
    expect(url.searchParams.has("species")).toBe(false);
    // The period filter is untouched.
    expect(url.searchParams.get("period")).toBe("90d");
  });

  it("says the jurisdiction param was not recognized in BOTH viewports (red-team #4)", () => {
    // ?province=CABA is a NAME, not the ISO code AR-C — fail-closed resolution
    // narrows nothing and renders no chip. Neither viewport may affirmatively
    // claim there are no filters while the URL carries one: the <md collapsed
    // summary AND the >=md notice row must both surface the same copy (before
    // the fix, desktop silently fell back mandate-wide with no message).
    setUrl("/gob/perdidas?province=CABA");
    render(
      <OpFilterBar showPeriod={false} jurisdiction={{ allowedProvinces: PROVINCES }} axes={[]} />,
    );
    expect(
      screen.getAllByText("Filtro no reconocido — mostrando tu cobertura completa"),
    ).toHaveLength(2);
    expect(screen.queryByText("Sin filtros activos")).toBeNull();
  });

  it("flags an unresolvable locality slug too, in both viewports, even with the period fallback", () => {
    setUrl("/gob/perdidas?locality=Palermo");
    render(
      <OpFilterBar
        period={{ defaultPreset: "30d" }}
        jurisdiction={{
          allowedProvinces: PROVINCES,
          localities: [{ slug: "la-plata", name: "La Plata" }],
        }}
        axes={[]}
      />,
    );
    expect(
      screen.getAllByText("Filtro no reconocido — mostrando tu cobertura completa"),
    ).toHaveLength(2);
  });

  it("renders NO unresolved-filter notice anywhere when the jurisdiction param resolves", () => {
    setUrl("/gob/perdidas?province=AR-B");
    render(
      <OpFilterBar showPeriod={false} jurisdiction={{ allowedProvinces: PROVINCES }} axes={[]} />,
    );
    expect(screen.queryByText("Filtro no reconocido — mostrando tu cobertura completa")).toBeNull();
  });

  it("mobile summary keeps 'Sin filtros activos' when no jurisdiction param is in the URL", () => {
    setUrl("/gob/perdidas");
    render(
      <OpFilterBar showPeriod={false} jurisdiction={{ allowedProvinces: PROVINCES }} axes={[]} />,
    );
    expect(screen.getByText("Sin filtros activos")).toBeTruthy();
  });

  it("'Limpiar todo' resets every owned param", () => {
    setUrl("/gob/perdidas?period=90d&province=AR-B&locality=la-plata&species=dog");
    render(
      <OpFilterBar
        period={{ defaultPreset: "30d" }}
        jurisdiction={{
          allowedProvinces: PROVINCES,
          localities: [{ slug: "la-plata", name: "La Plata" }],
        }}
        axes={[{ ...SPECIES_AXIS, current: "dog" }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Limpiar todo" }));
    const url = committedUrl();
    expect(url.searchParams.has("period")).toBe(false);
    expect(url.searchParams.has("province")).toBe(false);
    expect(url.searchParams.has("locality")).toBe(false);
    expect(url.searchParams.has("species")).toBe(false);
  });
});
