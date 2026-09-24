// THE ADAPTER'S MAPPING, shape by shape, against a mocked native module.
//
// This is §7 item 6 of dim-interno:docs/handoff/push-notifications.md: "every shape
// `expo-notifications` can return, mapped onto your port's outcome union".
//
// WHAT THIS FILE CAN AND CANNOT PROVE, stated first so nobody reads a green run
// as more than it is. It proves the TRANSLATION: for every status object and
// every rejection the module can produce, which member of
// `PushPermissionResult` / `PushTokenResult` comes out. It proves NOTHING about
// whether a real phone shows the dialog, whether Expo's servers issue a token,
// or whether a notification ever arrives. Those live behind the native module
// this file replaces, and the only instrument for them is a development build
// on a device — see the report's "what a person can actually do" section.
//
// WHY THE MODULE IS MOCKED AT ALL: importing `expo-notifications` touches the
// native runtime at import time and throws in a jest process. The adapter's own
// header explains why that import stays at module scope; the price is that its
// test hoists a `jest.mock` for it.
//
// MUTATIONS THAT MUST GO RED HERE (applied while writing, then reverted):
//   · `if (status.granted)` → `if (status.status === "granted")` — the
//     provisional-authorization test, which is the whole reason it reads the
//     boolean.
//   · dropping the `canAskAgain` guard in `requestPermission` — the "does not
//     re-ask after a permanent refusal" test.
//   · `unavailable` → `failed` for the two configuration codes, and the
//     converse for `E_REGISTRATION_FAILED` — the token-failure table.
//   · dropping the prefix check — the "refuses a token of the wrong shape"
//     test.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

// The `mock` prefix is required: jest's factories may not close over an
// unprefixed outer binding. The factories DELEGATE rather than handing the mock
// over, because `jest.mock` is hoisted above every `const` here and passing the
// binding directly would capture it inside its temporal dead zone.
const mockGetPermissionsAsync = jest.fn();
const mockRequestPermissionsAsync = jest.fn();
const mockGetExpoPushTokenAsync = jest.fn();
const mockSetNotificationChannelAsync = jest.fn();
const mockGetLastNotificationResponseAsync = jest.fn<() => Promise<unknown>>();
const mockAddNotificationResponseReceivedListener = jest.fn();
const mockRemoveSubscription = jest.fn();
let mockExpoConfig: unknown = { extra: { eas: { projectId: "db4bebed-test" } } };

jest.mock("expo-notifications", () => ({
  getPermissionsAsync: () => mockGetPermissionsAsync(),
  requestPermissionsAsync: (...args: unknown[]) => mockRequestPermissionsAsync(...args),
  getExpoPushTokenAsync: (...args: unknown[]) => mockGetExpoPushTokenAsync(...args),
  // THE ONE MOCK THAT CANNOT DELEGATE, and the reason is the same temporal dead
  // zone the header above warns about — one step worse. The adapter calls
  // `setNotificationHandler` at MODULE SCOPE, so it runs while this file's own
  // imports are still being resolved, BEFORE any `const` here has been
  // initialised. A delegating arrow would reach for a binding that does not
  // exist yet and fail the whole suite with "not a function". So the mock is
  // created inside the factory and fetched back below with `requireMock`.
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: (...args: unknown[]) => mockSetNotificationChannelAsync(...args),
  getLastNotificationResponseAsync: () => mockGetLastNotificationResponseAsync(),
  addNotificationResponseReceivedListener: (...args: unknown[]) => {
    mockAddNotificationResponseReceivedListener(...args);
    return { remove: () => mockRemoveSubscription() };
  },
  // The real enum, by value. Transcribed rather than imported because the module
  // is mocked wholesale here; the assertion below pins the NAME so a renumbering
  // upstream cannot pass silently.
  AndroidImportance: {
    UNKNOWN: 0,
    UNSPECIFIED: 1,
    NONE: 2,
    MIN: 3,
    LOW: 4,
    DEFAULT: 5,
    HIGH: 6,
    MAX: 7,
  },
}));

jest.mock("expo-constants", () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return mockExpoConfig;
    },
  },
}));

import { PUSH_ANDROID_CHANNEL_ID, PUSH_ANDROID_HEALTH_CHANNEL_ID } from "@dim/contract/input";
import { Platform } from "react-native";

