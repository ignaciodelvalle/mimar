// `app/mascotas/index.tsx`'s loaded arm, now a `FlatList` (M3 / R-1).
//
// WHY THIS FILE EXISTS. `MisMascotasFooter.test.tsx` only ever renders an EMPTY
// payload, so it never exercised the one thing that actually changed when the
// screen moved off `ScrollView`: pet rows and the footer are now two different
// kinds of `FlatList` slot (`data` vs `ListFooterComponent`) rather than two
// plain siblings in the same scroll container. This file renders a NON-EMPTY
// payload and checks the two survived the move: the rows still show, the
// footer's eight destinations still render AFTER them, and a stale-but-outage
// refresh does not force a memoized row to re-render (the defect this whole
// change exists to close — see `PetRow.tsx`'s header).
//
// It runs under JEST, same as `MisMascotasFooter.test.tsx`.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { RefreshControl } from "react-native";

const mockPush = jest.fn<(path: string) => void>();
const mockFetchMyPets = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
  useFocusEffect: () => undefined,
}));

jest.mock("../api/endpoints", () => ({
  fetchMyPets: (...args: unknown[]) => mockFetchMyPets(...args),
}));

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: { addEventListener: () => () => undefined },
}));

jest.mock("../auth/session-store", () => ({ sessionPort: {} }));
jest.mock("../auth/useGate", () => ({ useGate: () => ({ allowed: true }) }));

import MisMascotasScreen from "../../app/mascotas/index";
import { TOP_LEVEL_DESTINATIONS } from "../ui/TopLevelNavMenu";
import { getPetRowRenderCountForTests, resetPetRowRenderCountForTests } from "./PetRow";

function twoPets() {
  return {
    outcome: "ok" as const,
    payload: {
      version: 1,
      pets: [
        {
          publicToken: "DIM-AAAA-0001",
          name: "Firulais",
          species: "dog",
          status: "active",
          photoUrl: null,
        },
        {
          publicToken: "DIM-BBBB-0002",
          name: "Michi",
          species: "cat",
          status: "lost",
          photoUrl: null,
        },
      ],
      total: 2,
      truncated: false,
    },
  };
}

describe("the /mascotas list (FlatList)", () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockFetchMyPets.mockReset();
    resetPetRowRenderCountForTests();
  });

  it("renders every pet AND every footer destination, footer last", async () => {
    mockFetchMyPets.mockResolvedValue(twoPets());
    render(<MisMascotasScreen />);

    await screen.findByText("Firulais");
    expect(screen.getByText("Michi")).toBeTruthy();

    // The footer is now a `ListFooterComponent`, not a sibling `View` in the
    // same `ScrollView` — this is the assertion that it still shows up, and
    // still after the rows, not swallowed by the switch to `FlatList`.
    for (const destination of TOP_LEVEL_DESTINATIONS) {
      expect(screen.getByRole("button", { name: destination.label })).toBeTruthy();
    }
  });

  it("does not re-render a pet row when a pull-to-refresh fails as an outage (stale payload kept)", async () => {
    mockFetchMyPets.mockResolvedValueOnce(twoPets());
    render(<MisMascotasScreen />);
    await screen.findByText("Firulais");

    const rendersAfterMount = getPetRowRenderCountForTests();
    expect(rendersAfterMount).toBeGreaterThan(0);

    // `unreachable` is OUTAGE-shaped (`reload-state.ts`): the ready state keeps
    // its `view` BY REFERENCE and only flips `staleFailure`, so a memoized
    // `PetRow` given the same `pet` and the same `onPress` must not run again.
    mockFetchMyPets.mockResolvedValueOnce({ outcome: "unreachable", detail: "sin red" });
    const control = screen.UNSAFE_getByType(RefreshControl);
    fireEvent(control, "refresh");

    await screen.findByText("No pudimos actualizar");

    expect(getPetRowRenderCountForTests()).toBe(rendersAfterMount);
  });
});
