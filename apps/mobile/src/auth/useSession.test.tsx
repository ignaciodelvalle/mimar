// `useSessionBootstrap` — the SDK's refresh timer, driven by AppState.
//
// WHY THIS FILE EXISTS (native QA batch 2, D7)
// ---------------------------------------------------------------------------
// The reported finding was "the session expires after ~30-40 min in the
// foreground with a forced re-login instead of a silent refresh", and the first
// hypothesis was the familiar one: no proactive refresh timer, or a refresh that
// only fires on a foreground event. Neither is what this app does — the wiring
// below has been here since the router landed, and auth-js ALSO starts its own
// ticker unconditionally on non-browser platforms (GoTrueClient.js:4230-4238,
// reached from `_initialize`'s `finally`). So the timer runs.
//
// What did not exist was a single test over any of it. A behaviour that three
// files depend on, that nobody can see, and that no assertion holds in place is
// one refactor away from becoming the bug it was suspected of being — so this
// file pins it: foreground runs the ticker, background stops it, and unmount
// stops it. The refresh POLICY itself (what a failed refresh means) is pinned in
// session-store.test.ts and client.test.ts.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import { AppState, type AppStateStatus } from "react-native";

const mockBootstrapSession = jest.fn<() => Promise<void>>();
const mockStartAutoRefresh = jest.fn<() => Promise<void>>();
const mockStopAutoRefresh = jest.fn<() => Promise<void>>();
const mockAuthClient = jest.fn<() => unknown>();

jest.mock("./session-store", () => ({
  bootstrapSession: () => mockBootstrapSession(),
  getSessionState: () => ({ phase: "starting" }),
  subscribeToSession: () => () => undefined,
}));

jest.mock("./supabase-auth", () => ({
  authClient: () => mockAuthClient(),
}));

import { useSessionBootstrap } from "./useSession";

function Probe() {
  useSessionBootstrap();
  return null;
}

/** The AppState listener the hook registered, so a test can drive a transition. */
let listener: ((status: AppStateStatus) => void) | null = null;
const removeListener = jest.fn();

function mountWith(currentState: AppStateStatus) {
  Object.defineProperty(AppState, "currentState", {
    configurable: true,
    get: () => currentState,
  });
  return render(<Probe />);
}

beforeEach(() => {
  jest.clearAllMocks();
  listener = null;
  mockBootstrapSession.mockResolvedValue(undefined);
  mockStartAutoRefresh.mockResolvedValue(undefined);
  mockStopAutoRefresh.mockResolvedValue(undefined);
  mockAuthClient.mockReturnValue({
    auth: { startAutoRefresh: mockStartAutoRefresh, stopAutoRefresh: mockStopAutoRefresh },
  });
  jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation((_type: string, callback: (status: AppStateStatus) => void) => {
      listener = callback;
      return { remove: removeListener } as never;
    });
});

describe("useSessionBootstrap", () => {
  it("resolves the stored session once, at mount", () => {
    mountWith("active");

    expect(mockBootstrapSession).toHaveBeenCalledTimes(1);
  });

  it("runs the refresh ticker while the app is in the foreground", () => {
    // THE ASSERTION THE FINDING ASKED FOR: something starts the proactive
    // refresh, before any token is anywhere near expiry, without a request
    // having to fail first.
    mountWith("active");

    expect(mockStartAutoRefresh).toHaveBeenCalledTimes(1);
    expect(mockStopAutoRefresh).not.toHaveBeenCalled();
  });

  it("stops the ticker in the background and starts it again on return", () => {
    // A phone freezes the process in the background, so a timer there either
    // never fires or fires late against a token that already expired. Supabase's
    // own guidance is to drive it from AppState — and the return transition is
    // the half that matters, because `_startAutoRefresh` runs a tick immediately
    // (GoTrueClient.js:4068-4073), which is what catches up a session that
    // expired while the screen was off.
    mountWith("active");
    mockStartAutoRefresh.mockClear();

    listener?.("background");
    expect(mockStopAutoRefresh).toHaveBeenCalledTimes(1);
    expect(mockStartAutoRefresh).not.toHaveBeenCalled();

    listener?.("active");
    expect(mockStartAutoRefresh).toHaveBeenCalledTimes(1);
  });

  it("treats 'inactive' as not-foreground", () => {
    // iOS passes through `inactive` on its way to and from the background (the
    // app switcher, a system dialog). Running a refresh timer through it is
    // harmless; the point of the assertion is that the handler is exhaustive
    // rather than a two-value switch that silently ignores a third status.
    mountWith("active");

    listener?.("inactive");

    expect(mockStopAutoRefresh).toHaveBeenCalledTimes(1);
  });

  it("stops the ticker and unsubscribes when the tree goes away", () => {
    const view = mountWith("active");

    view.unmount();

    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(mockStopAutoRefresh).toHaveBeenCalledTimes(1);
  });

  it("does nothing with a client this build does not have", () => {
    // A build with no EXPO_PUBLIC_SUPABASE_URL has no auth plane at all; the
    // hook must not reach into a null client on the way to saying so.
    mockAuthClient.mockReturnValue(null);

    expect(() => mountWith("active")).not.toThrow();
    expect(mockBootstrapSession).toHaveBeenCalledTimes(1);
    expect(mockStartAutoRefresh).not.toHaveBeenCalled();
  });
});
