// @vitest-environment jsdom
//
// The home-locality chip (PO, 2026-09-26): where an OWNER is asked for a place
// about their own animal, the animal's registered locality is offered as ONE
// tap — "Usar Lomas de Zamora, donde vive Pampa". The contract pinned here:
//
//   1. NEVER A PREFILL. Every wire input stays empty until the person taps.
//   2. A tap selects the row EXACTLY as picking it does — on the map form, the
//      "¿Es acá?" path (INDEC id + `localityPicked`, recorded as `user_picked`);
//      on the alta's cascade, the picker's own selection.
//   3. A pin wins: the chip hides while there is a point, and a point placed
//      after the tap drops the home pick.
//   4. OPT-IN, for owners: no `suggestion`, no chip — and the forms a finder, a
//      denunciante, a vet or an official fills never pass one.
//   5. From the stored id only: a pet whose locality never resolved gets none.

import "@testing-library/jest-dom/vitest";

import { readFileSync } from "node:fs";
import path from "node:path";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalitySearchResult } from "@/lib/infra/ar-localidades";

const reverse = vi.fn();
const searchMock = vi.fn();
const localityByIdMock = vi.fn();

vi.mock("@/app/actions/localities", () => ({
  searchLocalitiesAction: (input: { provinceCode?: string; query: string }) => searchMock(input),
  searchLocalitiesPublicAction: (input: { provinceCode?: string; query: string }) =>
    searchMock(input),
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
        <button type="button" onClick={() => onChange({ lat: -34.76, lng: -58.4 })}>
          marcar pin
        </button>
      );
    } as ComponentType,
}));

// lib/place/home-suggestion reads the catalogue by id; no database here.
vi.mock("@/db", () => ({ db: {}, ownerships: {}, pets: {} }));
vi.mock("@/lib/infra/ar-localidades", () => ({
  localityById: (id: string) => localityByIdMock(id),
}));

import { LocationFields } from "@/components/LocationFields";
import { homeLocalityRow, petHomeSuggestion } from "@/lib/place/home-suggestion";

const LOMAS: LocalitySearchResult = {
  id: "uuid-lomas",
  indecId: "06490010",
  provinceCode: "AR-B",
  departmentName: "Lomas de Zamora",
  departmentCode: "490",
  localityName: "Lomas de Zamora",
  localitySlug: "lomas-de-zamora",
  category: "localidad",
  provinceName: "Buenos Aires",
  matchKind: "exact",
};
const SUGGESTION = { locality: LOMAS, petName: "Pampa" };
const CHIP = "Usar Lomas de Zamora, donde vive Pampa";

const PLACE_FIELDS = [
  "provinceCode",
  "provinceName",
  "localityName",
  "localityNameIndecId",
  "localityPicked",
] as const;

function hidden(container: HTMLElement, name: string): string {
  const input = container.querySelector<HTMLInputElement>(`input[type="hidden"][name="${name}"]`);
  if (!input) throw new Error(`no hidden input ${name}`);
  return input.value;
}

function placeOf(container: HTMLElement): Record<string, string> {
  return Object.fromEntries(PLACE_FIELDS.map((n) => [n, hidden(container, n)]));
}

beforeEach(() => {
  searchMock.mockReset();
  searchMock.mockResolvedValue({ results: [] });
});

afterEach(() => {
  cleanup();
  reverse.mockReset();
  localityByIdMock.mockReset();
});

