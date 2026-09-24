// THE TWO REQUESTS THIS APP MAKES ABOUT PUSH, and the refusals that come first.
//
// WHAT IS REAL HERE AND WHAT IS NOT. The PORT is real — these tests install a
// fake through `setPushPort`, the same call `app/_layout.tsx` makes, so the
// `…Safely()` wrappers and the honest default are exercised rather than
// described. The API client is mocked, because what is under test is WHICH body
// goes out and WHEN, not how a bearer token reaches a fetch.
//
// MUTATIONS THAT MUST GO RED HERE (applied while writing, then reverted):
//   · dropping the `getPushPort().available` guard in `registerThisDeviceForPush`
//     — the "does not ask a build that cannot receive" test.
//   · dropping the same guard in `revokeThisDeviceForPush` — the "signing out of
//     a build without push costs no request" test.
//   · registering with a `null` install id — the "does not register an id it
//     could not persist" test.
//   · moving the permission request above the install-id read — the ordering
//     test, which is the one that keeps a prompt off a phone that cannot use it.

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockApiRequest = jest.fn();
const mockGetOrCreateInstallDeviceId = jest.fn();
let mockPlatformOS = "android";
let mockAppVersion: unknown = "1.4.2";

jest.mock("../api/client", () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));

jest.mock("./install-identity", () => ({
  getOrCreateInstallDeviceId: (...args: unknown[]) => mockGetOrCreateInstallDeviceId(...args),
}));

jest.mock("react-native", () => ({
  Platform: {
    get OS() {
      return mockPlatformOS;
    },
  },
}));

jest.mock("expo-constants", () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return { version: mockAppVersion };
    },
  },
}));

import type { PushPort } from "../native/push-port";
import { resetPushPort, setPushPort } from "../native/push-port";
import {
  PUSH_TARGETS_PATH,
  currentPushPlatform,
  registerThisDeviceForPush,
  revokeThisDeviceForPush,
} from "./push-registration";

const DEVICE_ID = "0f2b1f3c-4d5e-4a6b-8c7d-9e0f1a2b3c4d";
const TOKEN = "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]";

/** A port that works, unless told otherwise. */
function workingPort(over: Partial<PushPort> = {}): PushPort {
  return {
    name: "fake",
    available: true,
    requestPermission: async () => ({ outcome: "granted" }),
    getExpoPushToken: async () => ({ outcome: "token", expoPushToken: TOKEN }),
    // The presentation half of the port. Nothing in THIS file exercises it —
    // registration is about delivery, not about drawing — but a port is a whole
    // contract and a fake that implements half of it would not compile.
    lastTap: async () => null,
    onTap: () => () => undefined,
    ensureNotificationChannel: async () => undefined,
    ...over,
  };
}

/** The session the requests are made with. Never read by anything under test. */
const session = { accessToken: async () => "bearer" } as never;

beforeEach(() => {
  mockApiRequest.mockReset();
  mockApiRequest.mockResolvedValue({ outcome: "ok", payload: { registered: true } } as never);
  mockGetOrCreateInstallDeviceId.mockReset();
  mockGetOrCreateInstallDeviceId.mockResolvedValue(DEVICE_ID as never);
  mockPlatformOS = "android";
  mockAppVersion = "1.4.2";
});

afterEach(() => {
  resetPushPort();
});

