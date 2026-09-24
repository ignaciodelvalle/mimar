// `AdoptionDetailScreen` — what a failed RE-read is allowed to do to the ficha.
//
// WHY THIS FILE EXISTS (lote 1b review, F7)
// ---------------------------------------------------------------------------
// The screen started re-reading on focus and grew a `hasLoaded` ref for the
// mode plumbing `PetDocumentScreen` already had — and then never READ it. So
// every focus took the `loading` branch and, worse, every failure took
// `{ phase: "failed" }`: returning from the postulación form in a dead spot
// replaced the animal somebody was reading about with a refusal.
//
// That is precisely the S-2 rule the rest of this batch is about, newly broken
// on a screen that had just gained a reason to re-read. The wiring is invisible
// to a type and invisible to a mount-only test, which is what these three
// assertions are for: the focus that keeps the ficha, the failure that keeps it,
// and the FIRST read that is still allowed to empty the screen.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, render, screen, waitFor } from "@testing-library/react-native";

const mockFetch = jest.fn<(...args: unknown[]) => Promise<unknown>>();

/**
 * Every focus callback currently mounted, so a test can fire a RE-focus.
 *
 * The same stand-in `LostScreen.test.tsx` and `NotificationsScreen.test.tsx`
 * use, for the same reason: the defect is about a screen that is ALREADY
 * MOUNTED when it regains focus, and a mount-only stand-in can only be re-fired
 * by remounting — precisely the case that never had the bug.
 */
const mockFocusCallbacks: Array<() => void> = [];

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useFocusEffect: (callback: () => void) => {
    const { useEffect } = require("react");
    useEffect(() => {
      mockFocusCallbacks.push(callback);
      // A mount IS a first focus, which is what the real hook does too.
      callback();
      return () => {
        const at = mockFocusCallbacks.indexOf(callback);
        if (at >= 0) mockFocusCallbacks.splice(at, 1);
      };
    }, [callback]);
  },
}));

jest.mock("../api/endpoints", () => ({
  fetchAdoptionDetail: (...args: unknown[]) => mockFetch(...args),
}));

// The screen now re-reads when the network comes back (B-05, `useReconnect`),
// and the real NetInfo has no native module under jest — it crashes inside its
// own reachability timer, several frames from anything this file is about. The
// stand-in `MisMascotasFooter.test.tsx` already uses.
jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: { addEventListener: () => () => undefined },
}));
jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import type { AdoptionDetailV1 } from "@dim/contract/api";
import { AdoptionDetailScreen } from "./AdoptionDetailScreen";

const TOKEN = "DIM-ADOP-0001";

function listed(): AdoptionDetailV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-09-06T00:00:00.000Z",
    staleAfter: "2026-09-06T00:00:30.000Z",
    detail: {
      state: "listed",
      petToken: TOKEN,
      name: "Lola",
      species: "dog",
      speciesLabel: "Perro",
      breed: null,
      sex: "female",
      sexLabel: "Hembra",
      color: null,
      distinguishingFeatures: null,
      photoUrls: [],
      locality: "Bariloche",
      province: "Río Negro",
      facts: [],
      story: null,
      requirements: null,
      goodWithKids: null,
      goodWithDogs: null,
      goodWithCats: null,
      needsYard: null,
      feeArs: null,
      health: {
        hasVaccinations: true,
        isSterilized: true,
        sterilizedLabel: "Castrada",
        hasMicrochip: false,
      },
      permanentConditions: [],
      permanentConditionsOther: null,
      org: {
        orgToken: "ORG-0001",
        name: "Refugio Sur",
        locality: "Bariloche",
        province: "Río Negro",
        custodySince: null,
        livesWithFamily: false,
      },
      canApply: true,
      applyBlockedReason: null,
    },
  };
}

const noop = () => {};

function renderScreen() {
  return render(<AdoptionDetailScreen petToken={TOKEN} onApply={noop} onBackToCatalogue={noop} />);
}

/** Re-focus every mounted screen, the way popping back from the form does. */
async function refocus(): Promise<void> {
  await act(async () => {
    for (const callback of [...mockFocusCallbacks]) callback();
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFocusCallbacks.length = 0;
});

describe("AdoptionDetailScreen — coming back does not delete the ficha (F7)", () => {
  it("does not blank the ficha to a placeholder when the screen regains focus", async () => {
    mockFetch.mockResolvedValue({ outcome: "ok", payload: listed() });
    renderScreen();
    await screen.findByText("Lola");

    // A read held in flight, so the assertion describes the window the person
    // actually sees rather than the state after it closes.
    mockFetch.mockReturnValue(new Promise(() => {}));
    await refocus();

    expect(screen.queryByText("Abriendo la ficha…")).toBeNull();
    expect(screen.getByText("Lola")).toBeOnTheScreen();
  });

  it("keeps the ficha when a focus re-read fails, and says so in a banner", async () => {
    mockFetch.mockResolvedValueOnce({ outcome: "ok", payload: listed() });
    renderScreen();
    await screen.findByText("Lola");

    mockFetch.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    await refocus();

    await waitFor(() => expect(screen.getByText("No pudimos actualizar")).toBeOnTheScreen());
    // The animal is STILL THERE. Deleting the ficha over a dead spot is the S-2
    // defect, and this screen is where somebody decides about an adoption.
    expect(screen.getByText("Lola")).toBeOnTheScreen();
  });

  it("still empties the screen when the FIRST read fails", async () => {
    // The control: with nothing on screen there is nothing to keep, and the
    // assertion above must not have loosened this one.
    mockFetch.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    renderScreen();

    await waitFor(() => expect(screen.getByText("Ver otras en adopción")).toBeOnTheScreen());
    expect(screen.queryByText("Lola")).toBeNull();
    expect(screen.queryByText("No pudimos actualizar")).toBeNull();
  });

  it("empties it for a REFUSAL even with the ficha on screen (F3)", async () => {
    // A ficha the org paused, or an application that changed this caller's
    // access, comes back as a refusal rather than an outage — and "lo último que
    // pudimos leer" over it would present an authorization change as a network
    // hiccup. See `reload-state.ts`.
    mockFetch.mockResolvedValueOnce({ outcome: "ok", payload: listed() });
    renderScreen();
    await screen.findByText("Lola");

    mockFetch.mockResolvedValue({
      outcome: "api-error",
      code: "not_found",
      retryAfterSeconds: null,
    });
    await refocus();

    await waitFor(() => expect(screen.getByText("Ver otras en adopción")).toBeOnTheScreen());
    expect(screen.queryByText("No pudimos actualizar")).toBeNull();
    expect(screen.queryByText("Lola")).toBeNull();
  });
});
