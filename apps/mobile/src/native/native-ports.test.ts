// The two native-module seams — what the DEFAULTS promise.
//
// These tests pin the honest-default contract both screens build on:
//
//   1. THE DEFAULT PICKER SAYS `unavailable`, AND SAYS IT BEFORE BEING CALLED.
//      `available: false` is what a screen reads to not draw the control;
//      `pickImage()` answering `unavailable` anyway is the defensive half. A
//      default that answered anything else would let a control ship that lies
//      about what this build can do — the `consoleSink` argument.
//   2. THE DEFAULT SCANNER IS `null`, NOT AN APOLOGY COMPONENT. A screen must
//      be unable to mount a scanner that is not there.
//   3. `set…Port` RETURNS WHAT IT REPLACED and `reset…Port` restores the
//      default — the seam's whole job is that wiring is one reversible call.
//
// MUTATIONS THAT MUST GO RED HERE (applied while writing, then reverted):
//   · `moduleMissingImagePicker.available: false → true` — test 1.
//   · its `pickImage` returning `{ outcome: "cancelled" }` — test 2.
//   · `moduleMissingChipScanner.ScanView: null → () => null` — test 5.
//   · `setImagePickerPort` returning the NEW port instead of the previous —
//     test 3.
//   · `moduleMissingImagePicker.recoverPendingPick` returning anything but
//     `null` — T4-M1's recovery test.
//   · dropping the try/catch in `recoverPendingPickSafely` — its throws test.

import { afterEach, describe, expect, it } from "@jest/globals";

import {
  getChipScannerPort,
  moduleMissingChipScanner,
  resetChipScannerPort,
  setChipScannerPort,
} from "./chip-scanner-port";
import {
  type ImagePickMarker,
  type ImagePickMarkerStore,
  type ImagePickerPort,
  getImagePickerPort,
  moduleMissingImagePicker,
  pickImageSafely,
  recoverPendingPickSafely,
  resetImagePickerPort,
  setImagePickerPort,
} from "./image-picker-port";

/**
 * A native-free fake of the marker store, for the tests in this file that are
 * about the pick/recover FLOOR (never-throws, port-wiring) and not about the
 * marker binding itself — that mechanism has its own dedicated coverage in
 * `image-picker-port.test.ts` (T3-R4, 2026-09-22).
 */
function fakeMarkerStore(initial: ImagePickMarker | null = null): ImagePickMarkerStore {
  let marker = initial;
  return {
    read: async () => marker,
    write: async (m) => {
      marker = m;
    },
    clear: async () => {
      marker = null;
    },
  };
}

/** Identity a recovery is checked against, for the tests below that need a
 *  MATCHING marker to prove pass-through rather than the binding itself. */
const RECOVERY_IDENTITY = {
  screen: "pet-photo" as const,
  publicToken: "DIM-TEST-0001",
  sessionUserId: "11111111-1111-4111-8111-111111111111",
};

function matchingMarker(now: number = Date.now()): ImagePickMarker {
  return { ...RECOVERY_IDENTITY, launchedAt: now };
}
import {
  type PushPort,
  getExpoPushTokenSafely,
  getPushPort,
  moduleMissingPush,
  requestPushPermissionSafely,
  resetPushPort,
  setPushPort,
} from "./push-port";

afterEach(() => {
  resetImagePickerPort();
  resetChipScannerPort();
  resetPushPort();
});

describe("the image-picker seam", () => {
  it("defaults to a port that declares itself unavailable", () => {
    expect(getImagePickerPort()).toBe(moduleMissingImagePicker);
    expect(getImagePickerPort().available).toBe(false);
    expect(getImagePickerPort().name).toBe("module-missing");
  });

  it("answers `unavailable` even when called anyway — the defensive half", async () => {
    // A screen reads `available` first; this is what happens if one does not.
    await expect(moduleMissingImagePicker.pickImage()).resolves.toEqual({
      outcome: "unavailable",
    });
  });

  it("has nothing to recover — no module ever launched a picker to lose", async () => {
    await expect(moduleMissingImagePicker.recoverPendingPick()).resolves.toBeNull();
  });

  it("set returns the replaced port, and reset restores the default", async () => {
    const fake: ImagePickerPort = {
      name: "fake",
      available: true,
      pickImage: async () => ({ outcome: "cancelled" }),
      recoverPendingPick: async () => null,
    };
    const previous = setImagePickerPort(fake);
    expect(previous).toBe(moduleMissingImagePicker);
    expect(getImagePickerPort()).toBe(fake);
    await expect(getImagePickerPort().pickImage()).resolves.toEqual({ outcome: "cancelled" });

    resetImagePickerPort();
    expect(getImagePickerPort()).toBe(moduleMissingImagePicker);
  });
});