describe("registerThisDeviceForPush", () => {
  it("sends the register command with the install id, the token and the platform", async () => {
    setPushPort(workingPort());

    expect(await registerThisDeviceForPush(session)).toEqual({ outcome: "registered" });
    expect(mockApiRequest).toHaveBeenCalledTimes(1);
    // The body is pinned against literals: every field here is one the endpoint
    // validates, and a rename on either side must fail in a test rather than as
    // a 400 on somebody's phone.
    expect(mockApiRequest).toHaveBeenCalledWith(
      {
        path: "/api/v1/me/push-targets",
        method: "POST",
        body: {
          command: "register",
          deviceId: DEVICE_ID,
          expoPushToken: TOKEN,
          platform: "android",
          appVersion: "1.4.2",
        },
      },
      session,
    );
  });

  it("pins the endpoint path", () => {
    expect(PUSH_TARGETS_PATH).toBe("/api/v1/me/push-targets");
  });

  it("does NOT ask a build that cannot receive — the honest default stops it", async () => {
    // No `setPushPort`: this is `moduleMissingPush`, which is what every device
    // in the closed test is actually running today.
    expect(await registerThisDeviceForPush(session)).toEqual({ outcome: "unavailable" });
    expect(mockApiRequest).not.toHaveBeenCalled();
    expect(mockGetOrCreateInstallDeviceId).not.toHaveBeenCalled();
  });

  it("reads the install id BEFORE it asks for permission", async () => {
    // THE ORDER IS THE TEST. A phone whose keychain will not answer cannot
    // register at all, and asking it for notification permission first would
    // spend the one prompt iOS ever gives on a registration that cannot happen.
    const order: string[] = [];
    mockGetOrCreateInstallDeviceId.mockImplementation(async () => {
      order.push("install-id");
      return DEVICE_ID;
    });
    setPushPort(
      workingPort({
        requestPermission: async () => {
          order.push("permission");
          return { outcome: "granted" };
        },
      }),
    );

    await registerThisDeviceForPush(session);
    expect(order).toEqual(["install-id", "permission"]);
  });

  it("does not register an id it could not persist", async () => {
    mockGetOrCreateInstallDeviceId.mockResolvedValue(null as never);
    setPushPort(workingPort());

    expect(await registerThisDeviceForPush(session)).toEqual({
      outcome: "failed",
      detail: "no install id",
    });
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  it("carries a refusal through as denied, and spends no request on it", async () => {
    setPushPort(workingPort({ requestPermission: async () => ({ outcome: "denied" }) }));

    expect(await registerThisDeviceForPush(session)).toEqual({ outcome: "denied" });
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  it("keeps denied and unavailable apart when the TOKEN read is what refuses", async () => {
    setPushPort(workingPort({ getExpoPushToken: async () => ({ outcome: "denied" }) }));
    expect(await registerThisDeviceForPush(session)).toEqual({ outcome: "denied" });

    setPushPort(workingPort({ getExpoPushToken: async () => ({ outcome: "unavailable" }) }));
    expect(await registerThisDeviceForPush(session)).toEqual({ outcome: "unavailable" });

    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  it("names which step failed, so a breadcrumb says permission or token", async () => {
    setPushPort(
      workingPort({ requestPermission: async () => ({ outcome: "failed", detail: "boom" }) }),
    );
    expect(await registerThisDeviceForPush(session)).toEqual({
      outcome: "failed",
      detail: "permission: boom",
    });

    setPushPort(
      workingPort({ getExpoPushToken: async () => ({ outcome: "failed", detail: "kaboom" }) }),
    );
    expect(await registerThisDeviceForPush(session)).toEqual({
      outcome: "failed",
      detail: "token: kaboom",
    });
  });

  it("survives a port that THROWS, because the seam's wrapper catches it", async () => {
    // The `…Safely()` wrappers exist for exactly this, and this test is the
    // proof that this call path goes through them rather than around them.
    setPushPort(
      workingPort({
        requestPermission: async () => {
          throw new Error("adapter broke its promise");
        },
      }),
    );

    const result = await registerThisDeviceForPush(session);
    expect(result.outcome).toBe("failed");
    expect(result).toMatchObject({
      detail: expect.stringContaining("adapter broke its promise") as never,
    });
  });

  it("reports an API failure as failed rather than as a registration", async () => {
    mockApiRequest.mockResolvedValue({
      outcome: "api-error",
      code: "rate_limited",
      retryAfterSeconds: 30,
    } as never);
    setPushPort(workingPort());

    expect(await registerThisDeviceForPush(session)).toEqual({
      outcome: "failed",
      detail: "api: api-error",
    });
  });

  it("refuses a platform the column's CHECK does not admit", async () => {
    mockPlatformOS = "web";
    setPushPort(workingPort());

    expect(await registerThisDeviceForPush(session)).toEqual({ outcome: "unavailable" });
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  it("omits appVersion when the build carries none, and truncates a silly one", async () => {
    mockAppVersion = undefined;
    setPushPort(workingPort());
    await registerThisDeviceForPush(session);
    expect(mockApiRequest.mock.calls[0]?.[0]).toMatchObject({
      body: { appVersion: undefined },
    });

    mockApiRequest.mockClear();
    mockAppVersion = "9".repeat(200);
    await registerThisDeviceForPush(session);
    // 64 is the contract's cap. Truncating keeps the registration; refusing it
    // would lose the row over triage metadata.
    const sent = (mockApiRequest.mock.calls[0]?.[0] as { body: { appVersion: string } }).body;
    expect(sent.appVersion).toHaveLength(64);
  });
});

describe("currentPushPlatform", () => {
  it("answers ios and android, and null for everything else", () => {
    mockPlatformOS = "ios";
    expect(currentPushPlatform()).toBe("ios");
    mockPlatformOS = "android";
    expect(currentPushPlatform()).toBe("android");
    mockPlatformOS = "macos";
    expect(currentPushPlatform()).toBeNull();
  });
});

describe("revokeThisDeviceForPush", () => {
  it("sends the revoke command with the install id and nothing else", async () => {
    setPushPort(workingPort());

    await revokeThisDeviceForPush(session);

    expect(mockApiRequest).toHaveBeenCalledWith(
      {
        path: "/api/v1/me/push-targets",
        method: "POST",
        // NO token and NO platform. The server scopes the update by the caller
        // and the device; sending a token here would be sending a delivery
        // address in order to stop deliveries to it.
        body: { command: "revoke", deviceId: DEVICE_ID },
      },
      session,
    );
  });

  it("costs no request when this build has no push at all", async () => {
    // Every sign-out on every installed build today lands here. Minting an
    // install id and revoking a row that was never written would be one wasted
    // round trip on each of them.
    await revokeThisDeviceForPush(session);

    expect(mockApiRequest).not.toHaveBeenCalled();
    expect(mockGetOrCreateInstallDeviceId).not.toHaveBeenCalled();
  });

  it("gives up quietly when there is no install id", async () => {
    mockGetOrCreateInstallDeviceId.mockResolvedValue(null as never);
    setPushPort(workingPort());

    await expect(revokeThisDeviceForPush(session)).resolves.toEqual({
      outcome: "skipped",
      reason: "no-install-id",
    });
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  it("resolves even when the request fails, because a sign-out must not be blocked", async () => {
    mockApiRequest.mockResolvedValue({ outcome: "unreachable", detail: "offline" } as never);
    setPushPort(workingPort());

    // IT RESOLVES, AND IT NOW SAYS WHAT HAPPENED. This used to assert
    // `toBeUndefined()`, which was the defect stated as a test: the function
    // returned `void`, so "the revoke did not land" and "the revoke landed" were
    // the same observation from every angle, and the row stayed live with
    // nothing anywhere recording it. Resolving is still the contract — somebody
    // signing out is leaving — but the outcome is now a value a caller can
    // report.
    await expect(revokeThisDeviceForPush(session)).resolves.toEqual({
      outcome: "failed",
      detail: "unreachable",
    });
  });

  it("reports an acknowledged revoke even when the server had nothing to revoke", async () => {
    // `revoked: false` — already revoked, or never registered — is a legitimate
    // 200 and must not read as a failure. Signing out twice is not an incident.
    mockApiRequest.mockResolvedValue({ outcome: "ok", payload: { revoked: false } } as never);
    setPushPort(workingPort());

    await expect(revokeThisDeviceForPush(session)).resolves.toEqual({ outcome: "acknowledged" });
  });

  it("says WHY it skipped on a build with no push, so a caller does not report it", async () => {
    resetPushPort();

    await expect(revokeThisDeviceForPush(session)).resolves.toEqual({
      outcome: "skipped",
      reason: "no-push-in-build",
    });
  });
});
