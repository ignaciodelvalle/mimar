// @vitest-environment jsdom
//
// C2 (Tanda A): Villa María is a cross-province homonym in the real INDEC
// catalog — AR-B / Alberti / "localidad" (a real town in Buenos Aires) and
// AR-X / General San Martín / "componente" (the INDEC agglomerate component
// for Villa María, Córdoba). Both rows are real, verified against the local
// `ar_localities` catalog (see __tests__/ar-localidades.test.ts). An admin on
// /admin/govts/new or the operator jurisdiction assignment form must be able
// to tell them apart AND pick the Córdoba 'componente' row — 'componente' is
// a real city here, not CABA's whole-province aggregate.
//
// The picker is exercised through its public props only; the search action is
// injected so no server action or DB call runs in this test.

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AssignLocalityForm } from "@/app/admin/govts/_components/AssignLocalityForm";
import { LocalityPickerAcross } from "@/components/LocalityPickerAcross";
import type { LocalitySearchResult } from "@/lib/infra/ar-localidades";

vi.mock("@/app/actions/localities", () => ({
  searchLocalitiesAction: vi.fn(async () => ({ results: [] })),
}));

const assignGovtLocalityAction = vi.fn(async (_input: unknown) => ({ ok: true }));
vi.mock("@/app/actions/admin-institutional", () => ({
  assignGovtLocalityAction: (input: unknown) => assignGovtLocalityAction(input),
}));

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// Transcribed verbatim from the live local `ar_localities` catalog
// (2026-09-23 — see __tests__/ar-localidades.test.ts for the DB-backed pin).
const VILLA_MARIA_BA = {
  indecId: "06021060",
  localityName: "Villa María",
  localitySlug: "villa-maria",
  provinceCode: "AR-B",
  provinceName: "Buenos Aires",
  departmentName: "Alberti",
  category: "localidad",
} as LocalitySearchResult;

const VILLA_MARIA_CBA = {
  indecId: "14042170",
  localityName: "Villa María",
  localitySlug: "villa-maria",
  provinceCode: "AR-X",
  provinceName: "Córdoba",
  departmentName: "General San Martín",
  category: "componente",
} as LocalitySearchResult;

async function searchVillaMaria(
  searchAction = vi.fn(async () => ({ results: [VILLA_MARIA_BA, VILLA_MARIA_CBA] })),
) {
  vi.useFakeTimers();
  render(<LocalityPickerAcross id="t" searchAction={searchAction} />);
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "Villa María" } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  fireEvent.focus(input);
  return { input };
}

describe("LocalityPickerAcross — Villa María cross-province homonym (C2)", () => {
  it("shows BOTH entries with their province/department visible so an admin can tell them apart", async () => {
    await searchVillaMaria();
    const list = screen.getByRole("listbox");
    // Both rows render — two distinct list items, not deduped by name.
    const items = within(list).getAllByText("Villa María");
    expect(items).toHaveLength(2);
    expect(within(list).getByText(/Alberti, Buenos Aires/)).toBeInTheDocument();
    expect(within(list).getByText(/General San Martín, Córdoba/)).toBeInTheDocument();
  });

  it("picking the Córdoba 'componente' row is not blocked by its category", async () => {
    const onSelect = vi.fn();
    vi.useFakeTimers();
    const searchAction = vi.fn(async () => ({ results: [VILLA_MARIA_BA, VILLA_MARIA_CBA] }));
    render(<LocalityPickerAcross id="t" searchAction={searchAction} onSelect={onSelect} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "Villa María" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    fireEvent.focus(input);
    fireEvent.mouseDown(screen.getByText(/General San Martín, Córdoba/));

    expect(onSelect).toHaveBeenCalledWith(VILLA_MARIA_CBA);
    // The "confirmed" status line names the picked province — Córdoba, not the
    // Buenos Aires homonym — so the admin gets confirmation of WHICH one stuck.
    expect(screen.getByText(/Localidad confirmada: Villa María, Córdoba/)).toBeInTheDocument();
  });

  it("picking the Buenos Aires 'localidad' row resolves to the OTHER province, not Córdoba", async () => {
    const onSelect = vi.fn();
    vi.useFakeTimers();
    const searchAction = vi.fn(async () => ({ results: [VILLA_MARIA_BA, VILLA_MARIA_CBA] }));
    render(<LocalityPickerAcross id="t" searchAction={searchAction} onSelect={onSelect} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "Villa María" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    fireEvent.focus(input);
    fireEvent.mouseDown(screen.getByText(/Alberti, Buenos Aires/));

    expect(onSelect).toHaveBeenCalledWith(VILLA_MARIA_BA);
    expect(screen.getByText(/Localidad confirmada: Villa María, Buenos Aires/)).toBeInTheDocument();
  });
});

describe("AssignLocalityForm — assigning Villa María, Córdoba names the right province (C2)", () => {
  it("confirms 'Córdoba' after picking the componente row, and submits that pair", async () => {
    vi.useFakeTimers();
    const { searchLocalitiesAction } = await import("@/app/actions/localities");
    vi.mocked(searchLocalitiesAction).mockResolvedValue({
      results: [VILLA_MARIA_BA, VILLA_MARIA_CBA],
    });
    render(<AssignLocalityForm targetUserId="u1" />);
    fireEvent.click(screen.getByRole("button", { name: "Asignar nueva localidad" }));

    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "Villa María" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    fireEvent.focus(input);
    fireEvent.mouseDown(screen.getByText(/General San Martín, Córdoba/));

    expect(screen.getByText("Provincia: Córdoba")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirmar asignación" }));
    });

    expect(assignGovtLocalityAction).toHaveBeenCalledWith(
      expect.objectContaining({ province: "Córdoba", locality: "Villa María" }),
    );
  });
});
