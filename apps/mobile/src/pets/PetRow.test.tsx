// `PetRow` — the memoization this file exists to pin (M3 / R-1).
//
// THE POINT. `PetRow` was extracted out of `app/mascotas/index.tsx` and wrapped
// in `React.memo` specifically because the J7 measurement named a per-frame
// bitmap re-upload as a suspect, and the one concrete cause the code showed was
// every row rebuilding its `<Image>` `source` object on every render of the
// SCREEN — not just every render of the row itself. `React.memo` only helps if
// the row's OWN function body stops being called when nothing about that pet
// changed; this file asserts that directly, via the render counter
// `PetRow.tsx` exports for exactly this purpose.
//
// It runs under JEST (see `MisMascotasFooter.test.tsx`'s header for why that
// matters in this app).

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { useState } from "react";
import { Pressable, Text } from "react-native";

import type { MyPetsV1Item } from "@dim/contract/api";

import { PetRow, getPetRowRenderCountForTests, resetPetRowRenderCountForTests } from "./PetRow";

function pet(overrides: Partial<MyPetsV1Item> = {}): MyPetsV1Item {
  return {
    publicToken: "DIM-TEST-0001",
    name: "Firulais",
    species: "dog",
    status: "active",
    photoUrl: null,
    ...overrides,
  };
}

describe("PetRow", () => {
  beforeEach(() => {
    resetPetRowRenderCountForTests();
  });

  it("renders the name, species and status, and calls onPress with the public token", () => {
    const onPress = jest.fn<(token: string) => void>();
    render(<PetRow pet={pet()} onPress={onPress} />);

    expect(screen.getByText("Firulais")).toBeTruthy();
    expect(screen.getByText("Perro")).toBeTruthy();
    expect(screen.getByText("Sin foto")).toBeTruthy();

    fireEvent.press(screen.getByRole("button"));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledWith("DIM-TEST-0001");
  });

  it("does NOT re-render when an unrelated parent state changes (same pet, same onPress)", () => {
    // A harness that re-renders on every press WITHOUT touching `pet` or
    // `onPress` — the exact shape of a pull-to-refresh's `setRefreshing(true)`
    // / `setRefreshing(false)`, which used to force every visible row's
    // `<Image>` to rebuild its `source` object for no reason.
    const stablePet = pet();
    const stableOnPress = jest.fn<(token: string) => void>();

    function Harness() {
      const [, forceRerender] = useState(0);
      return (
        <>
          <PetRow pet={stablePet} onPress={stableOnPress} />
          <Pressable onPress={() => forceRerender((n) => n + 1)}>
            <Text>bump</Text>
          </Pressable>
        </>
      );
    }

    render(<Harness />);
    const afterMount = getPetRowRenderCountForTests();
    expect(afterMount).toBeGreaterThan(0);

    fireEvent.press(screen.getByText("bump"));
    fireEvent.press(screen.getByText("bump"));
    fireEvent.press(screen.getByText("bump"));

    // The harness itself re-rendered three times (asserted indirectly: the
    // "bump" press handler ran and did not throw); PetRow's own body did not
    // run again, because `React.memo` saw the same `pet` and the same
    // `onPress` by reference.
    expect(getPetRowRenderCountForTests()).toBe(afterMount);
  });

  it("DOES re-render when the pet's own data changes", () => {
    const onPress = jest.fn<(token: string) => void>();
    const { rerender } = render(<PetRow pet={pet({ status: "active" })} onPress={onPress} />);
    const afterMount = getPetRowRenderCountForTests();

    rerender(<PetRow pet={pet({ status: "lost" })} onPress={onPress} />);

    expect(getPetRowRenderCountForTests()).toBeGreaterThan(afterMount);
    expect(screen.getByText("Perdida")).toBeTruthy();
  });
});
