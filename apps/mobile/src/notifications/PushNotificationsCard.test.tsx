// The Ajustes entry point back into notification permission — M4, decision
// 10A. Real port seam (`setPushPort`), mocked registration call — the same
// split `AltaScreen.test.tsx` uses for the priming card, and for the same
// reason: what this file proves is WHICH STATE shows WHICH control, not the
// registration plumbing behind the button.

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AppState, type AppStateStatus, Linking } from "react-native";

const mockRequestPushPermissionAndRegister = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock("./push-registration", () => ({
  requestPushPermissionAndRegister: (...args: unknown[]) =>
    mockRequestPushPermissionAndRegister(...args),
}));

import type { PushPort } from "../native/push-port";
import { resetPushPort, setPushPort } from "../native/push-port";
import { PushNotificationsCard } from "./PushNotificationsCard";

function portWithPeek(outcome: PushPort["getPermissionStatus"]): PushPort {
  return {
    name: "fake",
    available: true,
    requestPermission: async () => ({ outcome: "granted" }),
    getPermissionStatus: outcome,
    getExpoPushToken: async () => ({ outcome: "unavailable" }),
    lastTap: async () => null,
    onTap: () => () => undefined,
    ensureNotificationChannel: async () => undefined,
  };
}

/**
 * SPIED ON THE PUBLIC API and left calling through — same idiom
 * `AltaScreen.test.tsx`'s `appStateListener` uses. The point is only to get
 * hold of the "change" listener this card registered.
 */
const appStateListener = jest.spyOn(AppState, "addEventListener");

/** Take the app out of, or back into, the foreground. */
function emitAppState(next: AppStateStatus): void {
  const listener = appStateListener.mock.calls.at(-1)?.[1] as
    | ((state: AppStateStatus) => void)
    | undefined;
  if (listener === undefined) throw new Error("the card registered no AppState listener");
  act(() => listener(next));
}

beforeEach(() => {
  mockRequestPushPermissionAndRegister.mockReset();
  mockRequestPushPermissionAndRegister.mockResolvedValue({ outcome: "registered" });
});

afterEach(() => {
  resetPushPort();
});

describe("PushNotificationsCard", () => {
  it("renders nothing on a build with no push module at all", async () => {
    // The honest default (`resetPushPort` in `afterEach` covers `beforeEach`
    // too, since nothing here calls `setPushPort` first).
    const { toJSON } = render(<PushNotificationsCard />);
    await waitFor(() => expect(toJSON()).toBeNull());
  });

  it("renders nothing once permission is already granted", async () => {
    setPushPort(portWithPeek(async () => ({ outcome: "granted" })));

    const { toJSON } = render(<PushNotificationsCard />);
    await waitFor(() => expect(toJSON()).toBeNull());
  });

  it("offers a way back to system settings when permission was permanently refused, with no dead button", async () => {
    setPushPort(portWithPeek(async () => ({ outcome: "denied" })));

    render(<PushNotificationsCard />);
    await waitFor(() =>
      expect(screen.getByText(/entrá a los ajustes de notificaciones del sistema/)).toBeTruthy(),
    );
    expect(screen.queryByText("Activar avisos")).toBeNull();
  });

  it("offers 'Activar avisos' when nobody has been asked yet", async () => {
    setPushPort(portWithPeek(async () => ({ outcome: "undetermined" })));

    render(<PushNotificationsCard />);
    await waitFor(() => expect(screen.getByText("Activar avisos")).toBeOnTheScreen());
  });

  it("pressing 'Activar avisos' calls requestPushPermissionAndRegister", async () => {
    setPushPort(portWithPeek(async () => ({ outcome: "undetermined" })));

    render(<PushNotificationsCard />);
    await waitFor(() => expect(screen.getByText("Activar avisos")).toBeOnTheScreen());

    await act(async () => {
      fireEvent.press(screen.getByText("Activar avisos"));
    });

    expect(mockRequestPushPermissionAndRegister).toHaveBeenCalledTimes(1);
  });

  it("re-peeks after the request, and hides itself once the answer is granted", async () => {
    let granted = false;
    setPushPort(portWithPeek(async () => ({ outcome: granted ? "granted" : "undetermined" })));
    mockRequestPushPermissionAndRegister.mockImplementation(async () => {
      granted = true;
      return { outcome: "registered" };
    });

    const { toJSON } = render(<PushNotificationsCard />);
    await waitFor(() => expect(screen.getByText("Activar avisos")).toBeOnTheScreen());

    await act(async () => {
      fireEvent.press(screen.getByText("Activar avisos"));
    });

    await waitFor(() => expect(toJSON()).toBeNull());
  });

  it("'Abrir ajustes del teléfono' opens the OS notification settings, not the in-app request", async () => {
    setPushPort(portWithPeek(async () => ({ outcome: "denied" })));
    const openSettings = jest.spyOn(Linking, "openSettings").mockResolvedValue(undefined);

    render(<PushNotificationsCard />);
    await waitFor(() => expect(screen.getByText("Abrir ajustes del teléfono")).toBeOnTheScreen());

    await act(async () => {
      fireEvent.press(screen.getByText("Abrir ajustes del teléfono"));
    });

    expect(openSettings).toHaveBeenCalledTimes(1);
    // The denied state must never reach the in-app dialog: the OS will not
    // show it any more, and a call here would either no-op or look like a
    // failed attempt.
    expect(mockRequestPushPermissionAndRegister).not.toHaveBeenCalled();
    openSettings.mockRestore();
  });

  it("re-peeks when the app returns to the foreground, and updates once the OS grant changed underneath it", async () => {
    // THE SCENARIO THIS EXISTS FOR: denied → "Abrir ajustes del teléfono" →
    // the person flips the switch in system settings → back to miMAR. Nothing
    // inside this app observes that switch directly; the only signal is the
    // app itself coming back to `active`.
    let grantedNow = false;
    setPushPort(portWithPeek(async () => ({ outcome: grantedNow ? "granted" : "denied" })));

    render(<PushNotificationsCard />);
    await waitFor(() => expect(screen.getByText("Abrir ajustes del teléfono")).toBeOnTheScreen());

    grantedNow = true;
    emitAppState("background");
    emitAppState("active");

    await waitFor(() => expect(screen.queryByText("Abrir ajustes del teléfono")).toBeNull());
  });

  it("does NOT re-peek on a change that never left `active`", async () => {
    // The negative case for the guard above: without it, EVERY AppState
    // "change" event — including ones that never left the foreground — would
    // re-run the peek, which is a wasted read on every such event.
    let peekCount = 0;
    setPushPort(
      portWithPeek(async () => {
        peekCount += 1;
        return { outcome: "undetermined" };
      }),
    );

    render(<PushNotificationsCard />);
    await waitFor(() => expect(screen.getByText("Activar avisos")).toBeOnTheScreen());
    const afterMount = peekCount;

    emitAppState("active");

    // Flush any microtask a stray peek would have scheduled.
    await act(async () => undefined);
    expect(peekCount).toBe(afterMount);
  });
});