describe("map form (L2) — lost-pet marking and last-seen update", () => {
  it("shows no chip without a suggestion", () => {
    render(<LocationFields mode="l2" />);
    expect(screen.queryByRole("button", { name: /donde vive/ })).toBeNull();
  });

  it("offers the chip as a real, unpressed button and prefills nothing", () => {
    const { container } = render(<LocationFields mode="l2" suggestion={SUGGESTION} />);

    const chip = screen.getByRole("button", { name: CHIP });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    // It does not steal focus.
    expect(chip).not.toHaveFocus();
    expect(document.activeElement).toBe(document.body);
    for (const name of PLACE_FIELDS) expect(hidden(container, name)).toBe("");
    expect(screen.getByLabelText("Dirección o referencia")).toHaveValue("");
  });

  it("a tap selects the row exactly as the '¿Es acá?' pick does", async () => {
    const chipForm = render(<LocationFields mode="l2" suggestion={SUGGESTION} />);
    fireEvent.click(screen.getByRole("button", { name: CHIP }));
    await waitFor(() => expect(hidden(chipForm.container, "localityPicked")).toBe("1"));
    expect(screen.getByRole("button", { name: CHIP })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/Confirmado: Lomas de Zamora · Buenos Aires/)).toBeInTheDocument();
    const viaChip = placeOf(chipForm.container);
    chipForm.unmount();

    // The same row, picked from the candidates a pin offered.
    reverse.mockResolvedValue({
      display_name: "Lomas de Zamora, Buenos Aires",
      province: "Buenos Aires",
      locality: null,
      place: {
        status: "unresolved",
        candidates: [
          {
            provinceCode: "AR-B",
            provinceName: "Buenos Aires",
            localityName: "Lomas de Zamora",
            localityIndecId: "06490010",
            departmentName: "Lomas de Zamora",
          },
        ],
      },
    });
    const pinForm = render(<LocationFields mode="l2" />);
    fireEvent.click(screen.getByRole("button", { name: "marcar pin" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Lomas de Zamora/ }));
    await waitFor(() => expect(hidden(pinForm.container, "localityPicked")).toBe("1"));

    expect(viaChip).toEqual(placeOf(pinForm.container));
    expect(viaChip).toEqual({
      provinceCode: "AR-B",
      provinceName: "Buenos Aires",
      localityName: "Lomas de Zamora",
      localityNameIndecId: "06490010",
      localityPicked: "1",
    });
  });

  it("a second tap undoes the pick", async () => {
    const { container } = render(<LocationFields mode="l2" suggestion={SUGGESTION} />);
    const chip = screen.getByRole("button", { name: CHIP });
    fireEvent.click(chip);
    await waitFor(() => expect(hidden(container, "localityPicked")).toBe("1"));
    fireEvent.click(chip);
    await waitFor(() => expect(hidden(container, "localityPicked")).toBe(""));
    for (const name of PLACE_FIELDS) expect(hidden(container, name)).toBe("");
  });

  it("a pin placed after the tap wins: the chip goes and so does the home pick", async () => {
    reverse.mockResolvedValue({
      display_name: "Adrogué, Buenos Aires",
      province: "Buenos Aires",
      locality: "Adrogué",
      place: { status: "resolved", candidates: [] },
    });
    const { container } = render(<LocationFields mode="l2" suggestion={SUGGESTION} />);
    fireEvent.click(screen.getByRole("button", { name: CHIP }));
    await waitFor(() => expect(hidden(container, "localityPicked")).toBe("1"));

    fireEvent.click(screen.getByRole("button", { name: "marcar pin" }));

    await waitFor(() => expect(hidden(container, "localityName")).toBe("Adrogué"));
    expect(hidden(container, "localityPicked")).toBe("");
    expect(hidden(container, "localityNameIndecId")).toBe("");
    expect(screen.queryByRole("button", { name: CHIP })).toBeNull();
  });

  it("with a point already set there is no chip — home never stands in for a pin", () => {
    render(
      <LocationFields
        mode="l2"
        suggestion={SUGGESTION}
        defaultValue={{ lat: -34.76, lng: -58.4, address: "Plaza Grigera" }}
      />,
    );
    expect(screen.queryByRole("button", { name: CHIP })).toBeNull();
  });
});

