// @vitest-environment jsdom
//
// Regression test for the Ciudadano Cero QA (2026-07-08): the locality
// autocomplete on the UNAUTHENTICATED signup page used the default auth-gated
// search action, which calls requireUserOrRedirect() and bounces the user to
// /login on the first keystroke — the picker just shows "Sin resultados".
//
// LocationFields now routes L1 search through the no-auth public action when
// `allowAnonymous` is set (signup), and keeps the auth-gated action otherwise
// (authed pet-alta). This test drives a real keystroke and asserts which action
// fires in each mode.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

type SearchInput = { provinceCode?: string; query: string };
const searchAuth = vi.fn(async (_input: SearchInput) => ({ results: [] }));
const searchPublic = vi.fn(async (_input: SearchInput) => ({ results: [] }));

vi.mock("@/app/actions/localities", () => ({
  searchLocalitiesAction: (input: SearchInput) => searchAuth(input),
  searchLocalitiesPublicAction: (input: SearchInput) => searchPublic(input),
}));

// LocationFields imports these at module load; only used in L2 mode.
vi.mock("@/app/actions/geocoding", () => ({
  geocodeAddressAction: vi.fn(),
  geocodeAddressPublicAction: vi.fn(),
  reverseGeocodeAction: vi.fn(),
  reverseGeocodePublicAction: vi.fn(),
}));

import { LocationFields } from "@/components/LocationFields";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LocationFields L1 — anonymous vs authed locality search", () => {
  it("uses the PUBLIC search action when allowAnonymous (signup)", async () => {
    render(<LocationFields mode="l1" allowAnonymous />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "Pal" } });

    await waitFor(() => expect(searchPublic).toHaveBeenCalled());
    expect(searchAuth).not.toHaveBeenCalled();
    expect(searchPublic).toHaveBeenCalledWith(expect.objectContaining({ query: "Pal" }));
  });

  it("uses the AUTH search action by default (authed surfaces)", async () => {
    render(<LocationFields mode="l1" />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "Pal" } });

    await waitFor(() => expect(searchAuth).toHaveBeenCalled());
    expect(searchPublic).not.toHaveBeenCalled();
  });
});
