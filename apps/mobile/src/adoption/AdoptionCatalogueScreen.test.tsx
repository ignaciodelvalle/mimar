// `AdoptionCatalogueScreen` — the paging control, which is the part that can lie.
//
// A "Mostrar más" that spins and comes back with nothing on screen leaves one
// available reading: there are no more animals. The cursor says the opposite,
// which makes that reading a lie the screen tells by omission
// (A5-ciudadanas-06).

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

const mockFetch = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("../api/endpoints", () => ({
  fetchAdoptionCatalogue: (...args: unknown[]) => mockFetch(...args),
}));

jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import type { AdoptionCatalogueItemV1 } from "@dim/contract/api";
import { AdoptionCatalogueScreen } from "./AdoptionCatalogueScreen";

function anItem(over: Partial<AdoptionCatalogueItemV1> = {}): AdoptionCatalogueItemV1 {
  return {
    petToken: "DIM-ADOP-0001",
    name: "Lola",
    species: "dog",
    speciesLabel: "Perro",
    breed: null,
    sex: "female",
    sexLabel: "Hembra",
    color: null,
    photoUrl: null,
    locality: "Bariloche",
    province: "Río Negro",
    facts: [],
    goodWithKids: null,
    goodWithDogs: null,
    goodWithCats: null,
    needsYard: null,
    hasMicrochip: false,
    isSterilized: true,
    sterilizedLabel: "Castrada",
    feeArs: null,
    orgToken: "ORG-0001",
    orgName: "Refugio Sur",
    livesWithFamily: false,
    ...over,
  };
}

function page(items: AdoptionCatalogueItemV1[], nextCursor: string | null) {
  return {
    outcome: "ok" as const,
    payload: { payloadVersion: 1, items, nextCursor },
  };
}

const noop = () => {};

beforeEach(() => {
  mockFetch.mockReset();
});

describe('"Mostrar más" that could not read the next page', () => {
  it("says so instead of leaving the screen looking finished", async () => {
    mockFetch.mockResolvedValueOnce(page([anItem()], "cursor-2"));
    render(<AdoptionCatalogueScreen onOpenPet={noop} onOpenMyApplications={noop} />);
    await waitFor(() => expect(screen.getByText("Mostrar más")).toBeTruthy());

    mockFetch.mockResolvedValueOnce({ outcome: "unreachable", detail: "offline" });
    fireEvent.press(screen.getByText("Mostrar más"));

    await waitFor(() => expect(screen.getByText("No pudimos actualizar")).toBeTruthy());
    // The page already on screen is untouched, and the button is still there —
    // the next tap is the fix.
    expect(screen.getByText("Lola")).toBeTruthy();
    expect(screen.getByText("Mostrar más")).toBeTruthy();
  });

  it("appends and clears the notice when the next page DOES arrive", async () => {
    // The control: the failure arm must not swallow the success one.
    mockFetch.mockResolvedValueOnce(page([anItem()], "cursor-2"));
    render(<AdoptionCatalogueScreen onOpenPet={noop} onOpenMyApplications={noop} />);
    await waitFor(() => expect(screen.getByText("Mostrar más")).toBeTruthy());

    mockFetch.mockResolvedValueOnce({ outcome: "unreachable", detail: "offline" });
    fireEvent.press(screen.getByText("Mostrar más"));
    await waitFor(() => expect(screen.getByText("No pudimos actualizar")).toBeTruthy());

    mockFetch.mockResolvedValueOnce(
      page([anItem({ petToken: "DIM-ADOP-0002", name: "Cachi" })], null),
    );
    fireEvent.press(screen.getByText("Mostrar más"));

    await waitFor(() => expect(screen.getByText("Cachi")).toBeTruthy());
    expect(screen.getByText("Lola")).toBeTruthy();
    expect(screen.queryByText("No pudimos actualizar")).toBeNull();
  });
});