describe("alta cascade (L1) — a second animal", () => {
  it("prefills nothing: no province, no locality until the tap", () => {
    const { container } = render(
      <LocationFields mode="l1" cascade required suggestion={SUGGESTION} />,
    );
    expect(screen.getByRole("button", { name: CHIP })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByLabelText(/Provincia/)).toHaveValue("");
    expect(screen.getByLabelText(/Ciudad, pueblo o barrio/)).toHaveValue("");
    expect(hidden(container, "localityName")).toBe("");
    expect(hidden(container, "localityNameIndecId")).toBe("");
  });

  it("a tap selects the row exactly as picking it from the list does", async () => {
    const chipForm = render(<LocationFields mode="l1" cascade required suggestion={SUGGESTION} />);
    fireEvent.click(screen.getByRole("button", { name: CHIP }));
    expect(screen.getByLabelText(/Provincia/)).toHaveValue("AR-B");
    expect(screen.getByLabelText(/Ciudad, pueblo o barrio/)).toHaveValue("Lomas de Zamora");
    expect(screen.getByText(/Confirmado: Lomas de Zamora · Buenos Aires/)).toBeInTheDocument();
    const fields = ["provinceCode", "provinceName", "localityName", "localityNameIndecId"];
    const viaChip = Object.fromEntries(fields.map((n) => [n, hidden(chipForm.container, n)]));
    chipForm.unmount();

    searchMock.mockResolvedValue({ results: [LOMAS] });
    const listForm = render(<LocationFields mode="l1" cascade required />);
    fireEvent.change(screen.getByLabelText(/Provincia/), { target: { value: "AR-B" } });
    fireEvent.change(screen.getByLabelText(/Ciudad, pueblo o barrio/), {
      target: { value: "Lomas" },
    });
    fireEvent.mouseDown(await screen.findByText("Lomas de Zamora"));
    const viaList = Object.fromEntries(fields.map((n) => [n, hidden(listForm.container, n)]));

    expect(viaChip).toEqual(viaList);
    expect(viaChip.localityNameIndecId).toBe("06490010");
  });

  it("typing over the chip's pick releases it, like any pick", () => {
    const { container } = render(
      <LocationFields mode="l1" cascade required suggestion={SUGGESTION} />,
    );
    const chip = screen.getByRole("button", { name: CHIP });
    fireEvent.click(chip);
    fireEvent.change(screen.getByLabelText(/Ciudad, pueblo o barrio/), {
      target: { value: "Temperley" },
    });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    expect(hidden(container, "localityNameIndecId")).toBe("");
  });
});

describe("the suggestion comes from the stored id only", () => {
  it("a pet whose locality never resolved gets no suggestion", async () => {
    expect(await petHomeSuggestion({ name: "Pampa", localityId: null })).toBeNull();
    expect(localityByIdMock).not.toHaveBeenCalled();
  });

  it("a stored id that no longer names a live row gets none either", async () => {
    localityByIdMock.mockResolvedValue(null);
    expect(await homeLocalityRow("uuid-gone")).toBeNull();
  });

  it("a live row comes back with its province name, ready to pick", async () => {
    const { provinceName: _p, matchKind: _m, ...row } = LOMAS;
    localityByIdMock.mockResolvedValue(row);
    expect(await petHomeSuggestion({ name: "Pampa", localityId: "uuid-lomas" })).toEqual({
      locality: LOMAS,
      petName: "Pampa",
    });
  });
});

describe("only owner forms opt in", () => {
  const ROOT = path.resolve(__dirname, "..");
  const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

  it.each([
    "app/(app)/mis-mascotas/[publicToken]/perdida/MarkLostWizard.tsx",
    "app/(app)/mis-mascotas/[publicToken]/perdida/UpdateLastSeenForm.tsx",
    "app/(app)/mis-mascotas/nueva/MinimalNewPetForm.tsx",
  ])("%s passes a suggestion", (file) => {
    expect(read(file)).toMatch(/suggestion=\{homeSuggestion\}/);
  });

  it.each([
    // A stranger must never be shown where somebody's animal lives.
    "app/(public)/p/[publicToken]/encontre/FinderInPossessionForm.tsx",
    "app/(public)/p/[publicToken]/sighting/PetSightingForm.tsx",
    // A move is by definition somewhere else.
    "app/(app)/mis-mascotas/[publicToken]/mudanza/MoveForm.tsx",
    "app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/vet/VetVisitForm.tsx",
    "app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/mordedura/BiteForm.tsx",
    "app/(public)/denuncias/nueva/_components/Step3Where.tsx",
    "app/(public)/denuncias/nueva/WelfareReportForm.tsx",
    "app/org/[orgToken]/mordedura/nuevo/OrgBiteForm.tsx",
  ])("%s does not", (file) => {
    expect(read(file)).not.toMatch(/suggestion=/);
  });

  it("the lost page offers it on the person path only", () => {
    expect(read("app/(app)/mis-mascotas/[publicToken]/perdida/page.tsx")).toMatch(
      /session\.accessPath === "owner" \? await petHomeSuggestion\(pet\) : null/,
    );
  });
});