describe("`pickImageSafely` — the never-throws half, enforced", () => {
  it("passes a well-behaved port's answer through untouched", async () => {
    setImagePickerPort({
      name: "fake",
      available: true,
      pickImage: async () => ({ outcome: "cancelled" }),
      recoverPendingPick: async () => null,
    });

    await expect(pickImageSafely(null, fakeMarkerStore())).resolves.toEqual({
      outcome: "cancelled",
    });
  });

  it("turns a port that THROWS into `failed`, naming which port broke", async () => {
    // Until this function the "never throws" promise was a sentence in a
    // header and enforced nowhere. Both screens bare-await the pick after
    // setting a "picking" phase, so a rejection stranded them on a spinner
    // with no sentence and no retry — the one answer a tap may not get.
    setImagePickerPort({
      name: "throwing-adapter",
      available: true,
      pickImage: async () => {
        throw new Error("null is not an object");
      },
      recoverPendingPick: async () => null,
    });

    await expect(pickImageSafely(null, fakeMarkerStore())).resolves.toEqual({
      outcome: "failed",
      detail: "throwing-adapter threw: null is not an object",
    });
  });

  it("survives a port that throws something that was never an Error", async () => {
    setImagePickerPort({
      name: "rude-adapter",
      available: true,
      pickImage: async () => {
        // A non-Error throw, on purpose: `failureDetail` has to survive one.
        throw "just a string";
      },
      recoverPendingPick: async () => null,
    });

    await expect(pickImageSafely(null, fakeMarkerStore())).resolves.toEqual({
      outcome: "failed",
      detail: "rude-adapter threw: just a string",
    });
  });

  it("reads the port at CALL time, so the default's `unavailable` still arrives", async () => {
    await expect(pickImageSafely(null, fakeMarkerStore())).resolves.toEqual({
      outcome: "unavailable",
    });
  });
});

// ---------------------------------------------------------------------------
// T4-M1 (2026-09-22): the recovery half gets the same never-throws floor.
// ---------------------------------------------------------------------------
describe("`recoverPendingPickSafely` — the never-throws half, for the recovery seam", () => {
  it("passes a well-behaved port's answer through untouched", async () => {
    setImagePickerPort({
      name: "fake",
      available: true,
      pickImage: async () => ({ outcome: "cancelled" }),
      recoverPendingPick: async () => ({ outcome: "cancelled" }),
    });

    await expect(
      recoverPendingPickSafely(RECOVERY_IDENTITY, fakeMarkerStore(matchingMarker())),
    ).resolves.toEqual({ outcome: "cancelled" });
  });

  it("turns a THROWING recovery into null — nobody is waiting on a spinner for it", async () => {
    // Unlike `pickImageSafely`, a broken recovery has no screen sitting on a
    // "picking" phase to rescue: the screen is in its ordinary entry state
    // either way, so there is nothing to tell and nothing to retry.
    setImagePickerPort({
      name: "throwing-adapter",
      available: true,
      pickImage: async () => ({ outcome: "cancelled" }),
      recoverPendingPick: async () => {
        throw new Error("getPendingResultAsync exploded");
      },
    });

    await expect(
      recoverPendingPickSafely(RECOVERY_IDENTITY, fakeMarkerStore(matchingMarker())),
    ).resolves.toBeNull();
  });

  it("reads the port at CALL time, so the default's null still arrives", async () => {
    await expect(
      recoverPendingPickSafely(RECOVERY_IDENTITY, fakeMarkerStore(matchingMarker())),
    ).resolves.toBeNull();
  });
});

describe("the chip-scanner seam", () => {
  it("defaults to NO scan view at all — null, not a stub component", () => {
    expect(getChipScannerPort()).toBe(moduleMissingChipScanner);
    // `toBeNull` and not falsy: a component that renders nothing would still
    // be mountable, and mountable is exactly what the missing module must not be.
    expect(getChipScannerPort().ScanView).toBeNull();
  });

  it("set returns the replaced port, and reset restores the default", () => {
    const FakeView = () => null;
    const previous = setChipScannerPort({ name: "fake", ScanView: FakeView });
    expect(previous).toBe(moduleMissingChipScanner);
    expect(getChipScannerPort().ScanView).toBe(FakeView);

    resetChipScannerPort();
    expect(getChipScannerPort()).toBe(moduleMissingChipScanner);
  });
});

