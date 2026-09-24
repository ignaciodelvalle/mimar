// The Ajustes entry point back into notification permission — M4, decision
// 10A. Real port seam (`setPushPort`), mocked registration call — the same
// split `AltaScreen.test.tsx` uses for the priming card, and for the same
// reason: what this file proves is WHICH STATE shows WHICH control, not the
// registration plumbing behind the button.

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";

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
});
