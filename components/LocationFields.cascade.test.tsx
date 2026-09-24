// @vitest-environment jsdom
//
// LocationFields — province-first cascade (mode="l1" cascade). PO decision
// 2026-07-08: the pet alta picks a Provincia first, then the Localidad
// autocomplete is scoped to that province so "Palermo" no longer surfaces the
// CABA barrio AND an unrelated locality elsewhere. These tests pin the
// cascade's UX contract:
//   1. the locality picker is disabled until a province is picked;
//   2. the scoped search is invoked with the chosen province_code;
//   3. changing the province clears the previously-picked locality;
//   4. the hidden wire inputs (provinceCode/localityName) stay unchanged —
//      a real pick emits its province, free text emits none (so the
//      LOCALITY_UNRESOLVED guard downstream still bites).

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalitySearchResult } from "@/lib/infra/ar-localidades";

const searchMock = vi.fn();

// Both search actions live in this "use server" module, which transitively
// imports @/db (unavailable in unit tests). Mock the whole module.
vi.mock("@/app/actions/localities", () => ({
  searchLocalitiesAction: (input: { provinceCode?: string; query: string }) => searchMock(input),
  searchLocalitiesPublicAction: (input: { provinceCode?: string; query: string }) =>
    searchMock(input),
}));

// L2-only geocoding actions — never called in an L1 cascade, mocked so the
// module graph doesn't pull server-only deps at import time.
vi.mock("@/app/actions/geocoding", () => ({
  geocodeAddressAction: vi.fn(),
  geocodeAddressPublicAction: vi.fn(),
  reverseGeocodeAction: vi.fn(),
  reverseGeocodePublicAction: vi.fn(),
}));

import { LocationFields } from "./LocationFields";

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

/** Read a hidden input's value by its wire name from the rendered form. */
function hiddenValue(container: HTMLElement, name: string): string {
  const el = container.querySelector<HTMLInputElement>(`input[type="hidden"][name="${name}"]`);
  return el?.value ?? "__missing__";
}

beforeEach(() => {
  searchMock.mockReset();
  searchMock.mockResolvedValue({ results: [] });
});

afterEach(() => {
  cleanup();
});

describe("LocationFields cascade — province gates locality", () => {
  it("disables the locality picker until a province is chosen", () => {
    render(<LocationFields mode="l1" cascade required />);

    const locality = screen.getByLabelText(/Localidad o barrio/) as HTMLInputElement;
    expect(locality).toBeDisabled();
    expect(locality).toHaveAttribute("placeholder", "Elegí primero la provincia");
  });

  it("enables the picker and searches scoped to the chosen province_code", async () => {
    searchMock.mockResolvedValue({
      results: [makeResult("Palermo", "AR-C", "CABA", "02000010")],
    });
    render(<LocationFields mode="l1" cascade required />);

    fireEvent.change(screen.getByLabelText(/Provincia/), { target: { value: "AR-C" } });

    const locality = screen.getByLabelText(/Localidad o barrio/) as HTMLInputElement;
    expect(locality).not.toBeDisabled();

    fireEvent.change(locality, { target: { value: "Pal" } });

    await waitFor(() => {
      expect(searchMock).toHaveBeenCalledWith({ query: "Pal", provinceCode: "AR-C" });
    });
  });
});

describe("LocationFields cascade — wire contract", () => {
  it("emits the picked result's province + locality in the hidden inputs", async () => {
    searchMock.mockResolvedValue({
      results: [makeResult("Palermo", "AR-C", "CABA", "02000010")],
    });
    const { container } = render(<LocationFields mode="l1" cascade required />);

    fireEvent.change(screen.getByLabelText(/Provincia/), { target: { value: "AR-C" } });
    fireEvent.change(screen.getByLabelText(/Localidad o barrio/), { target: { value: "Pal" } });

    const option = await screen.findByText("Palermo");
    fireEvent.mouseDown(option);

    expect(hiddenValue(container, "provinceCode")).toBe("AR-C");
    expect(hiddenValue(container, "provinceName")).toBe("CABA");
    expect(hiddenValue(container, "localityName")).toBe("Palermo");
    expect(hiddenValue(container, "localityNameIndecId")).toBe("02000010");
  });

  it("emits NO provinceCode for a free-typed locality (LOCALITY_UNRESOLVED still bites)", async () => {
    // No results → the user typed something that never resolved to a catalog
    // row. The province <select> must NOT leak its code into the wire inputs,
    // otherwise free text would pass parsePetForm's province check.
    searchMock.mockResolvedValue({ results: [] });
    const { container } = render(<LocationFields mode="l1" cascade required />);

    fireEvent.change(screen.getByLabelText(/Provincia/), { target: { value: "AR-B" } });
    fireEvent.change(screen.getByLabelText(/Localidad o barrio/), {
      target: { value: "Villa Inventada" },
    });

    await waitFor(() => expect(searchMock).toHaveBeenCalled());

    expect(hiddenValue(container, "provinceCode")).toBe("");
    expect(hiddenValue(container, "localityName")).toBe("Villa Inventada");
  });

  it("clears the picked locality when the province changes", async () => {
    searchMock.mockResolvedValue({
      results: [makeResult("Palermo", "AR-C", "CABA", "02000010")],
    });
    const { container } = render(<LocationFields mode="l1" cascade required />);

    fireEvent.change(screen.getByLabelText(/Provincia/), { target: { value: "AR-C" } });
    fireEvent.change(screen.getByLabelText(/Localidad o barrio/), { target: { value: "Pal" } });
    fireEvent.mouseDown(await screen.findByText("Palermo"));
    expect(hiddenValue(container, "localityName")).toBe("Palermo");
    expect(hiddenValue(container, "provinceCode")).toBe("AR-C");

    // Switch province → the Palermo/CABA pick must not survive.
    fireEvent.change(screen.getByLabelText(/Provincia/), { target: { value: "AR-B" } });

    const locality = screen.getByLabelText(/Localidad o barrio/) as HTMLInputElement;
    expect(locality.value).toBe("");
    expect(hiddenValue(container, "localityName")).toBe("");
    expect(hiddenValue(container, "provinceCode")).toBe("");
  });
});