// ---------------------------------------------------------------------------
// The PUSH seam (2026-09-11).
//
// The same honest-default contract as the two above, and it matters MORE here
// than for either of them: the build on Play today was cut WITHOUT
// `expo-notifications`, so `moduleMissingPush` is the only answer every
// installed phone can give. A default that returned a fake token would register
// a row that can never receive anything, and the person would see push as "on"
// in an app that cannot deliver.
//
// MUTATIONS THAT MUST GO RED HERE (applied while writing, then reverted):
//   · `moduleMissingPush.available: false → true` — the first test.
//   · its `requestPermission` returning `{ outcome: "granted" }` — the second.
//   · its `getExpoPushToken` returning a token string — the third.
//   · dropping the try/catch in `requestPushPermissionSafely` — the throws test.
// ---------------------------------------------------------------------------

describe("the push seam", () => {
  it("defaults to a port that declares itself unavailable", () => {
    expect(getPushPort()).toBe(moduleMissingPush);
    // Read BEFORE anything is offered: iOS gives one permission prompt per
    // install, and spending it on a build that cannot receive is unrecoverable.
    expect(getPushPort().available).toBe(false);
  });

  it("answers `unavailable` to BOTH operations even when called anyway", async () => {
    await expect(requestPushPermissionSafely()).resolves.toEqual({ outcome: "unavailable" });
    await expect(getExpoPushTokenSafely()).resolves.toEqual({ outcome: "unavailable" });
  });

  it("never answers `granted` or a token by default", async () => {
    // Stated as its own assertion because these are the two answers that would
    // make the app write a row for a device that cannot be delivered to.
    const permission = await requestPushPermissionSafely();
    const token = await getExpoPushTokenSafely();
    expect(permission.outcome).not.toBe("granted");
    expect(token.outcome).not.toBe("token");
  });

  it("set returns the replaced port, and reset restores the default", async () => {
    const fake: PushPort = {
      name: "fake",
      available: true,
      requestPermission: async () => ({ outcome: "granted" }),
      getExpoPushToken: async () => ({ outcome: "token", expoPushToken: "ExponentPushToken[x]" }),
      lastTap: async () => null,
      onTap: () => () => undefined,
      ensureNotificationChannel: async () => undefined,
    };
    const previous = setPushPort(fake);
    expect(previous).toBe(moduleMissingPush);
    await expect(requestPushPermissionSafely()).resolves.toEqual({ outcome: "granted" });

    resetPushPort();
    expect(getPushPort()).toBe(moduleMissingPush);
  });

  it("turns a port that THROWS into `failed`, naming which port broke", async () => {
    setPushPort({
      name: "exploding",
      available: true,
      requestPermission: async () => {
        throw new Error("native module gone");
      },
      getExpoPushToken: async () => {
        throw new Error("no project id");
      },
      lastTap: async () => null,
      onTap: () => () => undefined,
      ensureNotificationChannel: async () => undefined,
    });

    const permission = await requestPushPermissionSafely();
    expect(permission.outcome).toBe("failed");
    expect(permission.outcome === "failed" && permission.detail).toContain("exploding");
    expect(permission.outcome === "failed" && permission.detail).toContain("native module gone");

    const token = await getExpoPushTokenSafely();
    expect(token.outcome).toBe("failed");
    expect(token.outcome === "failed" && token.detail).toContain("no project id");
  });

  it("survives a port that throws something that was never an Error", async () => {
    setPushPort({
      name: "rude",
      available: true,
      requestPermission: async () => {
        throw "just a string";
      },
      getExpoPushToken: async () => ({ outcome: "unavailable" }),
      lastTap: async () => null,
      onTap: () => () => undefined,
      ensureNotificationChannel: async () => undefined,
    });

    const result = await requestPushPermissionSafely();
    expect(result.outcome).toBe("failed");
    expect(result.outcome === "failed" && result.detail).toContain("just a string");
  });

  it("distinguishes `denied` from `unavailable`, because they are different facts", async () => {
    // A person who said no is not the same as a build that cannot ask. The
    // first must stop the app from asking again; the second must stop it from
    // asking at all. Collapsing them would make the app retry a refusal.
    setPushPort({
      name: "declined",
      available: true,
      requestPermission: async () => ({ outcome: "denied" }),
      getExpoPushToken: async () => ({ outcome: "denied" }),
      lastTap: async () => null,
      onTap: () => () => undefined,
      ensureNotificationChannel: async () => undefined,
    });
    await expect(requestPushPermissionSafely()).resolves.toEqual({ outcome: "denied" });
    await expect(getExpoPushTokenSafely()).resolves.toEqual({ outcome: "denied" });
  });
});