import {
  FOREGROUND_PRESENTATION,
  IOS_PERMISSION_REQUEST,
  deepLinkFromNotificationData,
  expoProjectId,
  expoPush,
  interpretPermission,
  interpretTokenFailure,
  tapFromResponse,
} from "./expo-push-adapter";

/**
 * `Platform.OS`, temporarily.
 *
 * The channel is Android-only and the suite runs under jest-expo's ios default,
 * so the one branch that does anything is unreachable without this. A defineProperty
 * rather than a `jest.mock("react-native")`: mocking the whole module here would
 * replace far more than the one field being varied.
 */
/**
 * The handler mock, fetched from the factory rather than closed over. See the
 * note on `setNotificationHandler` above for why it cannot be the other way.
 */
const mockSetNotificationHandler = (
  jest.requireMock("expo-notifications") as { setNotificationHandler: jest.Mock }
).setNotificationHandler;

function withPlatform(os: "ios" | "android", run: () => Promise<void>): Promise<void> {
  const original = Platform.OS;
  Object.defineProperty(Platform, "OS", { value: os, configurable: true });
  return run().finally(() => {
    Object.defineProperty(Platform, "OS", { value: original, configurable: true });
  });
}

/**
 * A permissions status, with the two fields the adapter actually reads.
 *
 * The real object carries a dozen more (iOS alert styles, Android importance).
 * They are omitted because the adapter never touches them, and a fixture that
 * transcribed them would suggest it did.
 */
function status(over: {
  granted: boolean;
  canAskAgain: boolean;
  status?: string;
}): never | object {
  return {
    granted: over.granted,
    canAskAgain: over.canAskAgain,
    status: over.status ?? (over.granted ? "granted" : "denied"),
    expires: "never",
  };
}

/** An Expo `CodedError`, as the module rejects with one. */
function coded(code: string, message = "something went wrong"): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

const GOOD_TOKEN = "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]";

beforeEach(() => {
  mockGetPermissionsAsync.mockReset();
  mockRequestPermissionsAsync.mockReset();
  mockGetExpoPushTokenAsync.mockReset();
  mockSetNotificationChannelAsync.mockReset();
  mockGetLastNotificationResponseAsync.mockReset();
  mockAddNotificationResponseReceivedListener.mockReset();
  mockRemoveSubscription.mockReset();
  mockExpoConfig = { extra: { eas: { projectId: "db4bebed-test" } } };
  // NOT `mockSetNotificationHandler`. It is called exactly once, at module
  // scope, when this file imports the adapter — resetting it would erase the
  // only record that ever exists and the "installs a handler" test would then
  // pass for every file order and fail for none.
});

describe("the port's identity", () => {
  it("claims the module is available and names itself", () => {
    // The name rides every `failed.detail` the safe wrappers produce, so a
    // breadcrumb says WHICH implementation broke its promise.
    expect(expoPush.name).toBe("expo-notifications");
    expect(expoPush.available).toBe(true);
  });
});

describe("interpretPermission — every status shape the module can return", () => {
  it("maps a plain grant to granted", () => {
    expect(interpretPermission(status({ granted: true, canAskAgain: false }) as never)).toEqual({
      outcome: "granted",
    });
  });

  it("maps an iOS PROVISIONAL authorization to granted, though its status string is not 'granted'", () => {
    // THE REASON THE ADAPTER READS `granted` AND NOT `status`. A provisional
    // authorization delivers quietly to Notification Center — the token is real
    // and registration is correct. Switching on the string would throw away a
    // working install for failing a comparison.
    const provisional = status({ granted: true, canAskAgain: false, status: "provisional" });
    expect(interpretPermission(provisional as never)).toEqual({ outcome: "granted" });
  });

  it("maps a refusal that cannot be asked again to denied", () => {
    expect(interpretPermission(status({ granted: false, canAskAgain: false }) as never)).toEqual({
      outcome: "denied",
    });
  });

  it("maps 'undetermined but still askable' to failed, NOT to denied", () => {
    // iOS defers the prompt when the request is made off the foreground and
    // answers undetermined without showing anything. Nobody said no; mapping it
    // to `denied` would permanently stop asking somebody who was never asked.
    const result = interpretPermission(
      status({ granted: false, canAskAgain: true, status: "undetermined" }) as never,
    );
    expect(result.outcome).toBe("failed");
    expect(result).toMatchObject({ detail: expect.stringContaining("undetermined") as never });
  });
});

