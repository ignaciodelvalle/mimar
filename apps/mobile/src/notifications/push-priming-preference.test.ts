// The dismissal store for the push-notification priming line — decision 10A,
// M-1. Real AsyncStorage (the in-memory mock from `jest.setup.js`), the same
// instrument `alta-draft-store.test.ts` and `qr-spotlight-preference.ts`'s own
// suite use — not a mocked module, because what is under test IS the storage
// round trip.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  pushPrimingDismissedKey,
  readPushPrimingDismissed,
  writePushPrimingDismissed,
} from "./push-priming-preference";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe("pushPrimingDismissedKey — the shared-phone fence", () => {
  it("separates two people on the same phone, the same way alta-draft-store's key does", () => {
    expect(pushPrimingDismissedKey(OWNER)).not.toBe(pushPrimingDismissedKey(OTHER_OWNER));
  });
});

describe("readPushPrimingDismissed", () => {
  it("answers false when nothing was ever written — never dismissed", async () => {
    await expect(readPushPrimingDismissed(OWNER)).resolves.toBe(false);
  });

  it("answers true once writePushPrimingDismissed has run for that account", async () => {
    await writePushPrimingDismissed(OWNER);
    await expect(readPushPrimingDismissed(OWNER)).resolves.toBe(true);
  });

  it("does not leak one account's dismissal onto another's read", async () => {
    await writePushPrimingDismissed(OWNER);
    await expect(readPushPrimingDismissed(OTHER_OWNER)).resolves.toBe(false);
  });

  it("survives a storage read that throws, reading it as NOT dismissed", async () => {
    // The safe direction: a broken read must not withhold the priming line
    // forever. Offering it again costs one more tap of "Ahora no"; the
    // opposite failure is unrecoverable from in-app.
    const getItem = jest
      .spyOn(AsyncStorage, "getItem")
      .mockRejectedValueOnce(new Error("keystore unavailable"));

    await expect(readPushPrimingDismissed(OWNER)).resolves.toBe(false);
    getItem.mockRestore();
  });
});

describe("writePushPrimingDismissed", () => {
  it("is best-effort — a storage failure does not throw", async () => {
    const setItem = jest
      .spyOn(AsyncStorage, "setItem")
      .mockRejectedValueOnce(new Error("keystore unavailable"));

    await expect(writePushPrimingDismissed(OWNER)).resolves.toBeUndefined();
    setItem.mockRestore();
  });
});
