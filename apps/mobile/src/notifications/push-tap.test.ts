// WHERE A TAPPED NOTIFICATION GOES — the mapping, and the two arrivals.
//
// WHAT THIS FILE CAN AND CANNOT PROVE, said first so a green run is not read as
// more than it is. It proves that a web path off `data.url` resolves to the
// in-app route the deep-link table names, that an unrecognised one resolves to
// nothing rather than to a broken route, and that BOTH arrivals — the listener
// and the response the module was holding from before this process existed —
// reach the router. It proves nothing about whether a notification is delivered,
// drawn, or tappable on a real phone; that lives behind the native module and
// the only instrument for it is a development build on hardware.
//
// THE PORT IS FAKED, NOT THE CONTRACT. `matchWebPath` and `appRoutePath` are the
// real ones from `@dim/contract/links`, because the whole point of the mapping
// is that it agrees with the table the web app routes from — a stubbed resolver
// would assert that this file calls a function, which is the assertion that
// never catches anything.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, render } from "@testing-library/react-native";
import React from "react";

const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: (...args: unknown[]) => mockPush(...args) }),
}));

import type { PushPort, PushTap } from "../native/push-port";
import { resetPushPort, setPushPort } from "../native/push-port";
import { appRouteForPushUrl, resetPushTapHandling, usePushTapNavigation } from "./push-tap";

/** Taps handed to whatever subscribed, so a test can deliver one on demand. */
let listeners: Array<(tap: PushTap) => void> = [];
let launchTap: PushTap | null = null;
let unsubscribed = 0;

/**
 * A port that can receive. Its `lastTap`/`onTap` are the only two members this
 * file exercises; the rest are present because a port is a whole contract.
 */
function receivingPort(over: Partial<PushPort> = {}): PushPort {
  return {
    name: "fake-push",
    available: true,
    requestPermission: async () => ({ outcome: "granted" }),
    getExpoPushToken: async () => ({ outcome: "token", expoPushToken: "ExponentPushToken[x]" }),
    lastTap: async () => launchTap,
    onTap: (listener) => {
      listeners.push(listener);
      return () => {
        unsubscribed += 1;
      };
    },
    ensureNotificationChannel: async () => undefined,
    ...over,
  };
}

/** A component whose only job is to run the hook, as the root layout does. */
function Harness(): React.ReactElement | null {
  usePushTapNavigation();
  return null;
}

/** Mount it, and let the awaited launch-tap read settle. */
async function mount() {
  const result = render(React.createElement(Harness));
  // `lastTap` resolves on a microtask AFTER the first paint, deliberately (see
  // the hook): flushing here is what makes the cold-start assertion observable.
  await act(async () => undefined);
  return result;
}

beforeEach(() => {
  mockPush.mockReset();
  listeners = [];
  launchTap = null;
  unsubscribed = 0;
  resetPushTapHandling();
  setPushPort(receivingPort());
});

// ---------------------------------------------------------------------------
// The mapping
// ---------------------------------------------------------------------------