describe("requestPermission — reading before asking", () => {
  it("answers granted from the existing state WITHOUT showing a second dialog", async () => {
    mockGetPermissionsAsync.mockResolvedValue(
      status({ granted: true, canAskAgain: false }) as never,
    );

    expect(await expoPush.requestPermission()).toEqual({ outcome: "granted" });
    // The load-bearing assertion: Android would draw a real prompt here.
    expect(mockRequestPermissionsAsync).not.toHaveBeenCalled();
  });

  it("does NOT re-ask after a permanent refusal", async () => {
    mockGetPermissionsAsync.mockResolvedValue(
      status({ granted: false, canAskAgain: false }) as never,
    );

    expect(await expoPush.requestPermission()).toEqual({ outcome: "denied" });
    // The OS would show nothing; calling anyway would be a round trip whose
    // answer we already had, and it would hide the fact that we knew.
    expect(mockRequestPermissionsAsync).not.toHaveBeenCalled();
  });

  it("asks when the dialog is still available, and passes the iOS options", async () => {
    mockGetPermissionsAsync.mockResolvedValue(
      status({ granted: false, canAskAgain: true, status: "undetermined" }) as never,
    );
    mockRequestPermissionsAsync.mockResolvedValue(
      status({ granted: true, canAskAgain: false }) as never,
    );

    expect(await expoPush.requestPermission()).toEqual({ outcome: "granted" });
    expect(mockRequestPermissionsAsync).toHaveBeenCalledWith(IOS_PERMISSION_REQUEST);
  });

  it("asks for alert, badge and sound — and for nothing else", () => {
    // Pinned against literals, not against the adapter's own constant read back
    // through itself. `allowProvisional` and `allowCriticalAlerts` are absent on
    // purpose; see the constant's header.
    expect(IOS_PERMISSION_REQUEST).toEqual({
      ios: { allowAlert: true, allowBadge: true, allowSound: true },
    });
  });

  it("maps a refusal given at the dialog to denied", async () => {
    mockGetPermissionsAsync.mockResolvedValue(
      status({ granted: false, canAskAgain: true, status: "undetermined" }) as never,
    );
    mockRequestPermissionsAsync.mockResolvedValue(
      status({ granted: false, canAskAgain: false }) as never,
    );

    expect(await expoPush.requestPermission()).toEqual({ outcome: "denied" });
  });

  it("maps a throwing read to failed, naming which call threw", async () => {
    mockGetPermissionsAsync.mockRejectedValue(coded("ERR_X", "no permissions module") as never);

    const result = await expoPush.requestPermission();
    expect(result.outcome).toBe("failed");
    expect(result).toMatchObject({ detail: expect.stringContaining("getPermissions") as never });
  });

  it("maps a throwing request to failed, naming the other call", async () => {
    mockGetPermissionsAsync.mockResolvedValue(
      status({ granted: false, canAskAgain: true, status: "undetermined" }) as never,
    );
    mockRequestPermissionsAsync.mockRejectedValue(new Error("activity is gone") as never);

    const result = await expoPush.requestPermission();
    expect(result.outcome).toBe("failed");
    expect(result).toMatchObject({
      detail: expect.stringContaining("requestPermissions") as never,
    });
  });
});

