// `useBiteDraftBanner` — the session-swap race, isolated from the screen.
//
// WHY A HARNESS AND NOT `MisMascotasBiteDraftBanner.test.tsx`. That file
// proves the banner through what a person sees; this one proves a single
// timing fact `event-draft-store.ts` cannot guarantee on its own — that
// `listEventDrafts` is itself several `await`s deep. A sign-out (or a
// switch to whoever else is on this phone) that lands INSIDE that window
// must not hand the finished scan's answer to the NEW session. Reproducing
// that from the real store would mean racing real `AsyncStorage` calls
// against a real clock; mocking `listEventDrafts` lets the test hold the
// scan open exactly as long as it needs to.

import { describe, expect, it, jest } from "@jest/globals";
import { act, render } from "@testing-library/react-native";

const mockGetSessionState = jest.fn();
jest.mock("../auth/session-store", () => ({
  getSessionState: () => mockGetSessionState(),
}));

const mockListEventDrafts = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock("./event-draft-store", () => ({
  listEventDrafts: (...args: unknown[]) => mockListEventDrafts(...args),
}));

import { type UseBiteDraftBanner, useBiteDraftBanner } from "./use-bite-draft-banner";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";
const TOKEN = "DIM-PAMP-0001";

function harness() {
  let latest: UseBiteDraftBanner | null = null;
  function Probe() {
    latest = useBiteDraftBanner();
    return null;
  }
  render(<Probe />);
  return {
    banner: () => latest?.banner ?? null,
    refresh: () => latest?.refresh(),
  };
}

/** Lets the test decide exactly when the mocked scan resolves. */
function deferredScan() {
  let resolve: (value: unknown) => void = () => {};
  const promise = new Promise((r) => {
    resolve = r;
  });
  mockListEventDrafts.mockReturnValueOnce(promise);
  return { resolve };
}

describe("useBiteDraftBanner — the session-swap race", () => {
  it("drops a scan that resolves after the signed-in account changed mid-flight", async () => {
    mockGetSessionState.mockReturnValue({ phase: "signed-in", user: { id: OWNER } });
    const scan = deferredScan();
    const h = harness();

    let pending!: Promise<void>;
    act(() => {
      pending = h.refresh() as Promise<void>;
    });

    // Somebody else is signed in by the time the scan comes back — a sign-out
    // and a re-sign-in, or the second person on a shared phone taking over.
    mockGetSessionState.mockReturnValue({ phase: "signed-in", user: { id: OTHER_OWNER } });
    await act(async () => {
      scan.resolve([{ publicToken: TOKEN, savedAt: Date.now() }]);
      await pending;
    });

    // NOT OWNER's draft, and NOT OTHER_OWNER's either — the scan was never
    // asked on OTHER_OWNER's behalf, so answering with it would be exactly
    // the cross-account leak `eventDraftKey`'s owner segment exists to stop.
    expect(h.banner()).toBeNull();
  });

  it("applies the scan when the same account is still signed in once it resolves", async () => {
    mockGetSessionState.mockReturnValue({ phase: "signed-in", user: { id: OWNER } });
    const scan = deferredScan();
    const h = harness();

    let pending!: Promise<void>;
    act(() => {
      pending = h.refresh() as Promise<void>;
    });

    await act(async () => {
      scan.resolve([{ publicToken: TOKEN, savedAt: 1234 }]);
      await pending;
    });

    expect(h.banner()).toEqual({ publicToken: TOKEN, savedAt: 1234 });
  });
});