describe("appRouteForPushUrl", () => {
  it("resolves the web path the server writes into data.url", () => {
    // `messageFor` puts the notification's `cta_url` here verbatim, and that
    // column holds WEB paths. This is the ordinary case and the whole feature.
    expect(appRouteForPushUrl("/mis-mascotas/DIM-PAMP-0001")).toBe("/mascotas/DIM-PAMP-0001");
  });

  it("resolves a deeper destination, params and all", () => {
    expect(appRouteForPushUrl("/mis-mascotas/DIM-PAMP-0001/eventos/ev-1")).toBe(
      "/mascotas/DIM-PAMP-0001/eventos/ev-1",
    );
  });

  it("prefers the static sibling over the parameterised one", () => {
    // The pair that made `matchWebPath` stop returning the first match: under
    // "first wins" this resolved to a pet credential whose token was the literal
    // word "postulaciones". Pinned here too, because a push is the one surface
    // where nobody is watching when it goes wrong.
    expect(appRouteForPushUrl("/mis-mascotas/postulaciones")).toBe("/adoptar/postulaciones");
  });

  it("answers null for a destination this app has no screen for", () => {
    // Most of the deep-link table is web-only and will stay that way. The tap
    // still opens the app; it just does not navigate.
    expect(appRouteForPushUrl("/p/DIM-PAMP-0001")).toBeNull();
  });

  it("answers null for an absolute URL, without matching it against our table", () => {
    // `cta_url` also holds external links. Matching another origin's path
    // against this table is how a notification from somewhere else opens one of
    // our screens.
    expect(appRouteForPushUrl("https://www.argentina.gob.ar/senasa")).toBeNull();
    expect(appRouteForPushUrl("https://mimar.ar/mis-mascotas/DIM-PAMP-0001")).toBeNull();
  });

  it("answers null for nothing at all", () => {
    expect(appRouteForPushUrl(null)).toBeNull();
    expect(appRouteForPushUrl(undefined)).toBeNull();
    expect(appRouteForPushUrl("")).toBeNull();
    expect(appRouteForPushUrl("not-a-path")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Arrival 1: the app was already running
// ---------------------------------------------------------------------------

describe("usePushTapNavigation — a tap on a running app", () => {
  it("opens the screen the notification pointed at", async () => {
    await mount();

    act(() => {
      for (const listener of listeners) listener({ url: "/mis-mascotas/DIM-PAMP-0001" });
    });

    expect(mockPush).toHaveBeenCalledWith("/mascotas/DIM-PAMP-0001");
  });

  it("pushes rather than replaces, so back unwinds INTO the app", async () => {
    // expo-router's `anchor` in the root layout is what puts a screen underneath
    // a one-deep stack; `replace` would discard it and hand the person a back
    // button that quits the app. That was a measured bug (NAV-1) on the other
    // deep-link path and must not be reintroduced here.
    await mount();
    act(() => {
      for (const listener of listeners) listener({ url: "/mis-mascotas/DIM-PAMP-0001" });
    });

    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it("stays put for a tap with no destination", async () => {
    await mount();

    act(() => {
      for (const listener of listeners) listener({ url: null });
    });

    // A tap with no CTA still means "open the app", which already happened.
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("stays put for a destination this build has no screen for", async () => {
    await mount();

    act(() => {
      for (const listener of listeners) listener({ url: "/p/DIM-PAMP-0001" });
    });

    expect(mockPush).not.toHaveBeenCalled();
  });

  it("unsubscribes when the layout goes away", async () => {
    const { unmount } = await mount();
    unmount();
    expect(unsubscribed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Arrival 2: the app was NOT running — the common one
// ---------------------------------------------------------------------------

describe("usePushTapNavigation — the tap that started the process", () => {
  it("opens the screen a cold-start tap pointed at", async () => {
    // A phone that has been quiet long enough for a notification to matter is a
    // phone whose app was swiped away days ago. The response happened before
    // this JS runtime existed, so no listener could have heard it — the module
    // held it and `lastTap` is the only way to it.
    launchTap = { url: "/mis-mascotas/DIM-PAMP-0001" };

    await mount();

    expect(mockPush).toHaveBeenCalledWith("/mascotas/DIM-PAMP-0001");
  });

  it("navigates ONCE even if the layout mounts twice", async () => {
    // `getLastNotificationResponseAsync` keeps answering the SAME response for
    // the life of the process — it is a held value, not a queue. React mounts
    // effects twice in development on purpose, and a second navigation would
    // yank somebody off the screen they had just reached.
    launchTap = { url: "/mis-mascotas/DIM-PAMP-0001" };

    await mount();
    await mount();

    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it("does nothing when nothing launched the app", async () => {
    launchTap = null;
    await mount();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("does nothing on a build with no push module at all", async () => {
    // Every device in the closed test today. `moduleMissingPush` answers `null`
    // and hands back an unsubscribe that does nothing, and the hook must survive
    // that rather than assume a module.
    resetPushPort();

    await mount();

    expect(mockPush).not.toHaveBeenCalled();
  });

  it("survives a port that throws while being read or subscribed to", async () => {
    setPushPort(
      receivingPort({
        lastTap: async () => {
          throw new Error("native module gone");
        },
        onTap: () => {
          throw new Error("native module gone");
        },
      }),
    );

    // The root layout mounts this hook. A rejection here would be a cold start
    // that never finishes routing — worse than a lost destination, because the
    // app is what stops.
    await expect(mount()).resolves.toBeDefined();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
