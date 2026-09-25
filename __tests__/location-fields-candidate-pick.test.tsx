// @vitest-environment jsdom
//
// "¿Es acá?" on the web map (localidades-por-id B6, design addendum #1).
//
// The catalogue has centroids, not boundaries, so a pin alone never names a
// locality. When the reverse-geocoded name is missing, or names two rows of
// the province (Mechita: partido Alberti and partido Bragado), the form shows
// the candidate rows — homonyms labelled with their department — and the
// person picks one. The pick travels as the row's INDEC id, marked as picked
// (`localityPicked`), so the server keeps THAT row and records `user_picked`.
// Declining leaves the place at province level, for the unresolved queue.
// Nothing is ever chosen for the person.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const reverse = vi.fn();

vi.mock("@/app/actions/localities", () => ({
  searchLocalitiesAction: vi.fn(async () => ({ results: [] })),
  searchLocalitiesPublicAction: vi.fn(async () => ({ results: [] })),
}));

vi.mock("@/app/actions/geocoding", () => ({
  geocodeAddressAction: vi.fn(async () => []),
  geocodeAddressPublicAction: vi.fn(async () => []),
  reverseGeocodeAction: (lat: number, lng: number) => reverse(lat, lng),
  reverseGeocodePublicAction: (lat: number, lng: number) => reverse(lat, lng),
}));

// The map is MapLibre; here it is a button that drops the pin by hand.
vi.mock("next/dynamic", () => ({
  default: () =>
    function FakeMap({ onChange }: { onChange: (p: { lat: number; lng: number }) => void }) {
      return (
        <button type="button" onClick={() => onChange({ lat: -35.07, lng: -60.4 })}>
          marcar pin
        </button>
      );
    } as ComponentType,
}));

import { LocationFields } from "@/components/LocationFields";

const ALBERTI = {
  provinceCode: "AR-B",
  provinceName: "Buenos Aires",
  localityName: "Mechita",
  localityIndecId: "06021030",
  departmentName: "Alberti",
};
const BRAGADO = { ...ALBERTI, localityIndecId: "06112080", departmentName: "Bragado" };

function answer(status: "resolved" | "ambiguous" | "unresolved", candidates = [ALBERTI, BRAGADO]) {
  return {
    display_name: "Mechita, Buenos Aires",
    province: "Buenos Aires",
    locality: "Mechita",
    place: { status, candidates: status === "resolved" ? [] : candidates },
  };
}

function hidden(name: string): string {
  const input = document.querySelector<HTMLInputElement>(`input[type="hidden"][name="${name}"]`);
  if (!input) throw new Error(`no hidden input ${name}`);
  return input.value;
}

afterEach(() => {
  cleanup();
  reverse.mockReset();
});

async function dropPin() {
  render(<LocationFields mode="l2" />);
  fireEvent.click(screen.getByRole("button", { name: "marcar pin" }));
}

describe("a pin whose name two rows share", () => {
  it("offers both rows, labelled with their departments, and picks neither", async () => {
    reverse.mockResolvedValue(answer("ambiguous"));
    await dropPin();

    const group = await screen.findByRole("radiogroup", { name: /¿En qué localidad fue\?/ });
    expect(group).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Mechita (Alberti), Buenos Aires" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("radio", { name: "Mechita (Bragado), Buenos Aires" }),
    ).not.toBeChecked();
    expect(hidden("localityNameIndecId")).toBe("");
    expect(hidden("localityPicked")).toBe("");
  });

  it("the row the person picks travels by id, marked as picked", async () => {
    reverse.mockResolvedValue(answer("ambiguous"));
    await dropPin();

    fireEvent.click(await screen.findByRole("radio", { name: "Mechita (Bragado), Buenos Aires" }));

    await waitFor(() => expect(hidden("localityNameIndecId")).toBe("06112080"));
    expect(hidden("localityPicked")).toBe("1");
    expect(hidden("provinceCode")).toBe("AR-B");
    expect(hidden("localityName")).toBe("Mechita");
  });

  it("declining leaves the place at province level — no locality, no id", async () => {
    reverse.mockResolvedValue(answer("ambiguous"));
    await dropPin();

    fireEvent.click(await screen.findByRole("radio", { name: "Mechita (Bragado), Buenos Aires" }));
    fireEvent.click(screen.getByRole("radio", { name: "Ninguna de estas / no sé" }));

    await waitFor(() => expect(hidden("localityNameIndecId")).toBe(""));
    expect(hidden("localityPicked")).toBe("");
    expect(hidden("localityName")).toBe("");
    expect(hidden("provinceCode")).toBe("AR-B");
  });
});

describe("a pin that resolved to one row", () => {
  it("asks nothing", async () => {
    reverse.mockResolvedValue(answer("resolved"));
    await dropPin();

    await waitFor(() => expect(reverse).toHaveBeenCalled());
    await waitFor(() => expect(hidden("localityName")).toBe("Mechita"));
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(hidden("localityPicked")).toBe("");
  });
});