describe("getExpoPushToken", () => {
  it("returns the token when permission is held", async () => {
    mockGetPermissionsAsync.mockResolvedValue(
      status({ granted: true, canAskAgain: false }) as never,
    );
    mockGetExpoPushTokenAsync.mockResolvedValue({ type: "expo", data: GOOD_TOKEN } as never);

    expect(await expoPush.getExpoPushToken()).toEqual({
      outcome: "token",
      expoPushToken: GOOD_TOKEN,
    });
  });

  it("passes the projectId from app.config's extra.eas", async () => {
    mockGetPermissionsAsync.mockResolvedValue(
      status({ granted: true, canAskAgain: false }) as never,
    );
    mockGetExpoPushTokenAsync.mockResolvedValue({ type: "expo", data: GOOD_TOKEN } as never);

    await expoPush.getExpoPushToken();

    // Inferring it instead would raise ERR_NOTIFICATIONS_NO_EXPERIENCE_ID with
    // a sentence about the bare workflow; passing it keeps the failure readable.
    expect(mockGetExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: "db4bebed-test" });
  });

  it("does NOT spend a network round trip when permission is not held", async () => {
    mockGetPermissionsAsync.mockResolvedValue(
      status({ granted: false, canAskAgain: true }) as never,
    );

    expect(await expoPush.getExpoPushToken()).toEqual({ outcome: "denied" });
    // `getExpoPushTokenAsync` is a request to Expo's servers, not a local read.
    expect(mockGetExpoPushTokenAsync).not.toHaveBeenCalled();
  });

  it("answers unavailable when the build carries no projectId, without calling the module", async () => {
    mockExpoConfig = { extra: {} };
    mockGetPermissionsAsync.mockResolvedValue(
      status({ granted: true, canAskAgain: false }) as never,
    );

    expect(await expoPush.getExpoPushToken()).toEqual({ outcome: "unavailable" });
    expect(mockGetExpoPushTokenAsync).not.toHaveBeenCalled();
  });

  it("refuses a token of the wrong shape rather than registering one the server would reject", async () => {
    mockGetPermissionsAsync.mockResolvedValue(
      status({ granted: true, canAskAgain: false }) as never,
    );
    mockGetExpoPushTokenAsync.mockResolvedValue({ type: "expo", data: "fcm-raw-token" } as never);

    const result = await expoPush.getExpoPushToken();
    expect(result.outcome).toBe("failed");
    // The token must NOT appear in the detail — it is a delivery address and
    // `detail` is written to logs. Its length may.
    expect(result).toMatchObject({ detail: expect.not.stringContaining("fcm-raw-token") as never });
    expect(result).toMatchObject({ detail: expect.stringContaining("13 chars") as never });
  });

  it("maps a rejection through the failure table", async () => {
    mockGetPermissionsAsync.mockResolvedValue(
      status({ granted: true, canAskAgain: false }) as never,
    );
    mockGetExpoPushTokenAsync.mockRejectedValue(coded("ERR_NOTIFICATIONS_NETWORK_ERROR") as never);

    expect((await expoPush.getExpoPushToken()).outcome).toBe("failed");
  });

  it("maps a throwing permissions read to failed rather than to denied", async () => {
    // `denied` would be a lie: nobody refused anything, the module broke.
    mockGetPermissionsAsync.mockRejectedValue(new Error("module gone") as never);

    expect((await expoPush.getExpoPushToken()).outcome).toBe("failed");
  });
});

describe("interpretTokenFailure — every rejection the token path can produce", () => {
  it("maps a missing experience id to unavailable", () => {
    expect(interpretTokenFailure(coded("ERR_NOTIFICATIONS_NO_EXPERIENCE_ID"))).toEqual({
      outcome: "unavailable",
    });
  });

  it("maps a missing application id to unavailable", () => {
    expect(interpretTokenFailure(coded("ERR_NOTIFICATIONS_NO_APPLICATION_ID"))).toEqual({
      outcome: "unavailable",
    });
  });

  it("maps E_REGISTRATION_FAILED to failed, NOT to unavailable", () => {
    // THE DECISION THIS TEST EXISTS TO PIN. An emulator without Play Services
    // and a real phone with a broken FCM config produce the same string from
    // JS. `unavailable` would silence both; the second is a production channel
    // that cannot obtain a single token, and it must stay visible.
    const result = interpretTokenFailure(
      coded("E_REGISTRATION_FAILED", "Fetching the token failed"),
    );
    expect(result.outcome).toBe("failed");
    expect(result).toMatchObject({
      detail: expect.stringContaining("E_REGISTRATION_FAILED") as never,
    });
  });

  it("maps the network and server codes to failed, carrying the code", () => {
    for (const code of ["ERR_NOTIFICATIONS_NETWORK_ERROR", "ERR_NOTIFICATIONS_SERVER_ERROR"]) {
      const result = interpretTokenFailure(coded(code));
      expect(result.outcome).toBe("failed");
      expect(result).toMatchObject({ detail: expect.stringContaining(code) as never });
    }
  });

  it("maps a bare Error, with no code at all, to failed", () => {
    const result = interpretTokenFailure(new Error("kaboom"));
    expect(result).toEqual({ outcome: "failed", detail: "kaboom" });
  });

  it("maps a thrown non-Error to failed without crashing on it", () => {
    // A native bridge can reject with a string. `error.message` on one is
    // `undefined`, and a detail of "undefined" tells a reader nothing.
    expect(interpretTokenFailure("not even an Error")).toEqual({
      outcome: "failed",
      detail: "not even an Error",
    });
  });
});

