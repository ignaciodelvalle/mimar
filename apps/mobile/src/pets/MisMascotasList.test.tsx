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
  // The casos block (M11) reads on every focus. No open cases: the block is
  // not drawn, and nothing this file asserts about the list moves.
  fetchMyCases: async () => ({
    outcome: "ok",
    payload: {
      payloadVersion: 1,
      issuedAt: "2026-09-24T00:00:00.000Z",
      staleAfter: "2026-09-24T00:01:00.000Z",
      open: [],
      history: { rows: [], hasMore: false },
    },
  }),
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

/**
 * Every string rendered inside one node, in tree order. Copied from
 * `MisMascotasFooter.test.tsx` (see that file's own docblock for why walking
 * the instance rather than stringifying props): `PetRow`'s `Pressable`
 * carries an explicit `accessibilityLabel`, but `SecondaryButton`/
 * `PrimaryButton` do not — their accessible name is their child `Text` — so a
 * single helper needs both paths.
 */
function textOf(node: { children: Array<unknown> }): string {
  const parts: string[] = [];
  const walk = (child: unknown): void => {
    if (typeof child === "string") {
      parts.push(child);
      return;
    }
    if (
      child &&
      typeof child === "object" &&
      Array.isArray((child as { children?: unknown[] }).children)
    ) {
      for (const grand of (child as { children: unknown[] }).children) walk(grand);
    }
  };
  for (const child of node.children) walk(child);
  return parts.join(" ");
}

function accessibleName(node: {
  children: Array<unknown>;
  props?: { accessibilityLabel?: unknown };
}): string {
  const explicit = node.props?.accessibilityLabel;
  return typeof explicit === "string" ? explicit : textOf(node);
}

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

    // AND STILL AFTER THE ROWS, BY POSITION — the assertion above only proves
    // presence, and `ListFooterComponent`/`data` could in principle land in
    // either order in the rendered tree. `getAllByRole("button")` returns
    // matches in tree order, so the last pet row's index must be BELOW the
    // first destination's.
    const names = screen.getAllByRole("button").map(accessibleName);
    const lastPetIndex = Math.max(
      names.findIndex((name) => name.startsWith("Firulais")),
      names.findIndex((name) => name.startsWith("Michi")),
    );
    const firstDestinationIndex = names.findIndex((name) =>
      TOP_LEVEL_DESTINATIONS.some((destination) => name === destination.label),
    );
    expect(lastPetIndex).toBeGreaterThanOrEqual(0);
    expect(firstDestinationIndex).toBeGreaterThan(lastPetIndex);
  });

  it("keeps the destinations footer reachable when the FIRST read fails", async () => {
    // THE GAP THE REVIEW CAUGHT: the loading/failed arms used to render on
    // `Screen` with nothing after the `ErrorNotice` — a person offline on
    // first open had no way out of this screen but the hardware back button,
    // even though the loaded arm always offered all eight destinations.
    mockFetchMyPets.mockResolvedValueOnce({ outcome: "unreachable", detail: "sin red" });
    render(<MisMascotasScreen />);

    await screen.findByText("No pudimos conectarnos. Revisá tu conexión.");

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
