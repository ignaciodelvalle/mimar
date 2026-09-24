// `useReconnect` — the EDGE, not the state.
//
// B-05 measured the gap this closes: with the network back and the offline
// banner already gone, the pet list stayed broken until somebody pressed
// "Volver a intentar". The app knew; nothing acted on it.
//
// The subscription mock is `OfflineBanner.test.tsx`'s, because it is the same
// module and the same contract.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, render } from "@testing-library/react-native";

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

import { useReconnect } from "./use-reconnect";

function fire(isConnected: boolean | null) {
  act(() => listener?.({ isConnected }));
}

function Probe({ onReconnect }: { onReconnect: () => void }) {
  useReconnect(onReconnect);
  return null;
}

beforeEach(() => {
  listener = null;
  mockUnsubscribe.mockReset();
});

describe("useReconnect", () => {
  it("fires when the network comes back after a definite outage", () => {
    const onReconnect = jest.fn();
    render(<Probe onReconnect={onReconnect} />);

    fire(false);
    expect(onReconnect).not.toHaveBeenCalled();

    fire(true);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire on a connection that was never lost", () => {
    // Otherwise every mount, every foreground and every flap would spend a
    // request the screens already make on focus.
    const onReconnect = jest.fn();
    render(<Probe onReconnect={onReconnect} />);

    fire(true);
    fire(null);
    fire(true);

    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("treats UNKNOWN as not-an-outage, the way the banner does", () => {
    const onReconnect = jest.fn();
    render(<Probe onReconnect={onReconnect} />);

    fire(null);
    fire(true);

    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("fires again on the NEXT outage, not only on the first", () => {
    const onReconnect = jest.fn();
    render(<Probe onReconnect={onReconnect} />);

    fire(false);
    fire(true);
    fire(false);
    fire(true);

    expect(onReconnect).toHaveBeenCalledTimes(2);
  });

  it("unsubscribes on unmount", () => {
    const view = render(<Probe onReconnect={() => undefined} />);
    view.unmount();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