describe("expoProjectId", () => {
  it("reads extra.eas.projectId", () => {
    expect(expoProjectId()).toBe("db4bebed-test");
  });

  it("answers null when the key is absent, and when it is empty", () => {
    mockExpoConfig = { extra: { eas: {} } };
    expect(expoProjectId()).toBeNull();

    // An empty string would pass a naive truthiness check in some shapes and
    // reach the module as a projectId, which fails three layers away.
    mockExpoConfig = { extra: { eas: { projectId: "" } } };
    expect(expoProjectId()).toBeNull();
  });

  it("answers null when there is no expoConfig at all", () => {
    mockExpoConfig = null;
    expect(expoProjectId()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The FOREGROUND, which used to be an absence and was the wrong one.
//
// With no handler installed, expo-notifications draws nothing while the app is
// open — so the notification that arrives during the five minutes somebody
// spends staring at this app because their animal is lost is the one that
// vanishes. These pin the answer, and specifically pin the field whose obvious
// value is a trap.
// ---------------------------------------------------------------------------

describe("the foreground presentation", () => {
  it("installs a handler at module scope, before anything can arrive", () => {
    // Importing the adapter is what does this; asserting it here is asserting
    // that the import had the effect, which is the only observable form of "at
    // module scope".
    expect(mockSetNotificationHandler).toHaveBeenCalledTimes(1);
  });

  it("answers the same presentation the constant declares", async () => {
    const [config] = mockSetNotificationHandler.mock.calls[0] as [
      { handleNotification: () => Promise<unknown> },
    ];
    await expect(config.handleNotification()).resolves.toEqual(FOREGROUND_PRESENTATION);
  });

  it("draws the banner AND files it in the tray", () => {
    // Both, not either. The banner is what the person sees now; the list is what
    // makes it recoverable for somebody mid-form who let the banner pass.
    expect(FOREGROUND_PRESENTATION.shouldShowBanner).toBe(true);
    expect(FOREGROUND_PRESENTATION.shouldShowList).toBe(true);
  });

  it("plays the sound, because on Android that is the banner's price", () => {
    // NOT a preference. expo-notifications documents that `shouldPlaySound:
    // false` suppresses the drop-down alert on Android entirely, "no matter what
    // the priority is" — so a `false` written to spare somebody a chime takes
    // the banner with it, which is the vanishing this handler exists to stop.
    // Pinned against the literal so nobody makes it quiet without reading why.
    expect(FOREGROUND_PRESENTATION.shouldPlaySound).toBe(true);
  });

  it("never touches the badge, which nothing in this app clears", () => {
    expect(FOREGROUND_PRESENTATION.shouldSetBadge).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The Android channel
// ---------------------------------------------------------------------------

describe("ensureNotificationChannel", () => {
  it("creates the ordinary channel the SERVER addresses, at default importance", async () => {
    await withPlatform("android", async () => {
      await expoPush.ensureNotificationChannel();
    });

    // TWO channels since 2026-09-16 (PO). On Android the channel is the unit a
    // person silences, so one channel for everything left them one switch:
    // silencing sighting notices took the rabies alerts with it.
    expect(mockSetNotificationChannelAsync).toHaveBeenCalledTimes(2);
    const [channelId, config] = mockSetNotificationChannelAsync.mock.calls[0] as [
      string,
      { name: string; description: string; importance: number },
    ];
    // THE SAME CONSTANT `expo-push.ts` puts in `channelId`. A channel the server
    // does not address is a channel that configures nothing, so this is the
    // assertion that keeps the two halves one design.
    expect(channelId).toBe(PUSH_ANDROID_CHANNEL_ID);
    // DEFAULT (5), not HIGH. Android refuses to let an app raise a channel's
    // importance after creation, so this value is effectively permanent for
    // every install that ever sees it — which is why it is pinned against a
    // literal and why raising it means a new channel id.
    expect(config.importance).toBe(5);
    // es-AR, because these are the two strings Android shows in the system
    // settings screen where somebody turns this category off. RENAMED when the
    // health channel was split out: a switch labelled "Avisos urgentes" that no
    // longer controls the urgent ones is a label that lies.
    expect(config.name).toBe("Avisos de tus mascotas");
    expect(config.description).toBe(
      "Hallazgos, avistajes, transferencias y cuidados. Suenan una vez y esperan en la bandeja.",
    );
  });

  it("creates the health channel at HIGH, which is the one place HIGH is spent", async () => {
    await withPlatform("android", async () => {
      await expoPush.ensureNotificationChannel();
    });

    const [channelId, config] = mockSetNotificationChannelAsync.mock.calls[1] as [
      string,
      { name: string; description: string; importance: number },
    ];
    expect(channelId).toBe(PUSH_ANDROID_HEALTH_CHANNEL_ID);
    // HIGH is 6, NOT 4, and the number is worth a sentence because the obvious
    // guess is wrong. `Notifications.AndroidImportance` is EXPO's enum and it is
    // offset from Android's own: Expo counts UNKNOWN 0, UNSPECIFIED 1, NONE 2,
    // MIN 3, LOW 4, DEFAULT 5, HIGH 6, MAX 7, while Android's NotificationManager
    // counts IMPORTANCE_DEFAULT as 3 and IMPORTANCE_HIGH as 4. Reading 4 off the
    // Android docs and pinning it here asserts LOW while the code says HIGH, and
    // every other assertion in this block would still pass. (Confirmed against a
    // real device on 2026-09-16: `dumpsys notification` reported mImportance=3
    // for the channel this file creates at Expo's 5.)
    //
    // Pinned against a literal for the same reason the 5 above is: immutable
    // once created, so this number is permanent per install.
    expect(config.importance).toBe(6);
    expect(config.name).toBe("Urgencias sanitarias");
    expect(config.description).toBe(
      "Rabia y brotes. Interrumpen porque hay un plazo legal corriendo.",
    );
  });

  it("the two channels are DISTINCT ids — one config cannot silently become the other", async () => {
    // The mutation this kills: pointing both `setNotificationChannelAsync` calls
    // at the same id. Android would upsert the second over the first, the person
    // would see one switch again, and every assertion above would still pass
    // because each one reads its own call.
    expect(PUSH_ANDROID_CHANNEL_ID).not.toBe(PUSH_ANDROID_HEALTH_CHANNEL_ID);
    await withPlatform("android", async () => {
      await expoPush.ensureNotificationChannel();
    });
    const ids = mockSetNotificationChannelAsync.mock.calls.map((call) => call[0]);
    expect(new Set(ids).size).toBe(2);
  });

  it("does nothing at all on iOS, where channels do not exist", async () => {
    await withPlatform("ios", async () => {
      await expoPush.ensureNotificationChannel();
    });

    expect(mockSetNotificationChannelAsync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Reading a tap
// ---------------------------------------------------------------------------

describe("deepLinkFromNotificationData — the payload is not trusted", () => {
  it("reads the url the server wrote", () => {
    expect(deepLinkFromNotificationData({ url: "/mis-mascotas/DIM-PAMP-0001" })).toBe(
      "/mis-mascotas/DIM-PAMP-0001",
    );
  });

  it("answers null for every shape that is not a url string", () => {
    // `content.data` is typed `Record<string, any>` by the module, which is to
    // say it is not typed: it came off a payload that travelled through Expo,
    // through APNs or FCM, and through the OS. Each of these is a real arrival —
    // another app's notification, an older server, a field lost on the way.
    expect(deepLinkFromNotificationData(undefined)).toBeNull();
    expect(deepLinkFromNotificationData(null)).toBeNull();
    expect(deepLinkFromNotificationData({})).toBeNull();
    expect(deepLinkFromNotificationData({ url: null })).toBeNull();
    expect(deepLinkFromNotificationData({ url: 42 })).toBeNull();
    expect(deepLinkFromNotificationData({ url: "" })).toBeNull();
    expect(deepLinkFromNotificationData({ url: { href: "/x" } })).toBeNull();
    expect(deepLinkFromNotificationData("/mis-mascotas/DIM-PAMP-0001")).toBeNull();
  });

  it("digs the url out of a whole response object", () => {
    expect(
      tapFromResponse({
        notification: { request: { content: { data: { url: "/mis-turnos" } } } },
      }),
    ).toEqual({ url: "/mis-turnos" });
  });

  it("answers a tap with no url rather than no tap", () => {
    // A notification with no CTA is still a tap, and a tap still means "open the
    // app". Collapsing it to null would make the two indistinguishable.
    expect(tapFromResponse({ notification: { request: { content: {} } } })).toEqual({ url: null });
  });
});

describe("lastTap — the tap that started the process", () => {
  it("reads the response the module was holding", async () => {
    mockGetLastNotificationResponseAsync.mockResolvedValue({
      notification: { request: { content: { data: { url: "/mis-mascotas/DIM-PAMP-0001" } } } },
    });

    await expect(expoPush.lastTap()).resolves.toEqual({ url: "/mis-mascotas/DIM-PAMP-0001" });
  });

  it("answers null when nothing launched this process", async () => {
    mockGetLastNotificationResponseAsync.mockResolvedValue(null);
    await expect(expoPush.lastTap()).resolves.toBeNull();
  });

  it("answers null for undefined too, which the module's own type allows", async () => {
    mockGetLastNotificationResponseAsync.mockResolvedValue(undefined);
    await expect(expoPush.lastTap()).resolves.toBeNull();
  });
});

describe("onTap — taps while the process is alive", () => {
  it("hands the listener a PushTap, not the module's response object", () => {
    const seen: Array<{ url: string | null }> = [];
    expoPush.onTap((tap) => seen.push(tap));

    const [listener] = mockAddNotificationResponseReceivedListener.mock.calls[0] as [
      (response: unknown) => void,
    ];
    listener({ notification: { request: { content: { data: { url: "/mis-turnos" } } } } });

    // The port's type owes nothing to expo-notifications, which is what lets a
    // fake in `push-tap.test.ts` be one arrow instead of a nested object.
    expect(seen).toEqual([{ url: "/mis-turnos" }]);
  });

  it("returns an unsubscribe that removes the subscription", () => {
    const unsubscribe = expoPush.onTap(() => undefined);
    expect(mockRemoveSubscription).not.toHaveBeenCalled();
    unsubscribe();
    expect(mockRemoveSubscription).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The missing FCM credential — item 4's "fail loudly and explainably"
// ---------------------------------------------------------------------------

describe("E_REGISTRATION_FAILED on Android", () => {
  it("names the file, where it comes from, and the harmless case", async () => {
    await withPlatform("android", async () => {
      const result = interpretTokenFailure(coded("E_REGISTRATION_FAILED", "FIS_AUTH_ERROR"));

      // Still `failed` and not `unavailable`: a build that cannot obtain a
      // single token must stay visible, which the file argues at length.
      expect(result.outcome).toBe("failed");
      const detail = result.outcome === "failed" ? result.detail : "";
      // The three things a reader needs and a bare error code does not give
      // them: WHAT is missing, WHERE it comes from, and when it means nothing.
      expect(detail).toContain("google-services.json");
      expect(detail).toContain("googleServicesFile");
      expect(detail).toContain("ar.mimar.app");
      expect(detail).toContain("Expo");
      expect(detail).toContain("Google Play Services");
      // The code still leads, so grouping in a log is unchanged.
      expect(detail.startsWith("E_REGISTRATION_FAILED:")).toBe(true);
    });
  });

  it("leaves the iOS message alone — that key is not iOS's problem", async () => {
    await withPlatform("ios", async () => {
      const result = interpretTokenFailure(coded("E_REGISTRATION_FAILED", "APNs said no"));

      expect(result.outcome).toBe("failed");
      const detail = result.outcome === "failed" ? result.detail : "";
      expect(detail).toBe("E_REGISTRATION_FAILED: APNs said no");
      expect(detail).not.toContain("google-services.json");
    });
  });
});
