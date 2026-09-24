// `OfflineBanner` — a definite NO shows it; anything else shows nothing.
//
// NetInfo answers `isConnected: null` while it does not know, and a banner
// that cries offline during "unknown" trains people to ignore it. These pin
// the strict-false rule, the recovery, and the unsubscribe.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, render, screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";

// A REAL INSET, overriding jest.setup.js's zeroes for this file only. The rule
// under test is "the banner is pushed below the status bar", and a mock that
// reports no status bar cannot tell a fix from the bug.
jest.mock("react-native-safe-area-context", () => ({
  ...require("react-native-safe-area-context/jest/mock").default,
  useSafeAreaInsets: () => ({ top: 24, right: 0, bottom: 0, left: 0 }),
}));

type Listener = (state: { isConnected: boolean | null }) => void;

let listener: Listener | null = null;
const mockUnsubscribe = jest.fn();

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: {
    addEventListener: (cb: Listener) => {
      listener = cb;
      return mockUnsubscribe;
    },
  },
}));

import { OfflineBanner } from "./OfflineBanner";

function fire(isConnected: boolean | null) {
  act(() => listener?.({ isConnected }));
}

beforeEach(() => {
  listener = null;
  mockUnsubscribe.mockReset();
});

describe("the strict-false rule", () => {
  it("shows the banner on a definite NO", () => {
    render(<OfflineBanner />);
    fire(false);
    expect(screen.getByText("Sin conexión a internet")).toBeOnTheScreen();
  });

  it("shows NOTHING while connected — and nothing on UNKNOWN, which is not a no", () => {
    render(<OfflineBanner />);
    fire(true);
    expect(screen.queryByText("Sin conexión a internet")).toBeNull();
    fire(null);
    expect(screen.queryByText("Sin conexión a internet")).toBeNull();
  });

  it("clears the banner the moment the network comes back", () => {
    render(<OfflineBanner />);
    fire(false);
    expect(screen.getByText("Sin conexión a internet")).toBeOnTheScreen();
    fire(true);
    expect(screen.queryByText("Sin conexión a internet")).toBeNull();
  });
});

describe("lifecycle", () => {
  it("unsubscribes from NetInfo when unmounted", () => {
    const view = render(<OfflineBanner />);
    view.unmount();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("the status bar (A6-cuenta-resiliencia-09)", () => {
  it("pads itself past the top inset instead of drawing under the clock", () => {
    // Mounted above the Stack in `app/_layout.tsx`, so it is outside `Screen` —
    // the only component in this app that applies safe-area padding. On an
    // edge-to-edge Android build its text landed under the status bar. The
    // module mock at the top of this file reports a 24dp top inset, which is
    // what an Android status bar actually is.
    render(<OfflineBanner />);
    fire(false);

    // UNSAFE_ by this app's no-testID convention (skeleton.test.tsx states it):
    // production code stays a11y-only and the test reaches under it.
    const banner = screen.UNSAFE_getByProps({ accessibilityRole: "alert" });
    const style = StyleSheet.flatten(banner.props.style);
    expect(style.paddingTop).toBeGreaterThanOrEqual(24);
  });
});
