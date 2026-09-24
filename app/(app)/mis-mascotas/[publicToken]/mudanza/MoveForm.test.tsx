// @vitest-environment jsdom
//
// MoveForm — province-first cascade adoption (province-first-cascade-write-surfaces).
// MoveForm is the one write surface that pre-fills LocationFields from an
// EXISTING pet jurisdiction (every other write surface starts empty), so it's
// the representative surface for pinning the cascade's prefill contract:
//   1. the province <select> is preselected from the pet's current province
//      (converted from the stored province NAME via provinceByName, since
//      LocationFields seeds its cascade state from defaultValue.provinceCode
//      ONCE at mount — see LocationFields.tsx's cascadeProvinceCode useState
//      initializer);
//   2. the locality autocomplete is enabled (not gated) at mount, because a
//      province is already known.

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const searchMock = vi.fn();

// LocationFields transitively imports these "use server" modules (which pull
// in @/db, unavailable in unit tests). Mock them exactly as
// LocationFields.cascade.test.tsx does so the module graph stays client-only.
vi.mock("@/app/actions/localities", () => ({
  searchLocalitiesAction: (input: { provinceCode?: string; query: string }) => searchMock(input),
  searchLocalitiesPublicAction: (input: { provinceCode?: string; query: string }) =>
    searchMock(input),
}));

vi.mock("@/app/actions/geocoding", () => ({
  geocodeAddressAction: vi.fn(),
  geocodeAddressPublicAction: vi.fn(),
  reverseGeocodeAction: vi.fn(),
  reverseGeocodePublicAction: vi.fn(),
}));

import type { NewPetFormState } from "@/src/modules/pets/actions";
import { MoveForm } from "./MoveForm";

// A no-op form action; these tests never exercise a real server submit.
const noopAction = async (): Promise<NewPetFormState> => ({ error: null });

beforeEach(() => {
  searchMock.mockReset();
  searchMock.mockResolvedValue({ results: [] });
});

afterEach(() => {
  cleanup();
});

describe("MoveForm — cascade prefill from the pet's current jurisdiction", () => {
  it("preselects the province from currentProvince and leaves the locality picker enabled", () => {
    render(
      <MoveForm
        action={noopAction}
        petName="Pampa"
        currentProvince="Buenos Aires"
        currentLocality="Belgrano"
      />,
    );

    const province = screen.getByLabelText(/Provincia/) as HTMLSelectElement;
    expect(province.value).toBe("AR-B");

    const locality = screen.getByLabelText(/Localidad o barrio/) as HTMLInputElement;
    expect(locality).not.toBeDisabled();
    expect(locality.value).toBe("Belgrano");
  });

  it("leaves the province unselected and the picker disabled when the pet has no jurisdiction yet", () => {
    render(
      <MoveForm
        action={noopAction}
        petName="Pampa"
        currentProvince={null}
        currentLocality={null}
      />,
    );

    const province = screen.getByLabelText(/Provincia/) as HTMLSelectElement;
    expect(province.value).toBe("");

    const locality = screen.getByLabelText(/Localidad o barrio/) as HTMLInputElement;
    expect(locality).toBeDisabled();
  });
});
